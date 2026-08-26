import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  encodeShapeField,
  type ShapeField,
  shapeExtent,
  shapePhi,
  shapeTheta,
} from '@inertialref/rendering'
import { SHAPE_SOURCES, type ShapeSource } from './shapeSources.ts'

/*
 * Published shape models to the grids the game ships.
 *
 * Two things happen here, and only one of them is arithmetic.
 *
 * **The resample.** A mesh becomes a radius grid by casting one ray per sample
 * from the body's center and keeping the *farthest* surface it hits. Farthest
 * rather than nearest is the whole of the star-shaped assumption made explicit:
 * where a ray does cross the surface more than once, the outer crossing is the
 * silhouette, and the silhouette is what a shape model is for.
 *
 * **The check.** Every model is measured after conversion and compared against
 * the source it came from — the enclosed volume, and the tri-axial extent. A
 * grid that dropped a concavity gains volume; one that is too coarse for its
 * source loses it. Both are reported, and past a threshold both fail the build.
 * Without that, a bad projection produces a file, a mesh, and an asteroid that
 * is merely the wrong shape — which is not something anyone would catch by
 * looking, because nobody knows what Golevka looks like.
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

/**
 * How far the reconstruction may be from the source before the build stops.
 *
 * Measured across the whole set: the grid sources round-trip to within a
 * fraction of a percent (they are already grids), and the meshes land between
 * 0.3% and 3% depending on how much finer the mesh is than the grid. 6% is
 * loose enough that no correct model trips it and tight enough that a body
 * with a genuine overhang — which is what this exists to catch — cannot pass.
 */
const VOLUME_TOLERANCE = 0.06

interface Mesh {
  /** Vertex positions in meters, xyz triples, already centered. */
  readonly vertices: Float64Array
  /** Triangle vertex indices. */
  readonly faces: Uint32Array
}

/* ------------------------------------------------------------------------- */
/* Readers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * A latitude/longitude table of radii, at whatever spacing its author chose.
 *
 * Returned as a sorted axis pair plus a dense array rather than as a
 * `ShapeField` directly: the source spacing is almost never the output's, and
 * pretending otherwise is how a 5° model becomes a 512-column file full of
 * interpolation.
 */
interface SourceGrid {
  readonly latitudes: number[]
  readonly longitudes: number[]
  /** Radii in meters, indexed `lat * longitudes.length + lon`. */
  readonly radii: Float64Array
}

function readGrid(text: string, source: ShapeSource): SourceGrid {
  const latitudeFirst = source.columns !== 'lon-lat-radius'
  const points: { lat: number; lon: number; radius: number }[] = []
  const latitudes = new Set<number>()
  const longitudes = new Set<number>()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const first = Number(parts[0])
    const second = Number(parts[1])
    const radius = Number(parts[2])
    if (!Number.isFinite(first) || !Number.isFinite(radius)) continue
    const lat = latitudeFirst ? first : second
    // Both archives write a 0 *and* a 360 column. They are the same meridian,
    // and keeping both would make the last cell of every row a zero-width one.
    const lon = (((latitudeFirst ? second : first) % 360) + 360) % 360
    latitudes.add(lat)
    longitudes.add(lon)
    points.push({ lat, lon, radius: radius * source.scale })
  }
  const lats = [...latitudes].sort((a, b) => a - b)
  const lons = [...longitudes].sort((a, b) => a - b)
  if (lats.length < 5 || lons.length < 5)
    throw new Error(
      `${source.key}: parsed a ${lats.length} × ${lons.length} grid, which is not a shape model`,
    )
  const latIndex = new Map(lats.map((value, i) => [value, i]))
  const lonIndex = new Map(lons.map((value, i) => [value, i]))
  const radii = new Float64Array(lats.length * lons.length)
  for (const point of points) {
    const i = latIndex.get(point.lat)
    const j = lonIndex.get(point.lon)
    if (i === undefined || j === undefined) continue
    radii[i * lons.length + j] = point.radius
  }
  return { latitudes: lats, longitudes: lons, radii }
}

/** `v x y z` and `f a b c`, one per line, comments and everything else ignored. */
function readObj(text: string, source: ShapeSource): Mesh {
  const vertices: number[] = []
  const faces: number[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const head = line.charCodeAt(0)
    // 'v' = 118, 'f' = 102. Checked before splitting, because these files run
    // to three million lines and `split` on all of them is the whole runtime.
    if (head !== 118 && head !== 102) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    if (parts[0] === 'v') {
      vertices.push(
        Number(parts[1]) * source.scale,
        Number(parts[2]) * source.scale,
        Number(parts[3]) * source.scale,
      )
    } else if (parts[0] === 'f') {
      // OBJ indices are 1-based and may carry `v/vt/vn`.
      faces.push(
        Number.parseInt(parts[1] as string, 10) - 1,
        Number.parseInt(parts[2] as string, 10) - 1,
        Number.parseInt(parts[3] as string, 10) - 1,
      )
    }
  }
  return centre({
    vertices: Float64Array.from(vertices),
    faces: Uint32Array.from(faces),
  })
}

/** Gaskell: a count line, then `index x y z`, then `index a b c`. */
function readVertexTable(text: string, source: ShapeSource): Mesh {
  const lines = text.split('\n')
  const header = (lines[0] ?? '').trim().split(/\s+/)
  const vertexCount = Number(header[0])
  const faceCount = Number(header[1])
  if (!Number.isFinite(vertexCount) || !Number.isFinite(faceCount))
    throw new Error(
      `${source.key}: no count line at the top of the vertex file`,
    )
  const vertices = new Float64Array(vertexCount * 3)
  const faces = new Uint32Array(faceCount * 3)
  for (let i = 0; i < vertexCount; i += 1) {
    const parts = (lines[1 + i] ?? '').trim().split(/\s+/)
    vertices[i * 3] = Number(parts[1]) * source.scale
    vertices[i * 3 + 1] = Number(parts[2]) * source.scale
    vertices[i * 3 + 2] = Number(parts[3]) * source.scale
  }
  for (let i = 0; i < faceCount; i += 1) {
    const parts = (lines[1 + vertexCount + i] ?? '').trim().split(/\s+/)
    faces[i * 3] = Number.parseInt(parts[1] as string, 10) - 1
    faces[i * 3 + 1] = Number.parseInt(parts[2] as string, 10) - 1
    faces[i * 3 + 2] = Number.parseInt(parts[3] as string, 10) - 1
  }
  return centre({ vertices, faces })
}

/* ------------------------------------------------------------------------- */
/* Mesh geometry                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Signed volume and centroid of a closed triangle mesh, by the divergence
 * theorem — the sum of the signed tetrahedra from the origin to each face.
 *
 * Robust to where the source put its origin, which matters: some of these are
 * centered on the center of figure, some on the center of mass, and one of the
 * radar models is centered on neither.
 */
function volumeAndCentroid(mesh: Mesh): {
  volume: number
  centroid: [number, number, number]
} {
  const { vertices, faces } = mesh
  let volume = 0
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < faces.length; i += 3) {
    const a = (faces[i] as number) * 3
    const b = (faces[i + 1] as number) * 3
    const c = (faces[i + 2] as number) * 3
    const ax = vertices[a] as number
    const ay = vertices[a + 1] as number
    const az = vertices[a + 2] as number
    const bx = vertices[b] as number
    const by = vertices[b + 1] as number
    const bz = vertices[b + 2] as number
    const cxv = vertices[c] as number
    const cyv = vertices[c + 1] as number
    const czv = vertices[c + 2] as number
    const signed =
      (ax * (by * czv - bz * cyv) +
        ay * (bz * cxv - bx * czv) +
        az * (bx * cyv - by * cxv)) /
      6
    volume += signed
    cx += signed * (ax + bx + cxv) * 0.25
    cy += signed * (ay + by + cyv) * 0.25
    cz += signed * (az + bz + czv) * 0.25
  }
  return {
    volume: Math.abs(volume),
    centroid:
      volume === 0 ? [0, 0, 0] : [cx / volume, cy / volume, cz / volume],
  }
}

/**
 * Move the mesh onto its own centroid.
 *
 * The radius field is single-valued *about its origin*, so the origin is the
 * one free parameter that decides whether a bilobate body reconstructs or
 * folds. The centroid is the choice that maximizes the solid angle each lobe
 * subtends from it, and it is also what "the body's center" means physically
 * for a uniform-density rubble pile.
 */
function centre(mesh: Mesh): Mesh {
  const { centroid } = volumeAndCentroid(mesh)
  const [dx, dy, dz] = centroid
  const vertices = mesh.vertices.slice()
  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] = (vertices[i] as number) - dx
    vertices[i + 1] = (vertices[i + 1] as number) - dy
    vertices[i + 2] = (vertices[i + 2] as number) - dz
  }
  return { vertices, faces: mesh.faces }
}

/* ------------------------------------------------------------------------- */
/* Resampling                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The body-fixed axes, and the one place the conventions are reconciled.
 *
 * PDS shape models are in a right-handed body-fixed frame with **+Z toward the
 * north pole** and +X through the prime meridian. `packages/rendering`'s grid
 * follows Three.js's sphere: **+Y is the pole**, and longitude runs so that
 * `x = -cos(phi)·sin(theta)`, `z = sin(phi)·sin(theta)`.
 *
 * Mapping (X, Y, Z) to (−X, Z, Y) satisfies both and preserves handedness — a
 * mapping that did not would mirror every asteroid, which is invisible on a
 * potato and is exactly the kind of error this comment exists to prevent
 * someone from introducing while tidying.
 */
const toGridAxes = (
  x: number,
  y: number,
  z: number,
): [number, number, number] => [-x, z, y]

/** Möller–Trumbore, ray from the origin. Returns the hit distance or null. */
function rayTriangle(
  direction: readonly [number, number, number],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number | null {
  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  const [dx, dy, dz] = direction
  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (Math.abs(det) < 1e-18) return null
  const inverse = 1 / det
  // The ray starts at the origin, so the vector to vertex A is just −A.
  const tx = -ax
  const ty = -ay
  const tz = -az
  const u = (tx * px + ty * py + tz * pz) * inverse
  if (u < -1e-9 || u > 1 + 1e-9) return null
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inverse
  if (v < -1e-9 || u + v > 1 + 1e-9) return null
  const t = (e2x * qx + e2y * qy + e2z * qz) * inverse
  return t > 0 ? t : null
}

function resampleMesh(mesh: Mesh, width: number, height: number): ShapeField {
  const radii = new Float32Array(width * height)
  const field: ShapeField = { width, height, radii }
  const { vertices, faces } = mesh

  // The sample directions, computed once. 512 × 257 of them is a megabyte and
  // saves three transcendental calls inside the innermost loop.
  const directions = new Float64Array(width * height * 3)
  for (let row = 0; row < height; row += 1) {
    const theta = shapeTheta(field, row)
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)
    for (let column = 0; column < width; column += 1) {
      const phi = shapePhi(field, column)
      const index = (row * width + column) * 3
      directions[index] = -Math.cos(phi) * sinTheta
      directions[index + 1] = cosTheta
      directions[index + 2] = Math.sin(phi) * sinTheta
    }
  }

  /*
   * One pass over the faces rather than over the samples.
   *
   * The other way round is 131,000 samples × 50,000 faces, which is six
   * billion intersection tests and about four minutes per body. A face covers
   * a handful of cells, so walking the faces and testing only the cells inside
   * each one's angular bounding box is the same answer in a second — and it is
   * *exactly* the same answer, not an approximation: a ray that hits a face has
   * its direction inside that face's angular extent by construction, so no
   * conservative rounding can miss it.
   */
  const scratch: [number, number, number] = [0, 0, 0]
  for (let f = 0; f < faces.length; f += 3) {
    const ia = (faces[f] as number) * 3
    const ib = (faces[f + 1] as number) * 3
    const ic = (faces[f + 2] as number) * 3
    const [ax, ay, az] = toGridAxes(
      vertices[ia] as number,
      vertices[ia + 1] as number,
      vertices[ia + 2] as number,
    )
    const [bx, by, bz] = toGridAxes(
      vertices[ib] as number,
      vertices[ib + 1] as number,
      vertices[ib + 2] as number,
    )
    const [cx, cy, cz] = toGridAxes(
      vertices[ic] as number,
      vertices[ic + 1] as number,
      vertices[ic + 2] as number,
    )

    const thetaA = angleTheta(ax, ay, az)
    const thetaB = angleTheta(bx, by, bz)
    const thetaC = angleTheta(cx, cy, cz)
    const rowLow = Math.max(
      0,
      Math.floor((Math.min(thetaA, thetaB, thetaC) / Math.PI) * (height - 1)),
    )
    const rowHigh = Math.min(
      height - 1,
      Math.ceil((Math.max(thetaA, thetaB, thetaC) / Math.PI) * (height - 1)),
    )

    const phiA = anglePhi(ax, az)
    const phiB = anglePhi(bx, bz)
    const phiC = anglePhi(cx, cz)
    // A face that straddles the prime meridian, or contains a pole, has no
    // meaningful longitude interval. Both are rare and both are handled by
    // scanning the row instead — correct, and costing nothing on average.
    const spread =
      Math.max(phiA, phiB, phiC) - Math.min(phiA, phiB, phiC) > Math.PI ||
      rowLow === 0 ||
      rowHigh === height - 1
    const columnLow = spread
      ? 0
      : Math.floor((Math.min(phiA, phiB, phiC) / (2 * Math.PI)) * width)
    const columnHigh = spread
      ? width - 1
      : Math.ceil((Math.max(phiA, phiB, phiC) / (2 * Math.PI)) * width)

    for (let row = rowLow; row <= rowHigh; row += 1) {
      for (let c = columnLow; c <= columnHigh; c += 1) {
        const column = ((c % width) + width) % width
        const cell = row * width + column
        const base = cell * 3
        scratch[0] = directions[base] as number
        scratch[1] = directions[base + 1] as number
        scratch[2] = directions[base + 2] as number
        const t = rayTriangle(scratch, ax, ay, az, bx, by, bz, cx, cy, cz)
        if (t !== null && t > (radii[cell] as number)) radii[cell] = t
      }
    }
  }

  const missed = fillGaps(field)
  if (missed > radii.length / 20)
    throw new Error(
      `resample missed ${missed} of ${radii.length} samples — the mesh is not closed about its centroid`,
    )
  return field
}

const angleTheta = (x: number, y: number, z: number): number =>
  Math.acos(Math.max(-1, Math.min(1, y / Math.hypot(x, y, z))))

const anglePhi = (x: number, z: number): number => {
  const phi = Math.atan2(z, -x)
  return phi < 0 ? phi + 2 * Math.PI : phi
}

/**
 * Samples no face covered, filled from their neighbours.
 *
 * Should be none for a closed mesh, and is a handful in practice at the poles
 * of a model whose facets are a hair smaller than the grid. The count is
 * returned rather than logged so the caller can refuse a model where it is not
 * a handful — a mesh with a real hole in it, or one the centroid sits outside.
 */
function fillGaps(field: ShapeField): number {
  const { width, height, radii } = field
  let missing = 0
  for (let i = 0; i < radii.length; i += 1) if (radii[i] === 0) missing += 1
  if (missing === 0) return 0
  for (let pass = 0; pass < 8; pass += 1) {
    let remaining = 0
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const index = row * width + column
        if (radii[index] !== 0) continue
        let sum = 0
        let count = 0
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const r = row + dr
          if (r < 0 || r >= height) continue
          const c = (((column + dc) % width) + width) % width
          const value = radii[r * width + c] as number
          if (value !== 0) {
            sum += value
            count += 1
          }
        }
        if (count === 0) remaining += 1
        else radii[index] = sum / count
      }
    }
    if (remaining === 0) break
  }
  return missing
}

/** A source grid resampled onto the shipped one, bilinearly in lat/lon. */
function resampleGrid(
  grid: SourceGrid,
  width: number,
  height: number,
): ShapeField {
  const radii = new Float32Array(width * height)
  const field: ShapeField = { width, height, radii }
  const lats = grid.latitudes
  const lons = grid.longitudes
  const sample = (latitude: number, longitude: number): number => {
    const i = interval(lats, latitude)
    const j = interval(lons, ((longitude % 360) + 360) % 360, true)
    const value = (a: number, b: number): number =>
      grid.radii[a * lons.length + b] as number
    const top =
      value(i.low, j.low) + (value(i.low, j.high) - value(i.low, j.low)) * j.t
    const bottom =
      value(i.high, j.low) +
      (value(i.high, j.high) - value(i.high, j.low)) * j.t
    return top + (bottom - top) * i.t
  }
  for (let row = 0; row < height; row += 1) {
    // The grid's rows run north to south; latitude runs south to north.
    const latitude = 90 - (180 * row) / (height - 1)
    for (let column = 0; column < width; column += 1) {
      radii[row * width + column] = sample(latitude, (360 * column) / width)
    }
  }
  return field
}

function interval(
  axis: readonly number[],
  value: number,
  wrap = false,
): { low: number; high: number; t: number } {
  const last = axis.length - 1
  const first = axis[0] as number
  /*
   * Longitude past the last sample wraps to the first; latitude clamps.
   *
   * The comparison is *strict* at the low end, and that is not a nicety. The
   * output's column 0 is longitude 0, which is the axis's first sample: a `<=`
   * here sent it through the wrap branch, which extrapolated it backwards
   * across the whole 357° gap to the far side of the table. Every body came out
   * with one meridian a few times its own radius long — a spike the volume
   * check saw and the eye would have read as a shape model of something else.
   */
  if (value < first)
    return wrap ? wrapping(axis, value + 360) : { low: 0, high: 0, t: 0 }
  if (value >= (axis[last] as number))
    return wrap ? wrapping(axis, value) : { low: last, high: last, t: 0 }
  let low = 0
  while (low < last && (axis[low + 1] as number) <= value) low += 1
  const a = axis[low] as number
  const b = axis[low + 1] as number
  return { low, high: low + 1, t: b === a ? 0 : (value - a) / (b - a) }
}

/** Between the last sample and the first one again, 360° on. */
function wrapping(
  axis: readonly number[],
  value: number,
): { low: number; high: number; t: number } {
  const last = axis.length - 1
  const a = axis[last] as number
  const b = (axis[0] as number) + 360
  return { low: last, high: 0, t: b === a ? 0 : (value - a) / (b - a) }
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
    const width = source.width
    // Latitude spans half the longitude range, plus the row that is the pole.
    const height = width / 2 + 1

    let field: ShapeField
    let sourceVolume: number
    let sourceDetail: string
    if (source.format === 'grid') {
      const grid = readGrid(text, source)
      field = resampleGrid(grid, width, height)
      // A grid has no faces, so its "source volume" is the same integral this
      // takes of the output — at the source's own spacing. Comparing the two
      // measures the resample and nothing else, which is the honest claim.
      sourceVolume = shapeExtent(
        resampleGrid(grid, grid.longitudes.length, grid.latitudes.length),
      ).volume
      sourceDetail = `${grid.longitudes.length} × ${grid.latitudes.length} grid`
    } else {
      const mesh =
        source.format === 'obj'
          ? readObj(text, source)
          : readVertexTable(text, source)
      field = resampleMesh(mesh, width, height)
      sourceVolume = volumeAndCentroid(mesh).volume
      sourceDetail = `${(mesh.faces.length / 3).toLocaleString('en-US')} facets`
    }

    const extent = shapeExtent(field)
    const volumeRatio = sourceVolume === 0 ? 0 : extent.volume / sourceVolume
    // `!Number.isFinite` first, because NaN loses every comparison it is in:
    // `Math.abs(NaN - 1) > 0.06` is `false`, so the one check that exists to
    // catch a bad conversion passed on the worst possible input. A single
    // unparseable vertex line makes every radius NaN, and `encodeShapeField`
    // then writes `Math.round(NaN)` — which is 0 through ToUint16 — for every
    // sample, shipping a committed model of a body with no size at all, with a
    // valid digest in the manifest and not one word of complaint.
    if (
      !Number.isFinite(volumeRatio) ||
      Math.abs(volumeRatio - 1) > VOLUME_TOLERANCE
    )
      throw new Error(
        `${source.name}: the radius grid encloses ${(volumeRatio * 100).toFixed(1)}% of the source's volume. ` +
          `Past ±${VOLUME_TOLERANCE * 100}% that is not a resampling loss — the body is not star-shaped about its centroid, ` +
          `and a grid cannot represent it. See the header of packages/rendering/src/shape.ts.`,
      )

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
        `r̄ ${formatMetres(extent.meanRadius).padStart(9)}  ` +
        `axes ${extent.semiAxes.map((a) => formatMetres(a)).join(' × ')}  ` +
        `vol ${(volumeRatio * 100).toFixed(1)}%`,
    )
  }

  return {
    generated: new Date().toISOString().slice(0, 10),
    attribution: [...attribution].sort(),
    shapes,
  }
}

const formatMetres = (metres: number): string =>
  metres >= 1_000
    ? `${(metres / 1_000).toFixed(1)} km`
    : `${metres.toFixed(0)} m`
