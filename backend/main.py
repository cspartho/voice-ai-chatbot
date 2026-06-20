import asyncio
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

# Load backend/.env before importing modules that read env at import time.
load_dotenv()

from fastapi import FastAPI, File, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from llm import generate_reply
from stt import get_model, is_loaded, transcribe_bytes
from tts import synthesize


PRELOAD = os.getenv("WHISPER_PRELOAD", "1").lower() not in ("0", "false", "no")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if PRELOAD:
        asyncio.create_task(asyncio.to_thread(get_model))
    yield


app = FastAPI(title="Voice Agent Backend", lifespan=lifespan)

_origins = os.getenv("ALLOWED_ORIGINS", "*").strip()
_allow_origins = ["*"] if _origins == "*" else [o.strip() for o in _origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


SAMPLE_AUDIO = [
    "https://samplelib.com/lib/preview/mp3/sample-3s.mp3",
    "https://samplelib.com/lib/preview/mp3/sample-6s.mp3",
    "https://samplelib.com/lib/preview/mp3/sample-9s.mp3",
]

# Canned (transcript, reply) pairs — fake STT + agent answer, rotated so
# repeated recordings feel varied.
CANNED = [
    {
        "transcript": "What's the weather like in Tokyo today?",
        "reply": "It's currently 24°C and partly cloudy in Tokyo, with a light breeze from the east.",
    },
    {
        "transcript": "Remind me to call the dentist tomorrow morning.",
        "reply": "Done — I've set a reminder to call the dentist tomorrow at 9 AM.",
    },
    {
        "transcript": "How long does it take to boil an egg?",
        "reply": "About 6 to 7 minutes for a firm yolk once the water is at a rolling boil.",
    },
    {
        "transcript": "Play some focus music.",
        "reply": "Starting a focus playlist for you now. Let me know if you want it louder.",
    },
]


@app.get("/")
async def health():
    """Simple health check so you can confirm the server is up in a browser."""
    return {
        "status": "ok",
        "service": "voice-agent-backend",
        "model_loaded": is_loaded(),
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Run Whisper on an uploaded audio file and return the transcript.

    Test with curl:
        curl -F "file=@sample.wav" http://127.0.0.1:8000/transcribe
    """
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="Empty audio upload")

    try:
        # Whisper inference is CPU-bound and blocking; run it off the event loop
        # so the server stays responsive.
        result = await asyncio.to_thread(transcribe_bytes, audio)
    except Exception as exc:  # noqa: BLE001 - surface decode/inference failures
        raise HTTPException(
            status_code=422, detail=f"Could not transcribe audio: {exc}"
        ) from exc

    return {
        "transcript": result["text"],
        "language": result["language"],
        "language_probability": result["language_probability"],
        "duration": result["duration"],
        "filename": file.filename,
    }


class ChatTurn(BaseModel):
    role: str  # "user" | "agent"
    text: str


class ChatRequest(BaseModel):
    text: str
    history: list[ChatTurn] = []


@app.post("/chat")
async def chat(req: ChatRequest):
    """Generate the agent's reply to a (transcribed) message with Gemini.

    Test with curl:
        curl -X POST http://127.0.0.1:8000/chat \\
             -H "Content-Type: application/json" \\
             -d '{"text": "What is the capital of France?"}'
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty message")

    history = [turn.model_dump() for turn in req.history]
    try:
        # The Gemini call is blocking network I/O; keep it off the event loop.
        reply = await asyncio.to_thread(generate_reply, req.text, history)
    except RuntimeError as exc:
        # Misconfiguration (e.g. missing API key) — make it actionable.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface upstream LLM errors
        raise HTTPException(status_code=502, detail=f"LLM error: {exc}") from exc

    return {"reply": reply}


class TTSRequest(BaseModel):
    text: str


@app.post("/tts")
async def tts(req: TTSRequest):
    """Synthesize speech for `text` with Gemini TTS; returns a WAV file.

    Test with curl:
        curl -X POST http://127.0.0.1:8000/tts \\
             -H "Content-Type: application/json" \\
             -d '{"text": "Hello there!"}' --output reply.wav
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty text")

    try:
        # Blocking network I/O — keep it off the event loop.
        wav = await asyncio.to_thread(synthesize, req.text)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface upstream TTS errors
        raise HTTPException(status_code=502, detail=f"TTS error: {exc}") from exc

    return Response(content=wav, media_type="audio/wav")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    # Greet the client so the frontend can confirm the channel is open.
    await websocket.send_json({"type": "ready", "message": "connected"})

    count = 0
    try:
        while True:
            message = await websocket.receive()

            # Starlette delivers a disconnect as a control message here.
            if message["type"] == "websocket.disconnect":
                break

            audio = message.get("bytes")
            text = message.get("text")

            if audio is not None:
                # Pretend to transcribe + think. Real pipeline replaces this.
                await asyncio.sleep(1.0)
                canned = CANNED[count % len(CANNED)]
                clip = SAMPLE_AUDIO[count % len(SAMPLE_AUDIO)]
                count += 1
                await websocket.send_json(
                    {
                        "type": "response",
                        "transcript": canned["transcript"],
                        "reply": canned["reply"],
                        "audioUrl": clip,
                        "bytes": len(audio),
                    }
                )
            elif text is not None:
                # Echo text frames so two-way flow is easy to verify.
                await websocket.send_json({"type": "echo", "text": text})
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
