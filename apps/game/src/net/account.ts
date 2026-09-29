import {
  ACCOUNT_PATH,
  type AccountStatus,
  decode,
  decodeAccountStatus,
} from '@inertialref/protocol'

/*
 * The client's half of `ACCOUNT_PATH`: asking the Worker who it thinks is
 * signed in.
 *
 * The browser's own answer is Clerk's, and it is enough for anything that
 * happens on this device. This one is the answer anything the server records
 * will be attributed under, and it can differ — a deployment with no key, a
 * token minted for another host — so it is asked for rather than assumed.
 *
 * Like the healthcheck, nothing here may block or throw into the game: every
 * failure is a state with a sentence.
 */

export type ServerAccount =
  | { readonly state: 'checking' }
  | { readonly state: 'answered'; readonly status: AccountStatus }
  | { readonly state: 'unreachable'; readonly detail: string }

export const CHECKING: ServerAccount = { state: 'checking' }

/**
 * `token` is Clerk's session token, or null for a signed-out visitor — who is
 * still worth asking, because "not configured" is an answer too.
 */
export async function askServer(
  token: string | null,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ServerAccount> {
  let response: Response
  try {
    response = await fetcher(ACCOUNT_PATH, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
  } catch {
    return { state: 'unreachable', detail: 'no server answered' }
  }
  if (!response.ok)
    return {
      state: 'unreachable',
      detail: `the server answered ${response.status}`,
    }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A captive portal's login page, or the dev server with no Worker behind
    // its proxy: a 200 that is not the server.
    return { state: 'unreachable', detail: 'the answer was not JSON' }
  }
  const decoded = decode(decodeAccountStatus, body)
  return decoded.ok
    ? { state: 'answered', status: decoded.value }
    : { state: 'unreachable', detail: 'the answer was not an account record' }
}
