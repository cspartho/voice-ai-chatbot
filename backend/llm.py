"""LLM reply generation with Google Gemini (google-genai SDK).

Takes the user's (transcribed) message plus recent conversation history and
returns the agent's reply. Replies are kept short and plain since they'll be
spoken aloud (TTS) in a later step.

Config via env (loaded from backend/.env):
  GEMINI_API_KEY   required — https://aistudio.google.com/app/apikey
  GEMINI_MODEL     optional — defaults to "gemini-2.5-flash"
"""

import os
import threading

from google import genai
from google.genai import types

_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

SYSTEM_PROMPT = (
    "You are a friendly, helpful voice assistant. Your replies are spoken aloud, "
    "so keep them concise and conversational — usually one to three sentences. "
    "Do not use markdown, bullet points, headings, or code blocks; just plain "
    "spoken language. If you don't know something, say so briefly."
)

_client = None
_client_lock = threading.Lock()


def get_client() -> genai.Client:
    """Return a shared Gemini client, created on first use (thread-safe)."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                api_key = os.getenv("GEMINI_API_KEY")
                if not api_key:
                    raise RuntimeError(
                        "GEMINI_API_KEY is not set. Add it to backend/.env "
                        "and restart the server."
                    )
                _client = genai.Client(api_key=api_key)
    return _client


def generate_reply(text: str, history: list[dict] | None = None) -> str:
    """Generate the agent's reply.

    `history` is a list of prior turns as {"role": "user"|"agent", "text": str},
    oldest first. The current user `text` is appended as the latest turn.
    """
    client = get_client()

    contents: list[types.Content] = []
    for turn in history or []:
        role = "user" if turn.get("role") == "user" else "model"
        content = turn.get("text", "")
        if content:
            contents.append(
                types.Content(role=role, parts=[types.Part(text=content)])
            )
    contents.append(types.Content(role="user", parts=[types.Part(text=text)]))

    response = client.models.generate_content(
        model=_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT),
    )
    return (response.text or "").strip()
