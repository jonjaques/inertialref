import { describe, expect, it } from 'vitest'
import type { OrbitPath, OrbitScopeContext } from '@inertialref/devtools'
import { OrbitTraceCache } from './orbitTraces.ts'

/*
 * The trace cache over a fake sampler: what it counts is how often the
 * expensive half runs, which is the whole point of splitting it.
 */

const path = (address: string, parent: string): OrbitPath =>
  ({ address, parent }) as unknown as OrbitPath

const PATHS = [path('a', 'sun'), path('b', 'sun'), path('a1', 'a')]

const scope = (focus: string | null): OrbitScopeContext =>
  ({
    focus,
    grandparent: focus === 'a' ? 'sun' : null,
    subject: focus,
    scope: 'context',
  }) as unknown as OrbitScopeContext

function counted() {
  let samples = 0
  return {
    sample: () => {
      samples += 1
      return PATHS
    },
    get samples() {
      return samples
    },
  }
}

describe('the orbit trace cache', () => {
  it('re-filters a retarget without re-sampling', () => {
    const cache = new OrbitTraceCache()
    const sampler = counted()
    cache.update(0, ['sol'], scope(null), sampler.sample)
    expect(cache.visible(0)).toHaveLength(3)
    cache.update(0, ['sol'], scope('a'), sampler.sample)
    cache.update(0, ['sol'], scope('a'), sampler.sample)
    expect(sampler.samples).toBe(1)
  })

  it('re-samples when the loaded set changes', () => {
    const cache = new OrbitTraceCache()
    const sampler = counted()
    cache.update(0, ['sol'], scope(null), sampler.sample)
    cache.update(0, ['sol', 'proxima'], scope(null), sampler.sample)
    expect(sampler.samples).toBe(2)
  })

  it('re-samples in a new generation, and draws nothing until it has', () => {
    const cache = new OrbitTraceCache()
    const sampler = counted()
    cache.update(0, ['sol'], scope(null), sampler.sample)
    expect(cache.visible(1)).toHaveLength(0)
    cache.update(1, ['sol'], scope(null), sampler.sample)
    expect(sampler.samples).toBe(2)
    expect(cache.visible(1)).toHaveLength(3)
  })

  it('re-samples when the traces come back on', () => {
    const cache = new OrbitTraceCache()
    const sampler = counted()
    cache.update(0, ['sol'], scope(null), sampler.sample)
    cache.hide()
    expect(cache.visible(0)).toHaveLength(0)
    cache.update(0, ['sol'], scope(null), sampler.sample)
    expect(sampler.samples).toBe(2)
  })
})
