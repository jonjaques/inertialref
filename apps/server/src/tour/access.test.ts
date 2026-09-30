import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AccountUnavailableError } from '../account.ts'
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

const env = (overrides: Partial<Env> = {}): Env =>
  ({
    CLERK_SECRET_KEY: 'sk_test_lookup',
    CLERK_JWT_KEY: issuer.pem,
    ...overrides,
  }) as unknown as Env

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
      expect(await guideAccess(await asking(token), env())).toEqual({
        signedIn: true,
        authorized: true,
      })
      // The secret key, and nothing from the visitor, authorizes the lookup.
      expect(
        new Headers(lookup.mock.calls[0]![1]?.headers).get('authorization'),
      ).toBe('Bearer sk_test_lookup')
    }
  })

  it('refuses a signed-in account without the grant', async () => {
    const token = await issuer.sign(session())
    for (const flags of [{}, { tour: false }, { tour: 'true' }, { admin: 1 }]) {
      clerkWith(flags)
      expect(await guideAccess(await asking(token), env())).toEqual({
        signedIn: true,
        authorized: false,
      })
    }
  })

  it('does not ask Clerk about somebody who is not signed in', async () => {
    const lookup = clerkWith({ admin: true })
    expect(await guideAccess(await asking(), env())).toEqual({
      signedIn: false,
      authorized: false,
    })
    const forged = await (await signer()).sign(session())
    expect(await guideAccess(await asking(forged), env())).toEqual({
      signedIn: false,
      authorized: false,
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('grants nothing without the secret key, which is what reads the grant', async () => {
    const token = await issuer.sign(session())
    clerkWith({ admin: true })
    expect(
      await guideAccess(
        await asking(token),
        env({ CLERK_SECRET_KEY: undefined } as unknown as Partial<Env>),
      ),
    ).toEqual({ signedIn: false, authorized: false })
  })

  it('treats a deleted user as ungranted and an unreachable Clerk as the server’s fault', async () => {
    const token = await issuer.sign(session({ sub: 'user_gone' }))
    clerkWith({ admin: true })
    expect(await guideAccess(await asking(token), env())).toEqual({
      signedIn: true,
      authorized: false,
    })
    clerkWith({ admin: true }, 500)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      guideAccess(await asking(await issuer.sign(session())), env()),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
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
