import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveSeed, formatSeed, rootSeed } from '@inertialref/procedural'
import {
  type CloudGenus,
  CUMULUS_DATUM,
  CUMULUS_FIELD_SUN,
  type CumulusFixture,
  type CumulusFixturePlace,
  type CumulusSubject,
  cumulusFixture,
  cumulusSky,
  fixtureVoxel,
  GENUS_TABLE,
  genusHash,
  halfFloatsFromBase64,
  isolateCumulus,
  mieDroplets,
  radiusIndex,
  SCENARIO_IDS,
  SLAB_VIEW_SOURCE,
  type SlabSourceRay,
  type SlabSourceTable,
  type SlabViewForm,
  sourceAt,
  subjectWeather,
  type TraceMedium,
  traceMedium,
  tracePhase,
  viewReads,
} from '@inertialref/rendering'
import { SLAB_VIEW_SOURCE_TEXELS } from '../../../../packages/rendering/src/slabSourceTexels.generated.ts'
import { phaseHash, SUN_RADIUS, scaledTable } from './cumulusTables.ts'
import {
  createTracer,
  estimateOf,
  joinSums,
  type TraceScene,
  tracePixel,
} from './pathTrace.ts'

/*
 * The factor of the sun's orders past the first, by genus: the generator
 * of `packages/rendering/src/sunFactor.generated.ts`.
 *
 *     node apps/ingest/src/transport/sunFactor.ts find
 *     node apps/ingest/src/transport/sunFactor.ts trace <cloud> [sun…]
 *     node apps/ingest/src/transport/sunFactor.ts rim <cloud>
 *     node apps/ingest/src/transport/sunFactor.ts cover <cover>
 *     node apps/ingest/src/transport/sunFactor.ts genera
 *     node apps/ingest/src/transport/sunFactor.ts write
 *
 * `find` cuts the cumuli out of the field and prints them. `trace`
 * is one process a cloud: under each sun it traces every order past the
 * first on the scaled medium, marches §5.5 through the committed source
 * table along the same rays, and writes a part under
 * `.data/weather/factor/`. `rim`, `cover` and `genera` take the module's
 * three records. `write` refuses a part that is short of its samples or was
 * taken on another genus table, droplet table or source table, fits the
 * pair, writes the module and runs prettier on it.
 *
 * A cloud is the field's own, found by the search that finds a cloud
 * standing clear, so no shape of the generator's own making is fitted or
 * judged. Rule 8 keeps `worker_threads` out of ingest, which is why the
 * split is by process and from the command line.
 */

type V = readonly [number, number, number]

/** What every stream is derived from. */
export const SEED_TEXT = 'sun-factor'
const SEED = /*@__PURE__*/ rootSeed(SEED_TEXT)
/** Samples a ray and band: the critic's count, which judged the pair. */
export const FACTOR_SAMPLES = 1536
/** A ray is kept where the tracer knows it to this share of its mean. */
const KEPT_ERROR = 0.1
/** A ray thinner than this scaled depth is not marched or kept: it misses the cloud. */
const MISSED_DEPTH = 0.05

/* ------------------------------------------------------------------------- */
/* The clouds                                                                 */
/* ------------------------------------------------------------------------- */

/** How a genus's clouds are searched for: the grid each is cut on, and the lattice the search reads. */
export interface FactorGrid {
  /** Voxels east, up and north, and a voxel's edge, meters. */
  readonly size: readonly [number, number, number]
  readonly voxel: number
  /** The square searched, and the spacing of its columns, meters. */
  readonly side: number
  readonly spacing: number
}

/** The grid a cumulus is cut on: the reference's own. */
export const CUMULUS_GRID: FactorGrid = {
  size: [160, 96, 160],
  voxel: 20,
  side: 19_200,
  spacing: 80,
}

/**
 * A cloud a factor is fitted on or judged on: the `pick`-th that stands
 * clear in a square `east` and `north` kilometers of arc from the
 * reference's, largest first. `half` is the half of the fit it belongs to;
 * `held` is fitted by neither half and judged by both.
 */
export interface FactorCloud {
  readonly id: string
  readonly genus: CloudGenus
  readonly regime: CumulusSubject['regime']
  readonly east: number
  readonly north: number
  readonly pick: number
  readonly half: 'a' | 'b' | 'held'
}

const cloud = (
  regime: CumulusSubject['regime'],
  east: number,
  north: number,
  pick: number,
  half: FactorCloud['half'],
  id = `${regime === 'fair-cumulus' ? 'fc' : 'bh'}${east}~${north}~${pick}`,
): FactorCloud => ({ id, genus: 'cumulus', regime, east, north, pick, half })

/**
 * The critic's ten cumuli: four of each of two regimes, in squares 150 to
 * 270 km from the reference's, and the first job's two. The halves are the
 * critic's: two clouds of each regime in each.
 */
export const FACTOR_CLOUDS: readonly FactorCloud[] = [
  cloud('fair-cumulus', 150, 20, 0, 'a'),
  cloud('fair-cumulus', -200, 60, 12, 'a'),
  cloud('broken-horizon', 150, 20, 0, 'a'),
  cloud('broken-horizon', -40, -160, 0, 'a'),
  cloud('fair-cumulus', -40, -160, 3, 'b'),
  cloud('fair-cumulus', 220, 190, 1, 'b'),
  cloud('broken-horizon', 220, 190, 4, 'b'),
  cloud('broken-horizon', -200, 60, 1, 'b'),
  cloud('fair-cumulus', 60, 45, 0, 'held', 'second'),
  cloud('fair-cumulus', -90, 130, 8, 'held', 'third'),
]

/** A cut cloud as the tracer and the march read it. */
export interface FactorField {
  readonly size: readonly [number, number, number]
  readonly voxel: number
  /** Scaled extinction, 1/m, laid out [up][north][east]. */
  readonly sigma: Float32Array
  /**
   * One radius for the whole cloud, µm, its voxels' weighed by their
   * extinction: the tracer's phase and the table's transport scale are
   * read at it, so the two see one droplet.
   */
  readonly radius: number
  /** First order's gain: the level's unscaled extinction over its scaled. */
  readonly gain: number
  /** The middle of the cloud's level, meters over the datum: where its sky is read. */
  readonly middle: number
  readonly fixture: CumulusFixture
}

/** A square's own place on the datum, with its own tangent plane: a corner laid on the reference's plane 75 km off stands 440 m over the datum. */
function squarePlace(
  east: number,
  north: number,
  grid: FactorGrid,
): (x: number, z: number, base: number) => CumulusFixturePlace {
  const lon = east / CUMULUS_DATUM
  const lat = north / CUMULUS_DATUM
  const corner = {
    x: CUMULUS_DATUM * Math.cos(lat) * Math.cos(lon),
    y: CUMULUS_DATUM * Math.sin(lat),
    z: -CUMULUS_DATUM * Math.cos(lat) * Math.sin(lon),
  }
  const E = { x: -Math.sin(lon), y: 0, z: -Math.cos(lon) }
  const N = {
    x: -Math.sin(lat) * Math.cos(lon),
    y: Math.cos(lat),
    z: Math.sin(lat) * Math.sin(lon),
  }
  return (x, z, base) => ({
    corner: {
      x: corner.x + E.x * x + N.x * z,
      y: corner.y + E.y * x + N.y * z,
      z: corner.z + E.z * x + N.z * z,
    },
    east: E,
    north: N,
    size: grid.size,
    voxel: grid.voxel,
    base,
  })
}

/** Voxels of clear air a cloud keeps from its grid's sides, and the least share of the grid's cloud it is. */
const MARGIN = 6
const OWN_SHARE = 0.5

/**
 * Every cloud of a square that stands clear in its grid, largest first: the
 * reference's search (`findCumulus`) in a square of its own, which that
 * search does not take. A lattice of columns finds the candidates, and each
 * is cut at the grid's own resolution before it is taken, since two clouds
 * the lattice sees apart can be joined by a bridge finer than its spacing.
 * `limit` stops the search once that many stand clear.
 */
export function standingClouds(
  regime: CumulusSubject['regime'],
  east: number,
  north: number,
  grid: FactorGrid,
  limit = Infinity,
): {
  readonly subject: CumulusSubject
  readonly fixture: CumulusFixture
  readonly middle: number
}[] {
  const place = squarePlace(east, north, grid)
  const draft: CumulusSubject = {
    id: `${regime}~${east}~${north}`,
    regime,
    thickness: null,
    time: 0,
    place: place(0, 0, 0),
  }
  const { weather, clock } = subjectWeather(draft)
  const level = weather.levels[0]
  const base = Math.max(0, level.base - MARGIN * grid.voxel)
  const across = Math.round(grid.side / grid.spacing)
  const heights = Math.ceil((level.top - level.base) / grid.spacing)
  const lattice: CumulusFixturePlace = {
    ...place(0, 0, level.base),
    size: [across, heights, across],
    voxel: grid.spacing,
  }
  const cloudy = new Uint8Array(across * across)
  for (let index = 0; index < across * across * heights; index += 1)
    if (
      fixtureVoxel(weather, clock, CUMULUS_FIELD_SUN, lattice, index)
        .extinction > 0
    )
      cloudy[index % (across * across)] = 1
  const candidates = latticeClouds(cloudy, across).filter(
    (c) =>
      c.span * grid.spacing <=
      (Math.min(grid.size[0], grid.size[2]) - 2 * MARGIN) * grid.voxel,
  )
  const snap = (center: number, voxels: number): number =>
    Math.round(
      (center * grid.spacing - (voxels * grid.voxel) / 2) / grid.voxel,
    ) * grid.voxel
  const middle = (level.base + level.top) / 2
  const found: {
    subject: CumulusSubject
    fixture: CumulusFixture
    middle: number
  }[] = []
  // Largest first; a sort is stable, so equals keep the scan's order.
  for (const candidate of candidates.sort((a, b) => b.columns - a.columns)) {
    const subject: CumulusSubject = {
      ...draft,
      place: place(
        snap(candidate.east, grid.size[0]),
        snap(candidate.north, grid.size[2]),
        base,
      ),
    }
    const cut = isolateCumulus(
      cumulusFixture(weather, clock, CUMULUS_FIELD_SUN, subject.place),
    )
    if (cut.voxels === 0 || cut.touches || cut.voxels < OWN_SHARE * cut.cloudy)
      continue
    found.push({ subject, fixture: cut.fixture, middle })
    if (found.length >= limit) break
  }
  return found
}

/** The lattice's clouds that touch none of its sides: their columns, their larger span, and their centers, in columns. */
function latticeClouds(
  cloudy: Uint8Array,
  across: number,
): { columns: number; span: number; east: number; north: number }[] {
  const label = new Uint8Array(across * across)
  const stack: number[] = []
  const clouds: {
    columns: number
    span: number
    east: number
    north: number
  }[] = []
  for (let start = 0; start < across * across; start += 1) {
    if (cloudy[start] !== 1 || label[start] === 1) continue
    let columns = 0
    const low = [across, across]
    const high = [-1, -1]
    label[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const at = stack.pop()!
      const i = at % across
      const k = Math.floor(at / across)
      columns += 1
      low[0] = Math.min(low[0]!, i)
      low[1] = Math.min(low[1]!, k)
      high[0] = Math.max(high[0]!, i)
      high[1] = Math.max(high[1]!, k)
      for (const [ni, nk] of [
        [i + 1, k],
        [i - 1, k],
        [i, k + 1],
        [i, k - 1],
      ] as const) {
        if (ni < 0 || nk < 0 || ni >= across || nk >= across) continue
        const next = nk * across + ni
        if (cloudy[next] !== 1 || label[next] === 1) continue
        label[next] = 1
        stack.push(next)
      }
    }
    if (
      low[0] === 0 ||
      low[1] === 0 ||
      high[0] === across - 1 ||
      high[1] === across - 1
    )
      continue
    clouds.push({
      columns,
      span: Math.max(high[0]! - low[0]!, high[1]! - low[1]!) + 1,
      east: (low[0]! + high[0]! + 1) / 2,
      north: (low[1]! + high[1]! + 1) / 2,
    })
  }
  return clouds
}

/** A fixture as one droplet's medium: its scaled extinction and its water-weighed radius. */
export function fieldOf(fixture: CumulusFixture, middle: number): FactorField {
  let water = 0
  let weighted = 0
  let first = -1
  fixture.sigma.forEach((value, index) => {
    if (value > 0 && first < 0) first = index
    water += value
    weighted += value * fixture.radius[index]!
  })
  return {
    size: fixture.size,
    voxel: fixture.voxel,
    sigma: fixture.sigma,
    radius: weighted / water,
    gain: first < 0 ? 1 : fixture.extinction[first]! / fixture.sigma[first]!,
    middle,
    fixture,
  }
}

/** A factor cloud, found and cut. */
export function cutCloud(spec: FactorCloud, grid = CUMULUS_GRID): FactorField {
  const found = standingClouds(
    spec.regime,
    spec.east * 1000,
    spec.north * 1000,
    grid,
    spec.pick + 1,
  )
  const chosen = found[spec.pick]
  if (chosen === undefined)
    throw new Error(
      `sunFactor: ${spec.id}: ${found.length} clouds stand clear, and the pick is ${spec.pick}`,
    )
  return fieldOf(chosen.fixture, chosen.middle)
}

/** A cloud's size, as the module records it. */
export function cloudSize(field: FactorField): {
  readonly voxels: number
  readonly extent: readonly [number, number, number]
  readonly thickness: number
  readonly columnDepth: number
  readonly radius: number
} {
  const [nx, ny, nz] = field.size
  const v = field.voxel
  const thick: number[] = []
  const depth: number[] = []
  const low = [nx, ny, nz]
  const high = [-1, -1, -1]
  let voxels = 0
  for (let k = 0; k < nz; k += 1)
    for (let i = 0; i < nx; i += 1) {
      let t = 0
      let d = 0
      for (let j = 0; j < ny; j += 1) {
        const s = field.sigma[(j * nz + k) * nx + i]!
        if (!(s > 0)) continue
        t += v
        d += s * v
        voxels += 1
        for (const [a, at] of [i, j, k].entries()) {
          low[a] = Math.min(low[a]!, at)
          high[a] = Math.max(high[a]!, at)
        }
      }
      if (t > 0) {
        thick.push(t)
        depth.push(d)
      }
    }
  const median = (values: number[]): number =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
  return {
    voxels,
    extent: [0, 1, 2].map((a) => (high[a]! - low[a]! + 1) * v) as unknown as V,
    thickness: median(thick),
    columnDepth: Number(median(depth).toFixed(1)),
    radius: Number(field.radius.toFixed(2)),
  }
}

/* ------------------------------------------------------------------------- */
/* The suns and the rays                                                      */
/* ------------------------------------------------------------------------- */

/** A sun: its elevation, and its azimuth from north toward east, degrees. The eye looks north. */
export interface FactorSun {
  readonly id: string
  readonly elevation: number
  readonly azimuth: number
}

/** Five elevations: behind the eye at each, ahead at the three low ones, across at 50°. */
export const FACTOR_SUNS: readonly FactorSun[] = [
  { id: '7-behind', elevation: 7, azimuth: 180 },
  { id: '7-ahead', elevation: 7, azimuth: 0 },
  { id: '15-behind', elevation: 15, azimuth: 180 },
  { id: '15-ahead', elevation: 15, azimuth: 0 },
  { id: '30-behind', elevation: 30, azimuth: 180 },
  { id: '30-ahead', elevation: 30, azimuth: 0 },
  { id: '50-behind', elevation: 50, azimuth: 180 },
  { id: '50-across', elevation: 50, azimuth: 90 },
  { id: '70-behind', elevation: 70, azimuth: 180 },
]

export function sunDirection(sun: Pick<FactorSun, 'elevation' | 'azimuth'>): V {
  const e = (sun.elevation * Math.PI) / 180
  const a = (sun.azimuth * Math.PI) / 180
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]
}

/** A ray of a picture: where it starts, meters from the grid's low corner, and which way it runs. */
export interface FactorRay {
  readonly label: string
  readonly view: 'level' | 'above' | 'below'
  readonly origin: V
  readonly direction: V
}

/** The pictures a cloud is seen in. */
export interface FactorViews {
  /** A level picture looking north: a lattice of `columns` by `rows` over the silhouette. */
  readonly columns: number
  readonly rows: number
  /** From 30° above and from 30° below, looking north: a lattice of `plan` a side over the plan. */
  readonly plan: number
  readonly pitch: number
}

export const FACTOR_VIEWS: FactorViews = {
  columns: 12,
  rows: 7,
  plan: 4,
  pitch: 30,
}

/** The rays of a cloud's three pictures, over the bounds of its cloudy voxels. */
export function pictureRays(
  field: FactorField,
  views: FactorViews = FACTOR_VIEWS,
): FactorRay[] {
  const [nx, ny, nz] = field.size
  const v = field.voxel
  const low = [nx, ny, nz]
  const high = [-1, -1, -1]
  for (let j = 0; j < ny; j += 1)
    for (let k = 0; k < nz; k += 1)
      for (let i = 0; i < nx; i += 1)
        if (field.sigma[(j * nz + k) * nx + i]! > 0)
          for (const [a, at] of [i, j, k].entries()) {
            low[a] = Math.min(low[a]!, at)
            high[a] = Math.max(high[a]!, at)
          }
  const [x0, y0, z0] = low.map((at) => at * v) as unknown as V
  const [x1, y1, z1] = high.map((at) => (at + 1) * v) as unknown as V
  const rays: FactorRay[] = []
  for (let r = 0; r < views.rows; r += 1)
    for (let c = 0; c < views.columns; c += 1)
      rays.push({
        label: `level ${c},${r}`,
        view: 'level',
        origin: [
          x0 + ((c + 0.5) / views.columns) * (x1 - x0),
          y0 + ((r + 0.5) / views.rows) * (y1 - y0),
          z0 - 3 * v,
        ],
        direction: [0, 0, 1],
      })
  const pitch = (views.pitch * Math.PI) / 180
  const toward = (
    label: string,
    view: FactorRay['view'],
    point: V,
    up: number,
  ): FactorRay => {
    const direction: V = [0, up * Math.sin(pitch), Math.cos(pitch)]
    const back = 6000
    return {
      label,
      view,
      origin: [
        point[0] - direction[0] * back,
        point[1] - direction[1] * back,
        point[2] - direction[2] * back,
      ],
      direction,
    }
  }
  for (let a = 0; a < views.plan; a += 1)
    for (let b = 0; b < views.plan; b += 1) {
      const x = x0 + ((a + 0.5) / views.plan) * (x1 - x0)
      const z = z0 + ((b + 0.5) / views.plan) * (z1 - z0)
      rays.push(toward(`above ${a},${b}`, 'above', [x, y1, z], -1))
      rays.push(toward(`below ${a},${b}`, 'below', [x, y0, z], 1))
    }
  return rays
}

/* ------------------------------------------------------------------------- */
/* The medium as the march reads it                                           */
/* ------------------------------------------------------------------------- */

/** A cloud's grid read trilinearly, as a linear 3D texture is, and the depths a march takes through it. */
export interface FieldReader {
  readonly field: FactorField
  sigmaAt(x: number, y: number, z: number): number
  /** The span of a ray inside the box about the cloudy voxels, meters, or null. */
  span(origin: V, direction: V): readonly [number, number] | null
  /** The scaled depth from a point along a unit direction to where it leaves that box, in steps of half a voxel. */
  depthFrom(x: number, y: number, z: number, direction: V): number
}

export function readerOf(field: FactorField): FieldReader {
  const [nx, ny, nz] = field.size
  const v = field.voxel
  const { sigma } = field
  const sigmaAt = (x: number, y: number, z: number): number => {
    const q = [x / v - 0.5, y / v - 0.5, z / v - 0.5]
    const i0 = Math.floor(q[0]!)
    const j0 = Math.floor(q[1]!)
    const k0 = Math.floor(q[2]!)
    const f = [q[0]! - i0, q[1]! - j0, q[2]! - k0]
    let sum = 0
    for (let corner = 0; corner < 8; corner += 1) {
      const i = i0 + (corner & 1)
      const j = j0 + ((corner >> 1) & 1)
      const k = k0 + (corner >> 2)
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue
      const weight =
        (corner & 1 ? f[0]! : 1 - f[0]!) *
        ((corner >> 1) & 1 ? f[1]! : 1 - f[1]!) *
        (corner >> 2 ? f[2]! : 1 - f[2]!)
      sum += weight * sigma[(j * nz + k) * nx + i]!
    }
    return sum
  }
  const lowIndex = [nx, ny, nz]
  const highIndex = [-1, -1, -1]
  for (let j = 0; j < ny; j += 1)
    for (let k = 0; k < nz; k += 1)
      for (let i = 0; i < nx; i += 1)
        if (sigma[(j * nz + k) * nx + i]! > 0)
          for (const [a, at] of [i, j, k].entries()) {
            lowIndex[a] = Math.min(lowIndex[a]!, at)
            highIndex[a] = Math.max(highIndex[a]!, at)
          }
  const low = lowIndex.map((at) => (at - 1) * v)
  const high = highIndex.map((at) => (at + 2) * v)
  const span = (o: V, d: V): readonly [number, number] | null => {
    let near = 0
    let far = Infinity
    for (let a = 0; a < 3; a += 1) {
      if (d[a] === 0) {
        if (o[a]! < low[a]! || o[a]! > high[a]!) return null
        continue
      }
      const t0 = (low[a]! - o[a]!) / d[a]!
      const t1 = (high[a]! - o[a]!) / d[a]!
      near = Math.max(near, Math.min(t0, t1))
      far = Math.min(far, Math.max(t0, t1))
    }
    return far > near ? [near, far] : null
  }
  const depthFrom = (x: number, y: number, z: number, d: V): number => {
    const s = span([x, y, z], d)
    if (s === null) return 0
    const steps = Math.ceil((s[1] - s[0]) / (v / 2))
    const dt = (s[1] - s[0]) / steps
    let sum = 0
    for (let n = 0; n < steps; n += 1) {
      const t = s[0] + (n + 0.5) * dt
      sum += sigmaAt(x + d[0] * t, y + d[1] * t, z + d[2] * t)
    }
    return sum * dt
  }
  return { field, sigmaAt, span, depthFrom }
}

/* ------------------------------------------------------------------------- */
/* §5.5 on the CPU                                                            */
/* ------------------------------------------------------------------------- */

/** The committed view table as `slabSourceRead.ts` reads it, decoded once. */
let viewTable: SlabSourceTable | null = null
function sourceTable(): SlabSourceTable {
  viewTable ??= {
    nodes: SLAB_VIEW_SOURCE.nodes,
    suns: SLAB_VIEW_SOURCE.suns,
    sunMuMin: SLAB_VIEW_SOURCE.sunMuMin,
    depthScale: SLAB_VIEW_SOURCE.depthScale,
    depthMax: SLAB_VIEW_SOURCE.depthMax,
    slabs: 2 * SLAB_VIEW_SOURCE.cosines.length,
    terms: halfFloatsFromBase64(
      SLAB_VIEW_SOURCE_TEXELS.texels,
      SLAB_VIEW_SOURCE_TEXELS.count,
      'the view table',
    ),
  }
  return viewTable
}
const VIEW_FORM: SlabViewForm = {
  cosines: SLAB_VIEW_SOURCE.cosines,
  stretch: SLAB_VIEW_SOURCE.stretch,
  blend: 'angle',
}

/** The source table's texels' hash: a part marched through another table is refused. */
export const sourceHash = (): string =>
  formatSeed(rootSeed(SLAB_VIEW_SOURCE_TEXELS.texels))

/** The table's transport scale at a radius, linear in ln r between its radii and held past them. */
export function transportScale(radius: number): number {
  const { radii, scales } = SLAB_VIEW_SOURCE.transport
  const r = Math.min(radii[radii.length - 1]!, Math.max(radii[0]!, radius))
  let i = 0
  while (i + 2 < radii.length && radii[i + 1]! <= r) i += 1
  const a =
    (Math.log(r) - Math.log(radii[i]!)) /
    (Math.log(radii[i + 1]!) - Math.log(radii[i]!))
  return scales[i]! + a * (scales[i + 1]! - scales[i]!)
}

/** The sun's cosine a read takes: §5.5's floor, `max(|sunMu|, 0.05)`. */
export const SUN_FLOOR = 0.05

/**
 * A ray for the table in a slab whose lit face is the local vertical:
 * `toEye` the light's direction to the eye, `sun` the direction to the sun.
 * The bearing is the two directions laid on the face's plane.
 */
function slabRay(toEye: V, sun: V, sunMu: number): SlabSourceRay {
  const muV = Math.max(-1, Math.min(1, toEye[1]))
  const lengths = Math.hypot(toEye[0], toEye[2]) * Math.hypot(sun[0], sun[2])
  const cosine =
    lengths < 1e-12 ? 0 : (toEye[0] * -sun[0] + toEye[2] * -sun[2]) / lengths
  return {
    sunMu,
    muV,
    along:
      Math.sqrt(Math.max(0, 1 - muV * muV)) * Math.max(-1, Math.min(1, cosine)),
    nu: 0,
  }
}

/** The march's step, in voxels. */
export const MARCH_STEP = 0.25

/**
 * The sun's orders past the first along a ray by §5.5, per unit of the
 * sun's irradiance, and the ray's scaled depth. A step a quarter voxel
 * long; at each, the slab the sample stands in is the plane through it
 * across the vertical, its two depths the exact scaled depths along the
 * sun's ray to the sun and away from it, each times μ₀ and the table's
 * transport scale, as `resolvedSlab` forms them.
 */
export function marchRay(
  reader: FieldReader,
  sun: V,
  origin: V,
  direction: V,
): { readonly depth: number; readonly higher: number } {
  const s = reader.span(origin, direction)
  if (s === null) return { depth: 0, higher: 0 }
  const k = transportScale(reader.field.radius)
  const mu0 = Math.max(Math.abs(sun[1]), SUN_FLOOR)
  const back: V = [-sun[0], -sun[1], -sun[2]]
  const toEye: V = [-direction[0], -direction[1], -direction[2]]
  const reads = viewReads(VIEW_FORM, slabRay(toEye, sun, mu0))
  const table = sourceTable()
  const texel = new Float64Array(4)
  const step = reader.field.voxel * MARCH_STEP
  const steps = Math.ceil((s[1] - s[0]) / step)
  const dt = (s[1] - s[0]) / steps
  let depth = 0
  let higher = 0
  for (let n = 0; n < steps; n += 1) {
    const t = s[0] + (n + 0.5) * dt
    const x = origin[0] + direction[0] * t
    const y = origin[1] + direction[1] * t
    const z = origin[2] + direction[2] * t
    const sigma = reader.sigmaAt(x, y, z)
    if (!(sigma > 0)) continue
    const dTau = sigma * dt
    const weight = Math.exp(-depth) * -Math.expm1(-dTau)
    if (weight > 1e-7) {
      const top = k * mu0 * reader.depthFrom(x, y, z, sun)
      const bottom = k * mu0 * reader.depthFrom(x, y, z, back)
      higher += weight * sourceAt(table, reads, top, bottom, mu0, texel)
    }
    depth += dTau
  }
  return { depth, higher }
}

/* ------------------------------------------------------------------------- */
/* The tracer                                                                 */
/* ------------------------------------------------------------------------- */

const DARK = { mean: [0, 0, 0], up: [0, 0, 0], sunward: [0, 0, 0] } as const

/** The droplet table's rows about a radius, and that table with them scaled. */
function phasesOf(radius: number) {
  const table = mieDroplets()
  const row = Math.floor(radiusIndex(table, radius))
  const rows = [Math.max(0, row), Math.min(table.radii - 1, row + 1)]
  return {
    whole: tracePhase(table),
    scaled: tracePhase(scaledTable(table, rows)),
  }
}

/** What of the light a trace counts. */
export type FactorPart =
  /** The sun's orders past the first on the scaled phase, under a dark sky: what §5.5 stands for. */
  | 'higher'
  /** The sun's first order on the whole phase, under a dark sky, before its gain. */
  | 'first'
  /** The sky alone, every order on the scaled phase, under a sun of no light. */
  | 'sky'

/** A ray's traced radiance: the three bands' mean, and its standard error. */
export interface Traced {
  readonly mean: number
  readonly error: number
}

/**
 * A tracer of a cloud's scaled medium under a sun, for one part of the
 * light. The sky is the reference's, read at the level's middle and the
 * sun's elevation, and counted only in the `sky` part.
 */
export function factorTracer(
  field: FactorField,
  sun: FactorSun,
  part: FactorPart,
  medium: TraceMedium = mediumOf(field),
) {
  const phases = phasesOf(field.radius)
  const direction = sunDirection(sun)
  const sky =
    part === 'sky' ? skyOf(field, sun) : (DARK as unknown as TraceScene['sky'])
  return createTracer({
    medium,
    phase: part === 'first' ? phases.whole : phases.scaled,
    sun: {
      direction,
      irradiance: part === 'sky' ? [0, 0, 0] : [1, 1, 1],
      angularRadius: SUN_RADIUS,
    },
    sky,
    ground: null,
    orders: part === 'first' ? 1 : Infinity,
    ...(part === 'higher' ? { first: 2 } : {}),
    estimator: 'cone',
  })
}

function skyOf(field: FactorField, sun: FactorSun): TraceScene['sky'] {
  const { sky } = cumulusSky(
    { id: 'forward', angle: 0, elevation: sun.elevation, azimuth: sun.azimuth },
    field.middle,
  )
  const bands = (of: readonly number[]) => [of[0]!, of[1]!, of[2]!] as const
  return {
    mean: bands(sky.mean),
    up: bands(sky.up),
    sunward: bands(sky.sunward),
  }
}

/** A cloud's medium: its scaled extinction at its one radius. */
export function mediumOf(field: FactorField): TraceMedium {
  const v = field.voxel
  return traceMedium(
    field.size,
    [v, v, v],
    field.sigma,
    new Float32Array(field.sigma.length).fill(field.radius),
  )
}

/** A ray's trace, on its own stream: the key names the cloud, the sun, the part and the ray. */
export function traceRay(
  tracer: ReturnType<typeof createTracer>,
  key: string,
  ray: Pick<FactorRay, 'origin' | 'direction'>,
  samples: number,
): Traced {
  const seed = deriveSeed(SEED, key)
  let mean = 0
  let squares = 0
  for (let band = 0; band < 3; band += 1) {
    const e = estimateOf(
      joinSums(
        tracePixel(tracer, ray.origin, ray.direction, band, seed, 0, samples),
        {
          sum: 0,
          squares: 0,
          samples: 0,
        },
      ),
    )
    mean += e.mean / 3
    squares += (e.error / 3) ** 2
  }
  return { mean, error: Math.sqrt(squares) }
}

/* ------------------------------------------------------------------------- */
/* A part                                                                     */
/* ------------------------------------------------------------------------- */

/** A ray of a part: its scaled depth, §5.5's higher orders and the tracer's. */
export interface PartRay {
  readonly label: string
  readonly view: FactorRay['view']
  readonly depth: number
  readonly higher: number
  readonly traced: Traced
}

/** What a part was taken on: a part taken on other tables is another field's. */
export interface PartInputs {
  readonly seed: string
  readonly samples: number
  readonly genusHash: string
  readonly dropletHash: string
  readonly sourceHash: string
}

/** One cloud under one sun. */
export interface FactorPartFile extends PartInputs {
  readonly cloud: string
  readonly sun: string
  readonly seconds: number
  readonly rays: readonly PartRay[]
}

export const partInputs = (samples: number): PartInputs => ({
  seed: SEED_TEXT,
  samples,
  genusHash: genusHash(),
  dropletHash: phaseHash(),
  sourceHash: sourceHash(),
})

/** A cloud under a sun: every ray of its pictures marched and traced. */
export function tracePart(
  spec: FactorCloud,
  field: FactorField,
  sun: FactorSun,
  samples: number,
  views: FactorViews = FACTOR_VIEWS,
): FactorPartFile {
  const reader = readerOf(field)
  const direction = sunDirection(sun)
  const tracer = factorTracer(field, sun, 'higher')
  const start = process.cpuUsage()
  const rays: PartRay[] = []
  for (const ray of pictureRays(field, views)) {
    const marched = marchRay(reader, direction, ray.origin, ray.direction)
    if (!(marched.depth > MISSED_DEPTH)) continue
    rays.push({
      label: ray.label,
      view: ray.view,
      depth: figures(marched.depth),
      higher: figures(marched.higher),
      traced: traceRay(
        tracer,
        `${spec.id}:${sun.id}:higher:${ray.label}`,
        ray,
        samples,
      ),
    })
  }
  const used = process.cpuUsage(start)
  return {
    ...partInputs(samples),
    cloud: spec.id,
    sun: sun.id,
    seconds: Math.round((used.user + used.system) / 1e6),
    rays: rays.map((ray) => ({
      ...ray,
      traced: {
        mean: figures(ray.traced.mean),
        error: figures(ray.traced.error, 3),
      },
    })),
  }
}

const figures = (value: number, digits = 6): number =>
  Number(value.toPrecision(digits))

/** Why a part will not do, or null. */
export function refusal(
  part: FactorPartFile,
  inputs: PartInputs,
): string | null {
  for (const key of Object.keys(inputs) as (keyof PartInputs)[])
    if (part[key] !== inputs[key])
      return `${part.cloud} under ${part.sun} has ${key} ${part[key]}, where this run has ${inputs[key]}`
  return null
}

/* ------------------------------------------------------------------------- */
/* The fit                                                                    */
/* ------------------------------------------------------------------------- */

/** A kept ray as the fit reads it. */
export interface FitRay {
  readonly label: string
  readonly cloud: string
  readonly sun: string
  readonly elevation: number
  readonly view: FactorRay['view']
  readonly depth: number
  /** §5.5's higher orders, and the tracer's. */
  readonly h: number
  readonly t: number
}

/** A part's rays the fit keeps: traced to a tenth, and lit by §5.5. */
export function keptRays(part: FactorPartFile): FitRay[] {
  const sun = FACTOR_SUNS.find(({ id }) => id === part.sun)
  if (sun === undefined) throw new Error(`sunFactor: no sun ${part.sun}`)
  return part.rays
    .filter(
      (ray) =>
        ray.traced.mean > 0 &&
        ray.traced.error <= KEPT_ERROR * ray.traced.mean &&
        ray.higher > 0,
    )
    .map((ray) => ({
      label: ray.label,
      cloud: part.cloud,
      sun: part.sun,
      elevation: sun.elevation,
      view: ray.view,
      depth: ray.depth,
      h: ray.higher,
      t: ray.traced.mean,
    }))
}

const sumOf = (
  rays: readonly FitRay[],
  pick: (ray: FitRay) => number,
): number => rays.reduce((sum, ray) => sum + pick(ray), 0)
/** §5.5's sum over the tracer's. */
const ratioOf = (rays: readonly FitRay[]): number =>
  sumOf(rays, (r) => r.h) / sumOf(rays, (r) => r.t)

function groups<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const map = new Map<string, T[]>()
  for (const item of items)
    map.set(key(item), [...(map.get(key(item)) ?? []), item])
  return [...map.values()]
}

/** The pooled factor at an elevation: each cloud and sun counted once, the geometric mean of their own factors. */
export function pooledFactor(rays: readonly FitRay[]): number {
  const own = groups(rays, (r) => `${r.cloud}|${r.sun}`)
  return Math.exp(
    -own.reduce((sum, g) => sum + Math.log(ratioOf(g)), 0) / own.length,
  )
}

/** The factor's two numbers. */
export interface FactorPair {
  readonly l: number
  readonly a: number
}

/** c = l·(1 + a·cot e): the ruled form at v = 1, μ₀ = sin e over the floor. */
export function formFactor(pair: FactorPair, elevation: number): number {
  const mu = Math.max(
    Math.abs(Math.sin((elevation * Math.PI) / 180)),
    SUN_FLOOR,
  )
  return pair.l * (1 + (pair.a * Math.sqrt(1 - mu * mu)) / mu)
}

/**
 * The step of the scan over `a`, and its end. The critic scanned in steps of
 * 0.005, which on all ten clouds lands `a` on 0.265, a tie for the rounding
 * to two decimals the module commits; a thousandth makes the rounding a
 * measurement.
 */
const A_STEP = 0.001
const A_MAX = 3

/**
 * The pooled factor at each elevation, and the pair that reads it best: for
 * each `a` of a scan, `ln l` is the mean of the nodes' logarithms less the
 * form's, and the pair kept is the one whose nodes are missed least in the
 * logarithm.
 */
export function fitPair(rays: readonly FitRay[]): {
  readonly table: readonly {
    readonly elevation: number
    readonly factor: number
  }[]
  readonly pair: FactorPair
} {
  const elevations = [...new Set(rays.map((r) => r.elevation))].sort(
    (a, b) => a - b,
  )
  const table = elevations.map((elevation) => ({
    elevation,
    factor: pooledFactor(rays.filter((r) => r.elevation === elevation)),
  }))
  let best = { l: 1, a: 0, miss: Infinity }
  for (let step = 0; step * A_STEP <= A_MAX + 1e-9; step += 1) {
    const a = step * A_STEP
    const shape = table.map(({ elevation }) =>
      Math.log(formFactor({ l: 1, a }, elevation)),
    )
    const lnL =
      table.reduce(
        (sum, node, i) => sum + Math.log(node.factor) - shape[i]!,
        0,
      ) / table.length
    const miss = table.reduce(
      (sum, node, i) => sum + (Math.log(node.factor) - shape[i]! - lnL) ** 2,
      0,
    )
    if (miss < best.miss) best = { l: Math.exp(lnL), a, miss }
  }
  return { table, pair: { l: best.l, a: best.a } }
}

const rms = (values: readonly number[]): number =>
  Math.sqrt(
    values.reduce((sum, x) => sum + x * x, 0) / Math.max(1, values.length),
  )

/**
 * A set of rays judged: the logarithm's RMS of §5.5 over the tracer as it
 * stands and times a pair's factor, the sum's error each way, and the least
 * any factor could leave, each cloud its own sum ratio a sun.
 */
export function judge(
  rays: readonly FitRay[],
  pair: FactorPair,
): {
  readonly rays: number
  readonly without: number
  readonly with: number
  readonly least: number
  readonly sumWithout: number
  readonly sumWith: number
} {
  const factor = (r: FitRay): number => formFactor(pair, r.elevation)
  const least = groups(rays, (r) => `${r.cloud}|${r.sun}`).flatMap((g) => {
    const own = Math.log(ratioOf(g))
    return g.map((r) => Math.log(r.h / r.t) - own)
  })
  return {
    rays: rays.length,
    without: rms(rays.map((r) => Math.log(r.h / r.t))),
    with: rms(rays.map((r) => Math.log((factor(r) * r.h) / r.t))),
    least: rms(least),
    sumWithout: ratioOf(rays) - 1,
    sumWith: sumOf(rays, (r) => factor(r) * r.h) / sumOf(rays, (r) => r.t) - 1,
  }
}

/* ------------------------------------------------------------------------- */
/* The module                                                                 */
/* ------------------------------------------------------------------------- */

const round = (value: number, digits = 3): number =>
  Number(value.toFixed(digits))

/** What `write` reads: the parts, and the records' files. */
export interface FactorRun {
  readonly parts: readonly FactorPartFile[]
  readonly clouds: readonly (FactorCloud & ReturnType<typeof cloudSize>)[]
  readonly rims: readonly RimFile[]
  readonly covers: readonly CoverFile[]
  readonly genera: ReturnType<typeof genusCounts>
}

/** The module's object: the pair, how it was fitted, what it was judged on, and the records. */
export function factorModule(run: FactorRun) {
  const rays = run.parts.flatMap(keptRays)
  const of = (half: FactorCloud['half'][]) => {
    const ids = new Set(
      run.clouds.filter((c) => half.includes(c.half)).map((c) => c.id),
    )
    return rays.filter((r) => ids.has(r.cloud))
  }
  const all = fitPair(rays)
  const pair: FactorPair = { l: round(all.pair.l, 2), a: round(all.pair.a, 2) }
  const halfOf = (fit: 'a' | 'b') => {
    const fitted = fitPair(of([fit]))
    const judged = judge(of([fit === 'a' ? 'b' : 'a', 'held']), fitted.pair)
    return {
      fitted: [...run.clouds.filter((c) => c.half === fit).map((c) => c.id)],
      pair: { l: round(fitted.pair.l), a: round(fitted.pair.a) },
      table: fitted.table.map((n) => round(n.factor, 2)),
      judged: roundAll(judged),
    }
  }
  const eight = fitPair(of(['a', 'b']))
  return {
    format: 'inertialref/sun-factor' as const,
    version: 1,
    genusHash: genusHash(),
    dropletHash: phaseHash(),
    sourceHash: sourceHash(),
    seed: SEED_TEXT,
    samples: FACTOR_SAMPLES,
    keptError: KEPT_ERROR,
    march: {
      step: MARCH_STEP,
      sunDepth:
        'exact: the scaled depth along the sun’s ray from the sample to where it leaves the cloud’s box, in steps of half a voxel, and the same away from the sun; each times μ₀ and the transport scale',
    },
    views: FACTOR_VIEWS,
    suns: FACTOR_SUNS,
    clouds: run.clouds,
    rays: rays.length,
    pairs: { cumulus: pair },
    fit: {
      elevations: all.table.map((n) => n.elevation),
      pooled: all.table.map((n) => round(n.factor, 3)),
      pair: { l: round(all.pair.l), a: round(all.pair.a) },
      form: all.table.map((n) => round(formFactor(pair, n.elevation), 3)),
      eight: {
        pooled: eight.table.map((n) => round(n.factor, 3)),
        pair: { l: round(eight.pair.l), a: round(eight.pair.a) },
      },
    },
    halves: { a: halfOf('a'), b: halfOf('b') },
    bySun: FACTOR_SUNS.map((sun) => {
      const judged = judge(
        rays.filter((r) => r.sun === sun.id),
        pair,
      )
      return {
        sun: sun.id,
        rays: judged.rays,
        sumWithout: round(judged.sumWithout),
        sumWith: round(judged.sumWith),
      }
    }),
    all: roundAll(judge(rays, pair)),
    records: {
      rim: rimRecord(run.rims, pair),
      cover: coverRecord(run.covers, pair),
      genera: run.genera.map((count) => ({
        ...count,
        committed: false,
        fitted: count.clouds >= GENUS_CLOUDS,
      })),
    },
  }
}

function roundAll<T extends Record<string, number>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, round(value)]),
  ) as T
}

/** The module's text, before prettier. */
export function moduleText(module: ReturnType<typeof factorModule>): string {
  return [
    '/*',
    ' * Generated by `node apps/ingest/src/transport/sunFactor.ts write`; rerun it',
    ' * rather than editing. `sunFactorRead.ts` is how the product reads it.',
    ' *',
    ' * The factor of the sun’s orders past the first a cumuliform genus takes,',
    ' * c = 1 + v·(l·(1 + a·√(1 − μ₀²)/μ₀) − 1), μ₀ = max(|sunMu|, 0.05), v the',
    ' * convective share a step holds: `pairs` is (l, a) by genus, and a genus',
    ' * not in it takes 1 and 0. It is fitted to the float64 tracer’s orders past',
    ' * the first on the scaled medium of the field’s own clouds, over §5.5',
    ' * marched on the CPU through the committed source table, and every record',
    ' * past `all` is a measurement that moves no committed number.',
    ' */',
    `export const SUN_FACTOR = ${JSON.stringify(module)} as const`,
    '',
  ].join('\n')
}

/* ------------------------------------------------------------------------- */
/* The records                                                                */
/* ------------------------------------------------------------------------- */

/** A ray thinner than this scaled depth is a rim's: the critic's bin. */
export const RIM_DEPTH = 1.55
/** The suns a rim is taken under: the low ones, ahead and behind. */
export const RIM_SUNS = ['7-behind', '7-ahead', '15-behind', '15-ahead']

/** A cloud's rim under a sun: the parts of its rays' light, summed over its thin rays. */
export interface RimFile extends PartInputs {
  readonly cloud: string
  readonly sun: string
  readonly seconds: number
  readonly rays: number
  /** First order with its gain, the sky alone, and the orders past the first, the tracer's and §5.5's. */
  readonly first: number
  readonly sky: number
  readonly higher: number
  readonly marched: number
}

/**
 * The whole pixel at a rim: on a cloud's rays thinner than `RIM_DEPTH`, kept
 * as the fit keeps them, the tracer's first order on the whole phase with
 * its gain and its sky alone, traced here, beside the higher orders its part
 * already holds. Every order traced is first + sky + higher; the march's
 * pixel puts §5.5 in place of the last, with the factor or without it.
 */
export function traceRim(
  spec: FactorCloud,
  field: FactorField,
  part: FactorPartFile,
  samples: number,
): RimFile {
  const sun = FACTOR_SUNS.find(({ id }) => id === part.sun)!
  const kept = new Set(
    keptRays(part)
      .filter((ray) => ray.depth < RIM_DEPTH)
      .map((ray) => ray.label),
  )
  const rays = pictureRays(field).filter((ray) => kept.has(ray.label))
  const medium = mediumOf(field)
  const first = factorTracer(field, sun, 'first', medium)
  const sky = factorTracer(field, sun, 'sky', medium)
  const start = process.cpuUsage()
  let sums = { first: 0, sky: 0, higher: 0, marched: 0 }
  for (const ray of rays) {
    const row = part.rays.find((r) => r.label === ray.label)!
    sums = {
      first:
        sums.first +
        field.gain *
          traceRay(
            first,
            `${spec.id}:${sun.id}:first:${ray.label}`,
            ray,
            samples,
          ).mean,
      sky:
        sums.sky +
        traceRay(sky, `${spec.id}:${sun.id}:sky:${ray.label}`, ray, samples)
          .mean,
      higher: sums.higher + row.traced.mean,
      marched: sums.marched + row.higher,
    }
  }
  const used = process.cpuUsage(start)
  return {
    ...partInputs(samples),
    cloud: spec.id,
    sun: sun.id,
    seconds: Math.round((used.user + used.system) / 1e6),
    rays: rays.length,
    first: figures(sums.first),
    sky: figures(sums.sky),
    higher: figures(sums.higher),
    marched: figures(sums.marched),
  }
}

/** The rim's record: by sun, every order traced against the march's pixel with the factor and without, and the higher orders alone each way. */
export function rimRecord(files: readonly RimFile[], pair: FactorPair) {
  return RIM_SUNS.map((id) => {
    const at = files.filter((file) => file.sun === id)
    const sum = (pick: (file: RimFile) => number): number =>
      at.reduce((total, file) => total + pick(file), 0)
    const c = formFactor(
      pair,
      FACTOR_SUNS.find((sun) => sun.id === id)!.elevation,
    )
    const traced = sum((f) => f.first + f.sky + f.higher)
    return {
      sun: id,
      clouds: at.length,
      rays: sum((f) => f.rays),
      factor: round(c),
      firstShare: round(sum((f) => f.first) / traced),
      skyShare: round(sum((f) => f.sky) / traced),
      higherShare: round(sum((f) => f.higher) / traced),
      higherWith: round((c * sum((f) => f.marched)) / sum((f) => f.higher) - 1),
      higherWithout: round(sum((f) => f.marched) / sum((f) => f.higher) - 1),
      pixelWith: round(
        (sum((f) => f.first + f.sky) + c * sum((f) => f.marched)) / traced - 1,
      ),
      pixelWithout: round(sum((f) => f.first + f.sky + f.marched) / traced - 1),
    }
  })
}

/** The cumulus level's footprint: 192 voxels of 50 m a side, the rays over its middle half. */
const COVER_GRID = { across: 192, voxel: 50, rays: 12 }
/** Where the footprints stand: the critic's second place. */
const COVER_PLACE = [60_000, 45_000] as const
/** The covers a cumulus level is held at, and the samples a footprint's ray takes. */
export const COVERS = [0.8, 0.9, 1] as const
export const COVER_SAMPLES = 512
export const COVER_SUNS: readonly FactorSun[] = [
  { id: '15-east', elevation: 15, azimuth: 90 },
  { id: '70-east', elevation: 70, azimuth: 90 },
]

/** A cumulus level at one cover under a sun, seen straight down and straight up. */
export interface CoverFile extends PartInputs {
  readonly cover: number
  readonly sun: string
  /** The climate's convective share at the footprint, and the level's cloudy share over it. */
  readonly convective: number
  readonly cloudy: number
  readonly seconds: number
  readonly views: readonly {
    readonly view: 'above' | 'below'
    readonly rays: number
    /** The footprint's mean: the tracer's, and §5.5's. */
    readonly traced: number
    readonly error: number
    readonly marched: number
  }[]
}

/**
 * A fair-weather cumulus level with its cover held at `cover`, cut over a
 * 9.6 km square at the critic's second place and read over the middle 4.8
 * km: the tracer's orders past the first and §5.5's, each a mean over a
 * lattice of rays straight down from over the level and straight up from
 * under it.
 */
export function traceCover(cover: number, samples: number): CoverFile[] {
  const regime = 'fair-cumulus'
  const draft: CumulusSubject = {
    id: `cover-${cover}`,
    regime,
    thickness: null,
    time: 0,
    place: squarePlace(0, 0, CUMULUS_GRID)(0, 0, 0),
  }
  const { weather: own, clock } = subjectWeather(draft)
  const climate = own.climate
  const weather = {
    ...own,
    climate: {
      ...climate,
      sample: (
        direction: Parameters<typeof climate.sample>[0],
        sun: Parameters<typeof climate.sample>[1],
        time: number,
      ) => {
        const sample = climate.sample(direction, sun, time)
        return {
          ...sample,
          cover: [cover, sample.cover[1], sample.cover[2]] as const,
        }
      },
    },
  }
  const level = weather.levels[0]
  const { across, voxel } = COVER_GRID
  const ny = Math.ceil((level.top - level.base) / voxel) + 2
  const grid: FactorGrid = {
    size: [across, ny, across],
    voxel,
    side: 0,
    spacing: 0,
  }
  const place = squarePlace(COVER_PLACE[0], COVER_PLACE[1], grid)(
    0,
    0,
    level.base - voxel,
  )
  const fixture = cumulusFixture(weather, clock, CUMULUS_FIELD_SUN, place)
  const field = fieldOf(fixture, (level.base + level.top) / 2)
  const convective = climate.sample(place.corner, CUMULUS_FIELD_SUN, clock.time)
    .convective[0]
  let columns = 0
  let cloudy = 0
  for (let k = across / 4; k < (3 * across) / 4; k += 1)
    for (let i = across / 4; i < (3 * across) / 4; i += 1) {
      columns += 1
      for (let j = 0; j < ny; j += 1)
        if (fixture.sigma[(j * across + k) * across + i]! > 0) {
          cloudy += 1
          break
        }
    }
  const reader = readerOf(field)
  const medium = mediumOf(field)
  const side = across * voxel
  return COVER_SUNS.map((sun) => {
    const direction = sunDirection(sun)
    const tracer = factorTracer(field, sun, 'higher', medium)
    const start = process.cpuUsage()
    const views = (['above', 'below'] as const).map((view) => {
      let traced = 0
      let squares = 0
      let marched = 0
      const n = COVER_GRID.rays
      for (let a = 0; a < n; a += 1)
        for (let b = 0; b < n; b += 1) {
          const x = side / 4 + ((a + 0.5) / n) * (side / 2)
          const z = side / 4 + ((b + 0.5) / n) * (side / 2)
          const ray: Pick<FactorRay, 'origin' | 'direction'> =
            view === 'above'
              ? { origin: [x, (ny + 1) * voxel, z], direction: [0, -1, 0] }
              : { origin: [x, -voxel, z], direction: [0, 1, 0] }
          const t = traceRay(
            tracer,
            `cover-${cover}:${sun.id}:${view}:${a},${b}`,
            ray,
            samples,
          )
          traced += t.mean
          squares += t.error ** 2
          marched += marchRay(
            reader,
            direction,
            ray.origin,
            ray.direction,
          ).higher
        }
      const rays = n * n
      return {
        view,
        rays,
        traced: figures(traced / rays),
        error: figures(Math.sqrt(squares) / rays, 3),
        marched: figures(marched / rays),
      }
    })
    const used = process.cpuUsage(start)
    return {
      ...partInputs(samples),
      cover,
      sun: sun.id,
      convective: round(convective),
      cloudy: round(cloudy / columns),
      seconds: Math.round((used.user + used.system) / 1e6),
      views,
    }
  })
}

/** The cover's record: the footprint means' error under §5.5, with the factor blended by the convective share and without. */
export function coverRecord(files: readonly CoverFile[], pair: FactorPair) {
  return files.flatMap((file) => {
    const sun = COVER_SUNS.find(({ id }) => id === file.sun)!
    const c = 1 + file.convective * (formFactor(pair, sun.elevation) - 1)
    return file.views.map((view) => ({
      cover: file.cover,
      cloudy: file.cloudy,
      convective: file.convective,
      sun: file.sun,
      view: view.view,
      traced: view.traced,
      error: round(view.error / view.traced),
      without: round(view.marched / view.traced - 1),
      with: round((c * view.marched) / view.traced - 1),
    }))
  })
}

/** The squares a genus is searched in for the record of other genera: the critic's four. */
const GENUS_SQUARES = [
  [150, 20],
  [220, 190],
  [-40, -160],
  [-200, 60],
] as const
/** Clouds a genus needs, standing clear, before a pair is fitted on half and judged on the other. */
export const GENUS_CLOUDS = 6

/**
 * The grid a genus's clouds are cut on: 96 voxels up across its level with
 * the search's margin, and as many across as the cumulus's, so a cloud of
 * the genus's own cell can stand clear.
 */
export function genusGrid(base: number, top: number, cell: number): FactorGrid {
  const voxel = Math.max(
    20,
    Math.ceil((top - base) / (96 - 2 * MARGIN) / 20) * 20,
  )
  return {
    size: [160, 96, 160],
    voxel,
    side: Math.max(19_200, 8 * cell),
    spacing: 4 * voxel,
  }
}

/** Every cumuliform genus but the cumulus, in each regime whose low level holds it: how many clouds stand clear in the four squares. */
export function genusCounts(): {
  readonly genus: CloudGenus
  readonly regime: CumulusSubject['regime']
  readonly voxel: number
  readonly clouds: number
}[] {
  const counts = []
  for (const genus of Object.keys(GENUS_TABLE) as CloudGenus[]) {
    if (!GENUS_TABLE[genus].cumuliform || genus === 'cumulus') continue
    for (const regime of SCENARIO_IDS) {
      const draft: CumulusSubject = {
        id: regime,
        regime,
        thickness: null,
        time: 0,
        place: squarePlace(0, 0, CUMULUS_GRID)(0, 0, 0),
      }
      const level = subjectWeather(draft).weather.levels[0]
      if (level.cumuliform !== genus) continue
      const grid = genusGrid(level.base, level.top, GENUS_TABLE[genus].cell)
      const clouds = GENUS_SQUARES.reduce(
        (sum, [east, north]) =>
          sum +
          standingClouds(regime, east * 1000, north * 1000, grid, GENUS_CLOUDS)
            .length,
        0,
      )
      counts.push({ genus, regime, voxel: grid.voxel, clouds })
    }
  }
  return counts
}

/* ------------------------------------------------------------------------- */
/* The commands                                                               */
/* ------------------------------------------------------------------------- */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const OUT = join(ROOT, 'packages/rendering/src/sunFactor.generated.ts')
const PARTS = join(ROOT, '.data/weather/factor/')

/** A cloud's part under a sun, as `trace` wrote it. */
const readPart = (cloud: string, sun: string): FactorPartFile =>
  JSON.parse(
    readFileSync(join(PARTS, `trace-${cloud}-${sun}.json`), 'utf8'),
  ) as FactorPartFile

const cloudOf = (id: string | undefined): FactorCloud => {
  const spec = FACTOR_CLOUDS.find((c) => c.id === id)
  if (spec === undefined)
    throw new Error(
      `sunFactor: a cloud is one of ${FACTOR_CLOUDS.map((c) => c.id).join(', ')}`,
    )
  return spec
}

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv
  mkdirSync(PARTS, { recursive: true })
  if (command === 'find') {
    for (const spec of FACTOR_CLOUDS)
      console.log(
        `${spec.id} ${spec.regime}: ${JSON.stringify(cloudSize(cutCloud(spec)))}`,
      )
  } else if (command === 'trace') {
    const spec = cloudOf(rest[0])
    const field = cutCloud(spec)
    const picks = rest.slice(1)
    for (const sun of FACTOR_SUNS.filter(
      (s) => picks.length === 0 || picks.includes(s.id),
    )) {
      const part = tracePart(spec, field, sun, FACTOR_SAMPLES)
      writeFileSync(
        join(PARTS, `trace-${spec.id}-${sun.id}.json`),
        JSON.stringify(part),
      )
      console.error(
        `sunFactor: ${spec.id} under ${sun.id}: ${part.rays.length} rays, ${part.seconds} s`,
      )
    }
  } else if (command === 'rim') {
    const spec = cloudOf(rest[0])
    const field = cutCloud(spec)
    for (const id of RIM_SUNS) {
      const part = readPart(spec.id, id)
      const rim = traceRim(spec, field, part, FACTOR_SAMPLES)
      writeFileSync(
        join(PARTS, `rim-${spec.id}-${id}.json`),
        JSON.stringify(rim),
      )
      console.error(
        `sunFactor: ${spec.id}'s rim under ${id}: ${rim.rays} rays, ${rim.seconds} s`,
      )
    }
  } else if (command === 'cover') {
    const cover = Number(rest[0])
    if (!(cover > 0 && cover <= 1)) throw new Error('sunFactor: cover <0 to 1>')
    for (const file of traceCover(cover, COVER_SAMPLES)) {
      writeFileSync(
        join(PARTS, `cover-${cover}-${file.sun}.json`),
        JSON.stringify(file),
      )
      console.error(
        `sunFactor: cover ${cover} under ${file.sun}: ${file.seconds} s`,
      )
    }
  } else if (command === 'genera') {
    const counts = genusCounts()
    writeFileSync(join(PARTS, 'genera.json'), JSON.stringify(counts))
    console.log(JSON.stringify(counts))
  } else if (command === 'write') {
    const inputs = partInputs(FACTOR_SAMPLES)
    const checked = <File extends PartInputs & { readonly samples: number }>(
      name: string,
      samples: number,
    ): File => {
      const file = JSON.parse(readFileSync(join(PARTS, name), 'utf8')) as File
      const why = refusal(file as never, { ...inputs, samples })
      if (why !== null) throw new Error(`sunFactor: refused ${name}: ${why}`)
      return file
    }
    const parts = FACTOR_CLOUDS.flatMap((spec) =>
      FACTOR_SUNS.map((sun) =>
        checked<FactorPartFile>(
          `trace-${spec.id}-${sun.id}.json`,
          FACTOR_SAMPLES,
        ),
      ),
    )
    const rims = FACTOR_CLOUDS.flatMap((spec) =>
      RIM_SUNS.map((id) =>
        checked<RimFile>(`rim-${spec.id}-${id}.json`, FACTOR_SAMPLES),
      ),
    )
    const covers = COVERS.flatMap((cover) =>
      COVER_SUNS.map((sun) =>
        checked<CoverFile>(`cover-${cover}-${sun.id}.json`, COVER_SAMPLES),
      ),
    )
    const genera = JSON.parse(
      readFileSync(join(PARTS, 'genera.json'), 'utf8'),
    ) as ReturnType<typeof genusCounts>
    const clouds = FACTOR_CLOUDS.map((spec) => ({
      ...spec,
      ...cloudSize(cutCloud(spec)),
    }))
    writeFileSync(
      OUT,
      moduleText(factorModule({ parts, clouds, rims, covers, genera })),
    )
    execFileSync(join(ROOT, 'node_modules/.bin/prettier'), ['--write', OUT], {
      stdio: 'inherit',
    })
    const seconds = [...parts, ...rims, ...covers].reduce(
      (sum, file) => sum + file.seconds,
      0,
    )
    console.log(
      `sunFactor: wrote ${OUT}: ${parts.length} parts, ${rims.length} rims, ${covers.length} covers, ${seconds} s of tracing`,
    )
  } else {
    throw new Error(
      'sunFactor: find | trace <cloud> [sun…] | rim <cloud> | cover <cover> | genera | write',
    )
  }
}

// `import.meta.main` rather than `process.argv[1]` against this file's path:
// run through a symlink, argv names the link and the loader resolved the
// target, so the comparison is false and the command exits 0 having written
// nothing.
if (import.meta.main) main(process.argv.slice(2))
