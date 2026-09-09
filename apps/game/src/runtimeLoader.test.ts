import { describe, expect, it, vi } from 'vitest'
import { createRuntimeLoader } from './runtimeLoader.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('runtime loading', () => {
  it('prepares browser services before starting the app and catalog together', async () => {
    const events: string[] = []
    const app = deferred<string>()
    const catalog = deferred<string>()
    const load = createRuntimeLoader({
      prepare: async () => {
        events.push('prepare')
      },
      app: () => {
        events.push('app')
        return app.promise
      },
      catalog: () => {
        events.push('catalog')
        return catalog.promise
      },
    })

    const pending = load()
    await Promise.resolve()
    expect(events).toEqual(['prepare', 'app', 'catalog'])
    catalog.resolve('stars')
    app.resolve('canvas')
    await expect(pending).resolves.toEqual({ App: 'canvas', catalog: 'stars' })
  })

  it('shares startup across StrictMode effect replay and later navigations', async () => {
    const prepare = vi.fn(async () => {})
    const app = vi.fn(async () => 'canvas')
    const catalog = vi.fn(async () => 'stars')
    const load = createRuntimeLoader({ prepare, app, catalog })
    const first = load()

    expect(load()).toBe(first)
    await first
    expect(load()).toBe(first)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(app).toHaveBeenCalledTimes(1)
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it.each(['prepare', 'app', 'catalog'] as const)(
    'returns a rejected promise when %s fails so the shell can report it',
    async (failing) => {
      const failure = new Error(`${failing} failed`)
      const step = (name: string) => async () => {
        if (name === failing) throw failure
        return name
      }
      const load = createRuntimeLoader({
        prepare: async () => {
          await step('prepare')()
        },
        app: step('app'),
        catalog: step('catalog'),
      })

      await expect(load()).rejects.toBe(failure)
    },
  )
})
