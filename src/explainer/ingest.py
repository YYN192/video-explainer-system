"""INGEST — source material -> sources/ (extracted text, framed screenshots/figures,
citations.json). PDF via PyMuPDF; URL via Playwright. No LLM calls."""
import json, re
from pathlib import Path


def _sources_dir(proj):
    p = proj.dir / "sources"
    p.mkdir(exist_ok=True)
    return p


def _load_citations(sdir):
    f = sdir / "citations.json"
    return json.loads(f.read_text()) if f.exists() else {"sources": []}


def _save_citations(sdir, cites):
    (sdir / "citations.json").write_text(json.dumps(cites, indent=2))


def _parse_pages(spec, n):
    if not spec:
        return list(range(min(n, 4)))  # default: first 4 pages
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a) - 1, int(b)))
        elif part:
            out.add(int(part) - 1)
    return sorted(i for i in out if 0 <= i < n)


def ingest_pdf(proj, pdf_path, pages=None, zoom=2.0):
    import fitz
    sdir = _sources_dir(proj)
    doc = fitz.open(str(pdf_path))
    sid = "src" + str(len(_load_citations(sdir)["sources"]) + 1)

    text = "\n\n".join(doc[i].get_text() for i in range(doc.page_count))
    text_rel = f"sources/{sid}_text.md"
    (proj.dir / text_rel).write_text(text)

    idxs = _parse_pages(pages, doc.page_count)
    images = []
    mat = fitz.Matrix(zoom, zoom)
    for i in idxs:
        rel = f"sources/{sid}_page-{i+1:02d}.png"
        doc[i].get_pixmap(matrix=mat).save(str(proj.dir / rel))
        images.append(rel)

    title = (doc.metadata or {}).get("title") or Path(pdf_path).stem
    pages_rel, pstats = _page_records(proj, doc, idxs, sid)
    cites = _load_citations(sdir)
    cites["sources"].append({"id": sid, "kind": "pdf", "ref": str(pdf_path),
                             "title": title, "pages": [i + 1 for i in idxs],
                             "images": images, "text": text_rel, "pages_json": pages_rel})
    _save_citations(sdir, cites)
    return {"source_id": sid, "title": title, "pages_rendered": [i + 1 for i in idxs],
            "images": images, "text": text_rel, "pages_json": pages_rel, **pstats}


# --- page-aware extraction (PDF profiles, PRD §19) -------------------------------------
# Characters that mark a line as (probably) mathematical. Used only to pick lines to crop
# for the side-by-side equation check — Claude still transcribes from the page image.
MATH_CHARS = set("=λΛ×÷±√∑∫∂πθΘΔδαβγμσΣωΩφΦε½¼¾²³⁻⁺∞≈≠≤≥∝→")
MATH_FONT_HINTS = ("math", "cmmi", "cmsy", "cmex", "symbol", "stix", "cambria")


def _norm_text(s):
    import unicodedata
    return unicodedata.normalize("NFKC", s)  # folds ligatures (ﬀ -> ff) so quotes can be matched


def _merge_near(rects, gap):
    """Union rectangles closer than `gap` points: a diagram drawn as several separate vector
    groups (wavefronts, a barrier, arcs) becomes one figure region."""
    rects = [r + (-1, -1, 1, 1) for r in rects if r.is_valid]  # thin lines have zero-width rects
    merged = True
    while merged:
        merged = False
        out = []
        for r in rects:
            for i, o in enumerate(out):
                if (o + (-gap, -gap, gap, gap)).intersects(r):
                    out[i] = o | r
                    merged = True
                    break
            else:
                out.append(r)
        rects = out
    return rects


def _page_records(proj, doc, idxs, sid, crop_zoom=4.0):
    """Write sources/<sid>_pages.json: per selected page its text, candidate equation lines
    (with a hi-res crop each) and figure regions (embedded images + vector-drawing clusters,
    cropped). Page numbers are 1-based, as printed in citations and on-screen references."""
    import fitz
    mat = fitz.Matrix(crop_zoom, crop_zoom)
    records, n_math, n_fig = [], 0, 0
    for i in idxs:
        page = doc[i]
        pno = i + 1
        rec = {"page": pno, "text": _norm_text(page.get_text()), "math_lines": [], "figures": []}
        for block in page.get_text("dict").get("blocks", []):
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                txt = _norm_text("".join(s.get("text", "") for s in spans)).strip()
                if not txt or len(txt) > 160:
                    continue
                fonts = " ".join(s.get("font", "") for s in spans).lower()
                if any(c in MATH_CHARS for c in txt) or any(h in fonts for h in MATH_FONT_HINTS):
                    r = fitz.Rect(line["bbox"]) + (-6, -6, 6, 6)
                    rel = f"sources/{sid}_p{pno:02d}_eq{len(rec['math_lines']) + 1:02d}.png"
                    page.get_pixmap(matrix=mat, clip=r & page.rect).save(str(proj.dir / rel))
                    rec["math_lines"].append({"text": txt, "bbox": [round(v, 1) for v in r], "crop": rel})
                    n_math += 1
        # raw drawing rects (cluster_drawings() drops zero-width lines, e.g. plane wavefronts),
        # merged by proximity below into whole-figure regions
        regions = [fitz.Rect(dr["rect"]) for dr in page.get_drawings()]
        for img in page.get_images(full=True):
            regions += list(page.get_image_rects(img[0]))
        regions = _merge_near(regions, gap=36)
        for r in regions:
            if r.width < 60 or r.height < 40:
                continue  # rules, underlines, boxes around text
            r = (r + (-10, -10, 10, 24)) & page.rect  # a little room for labels below
            rel = f"sources/{sid}_p{pno:02d}_fig{len(rec['figures']) + 1:02d}.png"
            page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=r).save(str(proj.dir / rel))
            rec["figures"].append({"bbox": [round(v, 1) for v in r], "crop": rel})
            n_fig += 1
        records.append(rec)
    rel = f"sources/{sid}_pages.json"
    (proj.dir / rel).write_text(json.dumps({"source_id": sid, "pages": records}, indent=2, ensure_ascii=False))
    return rel, {"math_line_crops": n_math, "figure_crops": n_fig}


def ingest_url(proj, url, width=1280, height=1600, full_page=False):
    from playwright.sync_api import sync_playwright
    sdir = _sources_dir(proj)
    sid = "src" + str(len(_load_citations(sdir)["sources"]) + 1)
    slug = re.sub(r"[^a-z0-9]+", "-", url.lower()).strip("-")[:40]
    img_rel = f"sources/{sid}_{slug}.png"
    text = ""
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--hide-scrollbars"])
        page = browser.new_page(viewport={"width": width, "height": height})
        page.goto(url, wait_until="networkidle", timeout=45000)
        page.screenshot(path=str(proj.dir / img_rel), full_page=full_page)
        try:
            text = page.inner_text("body")
        except Exception:
            text = ""
        browser.close()
    text_rel = f"sources/{sid}_text.md"
    (proj.dir / text_rel).write_text(text)

    cites = _load_citations(sdir)
    cites["sources"].append({"id": sid, "kind": "url", "ref": url, "title": url,
                             "images": [img_rel], "text": text_rel})
    _save_citations(sdir, cites)
    return {"source_id": sid, "url": url, "images": [img_rel], "text": text_rel}
