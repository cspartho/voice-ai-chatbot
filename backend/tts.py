import base64
import io
import os
import re
import wave

from google.genai import types

from llm import get_client

_TTS_MODEL = os.getenv("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
_VOICE = os.getenv("GEMINI_TTS_VOICE", "Kore")

_DEFAULT_RATE = 24000  # Gemini TTS sample rate


def _pcm_to_wav(pcm: bytes, rate: int) -> bytes:
    """Wrap raw 16-bit mono PCM in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return buf.getvalue()


def synthesize(text: str) -> bytes:
    """Synthesize `text` to speech and return WAV bytes."""
    client = get_client()
    # Prefix with a directive so the model speaks the text verbatim instead of
    # trying to answer it. Gemini treats the part before the colon as an
    # instruction (not spoken), which avoids sporadic "should only be used for
    # TTS" errors on question-like replies.
    response = client.models.generate_content(
        model=_TTS_MODEL,
        contents=f"Say: {text}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=_VOICE)
                )
            ),
        ),
    )

    inline = response.candidates[0].content.parts[0].inline_data
    data = inline.data
    if isinstance(data, str):  # some transports return base64 text
        data = base64.b64decode(data)

    # Sample rate may be advertised in the mime type, e.g. "audio/L16;rate=24000".
    rate = _DEFAULT_RATE
    match = re.search(r"rate=(\d+)", inline.mime_type or "")
    if match:
        rate = int(match.group(1))

    return _pcm_to_wav(data, rate)
