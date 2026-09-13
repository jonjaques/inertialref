import { describe, expect, it, vi } from 'vitest'
import { openSession } from '../session.ts'
import type { GuideStatus } from '../harness.ts'

describe('the optional guide host', () => {
  it('is unavailable headlessly and never constructs a conversation', async () => {
    const session = openSession()
    expect(session.harness.guideStatus().available).toBe(false)
    expect((await session.harness.guideAsk('Saturn')).available).toBe(false)
    session.dispose()
  })

  it('reads the installed host and bounds explicit diagnostic asks', async () => {
    const status: GuideStatus = {
      available: true,
      loaded: false,
      state: 'idle',
      connection: 'offline',
      planId: null,
      stopIndex: null,
      requestRevision: 0,
      viewRevision: null,
      microphone: 'off',
      guideMuted: false,
      automatic: false,
    }
    const ask = vi.fn(async () => status)
    const session = openSession({
      render: { guide: () => ({ status: () => status, ask }) },
    })
    expect(session.harness.guideStatus()).toEqual(status)
    expect(ask).not.toHaveBeenCalled()
    await session.harness.guideAsk('  Saturn  ')
    expect(ask).toHaveBeenCalledWith('Saturn')
    await expect(session.harness.guideAsk('x'.repeat(4001))).rejects.toThrow(
      '4000',
    )
    expect(ask).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})
