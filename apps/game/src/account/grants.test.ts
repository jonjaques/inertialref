import { describe, expect, it, vi } from 'vitest'
import type { Feature } from '@inertialref/protocol'
import { createGrants } from './grants.ts'

/** An ask the test answers by hand, one deferred answer per call. */
function asks() {
  const pending: ((features: readonly Feature[]) => void)[] = []
  const ask = vi.fn(
    () =>
      new Promise<readonly Feature[]>((resolve) => {
        pending.push(resolve)
      }),
  )
  return { ask, answer: (i: number, f: readonly Feature[]) => pending[i]!(f) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createGrants', () => {
  it('asks once per signed-in user and publishes the answer', async () => {
    const { ask, answer } = asks()
    const owner = createGrants(ask)
    const heard = vi.fn()
    owner.subscribe(heard)
    owner.forUser('user_a')
    owner.forUser('user_a')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(owner.current()).toEqual([])
    answer(0, ['solo'])
    await settle()
    expect(owner.current()).toEqual(['solo'])
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('never asks for nobody, and clears on a sign-out', async () => {
    const { ask, answer } = asks()
    const owner = createGrants(ask)
    owner.forUser(null)
    expect(ask).not.toHaveBeenCalled()
    owner.forUser('user_a')
    answer(0, ['solo', 'multiplayer'])
    await settle()
    owner.forUser(null)
    expect(owner.current()).toEqual([])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('drops an answer about the account before the current one', async () => {
    const { ask, answer } = asks()
    const owner = createGrants(ask)
    owner.forUser('user_admin')
    owner.forUser('user_plain')
    answer(1, [])
    answer(0, ['tour', 'solo', 'multiplayer'])
    await settle()
    expect(owner.current()).toEqual([])
  })

  it('reads a failed ask as granted nothing', async () => {
    const owner = createGrants(() => Promise.reject(new Error('offline')))
    owner.forUser('user_a')
    await settle()
    expect(owner.current()).toEqual([])
  })
})
