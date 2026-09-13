import { describe, expect, it, vi } from 'vitest'
import { UNAVAILABLE_GUIDE } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GuideLifetime } from './lifetime.ts'
import { mountGuide } from './guide.ts'
import type { GuideRuntime } from './runtime.ts'

describe('the guide diagnostic adapter', () => {
  it('keeps status inert and shares one runtime with the panel', async () => {
    const runtime = {
      diagnostics: () => ({
        ...UNAVAILABLE_GUIDE,
        available: true,
        loaded: true,
      }),
      ask: vi.fn(async () => {}),
      end: vi.fn(),
    }
    const create = vi.fn(async () => runtime as unknown as GuideRuntime)
    const guide = new GuideLifetime(create)
    const engine = { guide: null } as unknown as GameEngine
    const release = mountGuide(engine, guide)
    expect(engine.guide!.status()).toMatchObject({
      available: true,
      loaded: false,
    })
    expect(create).not.toHaveBeenCalled()
    await engine.guide!.ask('Saturn')
    expect(await guide.load()).toBe(runtime)
    expect(create).toHaveBeenCalledOnce()
    expect(runtime.ask).toHaveBeenCalledWith('Saturn')
    release()
    expect(engine.guide).toBeNull()
    await Promise.resolve()
    expect(runtime.end).toHaveBeenCalledOnce()
  })

  it('declines an ask whose lazy import finishes after the mode exits', async () => {
    const runtime = {
      diagnostics: () => UNAVAILABLE_GUIDE,
      ask: vi.fn(async () => {}),
      end: vi.fn(),
    }
    let complete!: (value: GuideRuntime) => void
    const guide = new GuideLifetime<GuideRuntime>(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const engine = { guide: null } as unknown as GameEngine
    const release = mountGuide(engine, guide)
    const pending = engine.guide!.ask('Saturn')
    release()
    await Promise.resolve()
    complete(runtime as unknown as GuideRuntime)
    expect((await pending).available).toBe(false)
    expect(runtime.ask).not.toHaveBeenCalled()
    expect(runtime.end).toHaveBeenCalledOnce()
  })
})
