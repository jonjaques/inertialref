import { useEffect, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useEngine } from '../state/engineStore.ts'

/*
 * The named places on whatever the camera is on.
 *
 * `useDossier`'s shape, minus the clock. A dossier goes stale because simulated
 * time moves; a survey does not — a body's highest ground is a pure function of
 * its seed and its radius, so the only thing that can invalidate this list is
 * pointing the camera at something else.
 *
 * It is an effect rather than a call in render for one measured reason: the
 * search is ~2,100 samples of fourteen-octave noise, about 20 ms on a body it
 * has not been asked about before. In render that is 20 ms of blocked paint on
 * every click in the sky; after paint it is a panel that fills in a frame later.
 * `surveySites` memoizes per body, so every render after the first is a map
 * lookup and the effect returns the same array.
 *
 * The address comes from the observatory rather than from the mode's React
 * mirror of it, for the reason `useDossier` gives at length: every other route
 * to the camera — the console, a cutscene, a `?at=` restore — moves it without
 * touching that mirror.
 */

export type SurveySiteRow = ReturnType<GameEngine['harness']['sites']>[number]

/**
 * The sites, or `null` while the search has not run for this body yet.
 *
 * `null` and `[]` are different answers and the panel draws different things
 * for them. The effect runs after paint, so on the render where the target
 * changes there is no list yet — returning `[]` there made the Surface panel
 * replace itself with "no ground here yet — pick a solid body" for one frame on
 * *every* body switch, including switches to bodies that have six sites. That
 * is the same distinction `Fact.value` makes between "none" and "not measured",
 * one layer up.
 */
export function useSurveySites(
  engine: GameEngine,
  requested: string | null,
): readonly SurveySiteRow[] | null {
  const looking = useEngine(
    (snapshot) => snapshot.observer?.target?.address ?? null,
  )
  const address = looking ?? requested

  /*
   * The list and the address it is a list *of*, carried together.
   *
   * The effect runs after paint, so on the render where the target changes the
   * state still holds the previous body's sites — six rows naming Iapetus's
   * summit under a header that has already become Miranda's, each of which
   * would send the camera to a latitude on the wrong world if pressed.
   */
  const [built, setBuilt] = useState<{
    readonly of: string | null
    readonly sites: readonly SurveySiteRow[]
  }>({ of: null, sites: [] })

  useEffect(() => {
    if (address === null) {
      setBuilt({ of: null, sites: [] })
      return
    }
    try {
      setBuilt({ of: address, sites: engine.harness.sites(address) })
    } catch {
      // A star, an unloaded system, or a world a save replaced under us. An
      // empty list is what the panel already draws an empty state for; throwing
      // would take the whole overlay through the error boundary.
      setBuilt({ of: address, sites: [] })
    }
  }, [engine, address])

  return built.of === address ? built.sites : null
}
