"""SFX — original, procedurally generated sound effects (PRD §19). No samples, no
licensing: every sound is synthesized from sine sweeps + seeded noise with numpy, so the
same project always produces the same track. Used by the BRAINROT profile (project.json
`sfx: true`); mux mixes the track under the narration.

One effect is placed at each slide's start. The effect follows the slide's transition
(whip -> whoosh, drop -> boom, ...) unless the slide sets `"sfx": "<name>" | "none"`."""
import json
import numpy as np
import soundfile as sf

SR = 48000
KINDS = ("whoosh", "pop", "boom", "ding", "glitch", "tick")
BY_TRANSITION = {"whip": "whoosh", "slide": "whoosh", "spin": "whoosh", "wipe": "whoosh",
                 "zoom": "pop", "pop": "pop", "drop": "boom", "glitch": "glitch",
                 "rise": "tick", "fade": "tick"}
BY_TYPE = {"meme": "ding", "punch": "boom", "stat": "ding", "hook": "boom"}


def _env(n, attack, decay):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / max(decay, 1e-4))


def _chirp(f0, f1, dur):
    n = int(SR * dur)
    f = np.linspace(f0, f1, n)
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def _lowpass(x, alpha):
    """One-pole low-pass with a per-sample coefficient array (cheap sweeping filter)."""
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += alpha[i] * (x[i] - acc)
        y[i] = acc
    return y


def make(kind, seed=7):
    rng = np.random.default_rng(seed + KINDS.index(kind))
    if kind == "whoosh":
        n = int(SR * 0.38)
        noise = rng.standard_normal(n)
        sweep = np.concatenate([np.linspace(0.02, 0.35, n // 2), np.linspace(0.35, 0.03, n - n // 2)])
        x = _lowpass(noise, sweep) * np.hanning(n) * 2.2
    elif kind == "pop":
        x = _chirp(900, 180, 0.09) * _env(int(SR * 0.09), 0.002, 0.03)
    elif kind == "boom":
        n = int(SR * 0.55)
        x = _chirp(110, 38, 0.55) * _env(n, 0.003, 0.18)
        x[: int(SR * 0.01)] += rng.standard_normal(int(SR * 0.01)) * 0.5
    elif kind == "ding":
        n = int(SR * 0.7)
        t = np.arange(n) / SR
        x = (np.sin(2 * np.pi * 1320 * t) + 0.45 * np.sin(2 * np.pi * 2640 * t)
             + 0.2 * np.sin(2 * np.pi * 3960 * t)) * _env(n, 0.002, 0.2) * 0.6
    elif kind == "glitch":
        n = int(SR * 0.22)
        x = np.zeros(n)
        for k in range(6):  # stuttered, bit-crushed noise bursts
            a = int(n * k / 6)
            b = a + int(n / 10)
            x[a:b] = np.round(rng.standard_normal(b - a) * 3) / 3
        x *= 0.5
    elif kind == "tick":
        x = _chirp(2400, 1800, 0.03) * _env(int(SR * 0.03), 0.001, 0.008) * 0.6
    else:
        raise ValueError(kind)
    peak = float(np.max(np.abs(x))) or 1.0
    return (x / peak).astype(np.float32)


def build_track(proj, gain=None):
    """Write work/sfx.wav (48 kHz mono, narration length) and return its path, or None."""
    timeline = json.loads((proj.work / "timeline.json").read_text())
    deck = json.loads(proj.deck_json.read_text())
    by_id = {s["id"]: s for s in deck.get("slides", [])}
    gain = float(proj.data.get("sfx_gain", 0.32) if gain is None else gain)
    motion = proj.theme.get("motion", "rise")
    total = int(SR * timeline["duration"]) + SR
    track = np.zeros(total, np.float32)
    cache, placed = {}, []
    for i, win in enumerate(timeline["slides"]):
        s = by_id.get(win["id"], {})
        kind = s.get("sfx") or BY_TYPE.get(s.get("type")) or BY_TRANSITION.get(s.get("transition") or motion, "pop")
        if kind == "none" or kind not in KINDS:
            continue
        snd = cache.setdefault(kind, make(kind))
        # a whoosh peaks mid-sound: start it a little early so the peak lands on the cut
        at = max(0, int(SR * (win["start"] - (0.15 if kind == "whoosh" else 0.0))))
        end = min(total, at + len(snd))
        track[at:end] += snd[: end - at] * gain
        placed.append({"slide": win["id"], "t": round(win["start"], 3), "sfx": kind})
    track = np.clip(track, -1, 1)[: int(SR * timeline["duration"])]
    out = proj.work / "sfx.wav"
    sf.write(out, track, SR)
    proj.write_json(proj.work / "sfx.json", {"generator": "explainer procedural sfx (original, no samples)",
                                             "gain": gain, "events": placed})
    return out
