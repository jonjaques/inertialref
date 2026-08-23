/*
 * The files the site serves but does not carry.
 *
 * One entry today: the cutscene's reference audio, which is somebody else's
 * music. Its use here is a fair-use claim this project is willing to make in a
 * deployment and not in a git history — which is permanent, mirrored by every
 * fork and indexed. So it lives in R2 and reaches the browser two ways, and
 * both of them start from this table:
 *
 *   1. `pnpm media:pull` copies it into `apps/game/public/media/` before the
 *      build, so it ships in the bundle as an ordinary static asset. Free,
 *      never wakes the script, and `Range` is the asset server's problem.
 *   2. The Worker reads it out of the bucket when the bundle does not have it —
 *      a build that ran without R2 credentials, which is what a fork gets.
 *
 * They are not two sources. It is one object under one key, reached by two
 * transports, and this file is the one place that says which.
 *
 * **An allow-list, not a prefix rule.** Mapping `/media/*` onto a key prefix
 * would make every object under that prefix world-readable, and the bucket is
 * the site's general storage rather than a public directory. A name that is not
 * in this table is a 404 before anything touches R2.
 *
 * No imports, deliberately: `scripts/media.mjs` runs this file directly under
 * Node's type stripping so the build tool and the Worker cannot disagree about
 * what exists or where it is.
 */

/** The bucket bound as `env.MEDIA` in `wrangler.jsonc`. */
export const MEDIA_BUCKET = 'inertialrefd-storage'

export interface MediaObject {
  /** The name under `/media/`, and the filename in `apps/game/public/media/`. */
  readonly name: string
  /**
   * The R2 key.
   *
   * `dropbox/` is where a file is put by hand; the URL is deliberately not the
   * key, so rearranging the bucket is an edit here rather than a broken link.
   */
  readonly key: string
  readonly type: string
  /** One line, for a build log that nobody is watching when it matters. */
  readonly what: string
}

export const MEDIA: readonly MediaObject[] = [
  {
    name: 'tng-intro.mp3',
    key: 'dropbox/tng-intro.mp3',
    type: 'audio/mpeg',
    what: 'the cutscene reference audio',
  },
]

/** The object a `/media/` name refers to, or `null` if it is not one we serve. */
export function mediaFor(name: string): MediaObject | null {
  return MEDIA.find((object) => object.name === name) ?? null
}

/* ------------------------------------------------------------------------- */
/* Range                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * What R2 hands back after a ranged `get`.
 *
 * Restated here rather than imported from `@cloudflare/workers-types` so this
 * module keeps its "no imports" property — `scripts/media.mjs` loads it under
 * plain Node, where those types do not exist.
 *
 * **All three fields are optional, and that is the correction rather than a
 * convenience.** The published `R2Range` is a union of three exclusive shapes,
 * so the obvious implementation narrows with `'suffix' in range`. The object
 * workerd actually hands over has *all three keys present*, two of them set to
 * `undefined` — so `in` is true for a range that has no suffix, and the math
 * runs `size - undefined`. Every number came out `NaN`, `Content-Length` was
 * silently replaced by the runtime from the real body length, and the only
 * visible symptom was `Content-Range: bytes NaN-NaN/2747091` on a response that
 * was otherwise correct. Narrow on the *value*, never on the key.
 */
export interface StorageRange {
  readonly offset?: number | undefined
  readonly length?: number | undefined
  readonly suffix?: number | undefined
}

export interface ResolvedRange {
  readonly offset: number
  readonly length: number
  /** The `Content-Range` value for a 206. */
  readonly contentRange: string
}

/**
 * Turn R2's answer into the numbers a 206 needs.
 *
 * Pure, and separated from the handler for the reason `routes.ts` is: this is
 * the half with arithmetic in it, and it runs in plain Node where the handler
 * needs workerd. It is worth testing because every one of the three shapes is
 * a different subtraction and the failure mode is silent — a `Content-Range`
 * that is off by one byte does not error, it corrupts the tail of whatever the
 * player is listening to.
 *
 * `size` is the size of the whole object, never of the slice.
 */
export function resolveRange(
  range: StorageRange,
  size: number,
): ResolvedRange | null {
  const suffix = typeof range.suffix === 'number' ? range.suffix : null
  const offset =
    suffix === null ? (range.offset ?? 0) : Math.max(0, size - suffix)
  if (!Number.isFinite(offset) || offset >= size) return null

  const requested =
    suffix ?? (typeof range.length === 'number' ? range.length : size - offset)
  // A client may ask past the end; the answer is the rest of the object, not an
  // error, and a Content-Range naming a byte that does not exist is worse than
  // either.
  const length = Math.min(requested, size - offset)
  if (!Number.isFinite(length) || length <= 0) return null

  return {
    offset,
    length,
    contentRange: `bytes ${offset}-${offset + length - 1}/${size}`,
  }
}
