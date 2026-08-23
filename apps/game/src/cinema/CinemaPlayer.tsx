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
import { FOCUS_RING, isOverlayControl, isTyping } from '../hud/focus.ts'
import { FrameScrubber } from '../hud/FrameScrubber.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { useScrubber } from '../hud/useScrubber.ts'
import { useEngine } from '../state/engineStore.ts'
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
  /*
   * One published playhead, and it carries `ended` with it.
   *
   * This component used to poll the director every 100 ms and reconstruct "did
   * it end or was it stopped?" from a `null` and a half-second window around
   * the final frame — a heuristic that read `stopCutscene` from the console as
   * an ending, because it produced identical evidence. The director says which
   * now (`cutsceneOutcome`), and `cinema/session.ts` is the one place that
   * reads it. Two other components asked the same question at two other rates;
   * all three read this.
   */
  const playhead = useEngine((snapshot) => snapshot.playhead)
  const session = engine.cutscene
  const [failed, setFailed] = useState<string | null>(null)
  // The pointer latch and the guarded seek, shared with the debug transport in
  // `hud/CutsceneOverlay.tsx` — see `hud/useScrubber.ts` for what each is for.
  // The latch's *meaning* — the published frame stands still — is the
  // session's, so nothing here has to remember to honor it.
  const { grab, seek: seekFrame } = useScrubber(engine)

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
      setFailed(session.open(id, frame, autoplay))
    },
    [session, id],
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

  /*
   * The verbs, which are the session's.
   *
   * `useScrubber`'s guard still runs first — it is the drag latch and the
   * "is a scene even open" refusal — and the session owns what a seek *means*,
   * including that it dismisses the end card. `toggle` used to be implemented
   * twice, identically, in this file and in the debug transport.
   */
  const seek = useCallback(
    (frame: number) => {
      if (!seekFrame(frame)) return
      session.seek(frame)
    },
    [seekFrame, session],
  )

  const toggle = useCallback(() => session.toggle(), [session])

  const replay = useCallback(() => {
    // Play it again through the same verb the URL used, and clear the frame the
    // ended playhead left in the address bar — a replay that opened on the last
    // frame would end immediately.
    void navigate(cinemaLink(id, { autoplay: true }), { replace: true })
    open(0, true)
  }, [id, navigate, open])

  /* Space plays and pauses, the arrows step. What a player's keys always are. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      /*
       * The same two refusals every window-level listener here makes, and
       * this one went without them for as long as no text field could exist
       * beside the player. The workspace changed that: the Navigate panel's
       * address input is one disclosure away, and typing a space into it
       * toggled the scene while `preventDefault` ate the character. The
       * overlay guard is the Space-on-a-focused-button rule from
       * `useShipControls`, plus the arrows — Radix gives a focused slider and
       * a toggle group arrow keys of their own, and two handlers stepping on
       * one keystroke seeks twice.
       */
      if (isTyping(event) || isOverlayControl(event)) return
      const status = engine.cutscene.sample()
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
   * produced a frame, or something outside the player stopped the scene
   * mid-run and the stop was respected. The natural end of a scene no longer
   * reaches this branch: the session reopens the final frame, so what is on
   * screen is the last shot, and the End of Scene card is drawn *over* it.
   */
  if (playhead === null) {
    return (
      <EndCard
        title="Nothing Playing"
        detail="the scene stopped before its end, or never produced a frame"
        onReplay={replay}
      />
    )
  }

  const lastFrame = Math.max(0, playhead.durationFrames - 1)
  const step = secondStep(playhead.fps)
  return (
    <>
      {playhead.ended && (
        <EndCard
          title="End of Scene"
          detail={durationText(playhead.durationFrames, playhead.fps)}
          onReplay={replay}
          onDismiss={() => session.seek(playhead.frame)}
        />
      )}
      <div
        /* `invisible`, not opacity alone — the same fix `CinemaMode` applies
           to its own bar: opacity leaves a fully transparent transport still
           taking hits, so a tap at the bottom of a playing scene landed on an
           invisible Pause or the way out. Visibility also removes it from the
           tab order while it is gone. */
        className={`pointer-events-none absolute inset-x-0 bottom-14 transition-opacity duration-300 ${
          idle ? 'invisible opacity-0' : 'visible opacity-100'
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
