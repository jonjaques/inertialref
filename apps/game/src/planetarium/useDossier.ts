import { useEffect, useState } from 'react'
import type { Dossier } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useEngine } from '../state/engineStore.ts'

/*
 * The record for whatever the camera is on, kept current without a timer.
 *
 * Building a dossier walks the system and derives thirty numbers, so it is a
 * *query* rather than a field read — the same family as the star survey, and
 * the same reason neither of them belongs in the 8 Hz snapshot. But it is not
 * the same family as the survey in one respect that matters: the survey goes
 * stale because the camera moves, which is continuous, and this goes stale
 * because the *clock* moves, which the snapshot already publishes.
 *
 * So there is no interval here. The effect keys off the simulated hour, taken
 * out of the engine snapshot through a selector that returns an integer — a
 * primitive, so `Object.is` bails out of the re-render on every one of the eight
 * samples a second where the hour has not changed. At 1× that is one rebuild
 * per simulated hour, which is one every hour; at 100,000× time warp it is one
 * every thirty-six milliseconds, which is exactly when the countdown on the
 * page is actually moving. The cadence follows the thing being described rather
 * than a number somebody picked.
 *
 * `react-shell.md`'s rule is "do not add a timer", and the two polls that remain
 * in the overlay are there because they are not field reads. This one would
 * have been a third and does not need to be.
 */

/** Simulated seconds a rebuild is worth. One hour: the finest row is in days. */
const RESOLUTION = 3_600

export function useDossier(
  engine: GameEngine,
  address: string | null,
): Dossier | null {
  const hour = useEngine((snapshot) =>
    Math.floor((snapshot.status?.world.time ?? 0) / RESOLUTION),
  )
  const [page, setPage] = useState<Dossier | null>(null)

  useEffect(() => {
    if (address === null) {
      setPage(null)
      return
    }
    try {
      setPage(engine.harness.dossier(address))
    } catch {
      // The address names a system that has been unloaded, or a world that a
      // save load replaced under us. An object panel that threw would take the
      // whole overlay with it through the error boundary; showing nothing is
      // what the caller already handles.
      setPage(null)
    }
  }, [engine, address, hour])

  return page
}
