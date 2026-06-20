const API_URL = import.meta.env.VITE_API_URL || '/api'


export async function transcribe(blob) {
  const form = new FormData()
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

async function errorDetail(res) {
  try {
    return (await res.json()).detail
  } catch {
    return ''
  }
}
