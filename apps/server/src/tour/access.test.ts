import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AccountUnavailableError } from '../account.ts'
import { fakeClerk, session, SITE, type Signer, signer } from '../testTokens.ts'
import { grantsGuide, guideAccess } from './access.ts'

/*
 * The verdict, end to end short of Clerk: the deployment's configuration as
 * the Worker's `Env`, a real session token, and Clerk's Backend API answered
 * by a stub — the instance's key set and the private metadata a person set in
 * the dashboard. The Worker carries only a secret key, so the key set is the
 * path the signature check takes here too.
 */

let issuer: Signer
beforeAll(async () => {
  issuer = await signer()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/*
 * A fresh secret key per call: the key set and the grants are held per key
 * for the isolate (`account.ts`), so a second case reusing one would read the
 * first one's.
 */
let instances = 0
function env(overrides: Record<string, unknown> = {}): Env {
  return {
    OPENAI_API_KEY: 'key-canary',
    CLERK_SECRET_KEY: `sk_test_access_${++instances}`,
    CLERK_ENABLED: 'true',
    TOUR_GUIDE_ENABLED: 'true',
    ...overrides,
  } as unknown as Env
}

/** Clerk, holding `user_2test` with the given private metadata. */
function clerkWith(privateMetadata: Record<string, unknown>, status = 200) {
  const clerk = fakeClerk(issuer, { user_2test: privateMetadata })
  clerk.state.status = status
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

const asking = (token?: string, site = SITE) =>
  new Request(`${site}/api/tour/sessions`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })

const GRANTED = { granted: true, userId: 'user_2test' }

describe('guideAccess', () => {
  it('grants the guide to an admin, or to an account given the tour', async () => {
    const token = await issuer.sign(session())
    for (const flags of [
      { admin: true },
      { tour: true },
      { admin: true, tour: true },
    ]) {
      const clerk = clerkWith(flags)
      const deployment = env()
      expect(await guideAccess(asking(token), deployment)).toEqual(GRANTED)
      // The secret key, and nothing from the visitor, authorizes the lookup.
      expect(clerk.lookups()[0]!.authorization).toBe(
        `Bearer ${deployment.CLERK_SECRET_KEY}`,
      )
    }
  })

  it('refuses a signed-in account without the grant', async () => {
    const token = await issuer.sign(session())
    for (const flags of [{}, { tour: false }, { tour: 'true' }, { admin: 1 }]) {
      clerkWith(flags)
      expect(await guideAccess(asking(token), env())).toEqual({
        granted: false,
        reason: 'not-granted',
      })
    }
  })

  it('does not ask Clerk about somebody who is not signed in', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clerk = clerkWith({ admin: true })
    const signedOut = { granted: false, reason: 'signed-out' }
    expect(await guideAccess(asking(), env())).toEqual(signedOut)
    const forged = await (await signer()).sign(session())
    expect(await guideAccess(asking(forged), env())).toEqual(signedOut)
    expect(clerk.lookups()).toEqual([])
  })

  it('is unavailable on a deployment that does not offer it, before any token is read', async () => {
    const token = await issuer.sign(session())
    const clerk = clerkWith({ admin: true })
    const unavailable = { granted: false, reason: 'unavailable' }
    for (const overrides of [
      // No provider to spend on.
      { OPENAI_API_KEY: undefined },
      { OPENAI_API_KEY: '' },
      // The guide switched off.
      { TOUR_GUIDE_ENABLED: 'false' },
      { TOUR_GUIDE_ENABLED: false },
      // No accounts, or none that can read a grant: a JWT key alone can
      // verify a session and cannot read private metadata.
      { CLERK_ENABLED: 'false' },
      { CLERK_SECRET_KEY: undefined },
    ])
      expect(await guideAccess(asking(token), env(overrides))).toEqual(
        unavailable,
      )
    // The production host Clerk does not serve has no accounts, so no guide.
    expect(
      await guideAccess(
        asking(token, 'https://inertialref.jonjaques.com'),
        env(),
      ),
    ).toEqual(unavailable)
    // Decided from the deployment alone: Clerk is never asked, not even for
    // the key set.
    expect(clerk.state.calls).toEqual([])
    // A switch spelled any other way leaves the guide on.
    expect(
      await guideAccess(asking(token), env({ TOUR_GUIDE_ENABLED: 'no' })),
    ).toEqual(GRANTED)
  })

  it('treats a deleted user as ungranted and an unreachable Clerk as the server’s fault', async () => {
    const token = await issuer.sign(session({ sub: 'user_gone' }))
    clerkWith({ admin: true })
    expect(await guideAccess(asking(token), env())).toEqual({
      granted: false,
      reason: 'not-granted',
    })
    clerkWith({ admin: true }, 500)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      guideAccess(asking(await issuer.sign(session())), env()),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
  })
})

describe('the grant, held', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks Clerk once a minute per user, however many requests ask', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const token = await issuer.sign(session())
    const clerk = clerkWith({ tour: true })
    const deployment = env()
    const verdicts = await Promise.all(
      Array.from({ length: 4 }, () => guideAccess(asking(token), deployment)),
    )
    expect(verdicts.every((verdict) => verdict.granted)).toBe(true)
    // Four at once share one call, and a second later is still that answer.
    expect(clerk.lookups()).toHaveLength(1)
    vi.advanceTimersByTime(59_000)
    await guideAccess(asking(token), deployment)
    expect(clerk.lookups()).toHaveLength(1)
    // A grant revoked in the dashboard is read at the next ask past a minute.
    clerk.state.users.user_2test = {}
    vi.advanceTimersByTime(1_000)
    expect(await guideAccess(asking(token), deployment)).toEqual({
      granted: false,
      reason: 'not-granted',
    })
    expect(clerk.lookups()).toHaveLength(2)
  })

  it('does not hold a failed lookup', async () => {
    const token = await issuer.sign(session())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deployment = env()
    const clerk = clerkWith({ admin: true }, 500)
    await expect(guideAccess(asking(token), deployment)).rejects.toBeInstanceOf(
      AccountUnavailableError,
    )
    clerk.state.status = 200
    expect(await guideAccess(asking(token), deployment)).toEqual(GRANTED)
    expect(clerk.lookups()).toHaveLength(2)
  })
})

describe('grantsGuide', () => {
  it('reads the two flags strictly', () => {
    expect(grantsGuide({ admin: true })).toBe(true)
    expect(grantsGuide({ tour: true })).toBe(true)
    expect(grantsGuide({ admin: 'yes', tour: 'true' })).toBe(false)
    expect(grantsGuide({})).toBe(false)
  })
})
