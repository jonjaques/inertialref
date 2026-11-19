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
import { beginGraphicsSession, SETTLED_MS } from './graphicsSession.ts'
import { watchRendererValidation } from './render/rendererErrors.ts'
import type { WebGPURenderer } from 'three/webgpu'

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

it.each(['sync', 'async'] as const)(
  'keeps a %s WebGPU pipeline refusal on the graphics notice until the visitor retries',
  async (path) => {
    const detail =
      'The combined byte size of all variables in the private address space exceeds 8192 bytes'
    class GPUPipelineError extends Error {
      readonly reason = 'validation'
    }
    const error = new GPUPipelineError(detail)
    const createRenderPipeline = vi.fn(() => ({}))
    const createRenderPipelineAsync = vi.fn(async () => {
      throw error
    })
    const device = {
      createRenderPipeline,
      createRenderPipelineAsync,
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn(async () => ({ message: detail })),
    }
    const renderer = {
      backend: { isWebGPUBackend: true, device },
    } as unknown as WebGPURenderer
    const reload = vi.fn()
    const tab = new EventTarget()
    const values = new Map<string, string>()
    vi.stubGlobal(
      'window',
      Object.assign(tab, {
        location: { reload },
        sessionStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
      }),
    )
    vi.useFakeTimers()
    const failures = createRuntimeFailureStore()
    const changed = vi.fn()
    failures.subscribe(changed)
    const stop = watchRendererValidation(renderer, (cause) =>
      failures.report('graphics', cause),
    )
    try {
      expect(beginGraphicsSession()).toBe(true)
      if (path === 'async') {
        await expect(device.createRenderPipelineAsync()).rejects.toBe(error)
      } else {
        device.pushErrorScope('validation')
        device.createRenderPipeline()
        await device.popErrorScope()
      }
      const failure = failures.getSnapshot()
      expect(failure).toEqual({ kind: 'graphics', detail })
      expect(changed).toHaveBeenCalledOnce()
      const html = renderToStaticMarkup(
        createElement(
          MemoryRouter,
          { initialEntries: ['/planetarium'] },
          createElement(RuntimeNotice, { failure: failure! }),
        ),
      )
      expect(html).toContain('role="alert"')
      expect(html).toContain('Graphics not supported')
      expect(html).toContain(detail)
      expect(html).toContain('href="/docs"')
      expect(html).toContain('Try graphics again')
      vi.advanceTimersByTime(2 * SETTLED_MS)
      expect(reload).not.toHaveBeenCalled()
      expect(failures.getSnapshot()).toBe(failure)
      expect(
        createRenderPipeline.mock.calls.length +
          createRenderPipelineAsync.mock.calls.length,
      ).toBe(1)
    } finally {
      stop()
      tab.dispatchEvent(new Event('pagehide'))
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  },
)
