# Voice Agent — Backend

FastAPI server providing a WebSocket the React frontend connects to.

## Setup

A virtualenv already exists at the project root (`../.venv`). Install deps into it:

```bash
# from the project root
.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
```

## Run

```bash
# from the backend/ folder
../.venv/Scripts/python.exe -m uvicorn main:app --reload --port 8000
```

- Health check: <http://127.0.0.1:8000/> → `{"status": "ok", ...}`
- WebSocket:   `ws://127.0.0.1:8000/ws`
- STT:         `POST /transcribe` (see below)
- Interactive docs: <http://127.0.0.1:8000/docs>

## Speech-to-text — `POST /transcribe` (Step 2)

Runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on an uploaded
audio file and returns the transcript. Accepts any ffmpeg-decodable container,
including the browser's `webm/opus` (decoded via PyAV — no separate ffmpeg
binary needed).

```bash
curl -F "file=@sample.wav" http://127.0.0.1:8000/transcribe
```

```json
{
  "transcript": "And so my fellow Americans, ask not what your country can do for you...",
  "language": "en",
  "language_probability": 0.96,
  "duration": 11.0,
  "filename": "sample.wav"
}
```

- The model is **preloaded at server startup** (in a background thread), so the
  first recording is fast. Watch `model_loaded` in the health response flip to
  `true` once it's ready. Set `WHISPER_PRELOAD=0` to disable and lazy-load on the
  first request instead.
- First boot ever still downloads the model (~140 MB for `base`); after that it
  loads from the local cache in a few seconds.
- Errors: empty upload → `400`; undecodable audio → `422`.

### Whisper config (env vars)

| Var                    | Default | Notes                                  |
| ---------------------- | ------- | -------------------------------------- |
| `WHISPER_MODEL`        | `base`  | `tiny`/`base`/`small`/`medium`/`large` |
| `WHISPER_DEVICE`       | `cpu`   | `cuda` if you have a GPU               |
| `WHISPER_COMPUTE_TYPE` | `int8`  | e.g. `float16` on GPU                  |

### Noise handling

Every upload is cleaned before transcription, in three layers:

1. **Browser** (capture-time) — `noiseSuppression` + `echoCancellation` +
   `autoGainControl` via `getUserMedia` (frontend).
2. **Local DSP** (`audio_cleanup.py`) — 80 Hz high-pass to strip hum/rumble,
   then RMS normalization to −16 dBFS. Runs on the decoded waveform (NumPy +
   SciPy). _Silence trimming was deliberately left out: it dropped words on
   clean audio and Whisper's VAD already handles non-speech._
3. **Whisper VAD** — `vad_filter=True` (Silero) drops non-speech segments and
   reduces noise-induced hallucinations.

Verified: a hum+hiss-corrupted clip transcribes identically to the clean
original, with no regression on the clean clip.

## Agent replies — `POST /chat` (Step 3, Gemini)

Generates the agent's reply with Google Gemini (`google-genai` SDK). Requires a
`GEMINI_API_KEY` in `backend/.env` (free key: <https://aistudio.google.com/app/apikey>).

```bash
curl -X POST http://127.0.0.1:8000/chat \
     -H "Content-Type: application/json" \
     -d '{"text": "What is the capital of France?"}'
# -> {"reply": "Paris is the capital of France."}
```

Multi-turn — pass prior turns as `history` (oldest first) for context:

```json
{
  "text": "What did I just ask about?",
  "history": [
    { "role": "user",  "text": "My favorite color is teal." },
    { "role": "agent", "text": "Teal is a lovely choice!" }
  ]
}
```

- Replies are kept short/plain (system prompt) since they'll be spoken aloud.
- Errors: empty message → `400`; missing key → `503` (actionable); upstream LLM
  failure → `502`.

### Gemini config (env vars, from `.env`)

| Var              | Default            | Notes                          |
| ---------------- | ------------------ | ------------------------------ |
| `GEMINI_API_KEY` | _(required)_       | from Google AI Studio          |
| `GEMINI_MODEL`   | `gemini-2.5-flash` | any Gemini model id            |

## Spoken replies — `POST /tts` (Step 4, Gemini TTS)

Synthesizes speech for the reply text and returns a **WAV** file. Uses the same
Gemini key.

```bash
curl -X POST http://127.0.0.1:8000/tts \
     -H "Content-Type: application/json" \
     -d '{"text": "Hello there!"}' --output reply.wav
```

- Gemini TTS emits raw PCM (16-bit mono, 24 kHz); the server wraps it in a WAV
  container so browsers can play it.
- The reply is prefixed with a `Say:` directive internally so the TTS model
  speaks the text verbatim instead of trying to answer it.
- Errors: empty text → `400`; missing key → `503`; upstream failure → `502`.

| Var                | Default                        | Notes                    |
| ------------------ | ------------------------------ | ------------------------ |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | TTS model id             |
| `GEMINI_TTS_VOICE` | `Kore`                         | any prebuilt Gemini voice |

## WebSocket contract (Step 1)

| Direction        | Frame              | Payload                                              |
| ---------------- | ------------------ | ---------------------------------------------------- |
| server → client  | JSON on connect    | `{ type: "ready" }`                                  |
| client → server  | binary             | the recorded audio blob                              |
| server → client  | JSON               | `{ type: "response", transcript, reply, audioUrl }` |
| client → server  | text               | any string (ping)                                    |
| server → client  | JSON               | `{ type: "echo", text }`                             |

> Transcription/reply/audio are still **mocked** in this step. Real STT → LLM →
> TTS replace the canned data in later steps.

The frontend points at `ws://127.0.0.1:8000/ws` by default; override with a
`VITE_WS_URL` env var (see `frontend/src/wsClient.js`).
