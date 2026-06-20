"""Local audio preprocessing to improve Whisper accuracy on noisy input.

Pipeline (all local, no external services):
  1. High-pass filter  — remove low-frequency hum/rumble (mains hum, HVAC, etc.)
  2. Normalize loudness — bring quiet recordings up to a consistent target level
  3. Clip guard        — keep samples in [-1, 1]

Operates on a mono float32 waveform at a known sample rate (16 kHz — Whisper's
native rate, produced by faster_whisper.audio.decode_audio).

Note: we intentionally do NOT trim silence here — Whisper's built-in VAD filter
already drops non-speech, and an extra trim step measurably hurt accuracy on
clean audio (it dropped words) without helping noisy audio.
"""

import numpy as np
from scipy.signal import butter, sosfilt

# Tunables.
HIGHPASS_HZ = 80.0  # cut rumble/hum below speech fundamentals
TARGET_DBFS = -16.0  # normalization target (RMS), matches the article


def _highpass(y: np.ndarray, sr: int) -> np.ndarray:
    """4th-order Butterworth high-pass to strip low-frequency noise."""
    sos = butter(4, HIGHPASS_HZ, btype="highpass", fs=sr, output="sos")
    return sosfilt(sos, y).astype(np.float32)


def _normalize(y: np.ndarray) -> np.ndarray:
    """Scale to the target RMS loudness, then hard-clip to [-1, 1]."""
    rms = np.sqrt(np.mean(y**2) + 1e-12)
    if rms > 1e-6:
        target = 10 ** (TARGET_DBFS / 20)
        y = y * (target / rms)
    return np.clip(y, -1.0, 1.0).astype(np.float32)


def clean(y: np.ndarray, sr: int = 16000) -> np.ndarray:
    """Run the full cleanup pipeline on a mono float32 waveform."""
    if y is None or y.size == 0:
        return y
    y = _highpass(y, sr)
    y = _normalize(y)
    return y
