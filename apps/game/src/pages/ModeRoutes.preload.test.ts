import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GameLoader from '../GameLoader.tsx'
import { ModeRoutes } from './ModeRoutes.tsx'

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  runtime: vi.fn(() => new Promise<never>(() => {})),
  preload: vi.fn(() => Promise.resolve()),
}))

// Capture passive effects without starting a DOM. Running them after the
// render models hydration while the deliberately pending runtime stays absent.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect)
  },
}))
vi.mock('../runtimeLoader.ts', () => ({ loadRuntime: hooks.runtime }))
vi.mock('./modeLoader.ts', () => ({
  preloadMode: hooks.preload,
  modeLoaders: {
    cinema: async () => ({ default: () => null }),
    flight: async () => ({ default: () => null }),
    planetarium: async () => ({ default: () => null }),
  },
}))

beforeEach(() => {
  hooks.effects.length = 0
  hooks.runtime.mockClear()
  hooks.preload.mockClear()
})

describe('mode prefetch at hydration', () => {
  it.each([
    ['/play/solo', 'flight'],
    ['/planetarium', 'planetarium'],
    ['/cinema/tng-intro', 'cinema'],
  ])('starts %s while the engine is still loading', (path, mode) => {
    renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(GameLoader),
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(ModeRoutes, {
            engine: null,
            dev: { panels: [], open: false, onOpenChange: () => {} },
            onNotice: () => {},
          }),
        ),
      ),
    )

    expect(hooks.runtime).not.toHaveBeenCalled()
    expect(hooks.preload).not.toHaveBeenCalled()
    for (const effect of hooks.effects) effect()
    expect(hooks.runtime).toHaveBeenCalledOnce()
    expect(hooks.preload).toHaveBeenCalledExactlyOnceWith(mode)
  })
})
