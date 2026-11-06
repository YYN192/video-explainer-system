"""Production profiles (PRD §19) — a named bundle of project.json defaults for a whole
*style* of video, applied at scaffold time. Like presets.py (platform) and themes.py
(look), a profile is plain data: every value lands in project.json and can be
overridden there or by an explicit scaffold flag. A project with no profile behaves
exactly as before.

The authoring rules for each style (pacing, hook, devices, tone) live in
skills/explainer/BRAINROT_STYLE.md and EDUCATIONAL_STYLE.md — this file only holds the
machine-readable defaults the media pipeline needs."""

PROFILES = {
    # TikTok-style study short: vertical, fast, dense, loud captions, SFX on every cut.
    "brainrot": {
        "aspect": "9:16",
        "theme": "brainrot",
        "voice": "am_puck",          # energetic male; af_bella is a good energetic alternative
        "speech_speed": 1.18,        # Kokoro speed multiplier (fast narration)
        "segment_gap": 0.05,         # near-zero breath between segments -> rapid cuts
        "min_length": 45, "max_length": 90,
        "caption_mode": "window", "caption_window": 2, "caption_style": "brainrot",
        "sfx": True,                 # original, procedurally generated SFX (sfx.py)
        "bg_fx": "procedural",       # original animated background (no footage needed)
        "safe_bottom": 0.20,
        "ambient": False,            # bg_fx replaces the ambient glow
        "target_wpm": 185,           # used by `explainer check` duration estimate
        "max_shot_s": 3.5,           # pacing gate in check/qa
    },
    # Lecture-quality lesson: landscape, measured, equations + diagrams, page references.
    "educational": {
        "aspect": "16:9",
        "theme": "lecture",
        "voice": "bm_george",        # calm British male; bf_emma / af_heart also fit
        "speech_speed": 0.97,
        "segment_gap": 0.30,
        "min_length": 240, "max_length": 480,
        "caption_mode": "window", "caption_window": 7, "caption_style": "lecture",
        "sfx": False,
        "bg_fx": None,
        "safe_bottom": 0.06,
        "ambient": True,
        "target_wpm": 158,        # measured: bm_george @0.97 incl. gaps
        "max_shot_s": 20.0,
    },
}

# Kokoro lang_code per supported narration language (Latin-script only: the MMS_FA
# aligner tokenizes romanized text). Voices must match the language's prefix letter.
LANGUAGES = {
    "en-us": {"kokoro": "a", "default_voice": "af_heart"},
    "en-gb": {"kokoro": "b", "default_voice": "bm_george"},
    "es":    {"kokoro": "e", "default_voice": "ef_dora"},
    "fr":    {"kokoro": "f", "default_voice": "ff_siwis"},
    "it":    {"kokoro": "i", "default_voice": "if_sara"},
    "pt-br": {"kokoro": "p", "default_voice": "pf_dora"},
}
LANGUAGE_ALIASES = {"en": "en-us", "pt": "pt-br"}


def resolve(name):
    return PROFILES.get(name)


def language(code):
    """Normalize a language code; returns (code, spec) or (None, None) if unsupported."""
    code = LANGUAGE_ALIASES.get((code or "en").lower(), (code or "en").lower())
    spec = LANGUAGES.get(code)
    return (code, spec) if spec else (None, None)


def parse_duration(spec):
    """'60' -> (60, 90)  ·  '45-90' -> (45, 90)  ·  '5m' / '4-8m' minutes supported."""
    s = str(spec).strip().lower()
    mult = 60 if s.endswith("m") else 1
    s = s.rstrip("ms")
    if "-" in s:
        a, b = s.split("-", 1)
        return int(float(a) * mult), int(float(b) * mult)
    v = int(float(s) * mult)
    return v, int(v * 1.5)
