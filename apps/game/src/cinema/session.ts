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
 * nothing; the two things this needed from it are additive — a richer status,
 * and a `hold` that keeps the last frame on stage — and leave `sample(frame)`
 * exactly as pure as it was.
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
  /**
   * Open a scene held at its end: on the last frame the director parks the
   * playhead, pauses the clock and reports `ended` while the scene stays on
   * stage, rather than restoring the player and going dark.
   *
   * That is the whole difference between watching a scene and measuring
   * one. A director that restores on the final frame hands the camera back
   * to the ship for a frame — wherever the ship is, which for a player who
   * opened the library from the menu is Earth orbit — and the terrain
   * streamer, which follows the eye, drops every patch it holds for the body
   * it was drawing. Reopening the scene a frame later put the camera back
   * over an empty cache, and the ground under the end card rebuilt itself
   * from the cube faces up at eight patches a frame: measured at 3200×1800,
   * the hover's 2,170 patches went to zero on the ending frame and were at
   * 221, level 6 of 16, two seconds later.
   */
  play(id: string): CutsceneStatus
  seek(frame: number): void
  pause(): void
  resume(): void
  stop(): void
}

export interface CutsceneSession {
  /**
   * Read the playhead, and notice a scene that has just ended.
   *
   * Called once per engine sample. It is the *one* place that raises the end
   * card, and the only thing it does about an ending is raise it: the
   * director is holding the last frame already.
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

export function createCutsceneSession(host: CutsceneHost): CutsceneSession {
  /*
   * Whether an end card is up.
   *
   * A state, not a suppression. It was a `dismissed` flag that transport verbs
   * set and only `open` cleared — which conflated "hide the card that is
   * showing" with "suppress any future card", so pausing part way through a
   * scene silently cost its ending the card, and with it the Replay button
   * that lives there. A card is raised by an ending and lowered by the person
   * reading it; nothing else has an opinion.
   */
  let carded = false
  /*
   * Whether this session has already raised a card for the ending it can see.
   *
   * Reset whenever the director has no outcome — a scene started fresh, or a
   * held ending that a seek has moved the playhead away from — so an open
   * scene with no outcome is one whose next ending is a new one. That is what
   * lets the same scene end twice: dismiss the card, seek back, play on, and
   * the second ending raises a second card.
   */
  let handled = false
  /** A pointer owns a scrubber; the published frame stands still. */
  let held = false
  /*
   * The scene this session opened, or null.
   *
   * `sample()` runs on the engine store's sampler, which is session-wide and
   * does not stop when the cinema does — so an ending is visible here whether
   * or not anybody is watching, and a card must only go up for a scene
   * somebody opened through this session to watch. A driver's
   * `ir.play('tng-intro')` is the case that bites: that scene ends by
   * restoring the player and the clock, and a session that claimed it would
   * publish an ended playhead for a scene that is no longer on stage.
   *
   * The *id* rather than a boolean, because "did I open something" and "did I
   * open **this**" are different questions and only the second one is safe.
   * A scene can be replaced under an open session without going through it —
   * `ir.play` from the console, `cutscene.skip` calling `stopCutscene`
   * directly — and a flag left standing from the last `open` claims whatever
   * ends next. Cleared before `host.play` for the same reason: an `open` that
   * throws must not leave the previous scene's claim behind it.
   */
  let mine: string | null = null
  /** The last playhead published, which is what a hold freezes. */
  let last: Playhead | null = null

  const open = (
    id: string,
    frame: number,
    autoplay: boolean,
  ): string | null => {
    // Dropped before the attempt, not after it: a throw below leaves no scene
    // open, and a claim on the one that was is a claim on somebody else's.
    mine = null
    try {
      const status = host.play(id)
      const at = Math.min(frame, Math.max(0, status.durationFrames - 1))
      if (at > 0) host.seek(at)
      // Pausing *after* seeking rather than before: `play` un-pauses the clock
      // as part of anchoring the reference timing and would otherwise undo it.
      if (!autoplay) host.pause()
      carded = false
      handled = false
      mine = id
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }

  return {
    sample() {
      if (held) return last
      const status = host.status()
      if (status === null) {
        // Stopped, abandoned, never opened, or a scene somebody else played
        // to its end without a hold: there is no playhead, and that is the
        // whole answer. No window around the final frame, no remembered
        // playhead to compare against.
        last = null
        carded = false
        return null
      }
      const outcome = host.outcome()
      if (outcome === null) {
        handled = false
      } else if (
        !handled &&
        outcome.ending === 'ended' &&
        outcome.id === mine
      ) {
        // The director is holding the last frame; the card goes over it.
        handled = true
        carded = true
      }
      last = {
        id: status.id,
        frame: status.frame,
        durationFrames: status.durationFrames,
        fps: status.fps,
        paused: host.paused(),
        ended: carded,
      }
      return last
    },

    hold(next) {
      held = next
    },

    open,

    toggle() {
      // Pressing play on an ended scene is watching it again, not reading a
      // card about how it went. Lowering a card that is not up is a no-op,
      // which is what makes an ordinary mid-scene pause cost nothing.
      carded = false
      if (!host.paused()) {
        host.pause()
        return
      }
      // From the top when the playhead is on the last frame, whether the card
      // is up or was dismissed: the director holds that frame, so a resume
      // there would park again on the next sample and the button would do
      // nothing anybody could see.
      const status = host.status()
      if (status !== null && status.frame >= status.durationFrames - 1) {
        host.seek(0)
      }
      host.resume()
    },

    seek(frame) {
      // Using the transport is how somebody stops reading the end card. Without
      // this the card sat over a scene that was visibly somewhere else.
      carded = false
      host.seek(frame)
    },

    replay() {
      const id = host.status()?.id ?? host.outcome()?.id
      if (id === undefined) return
      open(id, 0, true)
    },

    stop() {
      carded = false
      handled = false
      // Before `host.stop()`, so an ending that arrives in the same sample the
      // player unmounts in cannot be reacted to on the way out.
      mine = null
      host.stop()
    },
  }
}
