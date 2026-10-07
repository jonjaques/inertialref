import { getLogger } from '@inertialref/shared'
import {
  type OrbitPath,
  type OrbitScopeContext,
  orbitScopeKey,
  visibleOrbits,
} from '@inertialref/devtools'

/*
 * The orbit traces, cached in two halves keyed on what each one reads.
 *
 * Sampling is Kepler's equation ~97 times for every body in every loaded
 * system — 18.4 ms on a Sol retarget, 22.2 ms on a Proxima one, on the exact
 * interaction the planetarium exists for — and it depends on nothing but the
 * world and its loaded systems. Filtering is a predicate over ~130 paths and
 * depends on the focus, which is what a retarget changes. Keyed together,
 * every focus change re-solved every orbit.
 *
 * Both halves key on the engine's world generation, so a replaced world
 * re-samples without anyone clearing this by hand. The anchor is what makes
 * the split legal: a path carries the instant it was built against and
 * `OrbitTraces` differences the primary's live pose against it, so an old
 * path follows a moving primary exactly. What does age is the *phase* — the
 * sweep starts at the body's own eccentric anomaly, so where the closed
 * curve's two ends meet drifts away from the body — and a full ellipse looks
 * the same wherever it is cut.
 */

const log = getLogger('game.engine')

export class OrbitTraceCache {
  #generation = -1
  #scopeKey = ''
  #all: readonly OrbitPath[] = []
  #allKey = ''
  #visible: readonly OrbitPath[] = []

  /** The traces to draw for this generation; none until one is built in it. */
  visible(generation: number): readonly OrbitPath[] {
    return generation === this.#generation ? this.#visible : []
  }

  /**
   * Orbits are off. Both keys go, so turning them back on re-samples too:
   * clearing only the scope key would re-filter, after an hour of warp, paths
   * swept at the anomaly each body had before it.
   */
  hide(): void {
    this.#visible = []
    this.#scopeKey = ''
    this.#allKey = ''
  }

  /**
   * Rebuild what changed: re-sample when the generation or the loaded set
   * moves, re-filter when the scope does, and nothing otherwise.
   */
  update(
    generation: number,
    systems: readonly string[],
    scope: OrbitScopeContext,
    sample: () => readonly OrbitPath[],
  ): void {
    const key = orbitScopeKey(systems, scope)
    if (generation === this.#generation && key === this.#scopeKey) return
    this.#scopeKey = key

    const allKey = `${generation}|${systems.join(',')}`
    if (allKey !== this.#allKey) {
      this.#allKey = allKey
      this.#all = sample()
      log.info('orbit paths sampled', {
        paths: this.#all.length,
        systems: systems.length,
      })
    }
    this.#generation = generation
    this.#visible = visibleOrbits(this.#all, scope)
    log.info('orbit traces rebuilt', {
      paths: this.#visible.length,
      of: this.#all.length,
      focus: scope.focus ?? 'everything',
    })
  }
}
