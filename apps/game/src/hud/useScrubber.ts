import { useCallback, useEffect, useRef } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'

/*
 * A cutscene transport's two rules, in one place.
 *
 * There are two wrappers around one director — the cinema player in
 * `cinema/CinemaMode.tsx` and the debug transport in `hud/CutsceneOverlay.tsx`
 * — and both are a 100 ms poll driving a range input. Written out twice, they
 * had the same two defects twice and disagreed about a third: one guarded its
 * seek and the other did not, so the same click was safe in one and threw in
 * the other. Neither rule is about *this* transport; both are about what a
 * poll and a director make possible, which is what makes them a hook rather
 * than a shared component.
 *
 * Nothing here holds a playhead. The reading is `cinema/session.ts`'s, which
 * publishes one for both transports; this owns only the two moments the
 * session has no way of knowing about on its own — the pointer, and the seek
 * that arrives a poll interval after a scene has stopped itself.
 */

export interface Scrubber {
  /**
   * True while a pointer owns the input.
   *
   * The poll must leave the input's `value` alone while it is, or the readout
   * fights the hand dragging it. A ref rather than state on purpose: it is read
   * inside an interval and it must never cause a render.
   */
  readonly held: { current: boolean }
  /** `onPointerDown` for the range input. Release is handled below. */
  readonly grab: () => void
  /** Seek, or decline. `false` when there is no longer a scene to seek. */
  readonly seek: (frame: number) => boolean
}

export function useScrubber(engine: GameEngine): Scrubber {
  const held = useRef(false)

  /*
   * The release is registered on the window, not on the input.
   *
   * `onPointerUp` on the element fires only when the pointer comes up *over*
   * it. Press the thumb, drag off the transport, release: the handler never
   * ran, the flag stayed true, and the poll's `if (held) return` meant the
   * playhead was never read again — timecode, the frame readout, the
   * paused-frame writeback into the URL and the play/pause icon all frozen
   * until the player was remounted, with no error anywhere. Touch reaches the
   * same state through `pointercancel` alone, which no element handler
   * existed for either.
   *
   * Three events because they are three different endings: a release over the
   * page, a gesture the browser took away (scroll, long-press menu), and a
   * release outside the window entirely, which fires neither of the first two.
   */
  useEffect(() => {
    const release = (): void => {
      held.current = false
      engine.cutscene.hold(false)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('blur', release)
      // A transport that unmounts mid-drag must not leave the playhead frozen
      // for the rest of the session.
      engine.cutscene.hold(false)
    }
  }, [engine])

  const grab = useCallback(() => {
    held.current = true
    // What the hold *means* — the published frame stands still — belongs to the
    // session, because both transports need the same rule and neither owned it.
    engine.cutscene.hold(true)
  }, [engine])

  /*
   * Seek, or decline — never throw.
   *
   * `CutsceneDirector.seek` throws when nothing is playing, and a scene stops
   * *itself* inside `sample` the moment it passes its last frame: up to a
   * whole poll interval before the transport drawing it has noticed. A click
   * on the restart button or a nudge of the range input inside that window
   * threw out of an event handler, where React's error boundaries cannot see
   * it — so the surrounding `ErrorBoundary` did nothing and the interaction
   * was simply lost, with a console exception as the only sign.
   */
  const seek = useCallback(
    (frame: number): boolean => {
      if (engine.harness.cutsceneStatus() === null) return false
      engine.harness.seekCutscene(frame)
      return true
    },
    [engine],
  )

  return { held, grab, seek }
}
