// Phase 4 — Microphone Capture
// Wires the idle/recording/processing machine to real audio:
//   idle --click--> getUserMedia + MediaRecorder.start()  (recording)
//   recording --click--> MediaRecorder.stop()             (processing)
//   on 'stop' event: assemble Blob -> append to transcript -> back to idle
// There is no backend yet, so "processing" produces a stubbed agent reply.
// Transcription + a real response are added in a later phase.

import { useEffect, useRef, useState } from 'react'
import { transcribe, chat, synthesize } from './api'

// Per-state presentation. Keyed by the machine state so the button stays declarative.
const STATE_CONFIG = {
  idle: {
    status: 'Hold to talk',
    label: 'Hold to record',
    button: 'bg-gradient-to-br from-indigo-500 to-fuchsia-600 shadow-indigo-900/50',
  },
  recording: {
    status: 'Recording...',
    label: 'Release to stop',
    button: 'bg-gradient-to-br from-rose-500 to-red-600 shadow-red-900/50',
  },
  processing: {
    status: 'Processing...',
    label: 'Processing, please wait',
    button: 'bg-slate-700 shadow-black/40 cursor-not-allowed',
  },
}

let nextId = 1

// Monotonic clock, isolated at module scope so the in-component code stays pure
// (the purity lint rule flags direct performance.now()/Date.now() calls).
const now = () => performance.now()

function MicIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

// Solid square — the universal "stop" affordance shown while recording.
function StopIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function Spinner({ className }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  )
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Live circular waveform drawn around the mic button while recording.
// Reads the AnalyserNode's time-domain data each frame and maps amplitude to
// the radius of a ring of points. Renders nothing (and runs no RAF loop) unless
// `active`, so it costs nothing when idle.
function MicWaveform({ analyserRef, active }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(null)

  useEffect(() => {
    const analyser = analyserRef.current
    const canvas = canvasRef.current
    if (!active || !analyser || !canvas) return

    const ctx = canvas.getContext('2d')
    const size = 160
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const samples = analyser.fftSize
    const data = new Uint8Array(samples)
    const cx = size / 2
    const cy = size / 2
    const points = 72

    const draw = () => {
      analyser.getByteTimeDomainData(data)
      ctx.clearRect(0, 0, size, size)
      ctx.beginPath()
      for (let i = 0; i <= points; i++) {
        const idx = Math.floor((i / points) * (samples - 1))
        const amp = Math.abs((data[idx] - 128) / 128) // 0..1
        const radius = 50 + amp * 24
        const angle = (i / points) * Math.PI * 2 - Math.PI / 2
        const x = cx + Math.cos(angle) * radius
        const y = cy + Math.sin(angle) * radius
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.strokeStyle = 'rgba(251, 113, 133, 0.75)' // rose-400
      ctx.lineWidth = 2.5
      ctx.lineJoin = 'round'
      ctx.stroke()
      rafRef.current = requestAnimationFrame(draw)
    }
    draw()

    return () => cancelAnimationFrame(rafRef.current)
  }, [active, analyserRef])

  if (!active) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width: 160, height: 160 }}
    />
  )
}

// "Agent is thinking" bubble — three dots bouncing with staggered delays.
function TypingIndicator() {
  return (
    <div className="flex animate-fade-in-up justify-start" aria-live="polite">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-slate-800 px-4 py-3.5">
        <span className="sr-only">Agent is thinking…</span>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

function PlayIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PauseIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

const BAR_COUNT = 36

// Deterministic per-message bar heights (0.2–1.0) so the waveform is stable
// across renders without needing the real audio's amplitude data.
function barHeights(seed) {
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const v = Math.abs(Math.sin((i + 1) * (seed * 0.6 + 1.7)))
    return 0.2 + v * 0.8
  })
}

// WhatsApp-style voice note: round play/pause button + clickable waveform +
// timer. Wraps a hidden <audio> element driven imperatively via a ref.
function VoiceNote({ src, seed, variant, autoPlay = false }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  const isUser = variant === 'user'
  const bars = barHeights(seed)

  // Auto-play once on mount (used for the agent's spoken reply). Browsers may
  // block autoplay; if so it silently stays paused and the user can hit play.
  useEffect(() => {
    if (!autoPlay) return
    audioRef.current?.play().catch(() => {})
    // Mount-only: deliberately not depending on autoPlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return

    const onTime = () => setCurrent(a.currentTime || 0)
    const onPlay = () => {
      setPlaying(true)
      // Only one voice note plays at a time — pause every other one.
      document.querySelectorAll('audio[data-voice-note]').forEach((el) => {
        if (el !== a) el.pause()
      })
    }
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      setCurrent(0)
      a.currentTime = 0
    }
    const onLoaded = () => {
      // MediaRecorder/webm blobs often report duration=Infinity until seeked;
      // nudge to the end once to force the real duration, then rewind.
      if (a.duration === Infinity || Number.isNaN(a.duration)) {
        const fix = () => {
          a.removeEventListener('timeupdate', fix)
          if (a.duration !== Infinity && !Number.isNaN(a.duration)) {
            setDuration(a.duration)
          }
          a.currentTime = 0
        }
        a.addEventListener('timeupdate', fix)
        a.currentTime = 1e101
      } else {
        setDuration(a.duration)
      }
    }

    a.addEventListener('timeupdate', onTime)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnded)
    a.addEventListener('loadedmetadata', onLoaded)
    if (a.readyState >= 1) onLoaded()

    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [src])

  function toggle() {
    const a = audioRef.current
    if (!a) return
    if (playing) a.pause()
    else a.play()
  }

  function seek(e) {
    const a = audioRef.current
    if (!a || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    a.currentTime = ratio * duration
    setCurrent(a.currentTime)
  }

  const playedRatio = duration ? current / duration : 0
  const timeLabel = formatDuration(playing || current ? current : duration)

  // Palette per bubble background.
  const theme = isUser
    ? {
        btn: 'bg-white text-indigo-600',
        played: 'bg-white',
        track: 'bg-indigo-300/50',
        time: 'text-indigo-100',
      }
    : {
        btn: 'bg-indigo-500 text-white',
        played: 'bg-indigo-400',
        track: 'bg-slate-500/50',
        time: 'text-slate-400',
      }

  return (
    <div className="mt-2 flex w-full max-w-[280px] items-center gap-3">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        data-voice-note
        className="hidden"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-sm transition-transform active:scale-90 ${theme.btn}`}
      >
        {playing ? (
          <PauseIcon className="h-5 w-5" />
        ) : (
          <PlayIcon className="ml-0.5 h-5 w-5" />
        )}
      </button>

      <div className="flex flex-1 flex-col gap-1">
        <div
          onClick={seek}
          className="flex h-7 cursor-pointer items-center gap-[2px]"
        >
          {bars.map((h, i) => {
            const played = i / BAR_COUNT <= playedRatio
            return (
              <span
                key={i}
                className={`w-[3px] shrink-0 rounded-full transition-colors ${
                  played ? theme.played : theme.track
                }`}
                style={{ height: `${Math.round(h * 100)}%` }}
              />
            )
          })}
        </div>
        <span className={`text-[11px] tabular-nums ${theme.time}`}>
          {timeLabel}
        </span>
      </div>
    </div>
  )
}

function Bubble({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex animate-fade-in-up ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:text-base',
          isUser
            ? 'rounded-br-md bg-indigo-600 text-white'
            : 'rounded-bl-md bg-slate-800 text-slate-100',
        ].join(' ')}
      >
        <span
          className={`mb-0.5 block text-[11px] font-medium uppercase tracking-wide ${
            isUser ? 'text-indigo-200' : 'text-slate-400'
          }`}
        >
          {isUser ? 'You' : 'Agent'}
        </span>
        {message.text}
        {message.audioUrl && (
          <VoiceNote
            src={message.audioUrl}
            seed={message.id}
            variant={message.role}
            autoPlay={message.autoPlay}
          />
        )}
      </div>
    </div>
  )
}

export default function App() {
  // The single source of truth for the UI: 'idle' | 'recording' | 'processing'.
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const [messages, setMessages] = useState([])
  const [elapsed, setElapsed] = useState(0)

  // Latest messages, readable synchronously inside async handlers (the closure's
  // `messages` would be stale) — used to build the chat history.
  const messagesRef = useRef([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Mutable recording resources kept in refs so re-renders don't recreate them.
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const startTimeRef = useRef(0)
  const tickRef = useRef(null)
  const scrollRef = useRef(null)
  // Web Audio graph for the live waveform (separate from the MediaRecorder).
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  // Push-to-talk: true while the mic button is held down.
  const heldRef = useRef(false)

  // Auto-scroll the transcript to the newest message.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, state])

  // Release the mic and any timers/object URLs on unmount.
  useEffect(() => {
    return () => {
      clearInterval(tickRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close()
      messages.forEach((m) => m.audioUrl && URL.revokeObjectURL(m.audioUrl))
    }
    // Run only on unmount; messages is read via closure intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stopMicTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  // Tear down the Web Audio graph used for the waveform.
  function teardownAudio() {
    analyserRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
  }

  async function startRecording() {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Audio recording is not supported in this browser.')
      return
    }

    try {
      // Ask the browser to clean up the mic input at capture time. These are
      // hints — supported browsers run hardware/software noise suppression,
      // echo cancellation, and auto gain before we ever see the audio.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream
      chunksRef.current = []

      // Web Audio graph feeding the live waveform. The analyser is a passive
      // tap — it is not connected to the destination, so there's no playback.
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      const audioCtx = new AudioCtx()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      audioCtxRef.current = audioCtx
      analyserRef.current = analyser

      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        })
        const userAudioUrl = URL.createObjectURL(blob)
        stopMicTracks()
        teardownAudio()
        handleRecordingComplete({ blob, userAudioUrl })
      }

      recorder.start()
      startTimeRef.current = now()
      setElapsed(0)
      tickRef.current = setInterval(() => {
        setElapsed((now() - startTimeRef.current) / 1000)
      }, 200)
      setState('recording')

      // The button may have been released while we were awaiting permission;
      // if so, stop immediately so a quick tap still ends the recording.
      if (!heldRef.current) stopRecording()
    } catch (err) {
      stopMicTracks()
      teardownAudio()
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
        setError('Microphone access was denied. Check your browser permissions.')
      } else if (err?.name === 'NotFoundError') {
        setError('No microphone was found.')
      } else {
        setError('Could not start recording. Please try again.')
      }
      setState('idle')
    }
  }

  function stopRecording() {
    clearInterval(tickRef.current)
    setState('processing')
    // The 'onstop' handler assembles the blob and advances the transcript.
    recorderRef.current?.stop()
  }

  // Called from recorder.onstop once we have the finished audio Blob.
  // 1) transcribe the audio (Whisper), 2) generate a reply (Gemini),
  // appending each turn to the transcript as it arrives.
  // (Spoken audio for the reply — TTS — arrives in a later step.)
  async function handleRecordingComplete({ blob, userAudioUrl }) {
    try {
      // Conversation so far, before this turn — used as chat context.
      const history = messagesRef.current.map((m) => ({
        role: m.role,
        text: m.text,
      }))

      const { transcript } = await transcribe(blob)
      const userText = transcript?.trim() || '(no speech detected)'
      setMessages((prev) => [
        ...prev,
        { id: nextId++, role: 'user', text: userText, audioUrl: userAudioUrl },
      ])

      // Show the reply text right away, then attach spoken audio when ready.
      const { reply } = await chat(userText, history)
      const agentId = nextId++
      setMessages((prev) => [...prev, { id: agentId, role: 'agent', text: reply }])

      // TTS is best-effort: if it fails, the text reply still stands.
      try {
        const audioUrl = await synthesize(reply)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentId ? { ...m, audioUrl, autoPlay: true } : m,
          ),
        )
      } catch (ttsErr) {
        setError(ttsErr?.message || 'Could not synthesize speech.')
      }
    } catch (err) {
      URL.revokeObjectURL(userAudioUrl)
      setError(err?.message || 'Something went wrong processing your audio.')
    } finally {
      setState('idle')
    }
  }

  // Push-to-talk: start on press, stop on release.
  function handlePressStart(e) {
    if (state !== 'idle') return
    // Capture the pointer so we still get the release event even if the finger
    // or cursor drifts off the button while held.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    heldRef.current = true
    startRecording()
  }

  function handlePressEnd() {
    if (!heldRef.current) return
    heldRef.current = false
    // Only stop if recording actually got going (ignores the permission race).
    if (recorderRef.current?.state === 'recording') stopRecording()
  }

  const config = STATE_CONFIG[state]
  const isRecording = state === 'recording'
  const isProcessing = state === 'processing'

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 p-4 sm:p-6">
      <main className="flex h-[88vh] max-h-[760px] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70 shadow-2xl shadow-black/40 backdrop-blur sm:max-w-lg">
        {/* Header */}
        <header className="border-b border-slate-800 px-6 py-5 text-center">
          <h1 className="text-lg font-semibold text-white sm:text-xl">
            Voice Agent
          </h1>
          <p className="mt-1 text-xs text-slate-400 sm:text-sm">
            Hold the mic and start talking
          </p>
        </header>

        {/* Transcript */}
        <section
          ref={scrollRef}
          className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6"
        >
          {messages.length === 0 && !isProcessing ? (
            <p className="mt-10 text-center text-sm text-slate-500">
              No messages yet — hold the mic to record your first one.
            </p>
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
          {/* Agent "thinking" indicator while the backend round-trips. */}
          {isProcessing && <TypingIndicator />}
        </section>

        {/* Controls */}
        <footer className="flex flex-col items-center gap-3 border-t border-slate-800 px-6 py-6">
          <div className="relative flex h-20 w-20 items-center justify-center">
            {/* Soft glow behind the button while recording (waveform on top). */}
            {isRecording && (
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-rose-500/30 blur-md" />
            )}
            <MicWaveform analyserRef={analyserRef} active={isRecording} />
            <button
              type="button"
              onPointerDown={handlePressStart}
              onPointerUp={handlePressEnd}
              onPointerCancel={handlePressEnd}
              onContextMenu={(e) => e.preventDefault()}
              disabled={isProcessing}
              aria-label={config.label}
              className={[
                'relative flex h-20 w-20 touch-none select-none items-center justify-center rounded-full text-white shadow-lg transition duration-300 ease-out focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/50',
                config.button,
                isProcessing ? '' : 'hover:scale-105 active:scale-95',
              ].join(' ')}
            >
              <span className="absolute inset-0 rounded-full ring-1 ring-white/20" />
              {isProcessing ? (
                <Spinner className="h-8 w-8" />
              ) : isRecording ? (
                <StopIcon className="h-8 w-8" />
              ) : (
                <MicIcon className="h-8 w-8" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-2" aria-live="polite">
            {isProcessing && <Spinner className="h-4 w-4 text-slate-400" />}
            <p className="text-sm font-medium text-slate-300 transition-colors duration-300">
              {isRecording ? `Recording... ${formatDuration(elapsed)}` : config.status}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="flex w-full items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
            >
              <svg
                className="mt-0.5 h-4 w-4 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                aria-label="Dismiss error"
                className="-mr-1 rounded px-1 text-rose-400 transition-colors hover:text-rose-200"
              >
                ✕
              </button>
            </div>
          )}
        </footer>
      </main>
    </div>
  )
}
