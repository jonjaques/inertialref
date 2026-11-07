import { err, ok, type Result } from '@inertialref/shared'
import {
  decode,
  decodeArray,
  decodeEnum,
  decodeInteger,
  decodeNullable,
  decodeNumber,
  decodeObject,
  decodeString,
  type Decoder,
  refine,
} from './codec.ts'

/*
 * The soundtrack catalog: what the game may play, and what it has to say about
 * each piece while it does.
 *
 * Three programs read one file. `apps/ingest` writes `data/audio/catalog.json`
 * from the masters, the Worker allow-lists the files it names under `/media/`,
 * and the client plays them and prints their credits. The shape is declared
 * here rather than in any of the three so that none of them can drift from the
 * others, and it is decoded rather than cast because a JSON import's inferred
 * type is all `string`s: `category: string` is not a category, and a cast would
 * assert precisely what a validator exists to check.
 *
 * Every track's license is one of four, and each of the four permits a public
 * repository, a static site and a recorded video of the game. That is the filter
 * the sourcing spike applied (`docs/spikes.md` § 6). Anything with share-alike,
 * a non-commercial or no-derivatives term, or a library's "no standalone
 * redistribution", is not representable here at all, which is the point of
 * spelling the licenses out as a closed set rather than as a URL.
 */

export const SOUNDTRACK_VERSION = 1

/**
 * The playlist's categories, in the order a listener meets them.
 *
 * Ids rather than titles, because a preference stores which are switched off
 * and a title is copy that will be edited. Only categories with something in
 * them: a recording of an older work is the obvious fourth, and no recording
 * checked so far has a public-domain claim that survives its performer — a
 * category the player can name and never fill is a promise it cannot keep.
 */
export const SOUNDTRACK_CATEGORIES = ['ambient', 'lofi', 'signals'] as const

export type SoundtrackCategory = (typeof SOUNDTRACK_CATEGORIES)[number]

/**
 * What each category is called, and the one line that says what is in it.
 *
 * Here beside the ids rather than in the client, because the credits the
 * pipeline writes into `data/audio/LICENSE.md` are grouped under the same
 * headings the player draws, and two copies of three names is how a heading
 * comes to mean two things.
 */
export const SOUNDTRACK_CATEGORY_TITLES: Readonly<
  Record<SoundtrackCategory, { readonly title: string; readonly about: string }>
> = {
  ambient: {
    title: 'Ambient',
    about: 'Slow, spacious pieces written for looking up.',
  },
  lofi: {
    title: 'Lofi',
    about: 'Soft beats for a long look at the sky.',
  },
  signals: {
    title: 'Signals',
    about: 'Radio from spacecraft, made audible. Not music.',
  },
}

/**
 * The four licenses a track may carry.
 *
 * `attribution` is what decides whether the credit is an obligation or a
 * courtesy. The game prints every credit regardless: a player who records a
 * video needs the source of a CC0 track as much as a CC BY one when a claim
 * arrives, and the credit is the evidence that wins the dispute.
 */
export const SOUNDTRACK_LICENSES = {
  cc0: {
    name: 'CC0 1.0',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: false,
  },
  'public-domain': {
    name: 'Public domain',
    url: 'https://creativecommons.org/publicdomain/mark/1.0/',
    attribution: false,
  },
  'cc-by-3.0': {
    name: 'CC BY 3.0',
    url: 'https://creativecommons.org/licenses/by/3.0/',
    attribution: true,
  },
  'cc-by-4.0': {
    name: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: true,
  },
} as const

export type SoundtrackLicense = keyof typeof SOUNDTRACK_LICENSES

const LICENSE_IDS = Object.keys(SOUNDTRACK_LICENSES) as SoundtrackLicense[]

/** How many points a track's loudness contour has. */
export const CONTOUR_POINTS = 64

/** The quietest a contour point records, in LUFS. Silence is not −∞ on a chart. */
export const CONTOUR_FLOOR = -70

/** One encoding of a track. A track carries one file per codec. */
export interface SoundtrackFile {
  /**
   * The object's name under `/media/`, which is also its storage key.
   *
   * Content-addressed — `music/<id>.<digest>.<extension>` — so a re-encode is a
   * new name and a cached copy can never be a stale one. The service worker and
   * the Worker both lean on that: the first keeps a file across builds, the
   * second marks it immutable.
   */
  readonly name: string
  /** What `canPlayType` is asked, codecs included. `maybe` is not an answer. */
  readonly type: string
  readonly bytes: number
  readonly sha256: string
  /** The encoder's target, bits per second. */
  readonly bitrate: number
}

export interface SoundtrackTrack {
  /** Stable across a retitle: preferences store it, and so do saved orders. */
  readonly id: string
  readonly title: string
  /** The name the licensor publishes under. */
  readonly artist: string
  /** Who played it, for a recording of an older work; otherwise null. */
  readonly performer: string | null
  readonly release: string
  readonly year: number
  readonly category: SoundtrackCategory
  readonly license: SoundtrackLicense
  /**
   * The attribution line, whole: title, creator, source, license, and what was
   * changed. CC BY 4.0 § 3(a)(1) asks for all five "in any reasonable manner",
   * and one sentence that carries all of them is the reasonable manner for a
   * card that is on screen for six seconds.
   */
  readonly credit: string
  /** The licensor's own page for the release: where the license was read. */
  readonly licensor: string
  /** What this build did to the recording. § 3(a)(1)(B) asks to be told. */
  readonly modified: string
  /** Seconds, of the delivered files. */
  readonly duration: number
  /**
   * Where the music is, inside the file: the first and last moments above the
   * silence floor. A crossfade runs over the tail of the music rather than over
   * a stretch of digital silence the file happens to end with.
   */
  readonly cues: { readonly start: number; readonly end: number }
  /** The delivered loudness, EBU R128: integrated LUFS and true peak, dBTP. */
  readonly loudness: { readonly integrated: number; readonly truePeak: number }
  /**
   * Short-term loudness across the whole track, `CONTOUR_POINTS` integers in
   * LUFS, floored at `CONTOUR_FLOOR`. What a scrubber draws, and what a
   * transition reads to find a quiet place to enter.
   */
  readonly contour: readonly number[]
  /** Most preferred first. */
  readonly files: readonly SoundtrackFile[]
}

export interface SoundtrackCatalog {
  readonly version: typeof SOUNDTRACK_VERSION
  /** The day the pipeline wrote it. */
  readonly generated: string
  /** What every track was normalized toward: integrated LUFS and a dBTP ceiling. */
  readonly target: { readonly integrated: number; readonly truePeak: number }
  readonly tracks: readonly SoundtrackTrack[]
}

/* ------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A name the Worker may serve and a cache may key on.
 *
 * Narrow on purpose. The name becomes a URL path and a bucket key, so a `..`,
 * a leading slash or a space is not a quirk of one track — it is a request for
 * a key outside the music the catalog lists.
 */
const NAME = /^music\/[a-z0-9][a-z0-9-]*\.[0-9a-f]{10}\.(?:m4a|webm|mp3|ogg)$/

const ID = /^[a-z0-9][a-z0-9-]*$/

const decodeName = refine(
  decodeString,
  (value): value is string => NAME.test(value),
  'music/<id>.<10 hex>.<m4a|webm|mp3|ogg>',
)

const decodeId = refine(
  decodeString,
  (value): value is string => ID.test(value),
  'a lowercase, hyphenated id',
)

const decodeUrl = refine(
  decodeString,
  (value): value is string => value.startsWith('https://'),
  'an https URL',
)

const decodeFile: Decoder<SoundtrackFile> = decodeObject({
  name: decodeName,
  type: decodeString,
  bytes: decodeInteger,
  sha256: refine(
    decodeString,
    (value): value is string => /^[0-9a-f]{64}$/.test(value),
    'a sha-256 digest',
  ),
  bitrate: decodeInteger,
})

const decodeContour = refine(
  decodeArray(decodeInteger),
  (value): value is readonly number[] =>
    value.length === CONTOUR_POINTS &&
    value.every((point) => point >= CONTOUR_FLOOR && point <= 0),
  `${CONTOUR_POINTS} integers between ${CONTOUR_FLOOR} and 0`,
)

const decodeTrack: Decoder<SoundtrackTrack> = decodeObject({
  id: decodeId,
  title: decodeString,
  artist: decodeString,
  performer: decodeNullable(decodeString),
  release: decodeString,
  year: decodeInteger,
  category: decodeEnum(...SOUNDTRACK_CATEGORIES),
  license: decodeEnum(...LICENSE_IDS),
  credit: decodeString,
  licensor: decodeUrl,
  modified: decodeString,
  duration: decodeNumber,
  cues: decodeObject({ start: decodeNumber, end: decodeNumber }),
  loudness: decodeObject({ integrated: decodeNumber, truePeak: decodeNumber }),
  contour: decodeContour,
  files: refine(
    decodeArray(decodeFile),
    (value): value is readonly SoundtrackFile[] => value.length > 0,
    'at least one file',
  ),
})

/** A number literal; `decodeLiteral` is for strings. */
const decodeVersion: Decoder<typeof SOUNDTRACK_VERSION> = (value, path) =>
  value === SOUNDTRACK_VERSION
    ? ok(SOUNDTRACK_VERSION)
    : err(`${path || 'value'}: expected version ${SOUNDTRACK_VERSION}`)

const decodeCatalog: Decoder<SoundtrackCatalog> = decodeObject({
  version: decodeVersion,
  generated: decodeString,
  target: decodeObject({ integrated: decodeNumber, truePeak: decodeNumber }),
  tracks: decodeArray(decodeTrack),
})

/**
 * The catalog, believed, or the first thing wrong with it.
 *
 * Beyond the shape, three facts the shape cannot state: ids are unique, a cue
 * pair lies inside its track, and no two files share a name. Each has a reader
 * that depends on it — the playlist keys on the id, the crossfade reads the
 * cues, and the Worker's allow-list keys on the name.
 */
export function decodeSoundtrackCatalog(
  value: unknown,
): Result<SoundtrackCatalog, string> {
  const decoded = decode(decodeCatalog, value)
  if (!decoded.ok) return decoded
  const catalog = decoded.value
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const [index, track] of catalog.tracks.entries()) {
    const at = `tracks[${index}]`
    if (ids.has(track.id)) return err(`${at}.id: "${track.id}" is not unique`)
    ids.add(track.id)
    const { start, end } = track.cues
    if (!(start >= 0 && start < end && end <= track.duration + 0.05)) {
      return err(
        `${at}.cues: expected 0 ≤ start < end ≤ duration, got ${start}–${end} of ${track.duration}`,
      )
    }
    for (const file of track.files) {
      if (names.has(file.name)) {
        return err(`${at}.files: "${file.name}" is not unique`)
      }
      names.add(file.name)
      if (!file.name.startsWith(`music/${track.id}.`)) {
        return err(`${at}.files: "${file.name}" is not named for its track`)
      }
    }
  }
  return ok(catalog)
}

/** The license a track carries, as it is printed and linked. */
export const licenseOf = (
  track: Pick<SoundtrackTrack, 'license'>,
): (typeof SOUNDTRACK_LICENSES)[SoundtrackLicense] =>
  SOUNDTRACK_LICENSES[track.license]
