# EDUCATIONAL style — academic PDF → lecture-quality lesson

Profile: `--profile educational` · defaults in `src/explainer/profiles.py`. Read this file
before authoring an EDUCATIONAL run.

| setting | default | override |
|---|---|---|
| aspect | 16:9 (1920×1080) | `--aspect` |
| length | 4–8 min (240–480 s) | `--duration 5m` / `--duration 4-8m` |
| theme | `lecture` (slate "blackboard" + faint grid, Fraunces titles, Inter body) | `--theme` |
| voice / speed | `bm_george` @ 0.97× (calm, British) — `bf_emma`, `af_heart` also fit | `--voice`, `--speed` |
| gap between lines | 0.30 s | `segment_gap` |
| captions | quiet subtitle line, 7 words | `caption_window` |
| SFX / music | off | `"sfx": true`, `--music` |

## The rules

1. **Foundations → advanced.** Order the outline the way the source builds it: vocabulary →
   definitions → the governing equation → worked example → phenomenon → limits/extension.
   Never use a term before the slide that defines it.
2. **Reference the PDF on every factual slide.** Set `"claim": "source", "page": N` — the slide
   shows a *FROM THE TEXT · P. N* badge. Content that is *not* in the PDF (an analogy, a
   standard result you add, an everyday estimate) gets `"claim": "supplement"` and shows a
   dashed *SUPPLEMENTARY* badge, and the narration says so ("a helpful picture, beyond the
   text…"). Viewers must always be able to tell the source from your additions.
3. **Equations are preserved exactly.** Transcribe each formula from the page image (vision),
   not from extracted text (text extraction loses superscripts: `5 × 10−7`). Put it in
   `equations.json` with its page and crop, run `explainer eqsheet`, compare side by side, and
   only then set `"verified": true`. The deck may only show registry formulas, byte-for-byte.
4. **No invented derivations.** A `derivation` slide may only use steps that appear in the
   source (splitting one printed chain `a = b = c` into lines is fine; adding an algebra step
   is not). If the source skips a step, say so in narration; don't fill it in on screen.
5. **Explain every symbol.** Each `equation` slide carries a `symbols` legend (symbol, meaning,
   unit) whose rows are `cue`d to the narration word, so each one lights up as it is spoken.
6. **Step-by-step demonstrations** use `derivation` (cued line by line) and `scene2d`
   (animated diagrams: wavefronts, travelling waves, vectors). One visual idea per slide.
7. **Don't over-simplify.** Keep the source's precise wording for definitions (`define` uses
   the PDF's definition) and its conditions ("for sources in phase", "n is a whole number").
   Simplify the *delivery*, not the *physics*.
8. **Consistent typography + calm motion.** Stick to `fade · rise · wipe · pop`; one accent
   colour for "the thing being defined", `accent2` for contrast. No SFX, no flash cuts.
9. **Shots may breathe** (up to `max_shot_s` 20 s) but every slide still moves — cue reveals
   to the narration instead of holding a static frame.

## Narration voice

Teacher-to-student, complete sentences, measured. State conditions and units. Write maths as
speech ("v equals f lambda", "n plus a half wavelengths"). Signpost structure ("First…",
"Now…", "The text then goes beyond the syllabus").

## Device map

| lesson beat | device |
|---|---|
| motivating question | `hook` |
| term + definition (verbatim) | `define` |
| governing equation + symbol legend | `equation` |
| worked example / source derivation | `derivation` |
| phenomenon / mechanism | `scene2d` |
| properties that hold | `list` |
| scale comparison | `compare`, `statgrid` |
| analogy / supplementary idea | `statement` + `"claim": "supplement"` |
| source figure (when an exact figure matters) | `figure` (crop from `sources/*_figNN.png`) |
| recap | `payoff` |
