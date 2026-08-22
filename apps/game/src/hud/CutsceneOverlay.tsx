'use no memo'
import { useEffect, useRef, useState } from 'react'
import type { CinematicTextState, GameEngine } from '../engine/GameEngine.ts'

/*
 * The cutscene's screen-space layer: the blackout, the title cards, the
 * optional synced audio and the skip key.
 *
 * DOM rather than canvas because the reference's text behaviour is exactly
 * what DOM is good at — absolutely positioned lines, opacity fades, real
 * typefaces — and because the analysis pipeline measures titles by colour
 * masking a video capture, which cares nothing for how the pixels were made.
 *
 * `'use no memo'`: this component reads `engine.cinematic`, a stable
 * reference whose contents change every frame — the PerfPanel case exactly.
 * React renders only the *structure* (once per cutscene start/stop, at a slow
 * poll); the per-frame opacity and transform writes go straight to the DOM
 * nodes from a rAF loop, because 24-fps-timed fades re-rendered through React
 * at display rate would be all reconcile and no picture.
 */

/** The measured text colour: RGB ≈ (64,138,230); the logo runs deeper. */
const TEXT_BLUE = 'rgb(64,138,230)'
const LOGO_BLUE = 'rgb(24,120,215)'
const ACCENT_GOLD = 'rgb(216,180,90)'
const GLOW = '0 0 14px rgba(64,138,230,0.45)'

/** How closely the audio element tracks the reference clock, seconds. */
const AUDIO_TOLERANCE = 0.08

function textStyle(text: CinematicTextState): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: `${text.x * 100}%`,
    top: `${text.y * 100}%`,
    transform: 'translate(-50%, -50%)',
    whiteSpace: 'pre',
    opacity: 0,
    color: TEXT_BLUE,
    textShadow: GLOW,
    fontFamily: "'TNG Credits', ui-sans-serif, sans-serif",
    fontStyle: 'italic',
    lineHeight: 1,
  }
  switch (text.style) {
    case 'logo':
      return {
        ...base,
        fontFamily: "'TNG Title', ui-sans-serif, sans-serif",
        fontStyle: 'normal',
        fontSize: '15vh',
        letterSpacing: '0.04em',
        color: LOGO_BLUE,
        textShadow: '0 0 22px rgba(24,120,215,0.5)',
      }
    case 'subtitle':
      return { ...base, fontSize: '4.4vh', letterSpacing: '0.42em' }
    case 'name':
      // 5.6vh: matched against the reference dump — a name's cap height runs
      // a touch under 8% of the frame with its glow.
      return { ...base, fontSize: '5.6vh', letterSpacing: '0.2em' }
    case 'label':
      return { ...base, fontSize: '3vh', letterSpacing: '0.24em' }
    case 'card':
      // The display face, not the credits face: the opening and outro cards
      // are titles, and the project's own name should be set the way the
      // main logotype is.
      return {
        ...base,
        fontFamily: "'TNG Title', ui-sans-serif, sans-serif",
        fontStyle: 'normal',
        fontSize: '6vh',
        letterSpacing: '0.18em',
        color: LOGO_BLUE,
        textShadow: '0 0 18px rgba(24,120,215,0.5)',
      }
    case 'accent':
      return {
        ...base,
        fontSize: '5.1vh',
        letterSpacing: '0.2em',
        color: ACCENT_GOLD,
        textShadow: '0 0 14px rgba(216,180,90,0.4)',
      }
  }
}

export function CutsceneOverlay({ engine }: { engine: GameEngine }) {
  // Structure state only: which cutscene's text set is mounted. Polled slowly
  // — starting and stopping are human-rate events.
  const [texts, setTexts] = useState<readonly CinematicTextState[] | null>(null)
  /*
   * The transport's readout, at a human rate. The scrubber must not fight the
   * hand dragging it, so while `scrubbing` the poll leaves the input alone
   * and the drag drives the playhead instead.
   */
  const [transport, setTransport] = useState<{
    frame: number
    duration: number
    paused: boolean
  } | null>(null)
  const scrubbing = useRef(false)
  const blackout = useRef<HTMLDivElement>(null)
  const hint = useRef<HTMLDivElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const lines = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    const structure = window.setInterval(() => {
      const active = engine.cinematic
      setTexts((current) => {
        if (active === null) return current === null ? current : null
        // The text list is static for the life of a script; adopting the
        // array itself as the mounted structure makes "same cutscene" a
        // reference check.
        return current === null ? active.texts : current
      })
      const status = engine.harness.cutsceneStatus()
      if (status === null) setTransport(null)
      else if (!scrubbing.current) {
        setTransport({
          frame: status.frame,
          duration: status.durationFrames,
          paused: engine.world.clock.paused,
        })
      }
    }, 100)
    return () => window.clearInterval(structure)
  }, [engine])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && engine.cinematic !== null) {
        engine.harness.stopCutscene()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  /*
   * Adopt a local copy of the reference audio when one is present. The track
   * is copyrighted music and never ships in the repository — the path is
   * gitignored — so this probes rather than assumes, and the cutscene plays
   * silent when the file is absent. `engine.cutsceneAudio` stays writable
   * from the console for a differently named file.
   */
  useEffect(() => {
    if (engine.cutsceneAudio !== null) return
    let cancelled = false
    void fetch('/tng-intro.mp3', { method: 'HEAD' })
      .then((response) => {
        if (!cancelled && response.ok) engine.cutsceneAudio = '/tng-intro.mp3'
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [engine])

  // The per-frame writes. A rAF loop of its own rather than `useFrame`
  // because this component lives outside the canvas.
  useEffect(() => {
    let handle = 0
    const tick = (): void => {
      handle = window.requestAnimationFrame(tick)
      const view = engine.cinematic
      if (blackout.current !== null) {
        blackout.current.style.opacity =
          view === null ? '0' : String(view.effects.blackout)
      }
      if (hint.current !== null) {
        hint.current.style.opacity = view === null ? '0' : '1'
        if (view !== null) {
          hint.current.textContent = `f${Math.floor(view.frame)} · esc skips`
        }
      }
      for (const [id, node] of lines.current) {
        const state = view?.texts.find((text) => text.id === id)
        if (state === undefined) {
          node.style.opacity = '0'
          continue
        }
        node.style.opacity = String(state.opacity)
        node.style.transform = `translate(-50%, -50%) scale(${state.scale})`
      }

      // Audio: chase the reference clock, correct only outside lip-sync
      // tolerance — seeking every frame stutters the element.
      const element = audio.current
      if (element !== null) {
        if (view === null) {
          if (!element.paused) element.pause()
        } else {
          const status = engine.harness.cutsceneStatus()
          if (status !== null) {
            const target = view.frame / status.fps
            if (Math.abs(element.currentTime - target) > AUDIO_TOLERANCE) {
              element.currentTime = target
            }
            const paused = engine.world.clock.paused
            if (paused && !element.paused) element.pause()
            if (!paused && element.paused) void element.play().catch(() => {})
          }
        }
      }
    }
    handle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(handle)
  }, [engine])

  if (texts === null) return null

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The blackout sits over the scene and under the text: the opening
          card and the outro both put type over black. */}
      <div
        ref={blackout}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      {texts.map((text) => (
        <div
          key={text.id}
          ref={(node) => {
            if (node === null) lines.current.delete(text.id)
            else lines.current.set(text.id, node)
          }}
          style={textStyle(text)}
        >
          {text.text}
        </div>
      ))}
      <div
        ref={hint}
        className="absolute bottom-2 right-3 font-mono text-[10px] text-slate-500"
        style={{ opacity: 0 }}
      />

      {/* The transport: the one interactive island in an otherwise
          pointer-transparent layer. Same verbs as the console — pause,
          resume, seek, stop — so anything done here is reproducible there. */}
      {transport !== null && (
        <div className="pointer-events-auto absolute bottom-5 left-1/2 flex w-[34rem] max-w-[80vw] -translate-x-1/2 items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-950/70 px-3 py-1.5 font-mono text-[11px] text-slate-300 backdrop-blur">
          <TransportButton
            label="⟲"
            title="Restart"
            onClick={() => engine.harness.seekCutscene(0)}
          />
          <TransportButton
            label={transport.paused ? '▶' : '❚❚'}
            title={transport.paused ? 'Play' : 'Pause'}
            onClick={() => {
              if (engine.world.clock.paused) engine.harness.resume()
              else engine.harness.pause()
            }}
          />
          <TransportButton
            label="✕"
            title="Stop and restore the ship (Esc)"
            onClick={() => engine.harness.stopCutscene()}
          />
          <input
            type="range"
            min={0}
            max={transport.duration - 1}
            step={1}
            // While the hand is on the slider the poll stays out of it; the
            // key prop trick is unnecessary because we only set `value` from
            // state when not scrubbing.
            value={Math.floor(transport.frame)}
            onPointerDown={() => {
              scrubbing.current = true
            }}
            onPointerUp={() => {
              scrubbing.current = false
            }}
            onChange={(event) => {
              const frame = Number(event.target.value)
              engine.harness.seekCutscene(frame)
              setTransport((current) =>
                current === null ? current : { ...current, frame },
              )
            }}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-sky-400"
          />
          <span className="w-16 shrink-0 text-right tabular-nums text-slate-400">
            f{Math.floor(transport.frame)}
          </span>
        </div>
      )}
      {engine.cutsceneAudio !== null && (
        // Muted autoplay rules do not apply: playback starts from a user
        // gesture (the dock button or a console call), so the element may
        // sound. The file is user-supplied and never checked in.
        <audio ref={audio} src={engine.cutsceneAudio} preload="auto" />
      )}
    </div>
  )
}

function TransportButton({
  label,
  title,
  onClick,
}: {
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.currentTarget.blur()
        onClick()
      }}
      className="rounded border border-slate-700/60 px-2 py-0.5 hover:bg-slate-800/60"
    >
      {label}
    </button>
  )
}
