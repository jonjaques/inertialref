'use no memo'
import { useEffect, useRef, useState } from 'react'
import type { CinematicTextState, GameEngine } from '../engine/GameEngine.ts'
import { CutsceneTransport } from './CutsceneTransport.tsx'
import { labelStyle, textStyle } from './cutsceneText.ts'
import { useScrubber } from './useScrubber.ts'

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

/** How closely the audio element tracks the reference clock, seconds. */
const AUDIO_TOLERANCE = 0.08

export function CutsceneOverlay({
  engine,
  transport: showTransport = false,
}: {
  engine: GameEngine
  /**
   * Whether to draw the scrubber and the pause button.
   *
   * Off by default, because there are now two things that can put a transport
   * on screen — this and the cinema player — and two playheads a person can
   * disagree with is worse than none. `apps/game/src/App.tsx` turns it on with
   * the debug overlay, which is where a scrub-while-flying belongs; the cinema
   * mode has its own, with a timecode and a shareable link.
   */
  transport?: boolean
}) {
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
  // The drag latch and the guarded seek, shared with the cinema player's
  // transport — see `useScrubber.ts` for what each of them is for.
  const { held: scrubbing, grab, seek } = useScrubber(engine)
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
    // A ref, so it never changes identity — listed for the same reason the
    // cinema player's poll lists it.
  }, [engine, scrubbing])

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
        // Position every frame, not just opacity: the logotype's two words are
        // thrown in from opposite sides of the frame and shrink onto their
        // marks. Writing `left`/`top` alongside the transform keeps the scale
        // centred on the line while the line itself travels.
        node.style.left = `${state.x * 100}%`
        node.style.top = `${state.y * 100}%`
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
          {text.label !== undefined && (
            <div style={labelStyle(text)}>{text.label}</div>
          )}
          {text.text}
        </div>
      ))}
      {/* The frame counter and the skip hint ride the debug transport: the
          cinema player has its own timecode and its own way out, and a second
          frame number in the corner of every capture is exactly the chrome a
          scene is supposed to be free of. */}
      {showTransport && (
        <div
          ref={hint}
          className="absolute right-3 bottom-2 font-mono text-[10px] text-slate-400"
          style={{ opacity: 0 }}
        />
      )}

      {showTransport && transport !== null && (
        <CutsceneTransport
          frame={transport.frame}
          durationFrames={transport.duration}
          paused={transport.paused}
          onGrab={grab}
          onSeek={(frame) => {
            if (!seek(frame)) return
            setTransport((current) =>
              current === null ? current : { ...current, frame },
            )
          }}
          onTogglePlay={() => {
            if (engine.world.clock.paused) engine.harness.resume()
            else engine.harness.pause()
          }}
          onStop={() => engine.harness.stopCutscene()}
        />
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
