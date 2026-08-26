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
 * So there is no interval here. The effect keys off a *bucket* of simulated
 * time, taken out of the engine snapshot through a selector that returns an
 * integer — a primitive, so `Object.is` bails out of the re-render on every
 * sample where the bucket has not changed. The cadence then follows the thing
 * being described rather than a number somebody picked: at 1× a rebuild is one
 * per simulated hour, and under warp it is as often as the page's finest row
 * actually moves.
 *
 * **The bucket widens with the warp, and that is the whole of it.** A fixed
 * hour is right at 1× and wrong at the top of the transport: the snapshot is
 * republished at 8 Hz, so above 3600 / 0.125 = 28,800× the simulated hour turns
 * over on *every* sample and this rebuilds a full dossier eight times a second
 * — which is exactly the cost the paragraph above says a dossier must not be.
 * Scaling the bucket by the time scale holds the rebuild rate at roughly one
 * per second of wall clock whatever the transport is set to, and 8 Hz is the
 * floor either way, because nothing here can fire between snapshots.
 *
 * `react-shell.md`'s rule is "do not add a timer", and the two polls that remain
 * in the overlay are there because they are not field reads. This one would
 * have been a third and does not need to be.
 */

/**
 * Simulated seconds a rebuild is worth, at 1×. One hour: the finest row on the
 * page is a countdown in days, so an hour is already finer than it can show.
 */
const RESOLUTION = 3_600

/**
 * How many wall-clock seconds a bucket should cover, at most.
 *
 * One second, which at the 8 Hz sample rate is one rebuild in eight — the point
 * where the cost stops being a rounding error on a panel that is already
 * re-rendering. Below `RESOLUTION` this has no effect at all; it only binds
 * once the warp is high enough to outrun an hour per sample.
 */
const MIN_SECONDS_PER_REBUILD = 1

export function useDossier(
  engine: GameEngine,
  requested: string | null,
): Dossier | null {
  /*
   * The observatory's own target, not only the mode's React mirror of it.
   *
   * `PlanetariumMode.target` is written by its `focus` callback and by nothing
   * else, so every other route to the camera — `ir.look` from the console, a
   * cutscene, a `?at=` restore, the flight harness — moved the camera and left
   * this panel describing the body before it, with no sign it was stale. The
   * observatory is the thing that owns what is being looked at; ask it.
   */
  const looking = useEngine(
    (snapshot) => snapshot.observer?.target?.address ?? null,
  )
  const address = looking ?? requested

  const bucket = useEngine((snapshot) => {
    const world = snapshot.status?.world
    const width = Math.max(
      RESOLUTION,
      (world?.timeScale ?? 1) * MIN_SECONDS_PER_REBUILD,
    )
    return Math.floor((world?.time ?? 0) / width)
  })
  /*
   * The record, and the address it is the record *of*.
   *
   * Carried together because the effect runs after paint: on the render where
   * the target changes, `page` still holds the body before it, and returning it
   * paints Mars's name, mass, orbit and moons under a header that has already
   * become Europa's. In a mode where every click in the sky and every row in
   * the catalog changes the target, that flickers on each one.
   */
  const [built, setBuilt] = useState<{
    readonly of: string | null
    readonly page: Dossier | null
  }>({ of: null, page: null })

  useEffect(() => {
    if (address === null) {
      setBuilt({ of: null, page: null })
      return
    }
    try {
      setBuilt({ of: address, page: engine.harness.dossier(address) })
    } catch {
      // The address names a system that has been unloaded, or a world that a
      // save load replaced under us. An object panel that threw would take the
      // whole overlay with it through the error boundary; showing nothing is
      // what the caller already handles.
      setBuilt({ of: address, page: null })
    }
  }, [engine, address, bucket])

  return built.of === address ? built.page : null
}
