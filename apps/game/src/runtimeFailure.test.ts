import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import {
  createRuntimeFailureStore,
  runGraphicsFrame,
  runtimeFailure,
} from './runtimeFailure.ts'
import { RuntimeNotice } from './RuntimeNotice.tsx'
import GameLoader from './GameLoader.tsx'

it('keeps the original failure and unsubscribes observers', () => {
  const store = createRuntimeFailureStore()
  const listener = vi.fn()
  const unsubscribe = store.subscribe(listener)
  store.report('graphics', new Error('Pipeline rejected'))
  store.report('runtime', 'Cleanup failed')
  expect(store.getSnapshot()).toEqual({
    kind: 'graphics',
    detail: 'Pipeline rejected',
  })
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe()
})

it('contains a frame exception, stops later frames, and keeps SSR free of client failure state', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  runGraphicsFrame(() => {
    throw new Error('Draw failed')
  })
  const next = vi.fn()
  runGraphicsFrame(next)
  expect(next).not.toHaveBeenCalled()
  expect(runtimeFailure.getSnapshot()?.detail).toBe('Draw failed')
  expect(renderToStaticMarkup(createElement(GameLoader))).toBe('')
  log.mockRestore()
})

it('offers reading routes and an explicit retry without promising graphics will finish', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/planetarium'] },
      createElement(RuntimeNotice, {
        failure: { kind: 'restart', detail: 'Interrupted graphics session' },
      }),
    ),
  )
  expect(html).toContain('Graphics not supported')
  expect(html).toContain('prevent another restart')
  expect(html).toContain('href="/docs"')
  expect(html).toContain('Try graphics again')
  expect(html).not.toContain('when graphics are ready')
})
