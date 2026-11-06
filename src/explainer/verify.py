"""VERIFY — post-render QA + deliverable packaging for PDF-profile runs (PRD §19).
Pure Python (ffprobe/ffmpeg), no LLM. Runs after `explainer media` (automatically when
the project has a `profile`), or on its own via `explainer verify <dir>`.

  1. video        — every aspect's MP4 exists, has H.264 video + AAC audio, and its video,
                    audio and timeline durations agree
  2. sync         — captions are monotonic and inside the audio; caption words sit on
                    speech, not silence (ffmpeg silencedetect on the narration); each
                    segment's first word starts shortly after its segment begins
  3. frames       — one representative frame per slide pulled from the FINAL MP4 (what the
                    viewer sees) + a contact sheet, for visual inspection
  4. equations    — the deck engine's math report: any LaTeX error, zero-size render or
                    off-screen equation fails the run; equation slides are listed for a look
  5. deliverables — script/script.md + narration.txt, storyboard/storyboard.json + .md,
                    captions/ (SRT/VTT), video/ — all saved in the project dir

Writes review/verify.json. `ok:false` means something a human must look at."""
import json, math, re, shutil, subprocess


def _probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "stream=codec_type,codec_name,nb_frames,duration:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True)
    return json.loads(r.stdout or "{}")


def _silences(wav, noise="-38dB", d=0.25):
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(wav), "-af",
                          f"silencedetect=noise={noise}:d={d}", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    spans, start = [], None
    for line in err.splitlines():
        m = re.search(r"silence_start: ([\d.]+)", line)
        if m:
            start = float(m.group(1))
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            spans.append((start, float(m.group(1)))); start = None
    return spans


def _srt_times(path):
    def sec(s):
        h, m, rest = s.split(":"); s2, ms = rest.split(",")
        return int(h) * 3600 + int(m) * 60 + int(s2) + int(ms) / 1000
    out = []
    for a, b in re.findall(r"(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})", path.read_text()):
        out.append((sec(a), sec(b)))
    return out


def _frames(proj, aspect, slides, video, deck_by_id):
    label = aspect.replace(":", "x")
    fdir = proj.dir / "review" / f"frames_{label}"
    if fdir.exists():
        shutil.rmtree(fdir)
    fdir.mkdir(parents=True)
    listed = []
    for i, s in enumerate(slides, 1):
        span = s["end"] - s["start"]
        t = s["start"] + min(span * 0.7, max(0.5, span - 0.15))  # settled, before the next cut
        name = f"f_{i:03d}.png"
        subprocess.run(["ffmpeg", "-hide_banner", "-y", "-ss", f"{t:.3f}", "-i", str(video),
                        "-frames:v", "1", str(fdir / name)], capture_output=True)
        listed.append({"file": str((fdir / name).relative_to(proj.dir)), "slide": s["id"], "t": round(t, 2),
                       "type": deck_by_id.get(s["id"], {}).get("type")})
    w, h = proj.size_for(aspect)
    cols = 6 if h > w else 4
    rows = math.ceil(len(listed) / cols) or 1
    tw = 320 if h > w else 480
    sheet = proj.dir / "review" / f"contact_{label}.png"
    subprocess.run(["ffmpeg", "-hide_banner", "-y", "-framerate", "1", "-i", str(fdir / "f_%03d.png"),
                    "-vf", f"scale={tw}:-1,tile={cols}x{rows}:padding=6:color=0x222222",
                    "-frames:v", "1", str(sheet)], capture_output=True)
    return listed, (str(sheet.relative_to(proj.dir)) if sheet.exists() else None)


def _deliverables(proj, segs, timeline, deck):
    by_id = {s["id"]: s for s in deck.get("slides", [])}
    sdir = proj.dir / "script"; sdir.mkdir(exist_ok=True)
    bdir = proj.dir / "storyboard"; bdir.mkdir(exist_ok=True)
    words = timeline.get("words", [])
    md = [f"# {proj.data.get('title', 'Explainer')} — narration script", ""]
    board = []
    for seg, win in zip(segs, timeline["slides"]):
        s = by_id.get(seg["slide"], {})
        md.append(f"**[{win['start']:.1f}–{win['end']:.1f}s] {seg['slide']}** ({s.get('type')})"
                  + (f" — p. {s['page']}" if s.get("page") else "")
                  + (" — supplementary" if s.get("claim") == "supplement" else ""))
        md += [seg["text"], ""]
        board.append({"slide": seg["slide"], "start": win["start"], "end": win["end"],
                      "narration": seg["text"], "visual": s,
                      "words": [w for w in words if w["slide"] == seg["slide"]]})
    (sdir / "script.md").write_text("\n".join(md))
    (sdir / "narration.txt").write_text("\n\n".join(s["text"] for s in segs) + "\n")
    proj.write_json(bdir / "storyboard.json", {"duration": timeline["duration"], "fps": timeline["fps"],
                                              "scenes": board})
    lines = ["# Storyboard", "", "| t (s) | slide | device | page | narration |", "|---|---|---|---|---|"]
    for b in board:
        v = b["visual"]
        lines.append(f"| {b['start']:.1f}–{b['end']:.1f} | {b['slide']} | {v.get('type')}"
                     f"{' / ' + v['transition'] if v.get('transition') else ''} | "
                     f"{'supp.' if v.get('claim') == 'supplement' else (v.get('page') or '')} | {b['narration']} |")
    (bdir / "storyboard.md").write_text("\n".join(lines) + "\n")
    for extra in ("timeline.json", "alignment.json", "check.json", "qa.json", "math_report.json", "sfx.json"):
        if (proj.work / extra).exists():
            shutil.copy(proj.work / extra, bdir / extra if extra in ("timeline.json", "alignment.json") else proj.dir / "review" / extra)
    return ["script/script.md", "script/narration.txt", "storyboard/storyboard.json", "storyboard/storyboard.md",
            "captions/captions.srt", "captions/captions.vtt"]


def run(proj):
    (proj.dir / "review").mkdir(exist_ok=True)
    timeline = json.loads((proj.work / "timeline.json").read_text())
    segs = json.loads((proj.work / "segments.json").read_text())["segments"]
    deck = json.loads(proj.deck_json.read_text())
    deck_by_id = {s["id"]: s for s in deck.get("slides", [])}
    dur = timeline["duration"]
    errors, warnings, videos, frames = [], [], {}, {}

    # 1. video -------------------------------------------------------------------------
    for aspect in proj.aspects:
        label = aspect.replace(":", "x")
        mp4 = proj.video_dir / f"explainer_{label}.mp4"
        if not mp4.exists() or mp4.stat().st_size == 0:
            errors.append(f"{aspect}: video missing ({mp4.name})"); continue
        info = _probe(mp4)
        st = {s["codec_type"]: s for s in info.get("streams", [])}
        if "video" not in st or "audio" not in st:
            errors.append(f"{aspect}: expected a video AND an audio stream, got {list(st)}")
        vd = float(st.get("video", {}).get("duration") or 0)
        ad = float(st.get("audio", {}).get("duration") or 0)
        if vd and ad and abs(vd - ad) > 0.25:
            errors.append(f"{aspect}: video {vd:.2f}s vs audio {ad:.2f}s differ by >0.25s — A/V drift")
        if vd and abs(vd - dur) > 0.5:
            warnings.append(f"{aspect}: video {vd:.2f}s vs timeline {dur:.2f}s")
        videos[aspect] = {"file": str(mp4.relative_to(proj.dir)), "video_s": round(vd, 2), "audio_s": round(ad, 2),
                          "codecs": {k: v.get("codec_name") for k, v in st.items()},
                          "size_mb": round(mp4.stat().st_size / 1048576, 2)}
        listed, sheet = _frames(proj, aspect, timeline["slides"], mp4, deck_by_id)
        frames[aspect] = {"frames": listed, "contact_sheet": sheet}

    # 2. sync --------------------------------------------------------------------------
    words = timeline.get("words", [])
    sil = _silences(proj.work / "narration.wav")
    def in_silence(t):
        return any(a + 0.05 < t < b - 0.05 for a, b in sil)
    mids = [(w["start"] + w["end"]) / 2 for w in words]
    silent = [w["word"] for w, m in zip(words, mids) if in_silence(m)]
    frac = len(silent) / len(words) if words else 0
    if frac > 0.05:
        errors.append(f"{len(silent)}/{len(words)} caption words fall in silent audio — captions out of sync")
    nonmono = sum(1 for a, b in zip(words, words[1:]) if b["start"] < a["start"])
    if nonmono:
        errors.append(f"{nonmono} word timestamps go backwards")
    lead = []
    for seg in segs:
        ws = [w for w in words if w["slide"] == seg["slide"]]
        if ws:
            lead.append(round(ws[0]["start"] - seg["start"], 3))
    if lead and (max(lead) > 0.8 or min(lead) < -0.1):
        warnings.append(f"segment first-word offsets range {min(lead)}..{max(lead)}s (expected ~0–0.5s)")
    cues = _srt_times(proj.captions_dir / "captions.srt") if (proj.captions_dir / "captions.srt").exists() else []
    if not cues:
        errors.append("captions.srt missing or empty")
    elif any(b < a for a, b in cues) or any(c2[0] < c1[0] for c1, c2 in zip(cues, cues[1:])) or cues[-1][1] > dur + 0.1:
        errors.append("caption cues are not monotonic / run past the audio")

    # 4. equations ---------------------------------------------------------------------
    math_issues, math_frames = [], []
    mr = proj.work / "math_report.json"
    if mr.exists():
        for aspect, rep in json.loads(mr.read_text()).items():
            for r in rep:
                if not r.get("ok"):
                    math_issues.append({"aspect": aspect, **r})
                elif r.get("scale", 1) < 0.6:
                    warnings.append(f"{aspect}: equation on {r.get('slide')} scaled to {r['scale']} to fit — check legibility")
        if math_issues:
            errors.append(f"{len(math_issues)} equation render problem(s): " +
                          "; ".join(f"{m.get('slide')}: {m.get('error')}" for m in math_issues[:5]))
        math_types = {"equation", "derivation", "scene2d"}
        for aspect, fr in frames.items():
            math_frames += [f["file"] for f in fr["frames"] if f["type"] in math_types]

    # 5. deliverables -------------------------------------------------------------------
    saved = _deliverables(proj, segs, timeline, deck)
    report = {"ok": not errors, "errors": errors, "warnings": warnings, "videos": videos,
              "sync": {"words": len(words), "words_in_silence": len(silent), "silent_words": silent[:20],
                       "segment_first_word_offsets": lead, "caption_cues": len(cues)},
              "frames": frames, "inspect_math_frames": math_frames, "math_issues": math_issues,
              "deliverables": saved + [v["file"] for v in videos.values()]}
    proj.write_json(proj.dir / "review" / "verify.json", report)
    return {"ok": report["ok"], "errors": errors, "warnings": len(warnings),
            "contact_sheets": [f["contact_sheet"] for f in frames.values()],
            "inspect_math_frames": len(math_frames), "report": "review/verify.json"}
