import { describe, expect, it, vi } from 'vitest'
import { UNAVAILABLE_GUIDE } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GuideLifetime } from './lifetime.ts'
import { mountGuide } from './guide.ts'
import type { GuideRuntime } from './runtime.ts'
import { createGuideAccess } from './verdict.ts'

const granted = () => {
  const access = createGuideAccess(async () => ({
    granted: true,
    voices: ['marin'],
  }))
  access.forUser('user_1')
  return access
}

describe('the guide diagnostic adapter', () => {
  it('keeps status inert and shares one runtime with the panel', async () => {
    const runtime = {
      diagnostics: () => ({
        ...UNAVAILABLE_GUIDE,
        available: true,
        loaded: true,
      }),
      ask: vi.fn(async () => {}),
      trace: vi.fn(() => []),
      end: vi.fn(),
    }
    const create = vi.fn(async () => runtime as unknown as GuideRuntime)
    const guide = new GuideLifetime(create)
    const engine = { guide: null } as unknown as GameEngine
    const access = granted()
    await Promise.resolve()
    const release = mountGuide(engine, guide, access)
    expect(engine.guide!.status()).toMatchObject({
      available: true,
      loaded: false,
    })
    expect(create).not.toHaveBeenCalled()
    expect(engine.guide!.trace!()).toEqual([])
    expect(create).not.toHaveBeenCalled()
    expect(engine.guide!.trace!(true)).toEqual([])
    await engine.guide!.ask('Saturn')
    expect(await guide.load()).toBe(runtime)
    expect(create).toHaveBeenCalledOnce()
    expect(runtime.ask).toHaveBeenCalledWith('Saturn')
    expect(runtime.trace).toHaveBeenCalledWith(true)
    expect(runtime.trace.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.ask.mock.invocationCallOrder[0]!,
    )
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
    const release = mountGuide(engine, guide, granted())
    const pending = engine.guide!.ask('Saturn')
    release()
    await Promise.resolve()
    complete(runtime as unknown as GuideRuntime)
    expect((await pending).available).toBe(false)
    expect(runtime.ask).not.toHaveBeenCalled()
    expect(runtime.end).toHaveBeenCalledOnce()
  })

  it('reports a refusal while no runtime is loaded', async () => {
    const guide = new GuideLifetime<GuideRuntime>(async () => {
      throw new Error('not loaded in this test')
    })
    const access = createGuideAccess(async () => ({
      granted: false,
      reason: 'not-granted',
    }))
    const engine = { guide: null } as unknown as GameEngine
    const release = mountGuide(engine, guide, access)
    expect(engine.guide!.status()).toMatchObject({
      available: false,
      state: 'checking',
    })
    access.forUser('user_1')
    await Promise.resolve()
    expect(engine.guide!.status()).toMatchObject({
      available: false,
      loaded: false,
      state: 'not-granted',
    })
    access.forUser(null)
    expect(engine.guide!.status().state).toBe('signed-out')
    release()
  })

  it('ends a live runtime when the grant is lost', async () => {
    const runtime = {
      diagnostics: () => UNAVAILABLE_GUIDE,
      end: vi.fn(),
    }
    const guide = new GuideLifetime(
      async () => runtime as unknown as GuideRuntime,
    )
    const access = granted()
    await Promise.resolve()
    const engine = { guide: null } as unknown as GameEngine
    const release = mountGuide(engine, guide, access)
    await guide.load()
    expect(runtime.end).not.toHaveBeenCalled()
    // A sign-out with the panel withdrawn would leave the microphone open and
    // nothing on screen to stop it.
    access.forUser(null)
    expect(runtime.end).toHaveBeenCalledOnce()
    release()
  })
})
