"""Speech-to-text using faster-whisper (CTranslate2).

The model is loaded lazily on first use so the server starts instantly and the
(potentially large) model download only happens when transcription is first
requested. faster-whisper decodes the audio with PyAV, so browser webm/opus
blobs work without a separate ffmpeg install.

Config via env vars:
  WHISPER_MODEL        model size/name        (default: "base")
  WHISPER_DEVICE       "cpu" | "cuda"         (default: "cpu")
  WHISPER_COMPUTE_TYPE compute type           (default: "int8")
"""

import os
import tempfile
import threading

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

from audio_cleanup import clean

SAMPLE_RATE = 16000  # Whisper's native rate

_MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

_model = None
_model_lock = threading.Lock()


def get_model() -> WhisperModel:
    """Return the shared WhisperModel, loading it on first call (thread-safe)."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = WhisperModel(
                    _MODEL_NAME, device=_DEVICE, compute_type=_COMPUTE_TYPE
                )
    return _model


def is_loaded() -> bool:
    """True once the model has finished loading."""
    return _model is not None


def transcribe_bytes(audio: bytes) -> dict:
    """Transcribe raw audio bytes (any ffmpeg-decodable container).

    Returns { text, language, language_probability, duration }.
    """
    model = get_model()

    # Decode from a temp file rather than an in-memory BytesIO. Browser
    # MediaRecorder webm/opus blobs have an "unknown" duration and no seek
    # index, which makes in-memory decoding fail with an ffmpeg EOF error
    # ([Errno 541478725]). A seekable file on disk decodes reliably.
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio)
        tmp_path = tmp.name

    try:
        # Decode to a 16 kHz mono waveform (PyAV under the hood — handles
        # webm/opus), then run local noise cleanup before transcription.
        waveform = decode_audio(tmp_path, sampling_rate=SAMPLE_RATE)
        waveform = clean(waveform, SAMPLE_RATE)

        # vad_filter runs Silero VAD to drop non-speech regions before
        # transcription — this removes background noise between words and cuts
        # down on noise-induced hallucinations (e.g. phantom "thank you"s).
        segments, info = model.transcribe(
            waveform,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        # `segments` is a generator — iterate to actually run inference.
        text = "".join(segment.text for segment in segments).strip()
        return {
            "text": text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
        }
    finally:
        os.remove(tmp_path)
