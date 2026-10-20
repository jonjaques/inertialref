import { describe, expect, it, vi } from 'vitest'
import { openSession } from '../session.ts'
import { NO_GUIDE_USAGE, type GuideStatus } from '../host.ts'

describe('the optional guide host', () => {
  it('is unavailable headlessly and never constructs a conversation', async () => {
    const session = openSession()
    // `absent`, not `unavailable`: no guide in this mode is not a deployment
    // that does not offer one, and a script can tell the two apart.
    expect(session.harness.guideStatus()).toMatchObject({
      available: false,
      state: 'absent',
    })
    expect(session.harness.guideTrace()).toEqual([])
    expect(session.harness.guideTrace(true)).toEqual([])
    expect((await session.harness.guideAsk('Saturn')).available).toBe(false)
    session.dispose()
  })

  it('reads the installed host and bounds explicit diagnostic asks', async () => {
    const status: GuideStatus = {
      available: true,
      loaded: false,
      state: 'idle',
      connection: 'offline',
      sessionId: null,
      viewRevision: null,
      microphone: 'off',
      paused: false,
      pendingCalls: 0,
      inFlight: false,
      usage: NO_GUIDE_USAGE,
    }
    const ask = vi.fn(async () => status)
    const trace = vi.fn(() => [])
    const session = openSession({
      render: { guide: () => ({ status: () => status, ask, trace }) },
    })
    expect(session.harness.guideStatus()).toEqual(status)
    expect(ask).not.toHaveBeenCalled()
    expect(session.harness.guideTrace(true)).toEqual([])
    expect(trace).toHaveBeenCalledWith(true)
    await session.harness.guideAsk('  Saturn  ')
    expect(ask).toHaveBeenCalledWith('Saturn')
    await expect(session.harness.guideAsk('x'.repeat(4001))).rejects.toThrow(
      '4000',
    )
    expect(ask).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})
