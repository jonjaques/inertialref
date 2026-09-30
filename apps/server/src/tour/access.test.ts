import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AccountKeys, AccountUnavailableError } from '../account.ts'
import { session, SITE, type Signer, signer } from '../testTokens.ts'
import { grantsGuide, guideAccess } from './access.ts'

/*
 * The grant, end to end short of Clerk: a real session token verified with
 * the PEM key, and Clerk's user lookup answered by a stub with the private
 * metadata a person set in the dashboard.
 */

let issuer: Signer
beforeAll(async () => {
  issuer = await signer()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/*
 * A fresh secret key per call: grants are held per key and user for a minute
 * (`account.ts`), so a second case reusing one would read the first one's.
 */
let instances = 0
const keys = (overrides: Partial<AccountKeys> = {}): AccountKeys => ({
  secretKey: `sk_test_lookup_${++instances}`,
  jwtKey: issuer.pem,
  ...overrides,
})

/** Clerk's Backend API, holding one user with the given private metadata. */
function clerkWith(privateMetadata: Record<string, unknown>, status = 200) {
  const lookup = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    status === 200 && String(input).endsWith('/v1/users/user_2test')
      ? Response.json({
          id: 'user_2test',
          object: 'user',
          private_metadata: privateMetadata,
          public_metadata: {},
          unsafe_metadata: {},
        })
      : Response.json(
          { errors: [{ code: 'resource_not_found', message: 'not found' }] },
          { status: status === 200 ? 404 : status },
        ),
  )
  vi.stubGlobal('fetch', lookup)
  return lookup
}

const NOBODY = { signedIn: false, authorized: false, userId: null }

const asking = async (token?: string) =>
  new Request(`${SITE}/api/tour/sessions`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })

describe('guideAccess', () => {
  it('grants the guide to an admin, or to an account given the tour', async () => {
    const token = await issuer.sign(session())
    for (const flags of [
      { admin: true },
      { tour: true },
      { admin: true, tour: true },
    ]) {
      const lookup = clerkWith(flags)
      const held = keys()
      expect(await guideAccess(await asking(token), held)).toEqual({
        signedIn: true,
        authorized: true,
        userId: 'user_2test',
      })
      // The secret key, and nothing from the visitor, authorizes the lookup.
      expect(
        new Headers(lookup.mock.calls[0]![1]?.headers).get('authorization'),
      ).toBe(`Bearer ${held.secretKey}`)
    }
  })

  it('refuses a signed-in account without the grant', async () => {
    const token = await issuer.sign(session())
    for (const flags of [{}, { tour: false }, { tour: 'true' }, { admin: 1 }]) {
      clerkWith(flags)
      expect(await guideAccess(await asking(token), keys())).toEqual({
        signedIn: true,
        authorized: false,
        userId: 'user_2test',
      })
    }
  })

  it('does not ask Clerk about somebody who is not signed in', async () => {
    const lookup = clerkWith({ admin: true })
    expect(await guideAccess(await asking(), keys())).toEqual(NOBODY)
    const forged = await (await signer()).sign(session())
    expect(await guideAccess(await asking(forged), keys())).toEqual(NOBODY)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('grants nothing without the secret key, which is what reads the grant', async () => {
    const token = await issuer.sign(session())
    clerkWith({ admin: true })
    expect(
      await guideAccess(await asking(token), keys({ secretKey: undefined })),
    ).toEqual(NOBODY)
  })

  it('treats a deleted user as ungranted and an unreachable Clerk as the server’s fault', async () => {
    const token = await issuer.sign(session({ sub: 'user_gone' }))
    clerkWith({ admin: true })
    expect(await guideAccess(await asking(token), keys())).toEqual({
      signedIn: true,
      authorized: false,
      userId: 'user_gone',
    })
    clerkWith({ admin: true }, 500)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      guideAccess(await asking(await issuer.sign(session())), keys()),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
  })
})

describe('the grant, held', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks Clerk once a minute per user, however many requests ask', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const token = await issuer.sign(session())
    const lookup = clerkWith({ tour: true })
    const held = keys()
    const verdicts = await Promise.all(
      Array.from({ length: 4 }, async () =>
        guideAccess(await asking(token), held),
      ),
    )
    expect(verdicts.every((verdict) => verdict.authorized)).toBe(true)
    // Four at once share one call, and a second later is still that answer.
    expect(lookup).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(59_000)
    await guideAccess(await asking(token), held)
    expect(lookup).toHaveBeenCalledTimes(1)
    // A grant revoked in the dashboard is read at the next ask past a minute.
    clerkWith({})
    vi.advanceTimersByTime(1_000)
    expect(await guideAccess(await asking(token), held)).toMatchObject({
      authorized: false,
    })
  })

  it('does not hold a failed lookup', async () => {
    const token = await issuer.sign(session())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const held = keys()
    clerkWith({ admin: true }, 500)
    await expect(guideAccess(await asking(token), held)).rejects.toBeInstanceOf(
      AccountUnavailableError,
    )
    const lookup = clerkWith({ admin: true })
    expect(await guideAccess(await asking(token), held)).toMatchObject({
      authorized: true,
    })
    expect(lookup).toHaveBeenCalledTimes(1)
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
