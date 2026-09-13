import { describe, expect, it, vi } from 'vitest'
import { GuideLifetime } from './lifetime.ts'

describe('the guide belongs to the mode', () => {
  it('does no work until the panel requests its runtime', async () => {
    const create = vi.fn(async () => ({ end: vi.fn() }))
    const owner = new GuideLifetime(create)
    const release = owner.acquire()
    expect(create).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([owner.load(), owner.load()])
    expect(a).toBe(b)
    expect(create).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
    expect(a.end).toHaveBeenCalledTimes(1)
  })

  it('survives StrictMode effect cleanup and setup without closing the session', async () => {
    const runtime = { end: vi.fn() }
    const owner = new GuideLifetime(async () => runtime)
    const release = owner.acquire()
    await owner.load()
    release()
    const releaseAgain = owner.acquire()
    await Promise.resolve()
    expect(runtime.end).not.toHaveBeenCalled()
    releaseAgain()
    await Promise.resolve()
    expect(runtime.end).toHaveBeenCalledTimes(1)
  })

  it('closes a lazy runtime that resolves after the mode exits', async () => {
    const runtime = { end: vi.fn() }
    let complete!: (value: typeof runtime) => void
    const owner = new GuideLifetime(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const release = owner.acquire()
    const pending = owner.load()
    release()
    await Promise.resolve()
    complete(runtime)
    await pending
    expect(runtime.end).toHaveBeenCalledTimes(1)
  })
})
