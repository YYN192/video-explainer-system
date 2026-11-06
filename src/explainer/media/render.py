"""RENDER — Playwright frame capture streamed DIRECTLY into ffmpeg via a pipe.

Memory- and disk-friendly: exactly one frame is in flight at a time, so RAM stays
flat regardless of video length, and no intermediate PNG frames are written to disk
(a 9-min 1080p deck is ~16k frames / tens of GB if materialized). Each aspect is
encoded to a video-only MP4 in work/; the mux stage adds audio with -c:v copy.

The browser page is recycled every `render_recycle_frames` frames so Chromium memory
can't creep up over a long (multi-hour) render. Deterministic: renderAt(t) per frame.
"""
import json, time, math, subprocess
from playwright.sync_api import sync_playwright


def _bg_video_path(proj):
    """Optional operator-supplied, licensed background footage (project.json `bg_video`)."""
    from pathlib import Path
    v = proj.data.get("bg_video")
    if not v:
        return None
    p = Path(v) if Path(v).is_absolute() else proj.dir / v
    if not p.exists():
        raise FileNotFoundError(f"bg_video not found: {p}")
    return p


def _ffmpeg_video_only(proj, label, fps, size=None, bg=None):
    """Start an ffmpeg that reads PNG frames from stdin and writes a video-only MP4.
    With `bg` (licensed footage), the frames are transparent PNGs composited OVER the
    footage, which is looped, cover-cropped to the aspect and stripped of its audio."""
    out = proj.work / f"video_{label}.mp4"
    log = open(proj.work / f"render_ffmpeg_{label}.log", "wb")
    if bg:
        w, h = size
        src = ["-stream_loop", "-1", "-i", str(bg),
               "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
               "-filter_complex",
               f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps},setsar=1[bg];"
               f"[bg][1:v]overlay=0:0:shortest=1,format=yuv420p[v]",
               "-map", "[v]", "-an"]
    else:
        src = ["-f", "image2pipe", "-framerate", str(fps), "-i", "-"]
    cmd = ["ffmpeg", "-hide_banner", "-y", *src,
           "-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
           "-color_range", "tv", "-movflags", "+faststart", str(out)]
    # stdout/stderr -> log file (never a pipe) so ffmpeg can't deadlock on a full buffer.
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log)
    return proc, log, out


def run(proj):
    timeline = json.loads((proj.work / "timeline.json").read_text())
    fps = proj.fps
    duration = timeline["duration"]
    total = math.ceil(duration * fps)
    deck_url = (proj.deck_dir / "index.html").as_uri()
    recycle = int(proj.data.get("render_recycle_frames", 3000))  # 0 disables page recycling

    bg = _bg_video_path(proj)
    results, math_reports = {}, {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--hide-scrollbars", "--disable-gpu"])
        for aspect in proj.aspects:
            w, h = proj.size_for(aspect)
            label = aspect.replace(":", "x")
            # drop any stale materialized frames from older renders (we no longer write them)
            fdir = proj.frames_dir(label)
            for f in fdir.glob("*.png"):
                f.unlink()

            def open_page():
                pg = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
                pg.goto(deck_url)
                pg.wait_for_function("window.__deckReady === true")
                pg.evaluate("tl => { window.TIMELINE = tl; }", timeline)
                return pg

            proc, log, out = _ffmpeg_video_only(proj, label, fps, size=(w, h), bg=bg)
            page = open_page()
            # equations are typeset at load; keep the engine's per-equation report for QA
            math_reports[aspect] = page.evaluate("window.__mathReport || []")
            cap_s = 0.0
            try:
                for i in range(total):
                    if recycle and i and i % recycle == 0:
                        page.close()
                        page = open_page()
                    page.evaluate("t => window.renderAt(t)", i / fps)
                    ts = time.time()
                    buf = page.screenshot(clip={"x": 0, "y": 0, "width": w, "height": h}, omit_background=bool(bg))
                    proc.stdin.write(buf)          # backpressure: blocks if ffmpeg is busy -> bounded RAM
                    cap_s += time.time() - ts
            finally:
                page.close()
                try:
                    proc.stdin.close()
                except BrokenPipeError:
                    pass
                rc = proc.wait()
                log.close()
            if rc != 0:
                tail = (proj.work / f"render_ffmpeg_{label}.log").read_text(errors="ignore")[-2000:]
                raise RuntimeError(f"ffmpeg render failed for {aspect} (exit {rc}):\n{tail}")

            results[aspect] = {"frames": total, "width": w, "height": h,
                               "video_only": str(out.relative_to(proj.dir)),
                               "capture_s": round(cap_s, 2),
                               "ms_per_frame": round(cap_s / total * 1000, 1) if total else 0,
                               "render_x_realtime": round(cap_s / duration, 2) if duration else 0}
        browser.close()

    proj.write_json(proj.work / "metrics_render.json", {"fps": fps, "aspects": results})
    if any(math_reports.values()):
        proj.write_json(proj.work / "math_report.json", math_reports)
    return {"aspects": list(results), **{f"{a}_xRT": results[a]["render_x_realtime"] for a in results}}
