'use no memo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  ChevronFirst,
  ChevronLast,
  Link2,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { FrameScrubber } from '../hud/FrameScrubber.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { useScrubber } from '../hud/useScrubber.ts'
import { CINEMA, cinemaLink, QUERY } from '../pages/paths.ts'
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

export function CinemaPlayer({
  engine,
  id,
}: {
  engine: GameEngine
  id: string
}) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [playhead, setPlayhead] = useState<Playhead | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [idle, setIdle] = useState(false)
  // The drag latch and the guarded seek, shared with the debug transport in
  // `hud/CutsceneOverlay.tsx` — see `hud/useScrubber.ts` for what each is for.
  const { held: scrubbing, grab, seek: seekFrame } = useScrubber(engine)

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
    // `scrubbing` is a ref and never changes identity; it is named so the
    // dependency list can be read as the complete list of what this closes
    // over rather than as an omission somebody has to re-derive.
  }, [engine, scrubbing])

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
      if (!seekFrame(frame)) return
      setPlayhead((current) =>
        current === null ? current : { ...current, frame },
      )
    },
    [seekFrame],
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
        <Button
          asChild
          variant="outline"
          className={`h-auto rounded border-slate-700 bg-transparent px-3 py-1 font-mono text-[11px] font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
        >
          <Link to={CINEMA}>back to the library</Link>
        </Button>
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
        <p className="font-mono text-[11px] tracking-widest text-slate-400 uppercase">
          scene ended
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              // Play it again through the same verb the URL used, and clear the
              // frame the ended playhead left in the address bar — a replay
              // that opened on the last frame would end immediately.
              void navigate(cinemaLink(id, { autoplay: true }), {
                replace: true,
              })
              open(0, true)
            }}
            className={`h-auto gap-1.5 rounded border-sky-500/50 bg-sky-500/15 px-3 py-1.5 font-mono text-[11px] font-normal text-sky-200 shadow-none hover:bg-sky-500/25 hover:text-sky-100 ${FOCUS_RING}`}
          >
            <RotateCcw className="size-3.5" /> replay
          </Button>
          <Button
            asChild
            variant="outline"
            className={`h-auto gap-1.5 rounded border-slate-700 bg-transparent px-3 py-1.5 font-mono text-[11px] font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Link to={CINEMA}>
              <X className="size-3.5" /> library
            </Link>
          </Button>
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
        <FrameScrubber
          frame={playhead.frame}
          durationFrames={playhead.durationFrames}
          onGrab={grab}
          onSeek={seek}
          className="w-full"
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
            <span className="text-slate-400">
              {' / '}
              {durationText(playhead.durationFrames, playhead.fps)}
            </span>
          </span>
          <span className="text-slate-400">
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
            <Button
              asChild
              variant="outline"
              size="icon-xs"
              aria-label="Back to the library"
              title="Back to the library"
              className={`size-7 rounded border-slate-700 bg-transparent text-slate-400 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
            >
              <Link to={CINEMA}>
                <X />
              </Link>
            </Button>
          </span>
        </div>
      </div>
    </div>
  )
}
