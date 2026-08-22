import { describe, expect, it, vi } from 'vitest'
import type { HarnessStatus } from '@inertialref/devtools'
import {
  createEngineStore,
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

describe('the engine sampler', () => {
  it('publishes what the engine reports, and whether a cutscene is running', () => {
    const store = createEngineStore()
    const scene = {}
    let tick = 7
    const source: EngineSource = {
      harness: { status: () => status(tick) },
      get cinematic() {
        return tick > 7 ? scene : null
      },
    }

    expect(store.getState()).toEqual({ status: null, cinema: false })

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
      // What the real harness does: walk the world and build a description.
      // Nothing is cached and nothing is reused.
      harness: { status: () => status(4) },
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
        harness: {
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
})
