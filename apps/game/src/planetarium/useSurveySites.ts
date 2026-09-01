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
 * changes there is no list yet — returning `[]` there made the Ground section
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
   * The world's identity, not just the body's. A save load or a new game keeps
   * both `engine` and the address string — `s:SOL/b:2` names Earth in every
   * world — while the seed under them changes, and a survey keyed on the
   * address alone kept serving the previous universe's summit and basin
   * coordinates. The seed is the input the sites are actually a function of.
   */
  const seed = useEngine((snapshot) => snapshot.status?.world.seedHex ?? null)

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
    readonly seed: string | null
    readonly sites: readonly SurveySiteRow[]
  }>({ of: null, seed: null, sites: [] })

  useEffect(() => {
    if (address === null) {
      setBuilt({ of: null, seed: null, sites: [] })
      return
    }
    try {
      setBuilt({ of: address, seed, sites: engine.harness.sites(address) })
    } catch {
      // A star, an unloaded system, or a world a save replaced under us. An
      // empty list is what the panel already draws an empty state for; throwing
      // would take the whole overlay through the error boundary.
      setBuilt({ of: address, seed, sites: [] })
    }
  }, [engine, address, seed])

  // The seed is part of the guard, not just the effect: a save load that keeps
  // the address changes only the seed, and the paint between the load and the
  // effect would otherwise serve the previous world's coordinates.
  //
  // `null` for a null address too, and not `[]`. There is no body to have no
  // ground: drawing "no ground here yet — pick a solid body" for a session that
  // is looking at nothing is a claim about a body that does not exist, which is
  // the distinction the docstring above says this hook exists to keep.
  if (address === null) return null
  return built.of === address && built.seed === seed ? built.sites : null
}
