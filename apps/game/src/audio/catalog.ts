import {
  decodeSoundtrackCatalog,
  SOUNDTRACK_VERSION,
  type SoundtrackCatalog,
  type SoundtrackCategory,
  type SoundtrackTrack,
} from '@inertialref/protocol'
import { getLogger } from '@inertialref/shared'
import committed from '../../../../data/audio/catalog.json'

/*
 * The soundtrack the client plays, decoded once.
 *
 * Bundled rather than fetched: it is small (the tracks' words and numbers, not
 * their audio), it has to be there offline for the kept tracks to have names,
 * and the build that ships it is the build whose Worker allow-lists exactly
 * the files it names — `apps/server/src/media.ts` reads the same file.
 *
 * A catalog that does not decode is logged and replaced by an empty one, so a
 * bad commit costs the soundtrack and not the session. It cannot reach a
 * deploy that way: `soundtrack.test.ts` in the protocol package decodes the
 * committed file, and the Worker throws on it at module load.
 */

const log = getLogger('game.soundtrack')

const EMPTY: SoundtrackCatalog = {
  version: SOUNDTRACK_VERSION,
  generated: '',
  target: { integrated: -18, truePeak: -1 },
  tracks: [],
}

function load(): SoundtrackCatalog {
  const decoded = decodeSoundtrackCatalog(committed)
  if (decoded.ok) return decoded.value
  log.error('the soundtrack catalog does not decode; playing nothing', {
    error: decoded.error,
  })
  return EMPTY
}

export const SOUNDTRACK: SoundtrackCatalog = load()

const BY_ID = new Map(SOUNDTRACK.tracks.map((track) => [track.id, track]))

export const trackById = (id: string | null): SoundtrackTrack | null =>
  id === null ? null : (BY_ID.get(id) ?? null)

/** The categories that have a track in them, in catalog order. */
export const CATEGORIES_PRESENT = [
  ...new Set(SOUNDTRACK.tracks.map((track) => track.category)),
]

/** "Title — artist", with the performer where there is one. */
export function byline(
  track: Pick<SoundtrackTrack, 'artist' | 'performer'>,
): string {
  return track.performer === null
    ? track.artist
    : `${track.artist}, played by ${track.performer}`
}

/** A duration as `m:ss`, or `h:mm:ss` past the hour. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const s = whole % 60
  const m = Math.floor(whole / 60) % 60
  const h = Math.floor(whole / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** A long span in words — "2 h 14 min", "48 min" — for a category's length. */
export function span(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** How many tracks a category holds, and for how long they play. */
export function categorySize(category: SoundtrackCategory): {
  readonly count: number
  readonly seconds: number
} {
  const members = SOUNDTRACK.tracks.filter(
    (track) => track.category === category,
  )
  return {
    count: members.length,
    seconds: members.reduce((sum, track) => sum + track.duration, 0),
  }
}

/** "31 tracks · 2 h 14 min". */
export function describeSize(size: {
  readonly count: number
  readonly seconds: number
}): string {
  return `${size.count} ${size.count === 1 ? 'track' : 'tracks'} · ${span(size.seconds)}`
}

/**
 * Bytes as a reader weighs them: "14.2 MB", "1.3 GB".
 *
 * Decimal units, as the operating system's own storage settings print them,
 * so the figure beside Keep matches the one somebody checks it against.
 */
export function megabytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  const mb = bytes / 1e6
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}
