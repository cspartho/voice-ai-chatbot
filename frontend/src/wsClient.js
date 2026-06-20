// Real backend client — talks to the FastAPI WebSocket at /ws.
// Replaces the old mockApi.js. transcribe(blob) keeps the same contract the UI
// depends on: a Promise resolving to { transcript, reply, audioUrl }.
//
// Recordings happen one at a time (the mic button is disabled while
// processing), so a simple FIFO queue of pending resolvers is enough to match
// each "response" frame to the request that triggered it.

// Same-origin by default (Vite/nginx proxy /ws -> backend). Override with VITE_WS_URL.
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

let socket = null
const pending = [] // [{ resolve, reject }] awaiting a "response" frame

function connect() {
  const ws = new WebSocket(WS_URL)
  ws.binaryType = 'arraybuffer'

  ws.onmessage = (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return // ignore non-JSON frames
    }
    // The connect greeting / echoes aren't request responses.
    if (data.type !== 'response') return
    const waiter = pending.shift()
    waiter?.resolve(data)
  }

  // If the socket drops, fail any in-flight requests and reset so the next
  // call reconnects.
  const fail = () => {
    while (pending.length) pending.shift().reject(new Error('Connection lost'))
    if (socket === ws) socket = null
  }
  ws.onclose = fail
  ws.onerror = fail

  return ws
}

function ensureSocket() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return socket
  }
  socket = connect()
  return socket
}

// Send the recorded audio Blob to the backend and resolve with its response.
export function transcribe(blob) {
  return new Promise((resolve, reject) => {
    const ws = ensureSocket()
    pending.push({ resolve, reject })

    const send = () => ws.send(blob)
    if (ws.readyState === WebSocket.OPEN) {
      send()
    } else {
      ws.addEventListener('open', send, { once: true })
      ws.addEventListener(
        'error',
        () => reject(new Error('Could not reach the server')),
        { once: true },
      )
    }
  })
}
