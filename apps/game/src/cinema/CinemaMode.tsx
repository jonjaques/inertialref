'use no memo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  ChevronFirst,
  ChevronLast,
  Clapperboard,
  Link2,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { CINEMA, cinemaLink, cinemaScene, QUERY } from '../pages/paths.ts'
import {
  durationText,
  parseAutoplay,
  parseFrame,
  secondStep,
  timecode,
} from './timecode.ts'

/*
 * The cinematic player.
 *
 * A deliberately thin layer *over* the cutscene director rather than a second
 * way of running a scene: `ir.play`, `ir.seekCutscene` and the clock's own
 * pause are the whole mechanism, and everything here is transport chrome and a
 * URL. ADR-0010 owns how a scene is authored and evaluated; this owns how one
 * is *watched*, and keeping the two apart is what stops a player feature —
 * scrubbing, looping, a shareable frame — from becoming a change to the format
 * scenes are written in.
 *
 * The URL is the document, and for a player that means two parameters:
 * `?t=` is the frame and `?play=1` asks it to run. A link therefore reproduces
 * a still exactly, which is the same guarantee the verification pipeline
 * depends on when it compares a render against the reference edit — `ir.pause()`
 * then `ir.seekCutscene(1150)` is what this does, with buttons on it.
 */

/** How long the transport stays up after the pointer stops, while playing. */
const IDLE_MS = 2_600

interface Playhead {
  readonly id: string
  readonly frame: number
  readonly durationFrames: number
  readonly fps: number
  readonly paused: boolean
}

export function CinemaMode({ engine }: { engine: GameEngine }) {
  const { scene } = useParams<{ scene?: string }>()
  return scene === undefined ? (
    <CinemaLibrary engine={engine} />
  ) : (
    <CinemaPlayer engine={engine} id={scene} />
  )
}

/* ------------------------------------------------------------------------- */
/* The library                                                                */
/* ------------------------------------------------------------------------- */

function CinemaLibrary({ engine }: { engine: GameEngine }) {
  const scenes = engine.harness.cutscenes()
  return (
    // A scrim, because the library sits over whatever the world is showing and
    // that is very often a sunlit planet. `docs/design/ux.md` measured 70% in
    // front of Earth as the point where a page reads without obliterating what
    // it is over; the same number, for the same reason.
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-slate-950/70 p-6">
      <div className="w-full max-w-2xl">
        <header className="mb-6 flex items-center gap-3">
          <Clapperboard className="size-6 text-sky-400" />
          <div>
            <h1 className="text-lg tracking-[0.2em] text-slate-100 uppercase">
              Cinema
            </h1>
            <p className="font-mono text-[11px] text-slate-500">
              scripted scenes, played over the live world — nothing here is a
              video file
            </p>
          </div>
        </header>

        <ul className="flex flex-col gap-2">
          {scenes.map((entry) => (
            <li key={entry.id}>
              <Link
                to={cinemaScene(entry.id)}
                className={`flex items-center gap-3 rounded-lg border border-slate-700/60 bg-slate-950/80 px-4 py-3 backdrop-blur transition-colors hover:border-sky-500/60 hover:bg-slate-900/80 ${FOCUS_RING}`}
              >
                <Play className="size-4 shrink-0 text-sky-400" />
                <span className="min-w-0 flex-1">
                  <span className="block text-slate-100">{entry.id}</span>
                  <span className="block truncate font-mono text-[11px] text-slate-500">
                    {entry.description}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
                  {Math.floor(entry.seconds / 60)}:
                  {String(Math.round(entry.seconds % 60)).padStart(2, '0')}
                </span>
              </Link>
            </li>
          ))}
          {scenes.length === 0 && (
            <li className="rounded-lg border border-dashed border-slate-700/60 px-4 py-6 text-center font-mono text-[11px] text-slate-500">
              no scenes in this build
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* The player                                                                 */
/* ------------------------------------------------------------------------- */

function CinemaPlayer({ engine, id }: { engine: GameEngine; id: string }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [playhead, setPlayhead] = useState<Playhead | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [idle, setIdle] = useState(false)
  const scrubbing = useRef(false)

  /*
   * Start the scene, once per id.
   *
   * The seek is applied through the director's own pending-seek path — it is
   * issued before the first sample lands, which is exactly the case
   * `CutsceneDirector.seek` holds `pendingSeekFrame` for. Pausing *after*
   * seeking rather than before, because `play` un-pauses the clock as part of
   * anchoring the reference timing and would otherwise undo it.
   */
  const open = useCallback(
    (frame: number, autoplay: boolean) => {
      try {
        const status = engine.harness.play(id)
        const at = Math.min(frame, Math.max(0, status.durationFrames - 1))
        if (at > 0) engine.harness.seekCutscene(at)
        // Pausing *after* seeking rather than before: `play` un-pauses the
        // clock as part of anchoring the reference timing and would undo it.
        if (!autoplay) engine.harness.pause()
        setFailed(null)
      } catch (cause) {
        setFailed(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [engine, id],
  )

  const opened = useRef<string | null>(null)
  useEffect(() => {
    /*
     * The URL is read once, at open.
     *
     * Guarded by the id rather than by the dependency list, because the effect
     * also has to survive the playhead writing its own frame back into the
     * address bar — a `params` dependency would restart the scene on every one
     * of those, which is once a second while paused and never at all while
     * playing.
     */
    if (opened.current !== id) {
      opened.current = id
      open(
        parseFrame(params.get(QUERY.frame), Number.MAX_SAFE_INTEGER),
        parseAutoplay(params.get(QUERY.autoplay)),
      )
    }
    return () => {
      if (opened.current === id) return
      // Always stop on the way out. The director restores the ship, the clock
      // and the time warp it borrowed — leaving a scene running under a flight
      // mode would hand the camera to a script nobody asked for.
      engine.harness.stopCutscene()
    }
  }, [engine, id, open, params])

  // Stop for good when the player leaves, whatever the reason.
  useEffect(
    () => () => {
      opened.current = null
      engine.harness.stopCutscene()
    },
    [engine],
  )

  /* The readout, at a human rate. The scrubber owns the value while dragged. */
  useEffect(() => {
    const poll = window.setInterval(() => {
      const status = engine.harness.cutsceneStatus()
      if (status === null) {
        setPlayhead(null)
        return
      }
      if (scrubbing.current) return
      setPlayhead({
        id: status.id,
        frame: status.frame,
        durationFrames: status.durationFrames,
        fps: status.fps,
        paused: engine.world.clock.paused,
      })
    }, 100)
    return () => window.clearInterval(poll)
  }, [engine])

  /*
   * Write the parked frame back into the URL.
   *
   * Only while paused, and that is the whole rule: during playback this would
   * rewrite the address bar twenty-four times a second, and every one of those
   * is a router update. Paused, it means the address bar always describes the
   * still on screen — which is what makes "send me that frame" a copy of the
   * URL rather than a feature.
   */
  useEffect(() => {
    if (playhead === null || !playhead.paused) return
    const at = Math.floor(playhead.frame)
    // Frame zero is the default, so a link to it should look like a link to the
    // scene rather than a link to a position in it — the same rule
    // `cinemaLink` follows, applied to the address bar it writes into.
    const frame = at > 0 ? String(at) : null
    if ((params.get(QUERY.frame) ?? null) === frame) return
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (frame === null) next.delete(QUERY.frame)
        else next.set(QUERY.frame, frame)
        next.delete(QUERY.autoplay)
        return next
      },
      { replace: true },
    )
  }, [playhead, params, setParams])

  /* The transport hides itself while a scene is running and nothing moves. */
  useEffect(() => {
    if (playhead?.paused !== false) {
      setIdle(false)
      return
    }
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    const wake = (): void => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [playhead?.paused])

  const seek = useCallback(
    (frame: number) => {
      const status = engine.harness.cutsceneStatus()
      if (status === null) return
      engine.harness.seekCutscene(frame)
      setPlayhead((current) =>
        current === null ? current : { ...current, frame },
      )
    },
    [engine],
  )

  const toggle = useCallback(() => {
    if (engine.world.clock.paused) engine.harness.resume()
    else engine.harness.pause()
  }, [engine])

  /* Space plays and pauses, the arrows step. What a player's keys always are. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const status = engine.harness.cutsceneStatus()
      if (status === null) return
      const step = event.shiftKey ? secondStep(status.fps) : 1
      switch (event.key) {
        case ' ':
          event.preventDefault()
          toggle()
          break
        case 'ArrowLeft':
          event.preventDefault()
          seek(Math.max(0, Math.floor(status.frame) - step))
          break
        case 'ArrowRight':
          event.preventDefault()
          seek(Math.floor(status.frame) + step)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, seek, toggle])

  if (failed !== null) {
    return (
      <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-mono text-[12px] text-rose-300">{failed}</p>
        <Link
          to={CINEMA}
          className={`rounded border border-slate-700 px-3 py-1 font-mono text-[11px] text-slate-300 hover:border-sky-500/60 hover:text-sky-200 ${FOCUS_RING}`}
        >
          back to the library
        </Link>
      </div>
    )
  }

  /*
   * A scene that has ended. The director restores the ship and returns null
   * from `sample`, so there is nothing on screen to scrub — which is a state
   * worth a replay button rather than an empty transport bar.
   */
  if (playhead === null) {
    return (
      <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-3">
        <p className="font-mono text-[11px] tracking-widest text-slate-500 uppercase">
          scene ended
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={(event) => {
              releaseFocus(event)
              // Play it again through the same verb the URL used, and clear the
              // frame the ended playhead left in the address bar — a replay
              // that opened on the last frame would end immediately.
              void navigate(cinemaLink(id, { autoplay: true }), {
                replace: true,
              })
              open(0, true)
            }}
            className={`flex items-center gap-1.5 rounded border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 font-mono text-[11px] text-sky-200 ${FOCUS_RING}`}
          >
            <RotateCcw className="size-3.5" /> replay
          </button>
          <Link
            to={CINEMA}
            className={`flex items-center gap-1.5 rounded border border-slate-700 px-3 py-1.5 font-mono text-[11px] text-slate-300 hover:border-sky-500/60 ${FOCUS_RING}`}
          >
            <X className="size-3.5" /> library
          </Link>
        </div>
      </div>
    )
  }

  const last = Math.max(0, playhead.durationFrames - 1)
  const step = secondStep(playhead.fps)
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-300 ${
        idle ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className="pointer-events-auto mx-auto mb-3 flex w-[min(56rem,calc(100vw-1.5rem))] flex-col gap-2 rounded-lg border border-slate-700/60 bg-slate-950/80 px-3 py-2 backdrop-blur">
        {/* The scrubber, full width and first: it is the control this bar
            exists for, and putting it above the buttons is what stops a
            transport from reading as a toolbar. */}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.floor(playhead.frame)}
          aria-label="Frame"
          onPointerDown={() => {
            scrubbing.current = true
          }}
          onPointerUp={() => {
            scrubbing.current = false
          }}
          onChange={(event) => seek(Number(event.target.value))}
          className={`h-1 w-full cursor-pointer accent-sky-400 ${FOCUS_RING}`}
        />

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-300">
          <TransportButton
            label="Start"
            icon={ChevronFirst}
            onClick={() => seek(0)}
          />
          <TransportButton
            label={`Back ${step} frames`}
            icon={SkipBack}
            onClick={() => seek(Math.max(0, Math.floor(playhead.frame) - step))}
          />
          <TransportButton
            label={playhead.paused ? 'Play' : 'Pause'}
            icon={playhead.paused ? Play : Pause}
            primary
            onClick={toggle}
          />
          <TransportButton
            label={`Forward ${step} frames`}
            icon={SkipForward}
            onClick={() =>
              seek(Math.min(last, Math.floor(playhead.frame) + step))
            }
          />
          <TransportButton
            label="End"
            icon={ChevronLast}
            onClick={() => seek(last)}
          />

          <span className="ml-2 tabular-nums">
            <span className="text-sky-200">
              {timecode(playhead.frame, playhead.fps)}
            </span>
            <span className="text-slate-600">
              {' / '}
              {durationText(playhead.durationFrames, playhead.fps)}
            </span>
          </span>
          <span className="text-slate-600">
            {/* Rounded, because 23.976023976023978 is the true rate and it is
                also fourteen characters of noise in a transport bar. Two
                decimals distinguishes 23.98 from 24 and 29.97 from 30, which
                is the whole reason anyone reads this field. */}
            f{Math.floor(playhead.frame)} · {Number(playhead.fps.toFixed(2))}{' '}
            fps
          </span>

          <span className="ml-auto flex items-center gap-1.5">
            <TransportButton
              label="Copy a link to this frame"
              icon={Link2}
              onClick={() => {
                void navigator.clipboard?.writeText(
                  new URL(
                    cinemaLink(id, { frame: playhead.frame }),
                    window.location.origin,
                  ).toString(),
                )
              }}
            />
            <Link
              to={CINEMA}
              aria-label="Back to the library"
              title="Back to the library"
              className={`rounded border border-slate-700 p-1.5 text-slate-400 hover:border-sky-500/60 hover:text-sky-200 ${FOCUS_RING}`}
            >
              <X className="size-3.5" />
            </Link>
          </span>
        </div>
      </div>
    </div>
  )
}

function TransportButton({
  label,
  icon: Icon,
  onClick,
  primary = false,
}: {
  label: string
  icon: typeof Play
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        releaseFocus(event)
        onClick()
      }}
      className={`rounded border p-1.5 transition-colors ${FOCUS_RING} ${
        primary
          ? 'border-sky-500/50 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25'
          : 'border-slate-700 text-slate-400 hover:border-sky-500/60 hover:text-sky-200'
      }`}
    >
      <Icon className={primary ? 'size-4' : 'size-3.5'} />
    </button>
  )
}
