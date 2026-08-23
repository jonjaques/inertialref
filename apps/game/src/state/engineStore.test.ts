import { describe, expect, it, vi } from 'vitest'
import type { HarnessStatus, ObserverStatus } from '@inertialref/devtools'
import type { Playhead } from '../cinema/session.ts'
import {
  createEngineStore,
  type EngineSnapshot,
  type EngineSource,
  sampleOnce,
  startEngineSampler,
} from './engineStore.ts'

/*
 * The engine-to-React seam, without React.
 *
 * What is worth testing here is not zustand — it is that the sampler reads the
 * engine through the port and nothing else, that a selector's bail-out actually
 * bails out, and that stopping the sampler stops it. All three are Node-side
 * facts, which is the point of the port: no world, no DOM, no renderer.
 */

/** A `HarnessStatus` is deep and none of it is read here; only identity is. */
const status = (tick: number): HarnessStatus =>
  ({ world: { tick } }) as unknown as HarnessStatus

/** The rest of the port, at rest. Overridden per test where it is the subject. */
const idle = {
  showShip: true,
  showOrbits: false,
  flareArtifacts: 1,
  cutscene: { sample: (): Playhead | null => null },
  harness: {
    status: () => status(0),
    observerStatus: (): ObserverStatus | null => null,
  },
}

const EMPTY: EngineSnapshot = {
  status: null,
  cinema: false,
  observer: null,
  presentation: { showShip: false, showOrbits: false, flareArtifacts: 0 },
  playhead: null,
}

describe('the engine sampler', () => {
  it('publishes what the engine reports, and whether a cutscene is running', () => {
    const store = createEngineStore()
    const scene = {}
    let tick = 7
    const source: EngineSource = {
      ...idle,
      harness: { ...idle.harness, status: () => status(tick) },
      get cinematic() {
        return tick > 7 ? scene : null
      },
    }

    expect(store.getState()).toEqual(EMPTY)

    sampleOnce(store, source)
    expect(store.getState().status?.world.tick).toBe(7)
    expect(store.getState().cinema).toBe(false)

    tick = 8
    sampleOnce(store, source)
    expect(store.getState().status?.world.tick).toBe(8)
    expect(store.getState().cinema).toBe(true)
  })

  it('republishes a fresh status object, and a stable cutscene flag', () => {
    const store = createEngineStore()
    const source: EngineSource = {
      ...idle,
      // What the real harness does: walk the world and build a description.
      // Nothing is cached and nothing is reused.
      harness: { ...idle.harness, status: () => status(4) },
      cinematic: null,
    }

    sampleOnce(store, source)
    const first = store.getState()
    sampleOnce(store, source)
    const second = store.getState()

    /*
     * The property the whole seam is designed around, pinned here because it
     * is the one that is easy to lose and impossible to see.
     *
     * `status` is a new object every sample even when nothing moved, so
     * `Object.is` on it is always false and a consumer that selects the whole
     * thing re-renders at the sample rate no matter how still the world is.
     * That is why `useEngine` is documented as needing a narrow selector — and
     * why `cinema`, which is a boolean, is the cheap one. If a future sampler
     * starts caching, this goes red and the advice in `useEngine` needs
     * rewriting rather than quietly becoming wrong.
     *
     * The bail-out itself belongs to `useSyncExternalStore` and is not
     * re-tested here; what is tested is the input it depends on.
     */
    expect(second.status).not.toBe(first.status)
    expect(second.status).toEqual(first.status)
    expect(second.cinema).toBe(first.cinema)
  })

  it('samples immediately, then on the interval, and stops when stopped', () => {
    vi.useFakeTimers()
    try {
      const store = createEngineStore()
      let reads = 0
      const source: EngineSource = {
        ...idle,
        harness: {
          ...idle.harness,
          status: () => {
            reads += 1
            return status(reads)
          },
        },
        cinematic: null,
      }

      // Not one interval later: a mount that showed the empty snapshot for
      // 125 ms is a visible `starting…` on a world that has been running.
      const stop = startEngineSampler(store, source, 8)
      expect(reads).toBe(1)

      vi.advanceTimersByTime(1000)
      expect(reads).toBe(9)

      stop()
      vi.advanceTimersByTime(1000)
      expect(reads).toBe(9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes the presentation switches the engine is actually drawing', () => {
    /*
     * `NavPanel` used to mirror `engine.showShip` into its own state because no
     * snapshot published it, and it disagreed with `PlanetariumMode` the moment
     * either acted. A panel reads the engine's answer here, not its own memory
     * of what it asked for.
     */
    const store = createEngineStore()
    const engine = { showShip: true, showOrbits: false, flareArtifacts: 1 }
    const source: EngineSource = {
      ...idle,
      cinematic: null,
      get showShip() {
        return engine.showShip
      },
      get showOrbits() {
        return engine.showOrbits
      },
      get flareArtifacts() {
        return engine.flareArtifacts
      },
    }

    sampleOnce(store, source)
    expect(store.getState().presentation.showShip).toBe(true)

    engine.showShip = false
    engine.showOrbits = true
    sampleOnce(store, source)
    expect(store.getState().presentation).toEqual({
      showShip: false,
      showOrbits: true,
      flareArtifacts: 1,
    })
  })

  it('publishes the observer and the playhead through the one sampler', () => {
    // The point of widening: three components polled the director at three
    // rates and two more polled the observatory. Neither costs a timer now.
    const store = createEngineStore()
    const observer = { target: null } as unknown as ObserverStatus
    const playhead: Playhead = {
      id: 'tng-intro',
      frame: 1150,
      durationFrames: 2742,
      fps: 24,
      paused: true,
      ended: false,
    }
    sampleOnce(store, {
      ...idle,
      cinematic: null,
      harness: { ...idle.harness, observerStatus: () => observer },
      cutscene: { sample: () => playhead },
    })
    expect(store.getState().observer).toBe(observer)
    expect(store.getState().playhead).toBe(playhead)
  })

  it('selects a primitive that bails out, from a status that never does', () => {
    /*
     * The guardrail the widening ships with. A wide snapshot read widely is
     * worse than the props it replaced: `status` is a fresh object graph every
     * sample, so a selector over the whole thing re-renders at the sample rate
     * however still the world is. A primitive is `Object.is`-stable.
     */
    const store = createEngineStore()
    const source: EngineSource = { ...idle, cinematic: null }
    sampleOnce(store, source)
    const paused = (): boolean => store.getState().presentation.showShip
    const first = paused()
    sampleOnce(store, source)
    expect(paused()).toBe(first)
    // ...while the whole status is a different object every time.
    const wide = store.getState().status
    sampleOnce(store, source)
    expect(store.getState().status).not.toBe(wide)
  })
})
