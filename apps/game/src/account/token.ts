import { getToken } from '@clerk/react'
import { PUBLISHABLE_KEY } from './accounts.ts'

/**
 * The signed-in session's token, for a request to the Worker — or `null` for a
 * build without accounts, a visitor who is not signed in, or a provider that
 * never loaded.
 *
 * For code that is not a component: the guide's runtime is a plain object and
 * cannot call a hook. Clerk's standalone `getToken` waits up to ten seconds
 * for its script and throws if it never arrives; that is a visitor with no
 * session as far as a request is concerned, so it is answered as one. A token
 * is minted fresh when the cached one is near expiry, which is why a request
 * asks every time rather than holding one.
 */
export async function sessionToken(): Promise<string | null> {
  if (PUBLISHABLE_KEY === '') return null
  try {
    return await getToken()
  } catch {
    return null
  }
}
