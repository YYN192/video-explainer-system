# PDF → video with `/explainer` (BRAINROT · EDUCATIONAL)

Turn a textbook chapter or paper into a narrated MP4, locally, on Apple Silicon. Two styles:

| | **BRAINROT** | **EDUCATIONAL** |
|---|---|---|
| for | TikTok/Reels/Shorts study clips | lesson videos, YouTube, class |
| format | 9:16, 45–90 s | 16:9, 4–8 min |
| feel | 2-second hook, cut every ~2 s, huge pop captions, memes, SFX, animated bg | calm narration, exact equations, step-by-step derivations, page badges |
| guide | [BRAINROT_STYLE.md](BRAINROT_STYLE.md) | [EDUCATIONAL_STYLE.md](EDUCATIONAL_STYLE.md) |

## Use it

In Claude Code:
```
/explainer ~/Documents/physics.pdf pages 12-15
```
Claude asks which style (if you didn't say), then does the rest. You can also say things like
*"brainrot, 60 seconds, British voice"* or *"educational, 5 minutes, pages 3–9, in Spanish"*.

Before rendering, you get `review/outline.md`: the storyboard, the full script, every equation
with its PDF page, and the words whose pronunciation is worth a listen (`review/pronunciation.wav`).
Ask for changes, and Claude edits and re-checks. Then it renders and inspects the frames.

## What you get (`outputs/<date>_<slug>/`)

- `video/explainer_9x16.mp4` or `explainer_16x9.mp4`: the finished video
- `script/script.md`, `script/narration.txt`: the narration with timings and page refs
- `storyboard/storyboard.md` + `.json`, `timeline.json`, `alignment.json`: the scene plan and word timings
- `captions/captions.srt` / `.vtt`
- `deck/index.html`: the same content as a standalone, openable animated deck
- `review/`: the outline, equation sheet, contact sheet, per-slide frames, `check.json`, `verify.json`
- `claims.json`, `equations.json`: every claim with its PDF quote/page, and every formula as verified

## How accuracy is enforced

- Every `source` claim carries a verbatim quote; the gate checks the quote is really on that page.
- Every formula on screen must be in `equations.json`, transcribed from a crop of the PDF and
  marked verified after a side-by-side check (`review/equations.png`). Derivations can't add steps.
- Anything not from the PDF is labelled *SUPPLEMENTARY* on screen.
- After rendering: A/V and caption sync, LaTeX render errors and off-screen equations are checked
  automatically, and Claude inspects one frame per slide from the final MP4.

## Options

`--profile` · `--duration 60|45-90|4-8m` · `--aspect` · `ingest --pages "12-15"` ·
`--language en-us|en-gb|es|fr|it|pt-br` · `--voice <kokoro voice>` · `--speed 1.2` ·
`--bg-video <licensed clip>` · `--music <licensed track>`.

Bulgarian narration isn't available (Kokoro has no Bulgarian voice). Bulgarian PDFs still work
as input, explained in one of the languages above.

## Licensing

Nothing copyrighted ships or is downloaded for visuals or audio. Backgrounds are generated, SFX are
synthesized, and memes are text + emoji formats. Gameplay footage or music is used **only** if you
pass a file you have the rights to.

## Dependencies

Nothing paid, nothing new to install. One vendored file: MathJax 3.2.2 (Apache-2.0,
`src/explainer/assets/mathjax/`). The first run downloads the existing pipeline's free model
weights: Kokoro-82M (~330 MB, HuggingFace), the MMS_FA aligner (~1.2 GB, pytorch.org) and
spaCy `en_core_web_sm` (~13 MB, installed into the venv by Kokoro).
