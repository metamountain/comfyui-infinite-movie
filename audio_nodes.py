"""Infinite Movie · Audio or Silence (2026-11-02, Nutzer: „node der zero audio produziert und vhs fixed“).

VHS Load Video liefert `audio` als LazyAudioMap (videohelpersuite/utils.py:250): der Ton wird erst beim ersten
Zugriff mit ffmpeg gelesen, und bei Filmen OHNE Tonspur wirft get_audio (utils.py:224) eine Exception -> der
ganze Workflow bricht ab. Dieser Node greift den Ton geschützt ab: vorhanden -> durchreichen, fehlt/kaputt ->
Stille in der Länge des Films (frame_count / fps oder seconds).
"""

from __future__ import annotations

import torch

SAMPLE_RATE = 44100


def silence(seconds: float, sample_rate: int = SAMPLE_RATE, channels: int = 2) -> dict:
    n = max(1, int(round(max(0.0, float(seconds)) * sample_rate)))
    return {"waveform": torch.zeros((1, channels, n), dtype=torch.float32), "sample_rate": int(sample_rate)}


def audio_or_none(audio):
    """Echter Ton oder None – fängt den Fehler der VHS-LazyAudioMap beim Zugriff ab."""
    if audio is None:
        return None
    try:
        wav = audio["waveform"]
        sr = int(audio["sample_rate"])
    except Exception as e:  # noqa: BLE001 – VHS: „failed to extract audio“ bei stummen Filmen
        print(f"[InfiniteMovie] Audio or Silence: kein Ton ({str(e).splitlines()[0][:120]}) -> Stille")
        return None
    if wav is None or wav.numel() == 0:
        return None
    return {"waveform": wav, "sample_rate": sr}


# 75: InfiniteMovieAudioOrSilence removed (not used by any workflow).
# silence() and audio_or_none() remain - used by chunk_upscale_nodes.py.

AUDIO_NODE_LIST = []
