import { describe, expect, it } from 'vitest'
import type { GuideVerdict } from '@inertialref/protocol'
import { createGuideAccess } from './verdict.ts'

/** An ask the test answers by hand, in whatever order it likes. */
function controlled() {
  const pending: ((verdict: GuideVerdict | null) => void)[] = []
  const ask = () =>
    new Promise<GuideVerdict | null>((resolve) => {
      pending.push(resolve)
    })
  return { pending, ask }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the guide verdict, one per mode', () => {
  it('checks, then answers for whoever is signed in', async () => {
    const worker = controlled()
    const access = createGuideAccess(worker.ask)
    access.forUser('user_1')
    expect(access.current()).toEqual({ state: 'checking' })
    worker.pending[0]!({ granted: true, voices: ['marin'] })
    await settle()
    expect(access.current()).toEqual({ state: 'granted', voices: ['marin'] })
  })

  it('settles a signed-out visitor without asking', () => {
    const worker = controlled()
    const access = createGuideAccess(worker.ask)
    access.forUser(null)
    expect(access.current()).toEqual({ state: 'refused', reason: 'signed-out' })
    expect(worker.pending).toHaveLength(0)
  })

  it('discards an answer about the previous account', async () => {
    const worker = controlled()
    const access = createGuideAccess(worker.ask)
    access.forUser('granted_user')
    access.forUser('other_user')
    // The first account's grant lands after the switch, and must not be read
    // as one about the second.
    worker.pending[0]!({ granted: true, voices: ['marin'] })
    await settle()
    expect(access.current()).toEqual({ state: 'checking' })
    worker.pending[1]!({ granted: false, reason: 'not-granted' })
    await settle()
    expect(access.current()).toEqual({
      state: 'refused',
      reason: 'not-granted',
    })
  })

  it('asks once per user, and reads no answer as not offered', async () => {
    const worker = controlled()
    const access = createGuideAccess(worker.ask)
    access.forUser('user_1')
    access.forUser('user_1')
    expect(worker.pending).toHaveLength(1)
    worker.pending[0]!(null)
    await settle()
    expect(access.current()).toEqual({
      state: 'refused',
      reason: 'unavailable',
    })
  })
})
