'use no memo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  ChevronFirst,
  ChevronLast,
  Link2,
  Pause,
  Play,
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
import { EndCard } from './EndCard.tsx'
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
  idle,
}: {
  engine: GameEngine
  id: string
  /** Whether the mode's chrome is out of the picture. See `useTransportIdle`. */
  idle: boolean
}) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [playhead, setPlayhead] = useState<Playhead | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /*
   * Whether the scene has run to its end, as distinct from not being open.
   *
   * The director restores the ship and stops on the final frame, so the only
   * signal the player gets is `cutsceneStatus()` going null — which is also
   * what it reads before the scene has started and after `stopCutscene`. This
   * flag is what tells the end apart from the beginning, and it survives the
   * re-open below that puts the last frame back on screen.
   */
  const [ended, setEnded] = useState(false)
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

  /** The last playhead the poll saw, so it can tell "ended" from "never open". */
  const seen = useRef<Playhead | null>(null)

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
        /*
         * The scene ran out, and the picture went with it.
         *
         * The director restores the ship and stops on the final frame, which
         * is correct — a scene that kept the camera after it ended would be a
         * script nobody could get out of. What it leaves on screen, though, is
         * whatever the chase camera happens to see: the debug hull in front of
         * Earth, a composition nobody wrote, arriving as a hard cut on the
         * last beat of a title sequence. Reopening two frames short of the end
         * and pausing puts the picture back — `engine.cinematic` is non-null
         * again, so the camera is the shot's — and it hands back a scrubber
         * with the end of the scene under it rather than an empty bar.
         *
         * Two frames rather than one: the director reports `done` *on* the
         * final frame, so a seek to it would end the scene again on the next
         * sample and this would run in a loop.
         *
         * Read through a ref rather than the state, because the effect must not
         * depend on the playhead — it polls it — and a stale closure here is
         * the difference between "the scene ended" and "no scene was open".
         */
        const previous = seen.current
        if (previous !== null) {
          seen.current = null
          setEnded(true)
          open(Math.max(0, previous.durationFrames - 2), false)
        }
        return
      }
      if (scrubbing.current) return
      const next = {
        id: status.id,
        frame: status.frame,
        durationFrames: status.durationFrames,
        fps: status.fps,
        paused: engine.world.clock.paused,
      }
      seen.current = next
      setPlayhead(next)
    }, 100)
    return () => window.clearInterval(poll)
    // `scrubbing` is a ref and never changes identity; it is named so the
    // dependency list can be read as the complete list of what this closes
    // over rather than as an omission somebody has to re-derive.
  }, [engine, scrubbing, open])

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

  const replay = useCallback(() => {
    // Play it again through the same verb the URL used, and clear the frame the
    // ended playhead left in the address bar — a replay that opened on the last
    // frame would end immediately.
    setEnded(false)
    void navigate(cinemaLink(id, { autoplay: true }), { replace: true })
    open(0, true)
  }, [id, navigate, open])

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
        <p className="type-body max-w-[42ch] text-rose-300">{failed}</p>
        <Button
          asChild
          variant="outline"
          className={`type-ui h-auto rounded border-slate-700 bg-transparent px-3 py-1.5 font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
        >
          <Link to={CINEMA}>back to the library</Link>
        </Button>
      </div>
    )
  }

  /*
   * A scene with no picture at all — the player opened and the director never
   * produced a frame. The end of a scene no longer reaches this branch: the
   * poll reopens the final frame, so what is on screen is the last shot, and
   * the card below is drawn *over* it.
   */
  if (playhead === null) {
    return (
      <EndCard
        title="Nothing to Play"
        detail="the scene opened but produced no frames"
        onReplay={replay}
      />
    )
  }

  const lastFrame = Math.max(0, playhead.durationFrames - 1)
  const step = secondStep(playhead.fps)
  return (
    <>
      {ended && (
        <EndCard
          title="End of Scene"
          detail={durationText(playhead.durationFrames, playhead.fps)}
          onReplay={replay}
          onDismiss={() => setEnded(false)}
        />
      )}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-14 transition-opacity duration-300 ${
          idle ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div className="pointer-events-auto mx-auto flex w-[min(56rem,calc(100vw-1.5rem))] flex-col gap-2 rounded-lg border border-slate-700/60 bg-slate-950/80 px-3 py-2 backdrop-blur">
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

          <div className="type-readout flex flex-wrap items-center gap-1.5 text-slate-300">
            <TransportButton
              label="Start"
              icon={ChevronFirst}
              onClick={() => seek(0)}
            />
            <TransportButton
              label={`Back ${step} frames`}
              icon={SkipBack}
              onClick={() =>
                seek(Math.max(0, Math.floor(playhead.frame) - step))
              }
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
                seek(Math.min(lastFrame, Math.floor(playhead.frame) + step))
              }
            />
            <TransportButton
              label="End"
              icon={ChevronLast}
              onClick={() => seek(lastFrame)}
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
    </>
  )
}
