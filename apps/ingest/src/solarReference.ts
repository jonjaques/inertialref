import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type SolarReference,
  solarReference,
  validateSmallBody,
  validateSource,
} from './solarRecords.ts'
import {
  SMALL_BODIES,
  type SmallBodyQuery,
  sbdbUrl,
  SOLAR_SOURCES,
} from './solarSources.ts'

/*
 * JPL's tables, fetched and turned into `data/reference/solar-system.json`.
 *
 * The output is one record per planet, dwarf planet, satellite and small body.
 * This file is the I/O at the edge: it fetches and caches each source, refuses
 * a payload that is not the page it expects, hands the texts to
 * `solarReference` in `solarRecords.ts`, and stamps the result with the date
 * and the digest of each input. The parsing, and the reason it is literal, is
 * there.
 */

/* ------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* ------------------------------------------------------------------------- */

const cacheDirectory = (root: string): string => join(root, '.data', 'raw')

const exists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

async function fetchText(
  url: string,
  path: string,
  refresh: boolean,
  validate: (text: string) => void,
): Promise<{ text: string; cached: boolean }> {
  mkdirSync(dirname(path), { recursive: true })
  if (!refresh && exists(path)) {
    const text = readFileSync(path, 'utf8')
    validate(text)
    return { text, cached: true }
  }
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`${url}: ${response.status} ${response.statusText}`)
  const text = await response.text()
  validate(text)
  writeFileSync(path, text)
  return { text, cached: false }
}

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * Fetch everything, read it with `solarReference`, and stamp the provenance.
 *
 * `onProgress` rather than `console.log` because the ingest prints its own
 * report and this is a library — the same split every other builder here uses.
 */
export async function buildSolarReference({
  root,
  refresh = false,
  today,
  onProgress = () => {},
}: {
  root: string
  refresh?: boolean
  today: string
  onProgress?: (message: string) => void
}): Promise<SolarReference> {
  const tables = new Map<string, string>()
  const sources: {
    name: string
    url: string
    credit: string
    sha256: string
  }[] = []

  for (const source of SOLAR_SOURCES) {
    const { text, cached } = await fetchText(
      source.url,
      join(cacheDirectory(root), source.file),
      refresh,
      (payload) => validateSource(source, payload),
    )
    tables.set(source.key, text)
    sources.push({
      name: source.name,
      url: source.url,
      credit: source.credit,
      sha256: digest(text),
    })
    onProgress(
      `  ${source.name.padEnd(46)} ${String((text.length / 1024).toFixed(0)).padStart(6)} KB  ${
        cached ? 'cached' : 'downloaded'
      }`,
    )
  }

  const smallBodies: { query: SmallBodyQuery; text: string }[] = []
  for (const query of SMALL_BODIES) {
    const url = sbdbUrl(query.designation)
    const file = `sbdb_${query.designation.replace(/[^\w]+/g, '_')}.json`
    const { text } = await fetchText(
      url,
      join(cacheDirectory(root), 'sbdb', file),
      refresh,
      (payload) => validateSmallBody(query.designation, payload),
    )
    smallBodies.push({ query, text })
  }

  const records = solarReference({ tables, smallBodies })
  onProgress(
    `\n  ${records.planets.length} planets, ${records.dwarfPlanets.length} dwarf planets, ${records.satellites.length} satellites`,
  )
  sources.push({
    name: 'JPL Small-Body Database (SBDB) API',
    url: sbdbUrl('<designation>'),
    credit: 'NASA/JPL-Caltech Solar System Dynamics',
    sha256: digest(records.smallBodies.map((b) => b.fullName).join('|')),
  })
  onProgress(`  ${records.smallBodies.length} small bodies from SBDB`)

  return { generated: today, sources, ...records }
}
