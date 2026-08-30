import { useEffect, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { DocFraming } from './content.ts'

/*
 * The masthead's camera.
 *
 * The backdrop holds the observatory for the whole visit (`stanceForPath`
 * for the docs arm). This hook only re-aims: the framing changes when the
 * reader moves between wings, and it has to change without releasing the
 * stance underneath it. Releasing and re-pushing per wing would hand the
 * camera back to whatever is below for a frame, which is a visible cut to
 * the ship's chase view in the middle of a navigation.
 *
 * Where it points is `GameEngine.#step`'s (AGENTS.md, "no fourth camera
 * producer"). The phase is the wing's declared phase, set once; a rAF ramp
 * would be animation in a reading room, and it is the one place a wall clock
 * would have to enter the masthead.
 */

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
   * Destructured, because the effect below keys on the four *values* rather
   * than on the object.
   *
   * Not because the object churns per render — it does not. `loadManifest`
   * memoizes its promise, `useManifest` holds the one resolved object, and
   * `wingFor` returns a member of `manifest.wings`, so `wing.framing` is the
   * same reference for the life of the session. What the values survive is the
   * manifest being *replaced*: a second fetch, or a wing whose framing is
   * unchanged arriving inside a new object, would re-aim the camera for no
   * change at all. The dependency is what the camera is actually pointed at, so
   * that is what it is written as.
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

    observatory.setPhase(phase, tilt)
  }, [engine, address, phase, tilt, fill])

  return body
}
