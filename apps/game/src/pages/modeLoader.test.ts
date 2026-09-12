import { describe, expect, it } from 'vitest'
import { modeLoaders, preloadMode } from './modeLoader.ts'

describe('the mode loaders', () => {
  it('share one promise between the prefetch and the route', () => {
    expect(preloadMode('planetarium')).toBe(modeLoaders.planetarium())
    expect(preloadMode('menu')).toBeNull()
    expect(preloadMode('docs')).toBeNull()
  })

  it('mark the promise the way React.use reads it, so a landed chunk never suspends', async () => {
    const promise = modeLoaders.planetarium()
    expect(promise.status).toBe('pending')
    const module = await promise
    expect(promise.status).toBe('fulfilled')
    if (promise.status === 'fulfilled') expect(promise.value).toBe(module)
    expect(typeof module.default).toBe('function')
  })
})
