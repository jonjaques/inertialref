import {
  decode,
  decodeGuideVerdict,
  GUIDE_VERDICT_PATH,
  type GuideVerdict,
} from '@inertialref/protocol'

/*
 * What the Worker says about the guide, and the one reader of its answer.
 *
 * Its own module because two things read it and must not import each other:
 * the planetarium's access check, which runs on every mount and must not
 * bring the guide's runtime with it, and the runtime itself. The shape and
 * its decoder are `packages/protocol`'s, which the Worker's answer satisfies.
 */

export type { GuideVerdict }

/**
 * Ask the Worker for the verdict. Null for anything that is not one — no
 * answer, a refusal status, a proxy's error page, a stale shape — which the
 * callers read as "not offered" rather than an error on screen.
 */
export async function askGuideVerdict(
  headers: Headers,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<GuideVerdict | null> {
  try {
    const response = await fetcher(GUIDE_VERDICT_PATH, {
      headers,
      cache: 'no-store',
    })
    if (!response.ok) return null
    const decoded = decode(decodeGuideVerdict, await response.json())
    return decoded.ok ? decoded.value : null
  } catch {
    return null
  }
}
