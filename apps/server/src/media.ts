import { decodeSoundtrackCatalog } from '@inertialref/protocol'
import soundtrack from '../../../data/audio/catalog.json' with { type: 'json' }

/*
 * The files the site serves but does not carry.
 *
 * Two kinds. The cutscene's reference audio is somebody else's music, and its
 * use here is a fair-use claim this project is willing to make in a deployment
 * and not in a git history — which is permanent, mirrored by every fork and
 * indexed. The soundtrack is music anybody may redistribute, and the reason it
 * is not in the bundle is size rather than license: two encodings of a few
 * hours of music, which the static asset store would cap at 25 MiB a file and
 * every build would copy, and which the asset store would then serve without
 * byte ranges. Both kinds live in R2 and reach the browser from this table:
 *
 *   1. `pnpm media:pull` copies a `bundled` object into
 *      `apps/game/public/media/` before the build, so it ships in the bundle as
 *      an ordinary static asset and a plain GET of it costs nothing.
 *   2. The Worker reads it out of the bucket when the bundle does not have it —
 *      a build that ran without R2 credentials, which is what a fork gets — or
 *      when the request asks for a range, which the asset store ignores
 *      (`serveMedia.ts`). A soundtrack file is always this case.
 *
 * They are not two sources. It is one object under one key, reached by two
 * transports, and this file is the one place that says which.
 *
 * **An allow-list, not a prefix rule.** Mapping `/media/*` onto a key prefix
 * would make every object under that prefix world-readable, and the bucket is
 * the site's general storage rather than a public directory. A name that is not
 * in this table is a 404 before anything touches R2. The soundtrack's entries
 * come from `data/audio/catalog.json`, decoded, so a name is served exactly
 * when the catalog the client plays from lists it.
 *
 * Two imports and no more, both of them data and a decoder for it:
 * `scripts/media.mjs` runs this file directly under Node's type stripping, so
 * the build tool and the Worker read one table and cannot disagree about what
 * exists or where it is.
 */

/** The bucket bound as `env.MEDIA` in `cloudflare.config.ts`. */
export const MEDIA_BUCKET = 'inertialrefd-storage'

export interface MediaObject {
  /** The name under `/media/`, and the path under `apps/game/public/media/`. */
  readonly name: string
  /**
   * The R2 key.
   *
   * `dropbox/` is where a file is put by hand; the URL is deliberately not the
   * key, so rearranging the bucket is an edit here rather than a broken link.
   * A soundtrack file's key is its name: the name is content-addressed, so it
   * already says everything a key needs to.
   */
  readonly key: string
  /** The `Content-Type` it is stored and served with. */
  readonly type: string
  /** One line, for a build log that nobody is watching when it matters. */
  readonly what: string
  /**
   * Whether `pnpm media:pull` copies it into the bundle.
   *
   * The soundtrack is not: hours of it would be copied into every build and
   * uploaded with every deploy, a long track at these rates is past the asset
   * store's 25 MiB limit, and an `<audio>` element asks for ranges, which only
   * the bucket answers.
   */
  readonly bundled: boolean
}

/**
 * The cutscene's reference audio.
 *
 * **Two encodings of one track, and the m4a is the preferred one.** Safari is
 * the reason. The overlay does not play the reference audio, it *chases* a
 * clock with it — `currentTime` is written whenever the element drifts more
 * than 80 ms from the frame — and MPEG audio has no sample-accurate index, so
 * a seek lands on the nearest frame the decoder can resynchronize to. Chrome
 * hides that; Safari does not, and an mp3 seek there is coarse enough that the
 * correction lands outside tolerance and is issued again on the next frame, so
 * the track stutters instead of playing. AAC in an MP4 carries a sample table,
 * so a seek is exact.
 *
 * The two are the same audio and the same timeline: the m4a is transcoded from
 * the mp3 at 192 kbit/s AAC-LC, 48 kHz stereo, with `+faststart` so the moov
 * atom precedes the media data and playback can start on the first range
 * rather than after the whole file. Cross-correlated against the mp3 at 8 kHz
 * the best lag is 0 samples — the AAC encoder's priming delay is compensated
 * by the edit list — so a frame maps to the same instant in either, and the
 * client may pick whichever the browser can decode.
 */
const REFERENCE: readonly MediaObject[] = [
  {
    name: 'tng-intro.m4a',
    key: 'dropbox/tng-intro.m4a',
    type: 'audio/mp4',
    what: 'the cutscene reference audio, AAC',
    bundled: true,
  },
  {
    name: 'tng-intro.mp3',
    key: 'dropbox/tng-intro.mp3',
    type: 'audio/mpeg',
    what: 'the cutscene reference audio, MPEG',
    bundled: true,
  },
]

/**
 * The soundtrack's files, from the committed catalog.
 *
 * Decoded at module load, and a catalog that does not decode is a thrown error
 * rather than an empty list: the alternative is a deployment that 404s every
 * track while the client lists them all, which reads as an outage of R2
 * rather than as the bad commit it is. `soundtrack.test.ts` in the protocol
 * package and the ingest's own check hold the committed file to the decoder,
 * so the throw is never the first place anybody hears about it.
 */
function soundtrackObjects(): readonly MediaObject[] {
  const decoded = decodeSoundtrackCatalog(soundtrack)
  if (!decoded.ok) throw new Error(`data/audio/catalog.json: ${decoded.error}`)
  return decoded.value.tracks.flatMap((track) =>
    track.files.map((file) => ({
      name: file.name,
      key: file.name,
      // The catalog's type names the codec for `canPlayType`; a stored
      // object's `Content-Type` is the container's, without parameters.
      type: file.type.split(';')[0]!.trim(),
      what: `${track.title}, ${track.artist} (${file.name.split('.').at(-1)})`,
      bundled: false,
    })),
  )
}

/**
 * The objects served under `/media/`.
 *
 * `mediaFor` is an allow-list, so an entry here is what makes a name exist at
 * all. A deployment may have any of them or none; the client probes for the
 * cutscene's and falls back to the next track for the soundtrack's.
 */
export const MEDIA: readonly MediaObject[] = [
  ...REFERENCE,
  ...soundtrackObjects(),
]

const BY_NAME = new Map(MEDIA.map((object) => [object.name, object]))

/** The object a `/media/` name refers to, or `null` if it is not one we serve. */
export function mediaFor(name: string): MediaObject | null {
  return BY_NAME.get(name) ?? null
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
