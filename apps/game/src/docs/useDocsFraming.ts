import { useEffect, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { DocFraming } from './content.ts'

/*
 * The masthead's camera.
 *
 * The same mechanism the front door uses — a stance pushed on mount, an
 * observatory target, and a phase ramp driven by real elapsed time — with one
 * difference that is the whole reason this is a hook rather than four lines in
 * a component: the framing changes when the reader moves between wings, and it
 * has to change without releasing the stance underneath it. Releasing and
 * re-pushing per wing would hand the camera back to whatever is below for a
 * frame, which is a visible cut to the ship's chase view in the middle of a
 * navigation.
 *
 * So the stance is pushed once for the whole visit and only the *target* is
 * re-aimed. That is legal — the stance owns the observatory's lifetime, not
 * where it points, which is `GameEngine.#step`'s (AGENTS.md, "no fourth camera
 * producer").
 */

/** How fast the phase ramps, degrees per second. */
const PHASE_RATE = -1.5

/**
 * How much of the lens's ghost chain a masthead shows.
 *
 * The same third the front door allows, and for the same reason: the ghosts run
 * along the line from the star through the center of the frame, and in a band
 * this wide that line lands across the title. What survives at a third is the
 * anamorphic streak, which is a blade of light across a horizontal band and is
 * the best thing that can happen to one.
 */
const FLARE_ARTIFACTS = 0.35

/** What the masthead says it is looking at. */
export interface FramedBody {
  readonly name: string
  readonly detail: string
  readonly kind: string
}

export function useDocsFraming(
  engine: GameEngine,
  framing: DocFraming | undefined,
): FramedBody | null {
  const [body, setBody] = useState<FramedBody | null>(null)

  /*
   * The stance, for as long as the reading room is open. Nothing about it
   * depends on the wing, which is why it is its own effect: an effect keyed on
   * the framing would release and re-push on every navigation.
   */
  useEffect(() => {
    const stance = engine.presentation.push({
      showShip: false,
      showOrbits: false,
      flareArtifacts: FLARE_ARTIFACTS,
      observatory: true,
    })
    return () => stance.release()
  }, [engine])

  /*
   * Destructured, because the effect below keys on the four *values* rather
   * than on the object.
   *
   * Not because the object churns per render — it does not. `loadManifest`
   * memoizes its promise, `useManifest` holds the one resolved object, and
   * `wingFor` returns a member of `manifest.wings`, so `wing.framing` is the
   * same reference for the life of the session. What the values survive is the
   * manifest being *replaced*: a second fetch, or a wing whose framing is
   * unchanged arriving inside a new object, would re-aim the camera and restart
   * the phase ramp for no change at all. The dependency is what the camera is
   * actually pointed at, so that is what it is written as.
   */
  const address = framing?.address
  const phase = framing?.phase
  const tilt = framing?.tilt
  const fill = framing?.fill

  useEffect(() => {
    if (address === undefined || phase === undefined || tilt === undefined)
      return
    const observatory = engine.harness.observatory

    try {
      /*
       * `ease: true`, which is the opposite of the front door's choice and is
       * right for the opposite reason. The menu arrives at a framing with
       * nothing before it, so easing would be a camera drifting in from
       * nowhere. Here there is always a previous wing, and the flight between
       * Earth and Saturn — fourteen decades of distance, over about a second —
       * is the section's one authored moment.
       */
      const status = observatory.focus(address, { fill, ease: true })
      setBody(
        status.target === null
          ? null
          : {
              name: status.target.name,
              detail: status.target.detail,
              kind: status.target.kind,
            },
      )
    } catch {
      /* A world without this body is not a world this build makes, and a
         masthead that throws is a documentation site nobody can read. The band
         stays black, the readout stays empty, and the words are unaffected. */
      setBody(null)
      return
    }

    let handle = 0
    const opened = performance.now()
    const drift = (): void => {
      handle = window.requestAnimationFrame(drift)
      const elapsed = (performance.now() - opened) / 1000
      observatory.setPhase(phase + elapsed * PHASE_RATE, tilt)
    }
    handle = window.requestAnimationFrame(drift)
    return () => window.cancelAnimationFrame(handle)
  }, [engine, address, phase, tilt, fill])

  return body
}
