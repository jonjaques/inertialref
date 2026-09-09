import { beforeEach, describe, expect, it, vi } from 'vitest'

const imported: string[] = []
let flightFailure: Error | null = null
beforeEach(() => {
  vi.resetModules()
  imported.length = 0
  flightFailure = null
  vi.doMock('../cinema/CinemaMode.tsx', () => {
    imported.push('cinema')
    return { CinemaMode: () => null }
  })
  vi.doMock('../flight/FlightMode.tsx', () => {
    if (flightFailure !== null) throw flightFailure
    imported.push('flight')
    return { FlightMode: () => null }
  })
  vi.doMock('../planetarium/PlanetariumMode.tsx', () => {
    imported.push('planetarium')
    return { PlanetariumMode: () => null }
  })
})

describe('selected mode modules', () => {
  it('leaves public pages free of interactive mode imports', async () => {
    const { preloadMode } = await import('./modeLoader.ts')
    expect(preloadMode('menu')).toBeNull()
    expect(preloadMode('docs')).toBeNull()
    expect(imported).toEqual([])
  })

  it.each(['flight', 'planetarium', 'cinema'] as const)(
    'loads only %s and shares its promise with React.lazy and effect replay',
    async (mode) => {
      const { preloadMode, modeLoaders } = await import('./modeLoader.ts')
      expect(imported).toEqual([])
      const pending = preloadMode(mode)
      expect(modeLoaders[mode]()).toBe(pending)
      expect(preloadMode(mode)).toBe(pending)
      await pending
      expect(imported).toEqual([mode])
    },
  )

  it('preserves a failed prefetch for the route error boundary', async () => {
    // One factory per path avoids racing two queued doMock registrations.
    flightFailure = new Error('chunk unavailable')
    const { preloadMode, modeLoaders } = await import('./modeLoader.ts')
    const pending = preloadMode('flight')!
    const failure: unknown = await pending.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(modeLoaders.flight()).toBe(pending)
    await expect(modeLoaders.flight()).rejects.toBe(failure)
  })
})
