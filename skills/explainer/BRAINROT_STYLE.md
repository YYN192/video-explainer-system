# BRAINROT style — textbook → TikTok-style study short

Profile: `--profile brainrot` · defaults in `src/explainer/profiles.py`. Read this file before
authoring a BRAINROT run. It governs the **words and devices**; the profile governs the
**machine settings**.

| setting | default | override |
|---|---|---|
| aspect | 9:16 (1080×1920) | `--aspect` |
| length | 45–90 s | `--duration 60` / `--duration 45-90` |
| theme | `brainrot` (near-black, magenta + acid-lime, condensed black type) | `--theme` |
| voice / speed | `am_puck` @ 1.18× (energetic, fast) — `af_bella` also fits | `--voice`, `--speed` |
| gap between lines | 0.05 s (rapid cuts) | `segment_gap` in project.json |
| captions | 2 words at a time, huge, outlined, per-word pop | `caption_window`, `caption_style` |
| SFX | ON — original procedural whoosh/pop/boom/ding/glitch on every cut | `"sfx": false`; per slide `"sfx": "none"` |
| background | original animated geometry (`bg_fx: procedural`) | `--bg-video <licensed clip>` |
| music | none shipped | `--music <licensed track>` |

## The rules

1. **Hook in ≤ 2 s.** Segment 1 is ≤ 7 spoken words and lands the payoff or the paradox
   ("Sound bends round corners. Light refuses."). No "in this video", no title card. First
   slide is a hook-type device: `hook` · `punch` · `meme` · `stat` · `build` · `highlight` · `scene2d`.
2. **A cut every 1.5–3.5 s.** One idea per segment, 5–10 words. `explainer check` warns on any
   segment estimated over `max_shot_s` (3.5 s): split it into two slides.
3. **Density without confusion.** Fast ≠ vague. Every segment states one *checkable* fact from
   the PDF, and the **visual proves the line** (a diagram for a mechanism, a number for a
   quantity, a meme for a misconception). Never stack two new terms in one segment.
4. **5+ device types, no transition 3× in a row.** Rotate the energetic transitions
   `zoom · whip · glitch · spin · drop · pop · wipe`. The gate enforces both.
5. **Humour is a metaphor, not a substitute.** `meme` cards personify the concept ("Light at a
   doorway: nah, straight line only"), and the *next* slide gives the real physics. Absurd
   comparisons are fine; wrong physics is not.
6. **Animated diagrams for every mechanism** — `scene2d` with moving `wavefronts` / `wave`
   shapes beats any still image. Keep shapes few and thick (`width` 8–12) for phone screens.
7. **Units and symbols are sacred.** Display type is uppercase, but numbers, units and
   single-letter symbols are never case-transformed (the engine protects `stat`, `compare`,
   `define` and caption symbols — "3 m" must never read "3 M"). Don't put units inside
   `headline`/`punch`/`meme` text; use `stat`/`compare`/`equation`.
8. **Equations are allowed (and fun)** — one `equation` slide, symbol legend cued to the
   words. Same exactness rules as EDUCATIONAL: registry + `verified`.
9. **Close on a payoff, not a plea.** A callback to the hook ("Ears beat eyes at corners").

## Narration voice

Second person, present tense, punchy fragments ("Gap way wider than the wavelength? Barely any
spread."). Write maths as speech ("v equals f lambda", "five times ten to the minus seven
metres"). Avoid sarcasm that inverts facts — TTS can't do irony.

## Licensing (hard rules)

- **No unlicensed gameplay or music.** `--bg-video` / `--music` are for footage *you* own or
  hold a licence for (record the licence in `meta.json` → `sources`). The tool ships neither.
- Without footage, the original procedural background is used — it is generated, not copied.
- SFX are synthesized from sine sweeps and seeded noise (`media/sfx.py`) — no samples.
- Memes are **formats** (setup → reaction → punchline) with emoji; never third-party images or
  characters.

## Accuracy

BRAINROT is still a study video. Every factual line has an entry in `claims.json` (source quote
+ page, or `supplement`). Badges are optional in this profile (they add clutter at 9:16), but
the claims ledger is not: `explainer check` verifies every quote against the PDF.

## Device cheat-sheet (9:16)

| beat | device |
|---|---|
| paradox / hook | `hook`, `punch` |
| misconception, personified | `meme` |
| definition | `define` |
| mechanism | `scene2d` (`wavefronts`, `wave`, `arrow`) |
| one number | `stat` (keep the unit in `value`) |
| A vs B | `compare` |
| rule of thumb | `build`, `highlight` |
| "these don't change" | `list` |
| formula | `equation` |
| reframe the misconception | `reframe` |
