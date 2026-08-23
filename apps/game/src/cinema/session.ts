import type { CutsceneOutcome, CutsceneStatus } from '@inertialref/devtools'

/*
 * Watching a cutscene, as one module.
 *
 * Three components used to poll the director at three different rates and each
 * reach around it into `engine.world.clock.paused` — a canonical field read
 * from three places to answer a question none of them owned. `toggle` was
 * implemented twice, identically. And fifty lines in `CinemaPlayer`
 * reconstructed "did it end or was it stopped?" from a `null` and a
 * half-second window around the final frame, because the director had no
 * return value that said which.
 *
 * It has one now (`lastOutcome`), so the guessing is gone. What is left here is
 * a session over the seam the harness already had — `play` / `pause` /
 * `seekCutscene` / `stopCutscene` / `cutsceneStatus` — publishing one playhead
 * and offering one set of verbs. It holds no timer: `sample()` is called by the
 * engine store's sampler, which is already running.
 *
 * ADR-0010's director is untouched by this. A session *reading* it contradicts
 * nothing; the one thing this needed from it was a richer status, which is
 * additive and leaves `sample(frame)` exactly as pure as it was.
 */

/** Where a scene is, and whether it is over. */
export interface Playhead {
  readonly id: string
  readonly frame: number
  readonly durationFrames: number
  readonly fps: number
  readonly paused: boolean
  /**
   * The scene ran to its final frame, as distinct from not being open.
   *
   * The distinction the whole module exists for: an ended scene draws an end
   * card and keeps its transport, and a stopped one closes.
   */
  readonly ended: boolean
}

/**
 * What a session needs of the harness.
 *
 * A port rather than an import of `GameEngine`, the pattern
 * `packages/workers/src/transport.ts` uses — so the tests drive this with a
 * dozen lines of fake instead of building a world, and so `paused` has exactly
 * one reader in this half of the application.
 */
export interface CutsceneHost {
  status(): CutsceneStatus | null
  outcome(): CutsceneOutcome | null
  paused(): boolean
  play(id: string): CutsceneStatus
  seek(frame: number): void
  pause(): void
  resume(): void
  stop(): void
}

export interface CutsceneSession {
  /**
   * Read the playhead, and react to a scene that has just ended.
   *
   * Called once per engine sample. It is the *one* place that acts on an
   * ending — see `restoreFinalFrame` below for the one thing it does.
   */
  sample(): Playhead | null
  /**
   * Open a scene at a frame. Pausing after seeking; see below.
   *
   * Returns why it could not, or `null`. A return value rather than a field to
   * read back, so a component can hold it in state instead of reading mutable
   * session state during a render — which is what `'use no memo'` is for and
   * what this module exists to make unnecessary.
   */
  open(id: string, frame: number, autoplay: boolean): string | null
  /** Play or pause. Dismisses an end card: watching it again is not reading it. */
  toggle(): void
  /** Jump the playhead. Dismisses an end card. */
  seek(frame: number): void
  /** Play the current scene again from the top. */
  replay(): void
  /** Stop for good. */
  stop(): void
  /**
   * Freeze the published frame while a pointer owns a scrubber.
   *
   * The rule every transport needs and none of them owned: a readout that
   * keeps republishing while a hand is dragging the input fights the hand.
   * `hud/useScrubber.ts` holds the pointer; this holds what the hold *means*,
   * so both transports get it from the same place.
   */
  hold(held: boolean): void
}

/**
 * How far short of the end a re-open lands, in frames.
 *
 * Two, not one: the director reports the scene done *on* the final frame, so a
 * re-open at exactly the end would end again on the next sample and loop.
 */
const REOPEN_MARGIN = 2

export function createCutsceneSession(host: CutsceneHost): CutsceneSession {
  /** The scene whose ending has already been handled, so it is handled once. */
  let restored: string | null = null
  /** Suppresses the end card without stopping the scene. */
  let dismissed = false
  /** A pointer owns a scrubber; the published frame stands still. */
  let held = false
  /** The last playhead published, which is what a hold freezes. */
  let last: Playhead | null = null

  const open = (
    id: string,
    frame: number,
    autoplay: boolean,
  ): string | null => {
    try {
      const status = host.play(id)
      const at = Math.min(frame, Math.max(0, status.durationFrames - 1))
      if (at > 0) host.seek(at)
      // Pausing *after* seeking rather than before: `play` un-pauses the clock
      // as part of anchoring the reference timing and would otherwise undo it.
      if (!autoplay) host.pause()
      restored = null
      dismissed = false
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }

  /*
   * Put the last picture back.
   *
   * The director restores the ship and stops on the final frame, which is
   * correct — a scene that kept the camera after it ended would be a script
   * nobody could get out of. What it leaves on screen, though, is whatever the
   * chase camera happens to see: the debug hull in front of Earth, a
   * composition nobody wrote, arriving as a hard cut on the last beat of a
   * title sequence. Reopening two frames short and pausing puts the picture
   * back, and hands back a scrubber with the end of the scene under it rather
   * than an empty bar.
   *
   * It is a side effect inside a read, and that is deliberate: this is the
   * session's tick, it is called from exactly one place, and the alternative —
   * a component noticing the ending and calling `play` again — is the
   * arrangement this module replaced.
   */
  const restoreFinalFrame = (outcome: CutsceneOutcome): void => {
    if (restored === outcome.id) return
    restored = outcome.id
    try {
      host.play(outcome.id)
      host.seek(Math.max(0, outcome.durationFrames - REOPEN_MARGIN))
      host.pause()
    } catch {
      // A scene that will not reopen is a scene that ended. Nothing to say.
    }
  }

  return {
    sample() {
      if (held) return last
      const status = host.status()
      const outcome = host.outcome()
      const ended = outcome !== null && outcome.ending === 'ended'

      if (status !== null) {
        last = {
          id: status.id,
          frame: status.frame,
          durationFrames: status.durationFrames,
          fps: status.fps,
          paused: host.paused(),
          // `restored` names the scene whose ending was handled, so the
          // re-opened final frame still reads as ended rather than as a scene
          // somebody started at the last second.
          ended: !dismissed && restored !== null && restored === status.id,
        }
        return last
      }

      // Stopped, abandoned, or never opened: there is no playhead, and that is
      // the whole answer. No window around the final frame, no remembered
      // playhead to compare against.
      if (!ended || outcome === null) {
        last = null
        return null
      }

      restoreFinalFrame(outcome)
      last = {
        id: outcome.id,
        frame: outcome.durationFrames,
        durationFrames: outcome.durationFrames,
        fps: outcome.fps,
        paused: host.paused(),
        ended: !dismissed,
      }
      return last
    },

    hold(next) {
      held = next
    },

    open,

    toggle() {
      // Pressing play on an ended scene is watching it again, not reading a
      // card about how it went.
      dismissed = true
      if (host.paused()) host.resume()
      else host.pause()
    },

    seek(frame) {
      // Using the transport is how somebody stops reading the end card. Without
      // this the card sat over a scene that was visibly somewhere else.
      dismissed = true
      host.seek(frame)
    },

    replay() {
      const id = host.status()?.id ?? host.outcome()?.id
      if (id === undefined) return
      open(id, 0, true)
    },

    stop() {
      dismissed = true
      restored = null
      host.stop()
    },
  }
}
