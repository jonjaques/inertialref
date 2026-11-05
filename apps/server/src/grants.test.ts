import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES } from '@inertialref/protocol'
import { accountStatus, granted, grants } from './grants.ts'
import { fakeClerk, session, SITE, type Signer, signer } from './testTokens.ts'

describe('grants', () => {
  it('grants a feature to its own flag', () => {
    for (const feature of FEATURES)
      expect(grants({ [feature]: true }, feature)).toBe(true)
  })

  it('grants every feature to an admin', () => {
    for (const feature of FEATURES)
      expect(grants({ admin: true }, feature)).toBe(true)
    // An admin whose feature flag says no is still an admin.
    expect(grants({ admin: true, solo: false }, 'solo')).toBe(true)
  })

  it('reads the flags strictly', () => {
    for (const value of ['true', 1, 'yes', {}, [true], null, false]) {
      const flags = Object.fromEntries(
        ['admin', ...FEATURES].map((name) => [name, value]),
      )
      for (const feature of FEATURES) expect(grants(flags, feature)).toBe(false)
    }
    for (const feature of FEATURES) expect(grants({}, feature)).toBe(false)
  })

  it('never lets one feature’s flag grant another', () => {
    fc.assert(
      fc.property(
        fc.subarray([...FEATURES]),
        fc.constantFrom(...FEATURES),
        (set, feature) => {
          const flags = Object.fromEntries(set.map((name) => [name, true]))
          expect(grants(flags, feature)).toBe(set.includes(feature))
        },
      ),
    )
  })
})

describe('granted', () => {
  it('lists what the flags grant, in FEATURES order, and every one for an admin', () => {
    expect(granted({ multiplayer: true, tour: true })).toEqual([
      'tour',
      'multiplayer',
    ])
    expect(granted({ admin: true })).toEqual(FEATURES)
    expect(granted({ admin: 'true', solo: 1 })).toEqual([])
  })
})

/*
 * The account record end to end short of Clerk, as `tour/access.test.ts`
 * drives the guide's verdict: a real session token, and Clerk's Backend API
 * answered by a stub holding `user_2test`'s private metadata.
 */
describe('accountStatus', () => {
  let issuer: Signer
  beforeAll(async () => {
    issuer = await signer()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // A fresh secret key per case: metadata is held per key for the isolate.
  let instances = 0
  const env = (overrides: Record<string, unknown> = {}): Env =>
    ({
      CLERK_SECRET_KEY: `sk_test_grants_${++instances}`,
      CLERK_ENABLED: 'true',
      ...overrides,
    }) as unknown as Env

  function clerkWith(privateMetadata: Record<string, unknown>) {
    const clerk = fakeClerk(issuer, { user_2test: privateMetadata })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const answered = clerk.answer(input, init)
        if (answered === null) throw new Error(`unexpected fetch ${input}`)
        return answered
      }),
    )
    return clerk
  }

  const asking = (token?: string) =>
    new Request(`${SITE}/api/account`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })

  it('carries the reading of the flags, never the flags', async () => {
    const token = await issuer.sign(session())
    clerkWith({ solo: true, note: 'beta tester' })
    const status = await accountStatus(asking(token), env())
    expect(status).toEqual({
      configured: true,
      signedIn: true,
      userId: 'user_2test',
      grants: ['solo'],
    })
    clerkWith({ admin: true })
    expect((await accountStatus(asking(token), env())).grants).toEqual(FEATURES)
  })

  it('grants nobody signed in anything, without asking Clerk', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clerk = clerkWith({ admin: true })
    expect(await accountStatus(asking(), env())).toEqual({
      configured: true,
      signedIn: false,
      userId: null,
      grants: [],
    })
    expect(
      await accountStatus(
        asking(await issuer.sign(session())),
        env({ CLERK_ENABLED: 'false' }),
      ),
    ).toEqual({ configured: false, signedIn: false, userId: null, grants: [] })
    expect(clerk.lookups()).toEqual([])
  })
})
