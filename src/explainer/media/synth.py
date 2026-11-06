"""NARRATE — Kokoro TTS per segment -> loudness-normalized narration.wav + segments.json."""
import json, time, subprocess
import numpy as np
import soundfile as sf

SR = 24000      # Kokoro output sample rate
GAP = 0.18      # silence between segments (seconds)


def run(proj):
    if proj.voice_source == "operator":
        from . import voiceover
        return voiceover.run(proj)
    from .. import lexicon
    from .common import effective_segments
    script = json.loads(proj.script_json.read_text())
    lex = lexicon.load(proj.dir, (proj.brand or {}).get("lexicon"))
    from kokoro import KPipeline
    t0 = time.time()
    # PDF profiles (PRD §19): narration language, speed and inter-segment gap come from
    # project.json; absent -> the original defaults (American English, speed 1, 0.18 s).
    from ..profiles import language
    lang_code, lang = language(proj.data.get("language", "en-us"))
    if not lang:
        raise ValueError(f"unsupported narration language {proj.data.get('language')!r}")
    english = lang_code.startswith("en")
    speed = float(proj.data.get("speech_speed", 1.0))
    gap_s = float(proj.data.get("segment_gap", GAP))
    pipe = KPipeline(lang_code=lang["kokoro"], repo_id="hexgrad/Kokoro-82M")
    load_s = time.time() - t0

    segments = effective_segments(proj, script)

    gap = np.zeros(int(SR * gap_s), dtype=np.float32)
    full, segs, cursor, synth_s = [], [], 0.0, 0.0
    for seg in segments:
        ts = time.time()
        # expand acronyms for TTS only (the lexicon is English; other languages speak as written)
        spoken = lexicon.spoken_text(seg["text"], lex) if english else seg["text"]
        chunks = []
        for _, _, audio in pipe(spoken, voice=proj.voice, speed=speed):
            a = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
            chunks.append(a.astype(np.float32))
        synth_s += time.time() - ts
        seg_audio = np.concatenate(chunks) if chunks else np.zeros(1, np.float32)
        dur = len(seg_audio) / SR
        segs.append({"id": seg["id"], "slide": seg["slide"], "text": seg["text"],
                     "start": round(cursor, 4), "end": round(cursor + dur, 4)})
        full.append(seg_audio); full.append(gap); cursor += dur + gap_s

    narration = np.concatenate(full)
    raw = proj.work / "narration_raw.wav"
    sf.write(raw, narration, SR)
    out = proj.work / "narration.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-y", "-i", str(raw),
                    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), str(out)],
                   check=True, capture_output=True)

    dur_total = len(narration) / SR
    proj.write_json(proj.work / "segments.json",
                    {"sample_rate": SR, "duration": round(dur_total, 4), "segments": segs})
    metrics = {"kokoro_load_s": round(load_s, 2), "synth_s": round(synth_s, 2),
               "audio_duration_s": round(dur_total, 2),
               "rtf": round(synth_s / dur_total, 3) if dur_total else 0}
    proj.write_json(proj.work / "metrics_synth.json", metrics)
    return metrics
