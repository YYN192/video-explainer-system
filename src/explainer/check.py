"""CHECK — the pre-render quality gate for PDF-profile runs (PRD §19). Pure Python, no LLM.

Claude authors the judgement-heavy inputs (script.json, deck.json, claims.json,
equations.json); this module mechanically verifies them against the ingested PDF so a
bad claim or an invented equation is caught while edits are still cheap text:

  1. structure   — script/deck ids match; every slide is narrated
  2. claims      — every `source` claim's verbatim quote really occurs on its cited PDF
                   page; `supplement` claims are badged as supplementary on screen
  3. equations   — every formula on screen is in the verified registry, byte-for-byte;
                   derivation steps may only use equations that come from the source
  4. speech      — narration contains no raw symbols TTS would mangle (=, λ, ^, ½ …);
                   technical words missing from the G2P dictionary are listed with the
                   phonemes Kokoro will use (optionally rendered to a review WAV)
  5. pacing      — estimated duration vs the profile window; hook length; shot length;
                   device variety; transition repetition (BRAINROT)

Writes work/check.json and review/outline.md (the human-readable outline + script +
storyboard the skill shows the user before rendering)."""
import json, re, unicodedata
from pathlib import Path

SPOKEN_FORBIDDEN = re.compile(r"[=+×÷^_\\√∑∫∂±≈≠≤≥∝→½¼¾²³⁻⁺λΛαβγδΔθΘμσΣωΩφΦπε]|\d\s*[x×]\s*10|\d+/\d+")
UNIT_ABBREV = re.compile(r"\b\d+(?:\.\d+)?\s*(m/s|m|s|Hz|kHz|MHz|kg|N|J|W|V|A|nm|mm|cm|km)\b")
HOOK_TYPES = {"hook", "punch", "meme", "stat", "build", "highlight", "scene2d"}


def _norm(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = s.replace("−", "-").replace("–", "-").replace("—", "-")
    s = re.sub(r"-\s*\n\s*", "", s)          # re-join words hyphenated across lines
    return re.sub(r"\s+", " ", s).strip()


def _tex_key(t):
    return re.sub(r"\s+", "", t or "")


def _load(path, default=None):
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else default


def _pages(proj):
    """{page_no: normalized text} across every ingested PDF's pages.json."""
    out = {}
    for f in sorted((proj.dir / "sources").glob("*_pages.json")):
        for rec in json.loads(f.read_text()).get("pages", []):
            out.setdefault(rec["page"], "")
            out[rec["page"]] += " " + _norm(rec["text"])
    return out


def _deck_math(deck):
    """[(slide_id, role, latex)] for every formula that will appear on screen."""
    found = []
    for s in deck.get("slides", []):
        if s.get("type") == "equation":
            found.append((s["id"], "equation", s.get("latex", "")))
        for st in s.get("steps", []) if s.get("type") == "derivation" else []:
            found.append((s["id"], "derivation", st.get("latex", "")))
        for sh in s.get("shapes", []) or []:
            if sh.get("kind") == "math":
                found.append((s["id"], "label", sh.get("latex", "")))
    return found


def _oov_terms(texts, lang):
    """Words the English G2P has no dictionary entry for -> {word: phonemes}. Kokoro then
    guesses via espeak; these are the ones worth listening to before rendering."""
    if not lang.startswith("en"):
        return {}, "pronunciation dictionary check is English-only"
    try:
        from misaki import en, espeak
        fb = espeak.EspeakFallback(british=lang == "en-gb")
        g2p = en.G2P(trf=False, british=lang == "en-gb", fallback=fb)
    except Exception as e:  # pragma: no cover - environment dependent
        return {}, f"G2P unavailable: {e}"
    known = set(g2p.lexicon.golds) | set(g2p.lexicon.silvers)
    words = sorted({w for t in texts for w in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", t)})
    out = {}
    def _known(x):
        return x in known or x.lower() in known or x.capitalize() in known
    for w in words:
        if _known(w):
            continue
        lw = w.lower()  # misaki derives -s/-es/-ed/-ing forms from the stem: only flag unknown stems
        stems = [lw[:-1], lw[:-2], lw[:-3], lw[:-3] + "e", lw[:-2] + "e", lw[:-1].rstrip("e")]
        if lw.endswith(("s", "ed", "ing")) and any(len(st) > 2 and _known(st) for st in stems):
            continue
        try:
            out[w] = g2p(w)[0]
        except Exception:
            out[w] = "?"
    return out, None


def _render_pronunciation(proj, terms, lang_spec, path):
    """Speak each flagged term (then the sentence-context form) into one review WAV."""
    import numpy as np, soundfile as sf
    from kokoro import KPipeline
    pipe = KPipeline(lang_code=lang_spec["kokoro"], repo_id="hexgrad/Kokoro-82M")
    gap = np.zeros(int(24000 * 0.45), np.float32)
    parts = []
    for term in terms:
        for _, _, audio in pipe(term + ".", voice=proj.voice, speed=float(proj.data.get("speech_speed", 1.0))):
            parts.append(np.asarray(audio, dtype=np.float32))
        parts.append(gap)
    if parts:
        sf.write(path, np.concatenate(parts), 24000)
    return path


def run(proj, audio=False):
    from .profiles import language
    from .lexicon import load as load_lex, spoken_text
    script = _load(proj.script_json, {"segments": []})
    deck = _load(proj.deck_json, {"slides": []})
    claims = _load(proj.dir / "claims.json", {"claims": []}).get("claims", [])
    eqreg = _load(proj.dir / "equations.json", {"equations": []}).get("equations", [])
    d = proj.data
    profile = d.get("profile")
    errors, warnings = [], []

    # 1. structure ------------------------------------------------------------------
    slides = {s["id"]: s for s in deck.get("slides", [])}
    segs = script.get("segments", [])
    seg_slides = [s["slide"] for s in segs]
    for sid in slides:
        if sid not in seg_slides and slides[sid].get("type") != "cta":
            errors.append(f"slide {sid} has no narration segment")
    for s in segs:
        if s["slide"] not in slides:
            errors.append(f"segment {s['id']} points at missing slide {s['slide']}")

    # 2. claims ---------------------------------------------------------------------
    pages = _pages(proj)
    claim_rows = []
    for c in claims:
        kind, page, quote = c.get("kind"), c.get("page"), c.get("quote", "")
        row = {"id": c.get("id"), "slide": c.get("slide"), "kind": kind, "page": page, "status": "ok"}
        if kind == "source":
            q = _norm(quote)
            if not q:
                row["status"] = "error"; errors.append(f"claim {c.get('id')}: source claim without a verbatim quote")
            elif page not in pages:
                row["status"] = "error"; errors.append(f"claim {c.get('id')}: cited page {page} was not ingested")
            elif q not in pages[page]:
                elsewhere = [p for p, txt in pages.items() if q in txt]
                row["status"] = "error"
                errors.append(f"claim {c.get('id')}: quote not found on p.{page}"
                              + (f" (found on p.{elsewhere[0]} — fix the page)" if elsewhere else " — not in the PDF at all"))
            sl = slides.get(c.get("slide"), {})
            if row["status"] == "ok" and sl.get("claim") == "supplement":
                warnings.append(f"claim {c.get('id')} is from the source but slide {c.get('slide')} is badged supplementary")
        elif kind == "supplement":
            sl = slides.get(c.get("slide"), {})
            if sl and sl.get("claim") != "supplement" and profile == "educational":
                warnings.append(f"claim {c.get('id')} is supplementary but slide {c.get('slide')} is not badged "
                                f"\"claim\": \"supplement\" — viewers can't tell it apart from the source")
        else:
            row["status"] = "error"; errors.append(f"claim {c.get('id')}: kind must be 'source' or 'supplement'")
        claim_rows.append(row)
    if profile == "educational" and not claims:
        warnings.append("no claims.json — EDUCATIONAL runs should list every factual claim with its PDF page")

    # 3. equations ------------------------------------------------------------------
    reg = {_tex_key(e.get("latex")): e for e in eqreg}
    for e in eqreg:
        if not e.get("verified"):
            errors.append(f"equation {e.get('id')} is not verified against the PDF (run `explainer eqsheet` and compare)")
        if not e.get("page") and not e.get("supplement"):
            errors.append(f"equation {e.get('id')} has no source page (set `page`, or `supplement: true` if it is not in the PDF)")
    eq_rows = []
    for sid, role, tex in _deck_math(deck):
        e = reg.get(_tex_key(tex))
        status = "ok"
        if not e:
            status = "error"; errors.append(f"slide {sid}: formula not in equations.json registry: {tex}")
        elif role == "derivation" and e.get("supplement"):
            status = "error"
            errors.append(f"slide {sid}: derivation step {e.get('id')} is not from the source — derivations "
                          f"may only use the PDF's own steps")
        elif e.get("supplement") and slides.get(sid, {}).get("claim") != "supplement":
            warnings.append(f"slide {sid}: shows supplementary equation {e.get('id')} without a supplementary badge")
        eq_rows.append({"slide": sid, "role": role, "latex": tex, "id": (e or {}).get("id"),
                        "page": (e or {}).get("page"), "status": status})

    # 4. speech ---------------------------------------------------------------------
    lang_code, lang_spec = language(d.get("language", "en-us"))
    lex = load_lex(proj.dir, (proj.brand or {}).get("lexicon"))
    for s in segs:
        m = SPOKEN_FORBIDDEN.search(s["text"])
        if m:
            errors.append(f"segment {s['id']}: narration contains {m.group(0)!r} — write maths as spoken words "
                          f"(e.g. 'v equals f lambda', 'five times ten to the minus seven')")
        u = UNIT_ABBREV.search(s["text"])
        if u:
            warnings.append(f"segment {s['id']}: unit abbreviation {u.group(0)!r} — spell it out "
                            f"('metres per second', 'hertz') so TTS and captions agree")
    spoken = [spoken_text(s["text"], lex) for s in segs] if (lang_code or "").startswith("en") else [s["text"] for s in segs]
    oov, oov_note = _oov_terms(spoken, lang_code or "en-us")
    pron_wav = None
    if audio and oov and lang_spec:
        proj_review = proj.dir / "review"; proj_review.mkdir(exist_ok=True)
        pron_wav = str(_render_pronunciation(proj, list(oov), lang_spec, proj_review / "pronunciation.wav").relative_to(proj.dir))

    # 5. pacing ---------------------------------------------------------------------
    wpm = float(d.get("target_wpm", 150))
    gap = float(d.get("segment_gap", 0.18))
    est = [len(s["text"].split()) / wpm * 60 for s in segs]
    total = round(sum(est) + gap * len(est), 1)
    lo, hi = d.get("min_length"), d.get("max_length")
    if lo and total < lo * 0.95:
        warnings.append(f"estimated duration {total}s is under the {lo}s minimum — deepen with sourced beats, don't pad")
    if hi and total > hi * 1.05:
        warnings.append(f"estimated duration {total}s is over the {hi}s maximum — trim asides/recaps first")
    max_shot = float(d.get("max_shot_s", 1e9))
    for s, e in zip(segs, est):
        if e > max_shot:
            warnings.append(f"segment {s['id']} (~{e:.1f}s) is longer than the {max_shot}s shot limit — split it")
    if profile == "brainrot":
        if est and est[0] > 2.6:
            warnings.append(f"hook segment is ~{est[0]:.1f}s — the hook must land in the first ~2s")
        if segs and slides.get(segs[0]["slide"], {}).get("type") not in HOOK_TYPES:
            warnings.append("first slide is not a hook-type device (hook/punch/meme/stat/build/highlight/scene2d)")
        types = {s.get("type") for s in slides.values()}
        if len(types) < 5:
            warnings.append(f"only {len(types)} device types — use 5+ for visual density")
        seq = [s.get("transition") or proj.theme.get("motion") for s in deck.get("slides", [])]
        for i in range(2, len(seq)):
            if seq[i] == seq[i - 1] == seq[i - 2]:
                warnings.append(f"transition '{seq[i]}' used 3x in a row at slide {deck['slides'][i]['id']} — vary it")
                break

    report = {"ok": not errors, "profile": profile, "estimated_duration_s": total,
              "window_s": [lo, hi], "errors": errors, "warnings": warnings,
              "claims": claim_rows, "equations": eq_rows,
              "pronunciation": {"check": oov, "note": oov_note, "review_wav": pron_wav}}
    proj.write_json(proj.work / "check.json", report)
    _write_outline(proj, script, deck, claims, report)
    return {"ok": report["ok"], "errors": len(errors), "warnings": len(warnings),
            "estimated_duration_s": total, "outline": "review/outline.md",
            "pronunciation_terms": len(oov), "pronunciation_wav": pron_wav}


def _visual_summary(s):
    t = s.get("type")
    bits = [t]
    for k in ("headline", "word", "term", "latex", "punch", "setup", "title", "caption"):
        if s.get(k):
            bits.append(f"{k}: {s[k]}")
            break
    if t == "derivation":
        bits.append(f"{len(s.get('steps', []))} steps")
    if t == "scene2d":
        bits.append(f"{len(s.get('shapes', []))} shapes")
    if s.get("transition"):
        bits.append(f"→ {s['transition']}")
    return " · ".join(bits)


def _write_outline(proj, script, deck, claims, report):
    d = proj.data
    by_id = {s["id"]: s for s in deck.get("slides", [])}
    claims_by_slide = {}
    for c in claims:
        claims_by_slide.setdefault(c.get("slide"), []).append(c)
    lines = [f"# {d.get('title', 'Explainer')} — outline & script for review", "",
             f"- **Profile:** {d.get('profile') or 'none'} · **aspect:** {d.get('aspect')} · **voice:** {d.get('voice')}"
             f" · **language:** {d.get('language', 'en-us')} · **speed:** {d.get('speech_speed', 1.0)}",
             f"- **Target window:** {d.get('min_length')}–{d.get('max_length')} s · "
             f"**estimated:** {report['estimated_duration_s']} s",
             f"- **Gate:** {'PASS' if report['ok'] else 'FAIL'} — {len(report['errors'])} error(s), "
             f"{len(report['warnings'])} warning(s)", ""]
    if report["errors"]:
        lines += ["## Errors (must fix before rendering)", ""] + [f"- {e}" for e in report["errors"]] + [""]
    if report["warnings"]:
        lines += ["## Warnings", ""] + [f"- {w}" for w in report["warnings"]] + [""]
    lines += ["## Storyboard + script", "", "| # | slide | visual | source | narration |", "|---|---|---|---|---|"]
    for i, seg in enumerate(script.get("segments", []), 1):
        s = by_id.get(seg["slide"], {})
        src = "supplementary" if s.get("claim") == "supplement" else (f"p. {s['page']}" if s.get("page") else "")
        cl = ", ".join(f"{c.get('id')}({c.get('kind')[0]})" for c in claims_by_slide.get(seg["slide"], []))
        vis = _visual_summary(s).replace("|", "\\|")
        lines.append(f"| {i} | {seg['slide']} | {vis} | {src}{' · ' + cl if cl else ''} | {seg['text'].replace('|', '/')} |")
    if report["equations"]:
        lines += ["", "## Equations on screen", "", "| slide | role | registry id | PDF page | LaTeX |", "|---|---|---|---|---|"]
        for e in report["equations"]:
            lines.append(f"| {e['slide']} | {e['role']} | {e['id']} | {e['page']} | `{e['latex']}` |")
    pron = report["pronunciation"]["check"]
    if pron:
        lines += ["", "## Pronunciation to check (not in the G2P dictionary — Kokoro will guess)", ""]
        lines += [f"- **{w}** → /{p}/" for w, p in pron.items()]
        if report["pronunciation"]["review_wav"]:
            lines.append(f"\nListen: `{report['pronunciation']['review_wav']}` (terms spoken in this order).")
        lines.append("\nFix a wrong one by adding `{\"term\": \"respelling\"}` to `<project>/lexicon.json`.")
    review = proj.dir / "review"
    review.mkdir(exist_ok=True)
    (review / "outline.md").write_text("\n".join(lines) + "\n")


def equation_sheet(proj):
    """Render review/equations.png: each registry equation's PDF crop (left) next to the
    MathJax render of its LaTeX (right), for a side-by-side exactness check."""
    from playwright.sync_api import sync_playwright
    import shutil, html as _html
    eqreg = _load(proj.dir / "equations.json", {"equations": []}).get("equations", [])
    review = proj.dir / "review"
    review.mkdir(exist_ok=True)
    mj = Path(__file__).parent / "assets" / "mathjax" / "tex-svg-full.js"
    shutil.copy(mj, review / "tex-svg-full.js")
    rows = []
    for e in eqreg:
        crop = e.get("crop")
        img = f'<img src="../{crop}">' if crop and (proj.dir / crop).exists() else "<i>(no PDF crop — supplementary)</i>"
        rows.append(f"<tr><td class=id>{_html.escape(str(e.get('id')))}<br><small>p. {e.get('page') or '—'}</small></td>"
                    f"<td class=pdf>{img}</td><td class=tex data-tex=\"{_html.escape(e.get('latex', ''))}\"></td>"
                    f"<td class=raw><code>{_html.escape(e.get('latex', ''))}</code></td></tr>")
    page_html = ("<!doctype html><meta charset=utf-8><style>body{font-family:sans-serif;margin:24px;background:#fff}"
                 "table{border-collapse:collapse}td{border:1px solid #ccc;padding:10px 14px;vertical-align:middle}"
                 ".pdf img{max-height:90px}.tex{font-size:30px;min-width:340px}.raw{font-size:13px;color:#555;max-width:340px}"
                 "</style><h2>Equation check — PDF (left) vs rendered LaTeX (right)</h2><table>"
                 "<tr><th>id</th><th>PDF crop</th><th>rendered</th><th>LaTeX</th></tr>" + "".join(rows) + "</table>"
                 "<script>window.MathJax={startup:{typeset:false},svg:{fontCache:'local'},options:{enableMenu:false,enableAssistiveMml:false}};</script>"
                 "<script src='tex-svg-full.js'></script><script>MathJax.startup.promise.then(()=>{"
                 "document.querySelectorAll('td.tex').forEach(td=>td.appendChild(MathJax.tex2svg(td.dataset.tex,{display:true})));"
                 "document.head.appendChild(MathJax.svgStylesheet());"
                 "window.__done=true;});</script>")
    (review / "equations.html").write_text(page_html)
    out = review / "equations.png"
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1400, "height": 900})
        pg.goto((review / "equations.html").as_uri())
        pg.wait_for_function("window.__done === true")
        errs = pg.evaluate("[...document.querySelectorAll('[data-mjx-error]')].map(e=>e.getAttribute('data-mjx-error'))")
        pg.screenshot(path=str(out), full_page=True)
        b.close()
    return {"sheet": str(out.relative_to(proj.dir)), "equations": len(eqreg), "latex_errors": errs}
