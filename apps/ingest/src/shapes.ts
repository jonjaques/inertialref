import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { encodeShapeField, shapeExtent } from '@inertialref/rendering'
import { shapeFieldFrom } from './shapeResample.ts'
import { SHAPE_SOURCES, type ShapeSource } from './shapeSources.ts'

/*
 * Published shape models to the grids the game ships.
 *
 * Fetch, convert, write. `download` fetches and caches each source and refuses
 * the archive's HTML error page; `shapeFieldFrom` in `shapeResample.ts` reads
 * the text, resamples it onto a radius grid and refuses a body the grid cannot
 * hold; this encodes the grid, writes it, and records its extent and its
 * volume against the source's in the manifest, so every shipped model says how
 * faithful it is.
 */

export interface ShapeEntry {
  readonly key: string
  readonly name: string
  readonly file: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  /** Volume-equivalent radius of the shipped grid, meters. */
  readonly meanRadius: number
  readonly minRadius: number
  readonly maxRadius: number
  /** Semi-axes of the shipped grid, meters, largest first. */
  readonly semiAxes: readonly number[]
  /** Grid volume over source volume. 1 is a perfect reconstruction. */
  readonly volumeRatio: number
  readonly credit: string
  readonly reference: string
  readonly source: string
  readonly sha256: string
}

export interface ShapeManifest {
  readonly generated: string
  readonly attribution: readonly string[]
  readonly shapes: readonly ShapeEntry[]
}

/* ------------------------------------------------------------------------- */
/* The build                                                                  */
/* ------------------------------------------------------------------------- */

const cacheDirectory = (root: string): string => join(root, '.data', 'shapes')

const exists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

async function download(
  source: ShapeSource,
  root: string,
  refresh: boolean,
): Promise<string> {
  const path = join(cacheDirectory(root), source.file)
  mkdirSync(dirname(path), { recursive: true })
  if (!refresh && exists(path)) return readFileSync(path, 'utf8')
  const response = await fetch(source.url)
  if (!response.ok)
    throw new Error(
      `${source.name}: ${response.status} ${response.statusText} from ${source.url}`,
    )
  const text = await response.text()
  if (text.length < source.minimumBytes)
    throw new Error(
      `${source.name}: got ${text.length} bytes, expected at least ${source.minimumBytes} — the archive serves an HTML error page with a 200`,
    )
  writeFileSync(path, text)
  return text
}

export async function buildShapes({
  root,
  outputDirectory,
  refresh = false,
  onProgress = () => {},
}: {
  root: string
  outputDirectory: string
  refresh?: boolean
  onProgress?: (message: string) => void
}): Promise<ShapeManifest> {
  const directory = join(root, outputDirectory)
  mkdirSync(directory, { recursive: true })
  const shapes: ShapeEntry[] = []
  const attribution = new Set<string>()

  for (const source of SHAPE_SOURCES) {
    const text = await download(source, root, refresh)
    const { field, volumeRatio, sourceDetail } = shapeFieldFrom(text, source)
    const extent = shapeExtent(field)
    const { width, height } = field

    const bytes = encodeShapeField(field)
    const file = `${source.key}.irsm`
    writeFileSync(join(directory, file), bytes)
    attribution.add(source.credit)
    shapes.push({
      key: source.key,
      name: source.name,
      file,
      width,
      height,
      bytes: bytes.length,
      meanRadius: extent.meanRadius,
      minRadius: extent.minRadius,
      maxRadius: extent.maxRadius,
      semiAxes: extent.semiAxes,
      volumeRatio,
      credit: source.credit,
      reference: source.reference,
      source: source.url,
      sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    })
    onProgress(
      `  ${source.name.padEnd(18)} ${sourceDetail.padEnd(20)} → ${width}×${height}  ` +
        `${String((bytes.length / 1024).toFixed(0)).padStart(4)} KB  ` +
        `r̄ ${formatMeters(extent.meanRadius).padStart(9)}  ` +
        `axes ${extent.semiAxes.map((a) => formatMeters(a)).join(' × ')}  ` +
        `vol ${(volumeRatio * 100).toFixed(1)}%`,
    )
  }

  return {
    generated: new Date().toISOString().slice(0, 10),
    attribution: [...attribution].sort(),
    shapes,
  }
}

const formatMeters = (meters: number): string =>
  meters >= 1_000
    ? `${(meters / 1_000).toFixed(1)} km`
    : `${meters.toFixed(0)} m`
