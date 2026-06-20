// HTTP client for the FastAPI backend.
// Step 2 wiring: POST the recorded audio to /transcribe and get the transcript.
// (LLM reply + TTS audio are added in later steps.)

// Same-origin by default: Vite (dev) and nginx (prod) both proxy /api -> backend.
// Override with VITE_API_URL to point at an absolute backend URL.
const API_URL = import.meta.env.VITE_API_URL || '/api'

// Send the recorded audio Blob to the Whisper endpoint.
// Resolves to { transcript, language, language_probability, duration }.
export async function transcribe(blob) {
  const form = new FormData()
  // A filename helps the server treat this as a proper file upload; Whisper
  // decodes by content, not extension, so webm/opus is fine.
  form.append('file', blob, 'recording.webm')

  let res
  try {
    res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form })
  } catch {
    throw new Error('Could not reach the server. Is the backend running?')
  }

  if (!res.ok) {
    throw new Error((await errorDetail(res)) || `Transcription failed (${res.status})`)
  }

  return res.json()
}

// Generate the agent's reply with Gemini.
// `history` is prior turns as [{ role: 'user'|'agent', text }], oldest first.
// Resolves to { reply }.
export async function chat(text, history = []) {
  let res
  try {
    res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, history }),
    })
  } catch {
    throw new Error('Could not reach the server. Is the backend running?')
  }

  if (!res.ok) {
    throw new Error((await errorDetail(res)) || `Chat failed (${res.status})`)
  }

  return res.json()
}

// Synthesize speech for `text` (Gemini TTS). Resolves to an object URL for a
// WAV blob that an <audio> element can play. Caller owns the URL (revoke it).
export async function synthesize(text) {
  let res
  try {
    res = await fetch(`${API_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch {
    throw new Error('Could not reach the server. Is the backend running?')
  }

  if (!res.ok) {
    throw new Error((await errorDetail(res)) || `Speech synthesis failed (${res.status})`)
  }

  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// Pull FastAPI's `detail` out of an error response, tolerating non-JSON bodies.
async function errorDetail(res) {
  try {
    return (await res.json()).detail
  } catch {
    return ''
  }
}
