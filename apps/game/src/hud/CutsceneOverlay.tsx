'use no memo'
import { useEffect, useRef, useState } from 'react'
import type { CinematicTextState, GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING, releaseFocus } from './focus.ts'

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

/*
 * Sizes are the reference's measured cap heights divided by this face's own
 * cap-height-to-em ratio.
 *
 * Both halves are measurements. The reference's blue-mask row bands give a
 * name's caps as 0.0750 of the frame height, a label's ascenders 0.0546, the
 * subtitle 0.0639, a main-logo word 0.1546 and the opening card's logotype
 * 0.1056. The divisors come from the faces themselves, through
 * `measureText().actualBoundingBoxAscent`: TNG Credits sets caps at 0.80 em
 * and TNG Title at 0.595. Guessing those two instead — 0.72 and 0.7, the usual
 * rules of thumb — set every credit 19% too large and the logotype 15% too
 * small, and no amount of adjusting the *other* end would have found it. Ask
 * the font.
 *
 * With the sizes right the tracking falls out at zero: a name then measures
 * 0.516 of the frame against the reference's 0.489, and a logo word 0.323
 * against 0.328. The old `0.2em` was compensating for a size two steps wrong.
 */
const CAP_RATIO = { credits: 0.8, title: 0.595 } as const
const size = (capFraction: number, face: keyof typeof CAP_RATIO): string =>
  `${(capFraction * 100) / CAP_RATIO[face]}vh`

/**
 * How far the label's box sits above the name's, in vh.
 *
 * Tuned against the rendered result rather than derived: the reference puts a
 * label's cap centre 0.1056 of the frame height above its name's, and what
 * stands between a CSS margin and a cap centre is two line boxes' worth of two
 * fonts' ascent and descent metrics. Measuring the drawn bands and solving for
 * the margin is one round trip; deriving it is several, and wrong again the
 * moment the face changes.
 */
const LABEL_GAP = '2.5vh'

function textStyle(text: CinematicTextState): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute',
    // `left`/`top` are written every frame, not baked here: the main logotype
    // flies in from off-frame, so position is an animated channel.
    left: '50%',
    top: '50%',
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
        fontSize: size(0.1546, 'title'),
        letterSpacing: '0',
        color: LOGO_BLUE,
        textShadow: '0 0 22px rgba(24,120,215,0.5)',
      }
    case 'subtitle':
      return {
        ...base,
        fontSize: size(0.0639, 'credits'),
        letterSpacing: '0.02em',
      }
    case 'name':
      return {
        ...base,
        fontSize: size(0.075, 'credits'),
        letterSpacing: '0',
      }
    case 'label':
      return {
        ...base,
        fontSize: size(0.0546, 'credits'),
        letterSpacing: '0',
      }
    case 'card':
      // The display face, not the credits face: the opening and outro cards
      // are titles, and the project's own name should be set the way the
      // main logotype is.
      return {
        ...base,
        fontFamily: "'TNG Title', ui-sans-serif, sans-serif",
        fontStyle: 'normal',
        fontSize: size(0.1056, 'title'),
        letterSpacing: '0.02em',
        color: LOGO_BLUE,
        textShadow: '0 0 18px rgba(24,120,215,0.5)',
      }
    case 'accent':
      return {
        ...base,
        fontSize: size(0.075, 'credits'),
        letterSpacing: '0',
        color: ACCENT_GOLD,
        textShadow: '0 0 14px rgba(216,180,90,0.4)',
      }
  }
}

/*
 * The label line — 'Starring', 'Executive Producer'.
 *
 * Absolutely positioned inside its name's own box, flush left against it,
 * because that is what the reference does and the name's rendered width is a
 * property of the typeface rather than a number the script can supply: every
 * measured pair has the label's left edge within 0.006 of the name's. Anchor
 * the block on the name and the pair survives a font change; position the
 * label independently and it does not.
 */
function labelStyle(text: CinematicTextState): React.CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    bottom: '100%',
    marginBottom: LABEL_GAP,
    whiteSpace: 'pre',
    fontSize: size(0.0546, 'credits'),
    letterSpacing: '0',
    color: text.style === 'accent' ? ACCENT_GOLD : TEXT_BLUE,
  }
}

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
          className="absolute right-3 bottom-2 font-mono text-[10px] text-slate-500"
          style={{ opacity: 0 }}
        />
      )}

      {/* The transport: the one interactive island in an otherwise
          pointer-transparent layer. Same verbs as the console — pause,
          resume, seek, stop — so anything done here is reproducible there. */}
      {showTransport && transport !== null && (
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
            // A one-frame scene would otherwise put `max` below `min`, which
            // browsers resolve by clamping the value to `min` — a scrubber that
            // silently refuses to move.
            max={Math.max(0, transport.duration - 1)}
            step={1}
            aria-label="Cutscene frame"

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
            className={`h-1 min-w-0 flex-1 cursor-pointer accent-sky-400 ${FOCUS_RING}`}
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
      aria-label={title}
      onClick={(event) => {
        releaseFocus(event)
        onClick()
      }}
      className={`rounded border border-slate-700/60 px-2 py-0.5 hover:bg-slate-800/60 ${FOCUS_RING}`}
    >
      {label}
    </button>
  )
}
