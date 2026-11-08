import { describe, expect, it } from 'vitest'
import { type IdentityPort, reconcileAccount } from './client.ts'

/** The SDK's persisted identity, and the calls made against it, in order. */
function sdk(distinctId: string, identified: boolean) {
  const calls: string[] = []
  const port: IdentityPort = {
    get_distinct_id: () => distinctId,
    _isIdentified: () => identified,
    identify: (id: string) => {
      calls.push(`identify ${id}`)
    },
    reset: () => {
      calls.push('reset')
    },
  }
  return { port, calls }
}

describe("PostHog's identity follows the account", () => {
  it('identifies an anonymous visitor who signs in, keeping what they did before', () => {
    const { port, calls } = sdk('anon_1', false)
    reconcileAccount(port, 'user_a')
    expect(calls).toEqual(['identify user_a'])
  })

  it('does nothing when the SDK already agrees', () => {
    const signedIn = sdk('user_a', true)
    reconcileAccount(signedIn.port, 'user_a')
    const signedOut = sdk('anon_1', false)
    reconcileAccount(signedOut.port, null)
    expect([...signedIn.calls, ...signedOut.calls]).toEqual([])
  })

  it('resets an identity this page never saw sign out', () => {
    // A sign-out in another tab, or a session that lapsed between visits.
    const { port, calls } = sdk('user_a', true)
    reconcileAccount(port, null)
    expect(calls).toEqual(['reset'])
  })

  it('resets before identifying a different account', () => {
    const { port, calls } = sdk('user_a', true)
    reconcileAccount(port, 'user_b')
    expect(calls).toEqual(['reset', 'identify user_b'])
  })
})
