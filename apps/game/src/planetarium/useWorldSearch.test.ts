import { beforeEach, expect, it, vi } from 'vitest'
import type { WorldMatch, WorldQuery } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useWorldSearch, type WorldSearch } from './useWorldSearch.ts'

const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  cleanup: null as (() => void) | null,
}))

// Exercise the subscription in Node. React state retains the last published
// snapshot while the real hook attaches to a controlled asynchronous search.
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    hooks.state = initial
    return [
      initial,
      (next: unknown) => {
        hooks.state = typeof next === 'function' ? next(hooks.state) : next
      },
    ]
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => () => void) => {
    hooks.cleanup = effect()
  },
  useCallback: (callback: unknown) => callback,
}))

function searchEngine() {
  const pending: {
    onBatch: (
      matches: readonly WorldMatch[],
      progress: number,
      total: number,
    ) => void
    resolve: (matches: readonly WorldMatch[]) => void
    cancel: ReturnType<typeof vi.fn>
  }[] = []
  const engine = {
    harness: {
      findWorlds: (
        _query: WorldQuery,
        options: { onBatch: (typeof pending)[number]['onBatch'] },
      ) => {
        let resolve!: (matches: readonly WorldMatch[]) => void
        const done = new Promise<readonly WorldMatch[]>((finish) => {
          resolve = finish
        })
        const cancel = vi.fn()
        pending.push({
          onBatch: options.onBatch,
          resolve,
          cancel,
        })
        return { done, cancel, systems: 64 }
      },
    },
  } as unknown as GameEngine
  return { pending, engine }
}

const matches = Array.from({ length: 1500 }, (_, index) => ({
  address: `s:example/b:${index}`,
  lightYears: index / 100,
})) as WorldMatch[]

beforeEach(() => {
  hooks.state = undefined
  hooks.cleanup = null
})

it('publishes the final capped matches while preserving the full count', async () => {
  const { engine, pending } = searchEngine()
  const search = useWorldSearch(engine)
  search.run({ kinds: ['rocky'] }, 150)
  pending[0]!.onBatch(matches, 1, 2500)
  const nearest = matches.slice(0, 1000)
  pending[0]!.resolve(nearest)
  await Promise.resolve()
  const state = hooks.state as WorldSearch
  expect(state.matches).toHaveLength(1000)
  expect(state.matches).toEqual(nearest)
  expect(state).toMatchObject({
    total: 2500,
    progress: 1,
    running: false,
  })
})

it('ignores both batches and final results from a replaced search', async () => {
  const { engine, pending } = searchEngine()
  const search = useWorldSearch(engine)
  search.run({ kinds: ['rocky'] }, 150)
  search.run({ kinds: ['gas-giant'] }, 25)
  expect(pending[0]!.cancel).toHaveBeenCalledOnce()
  const current = hooks.state
  pending[0]!.onBatch(matches, 1, 1500)
  pending[0]!.resolve(matches)
  await Promise.resolve()
  expect(hooks.state === current).toBe(true)
  pending[1]!.resolve([])
  await Promise.resolve()
  expect(hooks.state).toMatchObject({
    matches: [],
    running: false,
    progress: 1,
  })
})

it('releases the subscription before unmounting cancels its worker jobs', async () => {
  const { engine, pending } = searchEngine()
  const search = useWorldSearch(engine)
  search.run({ kinds: ['rocky'] }, 150)
  hooks.cleanup!()
  expect(pending[0]!.cancel).toHaveBeenCalledOnce()
  const current = hooks.state
  pending[0]!.onBatch(matches, 1, 1500)
  pending[0]!.resolve(matches)
  await Promise.resolve()
  expect(hooks.state === current).toBe(true)
})
