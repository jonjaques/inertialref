import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/*
 * Where the data comes from, and how it is kept honest.
 *
 * Two rules, both learned the hard way by whoever wrote `docs/spikes.md`:
 *
 *   **Pin the URL and check what came back.** HYG's files are git-lfs pointers.
 *   Codeberg's `raw/` path serves the *pointer* — a valid, 133-byte text file
 *   that a downloader reports as a success and a CSV parser reports as a
 *   catalog with zero usable rows. Only the `media/` path serves the content.
 *   A pipeline that does not assert on what it received ingests the pointer and
 *   builds an empty galaxy.
 *
 *   **Record the digest, do not enforce it.** The NASA archive updates weekly
 *   and HYG updates when it updates, so a hard-coded hash would break the build
 *   every time astronomy published something — which is the opposite of what
 *   `docs/design/galaxy.md` wants. The digest of what was actually fetched is
 *   written into the manifest beside the artifact, so a rebuild that changes the
 *   output can always be traced to the input that changed.
 */

export interface Source {
  readonly key: string
  readonly name: string
  readonly url: string
  readonly file: string
  readonly licence: string
  /** Decompress after download. */
  readonly gzip?: boolean
  /** Fail if the decompressed payload is smaller than this. */
  readonly minimumBytes: number
}

/**
 * The NASA Exoplanet Archive is queried, not downloaded, so its "URL" is a TAP
 * query. `pscomppars` is the composite-parameters table: one row per planet with
 * the best published value for each field, rather than one row per publication.
 * A game wants the composite; a paper wants `ps`.
 *
 * 46 pc is 150 light-years, the radius `docs/spikes.md` settled on.
 */
const EXOPLANET_COLUMNS = [
  'pl_name',
  'pl_letter',
  'hostname',
  'hd_name',
  'hip_name',
  'sy_snum',
  'sy_pnum',
  'cb_flag',
  'discoverymethod',
  'disc_year',
  'pl_orbper',
  'pl_orbsmax',
  'pl_rade',
  'pl_bmasse',
  'pl_bmassprov',
  'pl_orbeccen',
  'pl_orbincl',
  'pl_orblper',
  'pl_eqt',
  'pl_insol',
  'st_spectype',
  'st_teff',
  'st_rad',
  'st_mass',
  'ra',
  'dec',
  'sy_dist',
].join(',')

const EXOPLANET_QUERY = `select ${EXOPLANET_COLUMNS} from pscomppars where sy_dist is not null and sy_dist < 46.0`

export const SOURCES: readonly Source[] = [
  {
    key: 'hyg',
    name: 'HYG v4.4',
    // `media/`, not `raw/` — see the header. The GitHub mirror is frozen at v4.1.
    url: 'https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz',
    file: 'hyg_v44.csv',
    licence: 'CC BY-SA 4.0',
    gzip: true,
    minimumBytes: 20_000_000,
  },
  {
    key: 'exoplanets',
    name: 'NASA Exoplanet Archive (pscomppars)',
    url:
      'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?format=csv&query=' +
      encodeURIComponent(EXOPLANET_QUERY),
    file: 'nea_pscomppars.csv',
    licence: 'No license stated; acknowledgment requested',
    minimumBytes: 100_000,
  },
]

export interface Fetched {
  readonly source: Source
  readonly text: string
  readonly sha256: string
  readonly bytes: number
  readonly cached: boolean
}

/**
 * The raw downloads live outside the repository.
 *
 * 34 MB of HYG is not something to commit to get a 200 KB artifact out of, and
 * the artifact is what the game needs. `.data/` is gitignored; the manifest
 * beside the built asset records exactly what produced it.
 */
export const rawDirectory = (root: string): string => join(root, '.data', 'raw')

export async function fetchSource(
  source: Source,
  root: string,
  { refresh = false } = {},
): Promise<Fetched> {
  const path = join(rawDirectory(root), source.file)
  mkdirSync(dirname(path), { recursive: true })

  let cached = false
  let text: string
  if (!refresh && exists(path)) {
    text = readFileSync(path, 'utf8')
    cached = true
    // A stale cache can hold a bad payload written by an older build of this
    // tool, so cached reads are checked too — with the remedy named.
    validate(source, text, cached)
  } else {
    const response = await fetch(source.url)
    if (!response.ok)
      throw new Error(
        `${source.name}: ${response.status} ${response.statusText} from ${source.url}`,
      )
    const body = new Uint8Array(await response.arrayBuffer())
    const decoded = source.gzip === true ? gunzipSync(body) : body
    text = new TextDecoder().decode(decoded)
    // Validated *before* it is written: a bad payload cached here would
    // re-throw from the cached branch on every later run, long after the
    // remote was fixed, with an error that talks about a service nobody
    // contacted.
    validate(source, text, cached)
    writeFileSync(path, text)
  }

  return {
    source,
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    cached,
  }
}

/**
 * Reject payloads that arrived with a 200 but are not the data — a git-lfs
 * pointer, or the TAP service's XML error body. Runs on the download before
 * it is cached and again on every cached read (a stale cache can hold a bad
 * payload written by an older build of this tool), and a cached failure
 * names its remedy: nothing about the remote is wrong, the cache is.
 */
function validate(source: Source, text: string, cached: boolean): void {
  const remedy = cached
    ? ` The cached copy in .data/raw is bad — re-run with --refresh to replace it.`
    : ''
  const bytes = Buffer.byteLength(text)
  if (bytes < source.minimumBytes)
    throw new Error(
      `${source.name}: got ${bytes} bytes, expected at least ${source.minimumBytes}. ` +
        (source.gzip === true
          ? 'A few hundred bytes here means a git-lfs pointer rather than the file — check the URL uses the media/ path.'
          : 'The query may have failed; the TAP service reports errors as a 200 with a VOTABLE body.') +
        remedy,
    )
  if (text.startsWith('<?xml'))
    throw new Error(
      `${source.name}: the service returned XML, which is how its TAP endpoint reports a bad query.${remedy}\n${text.slice(0, 400)}`,
    )
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
