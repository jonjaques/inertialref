import {
  deriveSeed,
  formatSeed,
  Rng,
  rootSeed,
  type Seed,
} from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { type Body, SOLAR_PLANETS } from '@inertialref/universe'
import {
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  type HazeAuthoring,
  sampleLut,
  type ScatteringLut,
  transmittanceFrom,
} from './atmosphere.ts'
import { type AirHeights, airHeights, airTopRatio } from './datum.ts'
import {
  angleOf,
  diffractionShare,
  mieDroplets,
  type MieTable,
} from './mieTable.ts'
import {
  bakeSkyMoments,
  marchSkyMoments,
  SKY_BLOCK_COLUMNS,
  SKY_GROUND_ALBEDO,
  type SkyAir,
  skyDirections,
  type SkyMoments,
  skyMomentsAt,
  type SkyQuadrature,
  skyRadiance,
} from './skyIrradiance.ts'
import { type BodyWeather, regimeWeather } from './weatherClimate.ts'
import { cloudFieldAt, type FieldClock, fieldClock } from './weatherField.ts'
import { GENUS_TABLE, levelProfile } from './weatherGenus.ts'
import type { ScenarioId } from './weatherScenario.ts'

/*
 * The isolated cumulus the path tracers render, and everything the two
 * tracers must agree on before either draws a sample: the density grid, how
 * a point between voxels reads it, the bricks a free flight is drawn
 * against, the phase function as a thing that can be sampled exactly, the
 * views, and the checks that tie a committed reference to the field it was
 * traced through.
 *
 * The CPU tracer lives in `apps/ingest` and the GPU one in `apps/game`, and
 * neither may import the other, so what they share is here. A definition
 * written twice would leave the two tiers agreeing only where the copies do.
 *
 * The fixture is built from `cloudFieldAt`, so it cannot drift from the
 * field: a reference generated from an old field fails against the voxels
 * this builds (`movedVoxels`).
 */

/* ------------------------------------------------------------------------- */
/* The fixture                                                                */
/* ------------------------------------------------------------------------- */

export interface CumulusFixture {
  /** Voxels along the fixture's east, up and north. */
  readonly size: readonly [number, number, number]
  /** A voxel's edge, meters. */
  readonly voxel: number
  /** The low corner's height over the datum, meters. */
  readonly base: number
  /** Scaled in-cloud extinction times the cloudy fraction, 1/m, laid out [up][north][east]. */
  readonly sigma: Float32Array
  /** Effective radius, µm, in the same layout. */
  readonly radius: Float32Array
  /**
   * The same extinction unscaled, 1/m: what the true medium extinguishes
   * with, diffraction counted. A path tracer reads this and the march reads
   * `sigma`; a reference that shared the march's scaling would not test it.
   */
  readonly extinction: Float32Array
}

/** Where on a body a fixture is cut, and how finely. */
export interface CumulusFixturePlace {
  /** The fixture's low corner on the datum, body-fixed, meters from the center. */
  readonly corner: Vec3
  /** Unit, body-fixed: the fixture's east and north; its up is the corner's own. */
  readonly east: Vec3
  readonly north: Vec3
  readonly size: readonly [number, number, number]
  readonly voxel: number
  readonly base: number
}

/** One voxel of a fixture: the three values its arrays hold at an index. */
export interface FixtureVoxel {
  readonly sigma: number
  readonly radius: number
  readonly extinction: number
}

/**
 * The resolved field at one voxel's center: a footprint of zero. Past a
 * footprint the field answers with its level's statistics, a cloudy share
 * and a mean, which is what a far sample marches and not a cloud a path can
 * be traced through. The unscaled extinction is the level's own ratio of
 * the two, as `columnDepth` forms it: a level scales by one diffraction
 * share, its greatest radius's.
 */
export function fixtureVoxel(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  place: CumulusFixturePlace,
  index: number,
): FixtureVoxel {
  const [nx, , nz] = place.size
  const i = index % nx
  const k = Math.floor(index / nx) % nz
  const j = Math.floor(index / (nx * nz))
  const length = Math.hypot(place.corner.x, place.corner.y, place.corner.z)
  const up: Vec3 =
    length > 0
      ? {
          x: place.corner.x / length,
          y: place.corner.y / length,
          z: place.corner.z / length,
        }
      : { x: 0, y: 1, z: 0 }
  const e = (i + 0.5) * place.voxel
  const n = (k + 0.5) * place.voxel
  const h = place.base + (j + 0.5) * place.voxel
  const at = cloudFieldAt(
    weather,
    clock,
    sun,
    {
      x: place.corner.x + place.east.x * e + place.north.x * n + up.x * h,
      y: place.corner.y + place.east.y * e + place.north.y * n + up.y * h,
      z: place.corner.z + place.east.z * e + place.north.z * n + up.z * h,
    },
    0,
  )
  const sigma = at.sigma * at.fraction
  const level = at.level >= 0 ? weather.levels[at.level] : undefined
  const profile = level === undefined ? null : levelProfile(level)
  const unscale =
    profile !== null && profile.scaled > 0 ? profile.sigma / profile.scaled : 0
  return { sigma, radius: at.radius, extinction: sigma * unscale }
}

/** The resolved field on a place's voxels, each read at its center. */
export function cumulusFixture(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  place: CumulusFixturePlace,
): CumulusFixture {
  const [nx, ny, nz] = place.size
  const count = nx * ny * nz
  const sigma = new Float32Array(count)
  const radius = new Float32Array(count)
  const extinction = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const at = fixtureVoxel(weather, clock, sun, place, index)
    sigma[index] = at.sigma
    radius[index] = at.radius
    extinction[index] = at.extinction
  }
  return {
    size: place.size,
    voxel: place.voxel,
    base: place.base,
    sigma,
    radius,
    extinction,
  }
}

/**
 * A fixture with every cloud but one masked off: the largest connected body
 * of cloudy voxels, by faces, that stands clear of the grid's own faces. A
 * body that reaches a face is cut there, and a cut face would be lit as no
 * cloud's is. Where every body is cut the largest is kept and `touches`
 * says so.
 */
export function isolateCumulus(fixture: CumulusFixture): {
  readonly fixture: CumulusFixture
  /** The kept body's voxels, and the cloudy voxels of every body together. */
  readonly voxels: number
  readonly cloudy: number
  readonly touches: boolean
} {
  const [nx, ny, nz] = fixture.size
  const count = nx * ny * nz
  const { extinction } = fixture
  // Each cloudy voxel's body, by the index of the voxel the body was found from.
  const body = new Int32Array(count).fill(-1)
  const stack = new Int32Array(count)
  let kept = -1
  let voxels = 0
  let cloudy = 0
  let touches = true
  for (let start = 0; start < count; start += 1) {
    if (!(extinction[start]! > 0) || body[start] !== -1) continue
    let held = 0
    let size = 0
    let cut = false
    const visit = (index: number): void => {
      if (body[index] !== -1 || !(extinction[index]! > 0)) return
      body[index] = start
      stack[held] = index
      held += 1
    }
    visit(start)
    while (held > 0) {
      held -= 1
      const index = stack[held]!
      size += 1
      const i = index % nx
      const k = Math.floor(index / nx) % nz
      const j = Math.floor(index / (nx * nz))
      if (i === 0 || i === nx - 1 || k === 0 || k === nz - 1) cut = true
      if (j === 0 || j === ny - 1) cut = true
      if (i > 0) visit(index - 1)
      if (i < nx - 1) visit(index + 1)
      if (k > 0) visit(index - nx)
      if (k < nz - 1) visit(index + nx)
      if (j > 0) visit(index - nx * nz)
      if (j < ny - 1) visit(index + nx * nz)
    }
    cloudy += size
    // A clear body beats any cut one, and among equals the larger wins.
    if (cut === touches ? size > voxels : !cut) {
      kept = start
      voxels = size
      touches = cut
    }
  }
  const masked = (values: Float32Array): Float32Array =>
    values.map((value, index) => (body[index] === kept ? value : 0))
  return {
    fixture: {
      ...fixture,
      sigma: masked(fixture.sigma),
      extinction: masked(fixture.extinction),
    },
    voxels,
    cloudy,
    touches: voxels > 0 && touches,
  }
}

let droplets: MieTable | null = null
/** The committed droplet table, decoded once for the readers here. */
const dropletTable = (): MieTable => (droplets ??= mieDroplets())

/** What an analytic cumulus is cut by. */
export interface AnalyticCumulus {
  readonly size: readonly [number, number, number]
  readonly voxel: number
  /** The greatest unscaled extinction, at the cloud's top, 1/m. */
  readonly sigma: number
}

/**
 * Five overlapping lobes over a flat base, in shares of the grid's width:
 * center and radius. A cumulus's shape with no noise in it, so a test of a
 * tracer does not move when the field's recipe does.
 */
const LOBES = [
  [0.5, 0.42, 0.5, 0.26],
  [0.36, 0.34, 0.44, 0.17],
  [0.64, 0.36, 0.56, 0.18],
  [0.52, 0.56, 0.46, 0.15],
  [0.44, 0.3, 0.62, 0.14],
] as const
/** The lobes' flat base and their top, in the same shares. */
const LOBE_BASE = 0.22
const LOBE_TOP = 0.71

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * The analytic fixture both tracers are built and held to each other on: a
 * cloud of lobes whose water grows with height as a cumulus's does,
 * extinction as `w^⅔` and radius as `w^⅓`, from 7.6 µm at the base to 12 µm
 * at the top. Its scaled extinction takes each voxel's own diffraction share.
 */
export function analyticCumulus(spec: AnalyticCumulus): CumulusFixture {
  const [nx, ny, nz] = spec.size
  const width = nx * spec.voxel
  const count = nx * ny * nz
  const sigma = new Float32Array(count)
  const radius = new Float32Array(count)
  const extinction = new Float32Array(count)
  const table = dropletTable()
  for (let j = 0; j < ny; j += 1)
    for (let k = 0; k < nz; k += 1)
      for (let i = 0; i < nx; i += 1) {
        const x = ((i + 0.5) * spec.voxel) / width
        const y = ((j + 0.5) * spec.voxel) / width
        const z = ((k + 0.5) * spec.voxel) / width
        let shape = 0
        for (const [cx, cy, cz, r] of LOBES)
          shape = Math.max(shape, 1 - Math.hypot(x - cx, y - cy, z - cz) / r)
        const density =
          smoothstep(0, 0.3, shape) * smoothstep(LOBE_BASE, LOBE_BASE + 0.03, y)
        const water =
          0.25 + 0.75 * clamp01((y - LOBE_BASE) / (LOBE_TOP - LOBE_BASE))
        const index = (j * nz + k) * nx + i
        const r = 12 * Math.cbrt(water)
        const unscaled = spec.sigma * water ** (2 / 3) * density
        radius[index] = r
        extinction[index] = unscaled
        sigma[index] = unscaled * (1 - diffractionShare(table, r))
      }
  return {
    size: spec.size,
    voxel: spec.voxel,
    base: 0,
    sigma,
    radius,
    extinction,
  }
}

/* ------------------------------------------------------------------------- */
/* The medium a tracer reads                                                  */
/* ------------------------------------------------------------------------- */

/** Cells a side of a brick: a free flight is drawn against a brick's greatest extinction. */
export const TRACE_BRICK = 8

/**
 * A grid as both tracers read it.
 *
 * **Cell coordinates.** A point `x` meters from the grid's low corner is at
 * `q = x/cell + ½` on each axis, so voxel `i`'s center is at `q = i + 1` and
 * the cell `c = ⌊q⌋` lies between the centers of voxels `c − 1` and `c`. The
 * extinction at a point is the trilinear blend of the eight centers about
 * it, with every voxel outside the grid at zero, so the medium ends half a
 * voxel outside the grid's faces and is continuous everywhere. The radius
 * there is the same blend weighted by extinction: the radius of what
 * scatters at the point, which a clear neighbor has no say in.
 *
 * **The domain is the brick grid,** `0 ≤ q < 8·bricks` on each axis. It
 * covers the medium's support, and the cells past the last voxel hold none.
 */
export interface TraceMedium {
  /** Voxels along east, up and north. */
  readonly size: readonly [number, number, number]
  /** A voxel's extent on each axis, meters. */
  readonly cell: readonly [number, number, number]
  /** `[σ, r_e]` a voxel: unscaled extinction, 1/m, and radius, µm, laid out [up][north][east]. */
  readonly voxels: Float32Array
  /** Bricks along each axis. */
  readonly bricks: readonly [number, number, number]
  /**
   * Each brick's greatest extinction, laid out as the voxels are. It is
   * taken over the voxels a point in the brick blends and one voxel more on
   * every side, so a point a rounding error past a brick's face is still
   * under the bound of the brick it was stepped from.
   */
  readonly majorant: Float32Array
}

/** A grid of extinction and radius as a tracer's medium. */
export function traceMedium(
  size: readonly [number, number, number],
  cell: readonly [number, number, number],
  extinction: ArrayLike<number>,
  radius: ArrayLike<number>,
): TraceMedium {
  const [nx, ny, nz] = size
  const voxels = new Float32Array(nx * ny * nz * 2)
  for (let index = 0; index < nx * ny * nz; index += 1) {
    voxels[2 * index] = extinction[index]!
    voxels[2 * index + 1] = radius[index]!
  }
  const bricks = [
    Math.ceil((nx + 1) / TRACE_BRICK),
    Math.ceil((ny + 1) / TRACE_BRICK),
    Math.ceil((nz + 1) / TRACE_BRICK),
  ] as const
  const majorant = new Float32Array(bricks[0] * bricks[1] * bricks[2])
  const span = (b: number, n: number): readonly [number, number] => [
    Math.max(0, TRACE_BRICK * b - 2),
    Math.min(n - 1, TRACE_BRICK * b + TRACE_BRICK),
  ]
  for (let by = 0; by < bricks[1]; by += 1)
    for (let bz = 0; bz < bricks[2]; bz += 1)
      for (let bx = 0; bx < bricks[0]; bx += 1) {
        const [i0, i1] = span(bx, nx)
        const [j0, j1] = span(by, ny)
        const [k0, k1] = span(bz, nz)
        let greatest = 0
        for (let j = j0; j <= j1; j += 1)
          for (let k = k0; k <= k1; k += 1)
            for (let i = i0; i <= i1; i += 1)
              greatest = Math.max(
                greatest,
                voxels[2 * ((j * nz + k) * nx + i)]!,
              )
        majorant[(by * bricks[2] + bz) * bricks[0] + bx] = greatest
      }
  return { size, cell, voxels, bricks, majorant }
}

/** A fixture's true medium: its unscaled extinction on cubic voxels. */
export function fixtureMedium(fixture: CumulusFixture): TraceMedium {
  const { voxel } = fixture
  return traceMedium(
    fixture.size,
    [voxel, voxel, voxel],
    fixture.extinction,
    fixture.radius,
  )
}

/**
 * The medium at a point in cell coordinates: `out[0]` the extinction, 1/m,
 * and `out[1]` the radius of what scatters there, µm, zero where nothing
 * does.
 */
export function mediumAt(
  medium: TraceMedium,
  qx: number,
  qy: number,
  qz: number,
  out: Float64Array,
): void {
  const { size, voxels } = medium
  const nx = size[0]
  const ny = size[1]
  const nz = size[2]
  const cx = Math.floor(qx)
  const cy = Math.floor(qy)
  const cz = Math.floor(qz)
  const fx = qx - cx
  const fy = qy - cy
  const fz = qz - cz
  let sum = 0
  let weighted = 0
  for (let dy = 0; dy < 2; dy += 1) {
    const j = cy - 1 + dy
    if (j < 0 || j >= ny) continue
    const wy = dy === 1 ? fy : 1 - fy
    for (let dz = 0; dz < 2; dz += 1) {
      const k = cz - 1 + dz
      if (k < 0 || k >= nz) continue
      const wyz = wy * (dz === 1 ? fz : 1 - fz)
      const row = (j * nz + k) * nx
      for (let dx = 0; dx < 2; dx += 1) {
        const i = cx - 1 + dx
        if (i < 0 || i >= nx) continue
        const at = 2 * (row + i)
        const s = wyz * (dx === 1 ? fx : 1 - fx) * voxels[at]!
        sum += s
        weighted += s * voxels[at + 1]!
      }
    }
  }
  out[0] = sum
  out[1] = sum > 0 ? weighted / sum : 0
}

/** Midpoint steps a cell a line-of-sight depth is integrated with. */
const DEPTH_STEPS = 8

/**
 * The unscaled optical depth along a ray through the whole medium, from a
 * point in meters from the grid's low corner along a unit direction. A
 * trilinear field is a cubic along a ray, so eight midpoints a cell hold it
 * to 10⁻³ of a cell's own depth.
 */
export function mediumDepth(
  medium: TraceMedium,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
): number {
  const { cell, bricks } = medium
  let near = -Infinity
  let far = Infinity
  const q = [0, 0, 0]
  const d = [0, 0, 0]
  for (let a = 0; a < 3; a += 1) {
    q[a] = origin[a]! / cell[a]! + 0.5
    d[a] = direction[a]! / cell[a]!
    const high = TRACE_BRICK * bricks[a]!
    if (d[a] === 0) {
      if (q[a]! < 0 || q[a]! >= high) return 0
      continue
    }
    const t0 = (0 - q[a]!) / d[a]!
    const t1 = (high - q[a]!) / d[a]!
    near = Math.max(near, Math.min(t0, t1))
    far = Math.min(far, Math.max(t0, t1))
  }
  near = Math.max(near, 0)
  if (!(far > near)) return 0
  const step = Math.min(cell[0], cell[1], cell[2]) / DEPTH_STEPS
  const steps = Math.ceil((far - near) / step)
  const dt = (far - near) / steps
  const out = new Float64Array(2)
  let depth = 0
  for (let s = 0; s < steps; s += 1) {
    const t = near + (s + 0.5) * dt
    mediumAt(
      medium,
      q[0]! + d[0]! * t,
      q[1]! + d[1]! * t,
      q[2]! + d[2]! * t,
      out,
    )
    depth += out[0]!
  }
  return depth * dt
}

/* ------------------------------------------------------------------------- */
/* The phase a tracer samples                                                 */
/* ------------------------------------------------------------------------- */

/** Numbers a node of the sampled phase holds: its density, its cumulative share and its coordinate. */
export const PHASE_NODE = 4

/**
 * The droplet table as a density a tracer can sample exactly.
 *
 * Each row and band is piecewise linear in the cosine between the table's
 * own angles and divided by its own integral under that rule, so drawing a
 * direction by the inverse of `cdf` draws from exactly the density `pdf`
 * evaluates. That identity is what gives an analog walk a throughput of one
 * and the furnace its zero variance; the table's own normalization is a
 * trapezoid in the angle and differs from this one in the fourth figure.
 *
 * **The coordinate is the cosine's distance from the nearer end:**
 * `1 − cos θ` in the forward half and `1 + cos θ` in the backward. The
 * table's first node is 4 × 10⁻⁴ of a degree from the axis, where the cosine
 * differs from one by 3 × 10⁻¹¹; a float32 cosine cannot hold that, and
 * its distance from one can.
 */
export interface TracePhase {
  readonly angles: number
  readonly rows: number
  /** µm: row j's radius is `radiusMin·(radiusMax/radiusMin)^(j/(rows − 1))`. */
  readonly radiusMin: number
  readonly radiusMax: number
  /**
   * `[pdf, cdf, coordinate, 0]` a node, laid out [row][band][angle]. `pdf`
   * is sr⁻¹ and integrates to one; `cdf` is the share of the row's light
   * scattered through less than the node's angle.
   */
  readonly nodes: Float64Array
}

/** The node an angle index, a row and a band start at in `TracePhase.nodes`. */
export const phaseNodeAt = (
  phase: TracePhase,
  row: number,
  band: number,
): number => (row * 3 + band) * phase.angles * PHASE_NODE

/** The sampled form of a phase table. */
export function tracePhase(table: MieTable): TracePhase {
  const { angles, radii } = table
  const nodes = new Float64Array(radii * 3 * angles * PHASE_NODE)
  const half = angles / 2
  /** `1 − cos θ` and `1 + cos θ` at every node, each by the half-angle, which holds it at its own end. */
  const forward = new Float64Array(angles)
  const backward = new Float64Array(angles)
  for (let i = 0; i < angles; i += 1) {
    const theta = angleOf(table, i)
    forward[i] = 2 * Math.sin(theta / 2) ** 2
    backward[i] = 2 * Math.cos(theta / 2) ** 2
  }
  /** The cosine's fall across the interval from node i to the next. */
  const width = (i: number): number =>
    i + 1 < half
      ? forward[i + 1]! - forward[i]!
      : backward[i]! - backward[i + 1]!
  for (let row = 0; row < radii; row += 1)
    for (let band = 0; band < 3; band += 1) {
      const at = (row * 3 + band) * angles * PHASE_NODE
      const value = (i: number): number =>
        table.phase[(row * angles + i) * 3 + band]!
      const piece = (i: number): number =>
        Math.PI * (value(i) + value(i + 1)) * width(i)
      let total = 0
      for (let i = 0; i + 1 < angles; i += 1) total += piece(i)
      let cumulative = 0
      for (let i = 0; i < angles; i += 1) {
        nodes[at + i * PHASE_NODE] = value(i) / total
        nodes[at + i * PHASE_NODE + 1] =
          i === angles - 1 ? 1 : cumulative / total
        nodes[at + i * PHASE_NODE + 2] = i < half ? forward[i]! : backward[i]!
        if (i + 1 < angles) cumulative += piece(i)
      }
    }
  return {
    angles,
    rows: radii,
    radiusMin: table.radiusMin,
    radiusMax: table.radiusMax,
    nodes,
  }
}

/**
 * The node whose angle bounds the cone about the sun, 9.38° on the committed
 * table, and that angle as `1 − cos θ`. A tracer treats a path that runs
 * toward the sun inside this cone apart from one that does not
 * (`apps/ingest/src/transport/pathTrace.ts` says why), and a cone that ends
 * on a node has its share of a row's light in the table: the node's `cdf`.
 */
export const PHASE_CONE_NODE = 150
export const phaseConeReach = (phase: TracePhase): number =>
  phase.nodes[PHASE_CONE_NODE * PHASE_NODE + 2]!

/**
 * The rows a radius blends, as the table's own bilinear read does: the lower
 * row and the share of the one above it. A scattering at a radius between
 * two rows is the lower row's with one less that share and the upper's with
 * it, so drawing the row by that share draws from the blend.
 */
export function phaseRow(
  phase: TracePhase,
  radius: number,
): readonly [row: number, share: number] {
  const index =
    ((phase.rows - 1) * Math.log(radius / phase.radiusMin)) /
    Math.log(phase.radiusMax / phase.radiusMin)
  const clamped = Math.min(phase.rows - 1, Math.max(0, index))
  const row = Math.min(phase.rows - 2, Math.floor(clamped))
  return [row, clamped - row]
}

/** The cosine's fall across the interval that starts at node `i` of the row at `at`. */
function phaseWidth(phase: TracePhase, at: number, i: number): number {
  const { nodes, angles } = phase
  const a = nodes[at + i * PHASE_NODE + 2]!
  const b = nodes[at + (i + 1) * PHASE_NODE + 2]!
  if (i + 1 < angles / 2) return b - a
  return (i < angles / 2 ? 2 - a : a) - b
}

/**
 * A row's density at an angle, sr⁻¹, the angle given as `m = 1 − cos θ` and
 * `s = 1 + cos θ` together, so whichever is small is exact. `at` is
 * `phaseNodeAt` of the row and band.
 */
export function phaseDensity(
  phase: TracePhase,
  at: number,
  m: number,
  s: number,
): number {
  const { nodes, angles } = phase
  // The table's angles are θ_i = (π/2)(1 − cos(πi/(n − 1))), so the index of
  // an angle is (n − 1)(2/π)·asin√(θ/π), and of π − θ the same from the end.
  const index =
    m <= 1
      ? (angles - 1) *
        (2 / Math.PI) *
        Math.asin(Math.sqrt((2 * Math.asin(Math.sqrt(m / 2))) / Math.PI))
      : (angles - 1) *
        (1 -
          (2 / Math.PI) *
            Math.asin(Math.sqrt((2 * Math.asin(Math.sqrt(s / 2))) / Math.PI)))
  const i = Math.min(angles - 2, Math.max(0, Math.floor(index)))
  const a = at + i * PHASE_NODE
  const width = phaseWidth(phase, at, i)
  // An index a rounding error off its interval lands on the shared node,
  // where both intervals hold one value.
  const t =
    i + 1 < angles / 2
      ? (m - nodes[a + 2]!) / width
      : ((i < angles / 2 ? 2 - nodes[a + 2]! : nodes[a + 2]!) - s) / width
  const share = Math.min(1, Math.max(0, t))
  return nodes[a]! + (nodes[a + PHASE_NODE]! - nodes[a]!) * share
}

/**
 * A scattering angle drawn from a row by the inverse of its cumulative
 * share, for `u` in [0, 1): `out` takes `m`, `s` and the row's density
 * there.
 */
export function phaseSample(
  phase: TracePhase,
  at: number,
  u: number,
  out: Float64Array,
): void {
  const { nodes, angles } = phase
  let low = 0
  let high = angles - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (nodes[at + middle * PHASE_NODE + 1]! <= u) low = middle
    else high = middle
  }
  const a = at + low * PHASE_NODE
  const from = nodes[a]!
  const slope = nodes[a + PHASE_NODE]! - from
  const width = phaseWidth(phase, at, low)
  // The interval holds 2π·width·(from·t + slope·t²/2) of the row's light by
  // t, and this is that quadratic's root in the form that keeps a small t.
  const c = Math.max(0, u - nodes[a + 1]!) / (2 * Math.PI * width)
  const root = from + Math.sqrt(Math.max(0, from * from + 2 * slope * c))
  const t = root > 0 ? Math.min(1, (2 * c) / root) : 0
  if (low + 1 < angles / 2) {
    out[0] = nodes[a + 2]! + t * width
    out[1] = 2 - out[0]!
  } else {
    out[1] = (low < angles / 2 ? 2 - nodes[a + 2]! : nodes[a + 2]!) - t * width
    out[0] = 2 - out[1]!
  }
  out[2] = from + slope * t
}

/* ------------------------------------------------------------------------- */
/* The views                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A view of the fixture: an orthographic camera looking north along the
 * fixture's own axis, level, and a sun placed by the angle a ray's light
 * turns through to reach the eye.
 */
export interface CumulusView {
  readonly id: 'forward' | 'side' | 'back'
  /** Degrees between the sun and the direction the camera looks. */
  readonly angle: number
  /** The sun's elevation, and its azimuth from north toward east, degrees. */
  readonly elevation: number
  readonly azimuth: number
}

/**
 * The rubric's three sun–view angles (row 6). At 15° the sun stands behind
 * the cloud and the rim is the silver lining; at 165° it stands behind the
 * eye and the near face is lit; at 90° it lights one flank.
 */
export const CUMULUS_VIEWS: readonly CumulusView[] = [
  { id: 'forward', angle: 15, elevation: 15, azimuth: 0 },
  { id: 'side', angle: 90, elevation: 45, azimuth: 90 },
  { id: 'back', angle: 165, elevation: 15, azimuth: 180 },
]

/** A view's sun, unit, in the fixture's east, up and north. */
export function viewSun(view: CumulusView): readonly [number, number, number] {
  const e = (view.elevation * Math.PI) / 180
  const a = (view.azimuth * Math.PI) / 180
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]
}

/**
 * Where a pixel's ray starts, meters from the grid's low corner: a square
 * image of `pixels` a side over the grid's east and up, centered on it and
 * as wide as the longer of the two, row 0 at the top. Every ray runs north
 * from south of the grid, through its pixel's center: a line-of-sight depth
 * is a pixel's own, and a jittered ray would have none.
 */
export function viewRay(
  medium: TraceMedium,
  pixels: number,
  px: number,
  py: number,
): readonly [number, number, number] {
  const width = medium.size[0] * medium.cell[0]
  const height = medium.size[1] * medium.cell[1]
  const side = Math.max(width, height)
  return [
    width / 2 + ((px + 0.5) / pixels - 0.5) * side,
    height / 2 + (0.5 - (py + 0.5) / pixels) * side,
    -medium.cell[2],
  ]
}

/* ------------------------------------------------------------------------- */
/* A reference and the field it was traced through                            */
/* ------------------------------------------------------------------------- */

/** A case of a reference: one subject seen one way, and the light it stands in. */
export interface CumulusCase {
  readonly id: string
  readonly subject: string
  readonly view: CumulusView['id']
  /** The image's side, pixels, and the samples a pixel and band took. */
  readonly pixels: number
  readonly samples: number
  /** The sun's angular radius, radians; its irradiance is one in every band. */
  readonly sunRadius: number
  /** The sky's mean radiance and its two irradiance differences (§5.6), per band, in the sun's irradiance. */
  readonly sky: {
    readonly mean: readonly [number, number, number]
    readonly up: readonly [number, number, number]
    readonly sunward: readonly [number, number, number]
  }
  /**
   * Where those three were read in the table of Earth's air (`cumulusSky`):
   * a height over the datum, meters, and the sun's cosine. Null where the
   * sky is no table's but three numbers a case was given.
   */
  readonly skyAt: { readonly height: number; readonly sunMu: number } | null
  /** A Lambertian ground, its height in meters from the grid's low corner, or none. */
  readonly ground: { readonly height: number; readonly albedo: number } | null
}

/** One pixel of a case: where it is, what it was chosen as, and its radiance per band with its standard error. */
export interface CumulusProbe {
  readonly case: string
  readonly mask: 'rim' | 'edge' | 'core' | 'base'
  /** The bin of line-of-sight depth it was drawn for; zero in the core and the base. */
  readonly bin: number
  readonly pixel: readonly [number, number]
  /** Its unscaled line-of-sight depth through the fixture. */
  readonly depth: number
  readonly radiance: readonly [number, number, number]
  readonly error: readonly [number, number, number]
}

/**
 * A case's curve in one mask and band: by bin of line-of-sight depth, the
 * bin's mean radiance over the core's median, with the standard error of
 * that ratio. `bins` names the bins that held a pixel.
 */
export interface CumulusCurve {
  readonly case: string
  readonly mask: 'rim' | 'edge'
  readonly band: number
  readonly bins: readonly number[]
  readonly depth: readonly number[]
  readonly radiance: readonly number[]
  readonly error: readonly number[]
}

/** A case's absolute levels: the medians of its core and base pixels, per band. */
export interface CumulusMedians {
  readonly case: string
  readonly core: readonly [number, number, number]
  readonly coreError: readonly [number, number, number]
  readonly base: readonly [number, number, number]
  readonly baseError: readonly [number, number, number]
}

/**
 * What the renderer's scaled medium costs in one mask of one case (§5.1):
 * the mean radiance of the mask's pixels on the scaled medium over their
 * mean on the true one, per band, with the standard error of that ratio.
 * The scaled medium is first order on the whole phase through scaled
 * depths and every order past it of the scaled phase, which is what the
 * march sets out to draw; the true one is the reference itself.
 */
export interface CumulusScaling {
  readonly case: string
  readonly mask: CumulusProbe['mask']
  /** Samples a pixel and band took on the scaled medium. */
  readonly samples: number
  readonly ratio: readonly [number, number, number]
  readonly error: readonly [number, number, number]
}

/**
 * One pixel of a case on the renderer's scaled medium, in two parts a
 * march keeps apart (§5.1, §5.5), each per band with its standard error and
 * in the reference's units:
 *
 * - `first`: one order of scattering of the sun, the whole phase as the
 *   source and scaled depths both ways, under no sky.
 * - `rest`: every order past the first of the scaled phase, and with it the
 *   case's own `sky` (the table's moments) by every order, the sky seen
 *   straight through the cloud included.
 *
 * Their sum is the pixel on the scaled medium, to hold beside the same
 * pixel of `probes`, which is the true one. The sky's share of `rest` is the
 * same row of `CUMULUS_LINEAR_SKIES.table`.
 */
export interface CumulusScaledProbe {
  readonly case: string
  readonly mask: CumulusProbe['mask']
  readonly bin: number
  readonly pixel: readonly [number, number]
  readonly first: readonly [number, number, number]
  readonly firstError: readonly [number, number, number]
  readonly rest: readonly [number, number, number]
  readonly restError: readonly [number, number, number]
}

/**
 * The sky alone on the renderer's scaled medium at one pixel of a case: a
 * sky by every order of the scaled phase, under a sun that gives its
 * bearing and no light. A row names its case and pixel and no more: its
 * mask and bin are that row of `scaled`'s, and the file is read whole by
 * whoever reads any of it.
 *
 * Three skies are traced so, each a block a row a row of `scaled`:
 *
 * - `CUMULUS_REFERENCE.airScattered`, under the air's own sky by direction
 *   (`cumulusAirSky`), the light the cloud scatters alone: what judges the
 *   march's sky term (ruling 008). `airSplit` holds it by case and mask
 *   beside the sky seen straight through.
 * - `CUMULUS_LINEAR_SKIES.linearScattered`, the same under the sky linear
 *   in direction on the quadrature's moments (`cumulusQuadratureSky`): what
 *   judges the march's transport under its own form of the sky, apart from
 *   that form's error. `linearSplit` beside it.
 * - `CUMULUS_LINEAR_SKIES.table`, under the case's own `sky`, the table's
 *   moments, the sky seen straight through included: the sky `scaled`'s
 *   `rest` was traced under, so `rest` less this row is the sun's light
 *   past its first order.
 */
export interface CumulusSkyProbe {
  readonly case: string
  readonly pixel: readonly [number, number]
  readonly sky: readonly [number, number, number]
  readonly skyError: readonly [number, number, number]
}

/**
 * The sky alone in one mask of a case, held apart (ruling 008), per band:
 * the sky seen straight through, a path that leaves the medium unscattered,
 * which is `e^(−τ)` along the eye's line of the sky on that line and has no
 * error; and the light the cloud scatters, with its standard error. Each is
 * the mean over the mask's rows. A march's sky term draws the second, and
 * the atmosphere draws the sky behind the cloud.
 */
export interface CumulusSkySplit {
  readonly case: string
  readonly mask: CumulusProbe['mask']
  readonly straight: readonly [number, number, number]
  readonly scattered: readonly [number, number, number]
  readonly scatteredError: readonly [number, number, number]
}

/** A case's sky linear in direction on the moments the quadrature takes at its height and sun, as traced. */
export interface CumulusSkyMoments {
  readonly case: string
  readonly mean: readonly [number, number, number]
  readonly up: readonly [number, number, number]
  readonly sunward: readonly [number, number, number]
}

/**
 * The sky alone under the two linear skies (`cumulusLinearSkies.generated.ts`),
 * beside the reference: a file of their own, because three blocks of 1,702
 * rows do not fit the reference's under its cap.
 */
export interface CumulusLinearSkies {
  readonly format: 'inertialref/cumulus-linear-skies'
  readonly version: 1
  /** The quadrature's moments each case's linear rows were traced under. */
  readonly moments: readonly CumulusSkyMoments[]
  /** Under the linear sky on the quadrature's moments, the light the cloud scatters, a row a row of `scaled`. */
  readonly linearScattered: readonly CumulusSkyProbe[]
  /** The same by case and mask, beside the sky seen straight through. */
  readonly linearSplit: readonly CumulusSkySplit[]
  /** Under the case's own `sky`, the table's moments, the whole sky alone, a row a row of `scaled`. */
  readonly table: readonly CumulusSkyProbe[]
}

/** The generated reference's form (`cumulusReference.generated.ts`). */
export interface CumulusReference {
  readonly format: 'inertialref/cumulus-reference'
  readonly version: 1
  /** The genus table's hash the subjects were built under; empty with no subject. */
  readonly genusHash: string
  readonly subjects: readonly CumulusSubject[]
  readonly cases: readonly CumulusCase[]
  readonly probes: readonly CumulusProbe[]
  readonly curves: readonly CumulusCurve[]
  readonly medians: readonly CumulusMedians[]
  /** Voxels of each subject's fixture, as the field returned them. */
  readonly voxels: readonly (RecordedVoxel & { readonly subject: string })[]
  /** The scaled medium against the true one, a row a case and mask. */
  readonly scaling: readonly CumulusScaling[]
  /** The scaled medium itself, a row a pixel of `probes`, in its two parts. */
  readonly scaled: readonly CumulusScaledProbe[]
  /** Under the air's own sky by direction, the light the cloud scatters of the sky alone on the scaled medium, a row a row of `scaled`. */
  readonly airScattered: readonly CumulusSkyProbe[]
  /** The same by case and mask, beside the sky seen straight through. */
  readonly airSplit: readonly CumulusSkySplit[]
  /**
   * The same tracer on the analytic cumulus, which no field moves: what the
   * GPU tracer is held to on every run of its suite.
   */
  readonly analytic: {
    readonly fixture: AnalyticCumulus
    readonly cases: readonly CumulusCase[]
    readonly probes: readonly CumulusProbe[]
  }
}

/** Earth's air as the scene hands it to the bake: its haze, its shell's ratio and its two scale heights. */
export function cumulusAir(): {
  readonly haze: HazeAuthoring
  readonly topRatio: number
  readonly heights: AirHeights
} {
  const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')
  if (earth === undefined || earth.haze === null || earth.atmosphere === null)
    throw new Error('cumulusFixture: Sol has no Earth with air')
  return {
    haze: earth.haze,
    topRatio: airTopRatio(earth.radius, earth.haze.height),
    heights: airHeights(
      earth.radius,
      earth.haze.height,
      earth.atmosphere.scaleHeight,
      earth.haze.aerosolHeight,
    ),
  }
}

let skyAir: SkyAir | null = null
/** Earth's air as the sky's march reads it: its recipe and its own two tables, baked once. */
export function cumulusSkyAir(): SkyAir {
  if (skyAir === null) {
    const { haze, topRatio, heights } = cumulusAir()
    const recipe = atmosphereRecipe(haze, topRatio, heights)
    const transmittance = bakeTransmittance(recipe)
    skyAir = {
      recipe,
      transmittance,
      multiScatter: bakeMultipleScattering(recipe, transmittance),
    }
  }
  return skyAir
}

let skyTable: ScatteringLut | null = null
/** The sky table of Earth's air (`bakeSkyMoments`), baked once: what the page bakes for Earth and the march reads. */
export function cumulusSkyTable(): ScatteringLut {
  if (skyTable === null) {
    const { recipe, transmittance, multiScatter } = cumulusSkyAir()
    skyTable = bakeSkyMoments(recipe, transmittance, multiScatter)
  }
  return skyTable
}

/** A height over the datum as the sky table's row coordinate: its share of the air's depth. */
export function cumulusSkyHeight(height: number): number {
  const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')
  return earth?.haze ? Math.max(0, height) / earth.haze.height : 0
}

/**
 * The sky a cumulus stands under: the table's three moments at a height
 * and a view's sun, read as the march's node reads them (`skyMomentsAt`),
 * and where they were read.
 */
export function cumulusSky(
  view: CumulusView,
  height: number,
): {
  readonly sky: SkyMoments
  readonly at: NonNullable<CumulusCase['skyAt']>
} {
  const sunMu = viewSun(view)[1]
  return {
    sky: skyMomentsAt(cumulusSkyTable(), cumulusSkyHeight(height), sunMu),
    at: { height, sunMu },
  }
}

/**
 * The radiance a unit direction sees of a case's sky, per band, in the
 * fixture's east, up and north under a sun toward `sun`: the sky linear in
 * direction that has the case's three moments,
 * `mean·max(0, 1 + ¾·(up·ω_y + sunward·ω·ŝ_h))`. Both tracers draw this
 * sky, behind the cloud as well as on it, so a march's light is laid over
 * this and not over the air's own sky before it is held to a pixel.
 */
export function cumulusSkyRadiance(
  sky: CumulusCase['sky'],
  sun: readonly [number, number, number],
  direction: readonly [number, number, number],
): readonly [number, number, number] {
  const flat = Math.hypot(sun[0], sun[2])
  const toward =
    flat > 0 ? (direction[0] * sun[0] + direction[2] * sun[2]) / flat : 0
  const band = (b: number): number =>
    sky.mean[b]! *
    Math.max(
      0,
      1 + 0.75 * (sky.up[b]! * direction[1] + sky.sunward[b]! * toward),
    )
  return [band(0), band(1), band(2)]
}

/* ------------------------------------------------------------------------- */
/* The air's own sky, by direction                                            */
/* ------------------------------------------------------------------------- */

/**
 * The quadrature the air's own sky is taken at: 2,016 directions, 32 heights
 * over the horizon and 16 under it by 42 azimuths on one side of the sun's
 * vertical plane, at the bake's 16 samples a direction. It is the one the
 * sky table is held to (`skyIrradiance.test.ts`), so a reference lit by it
 * and a table judged by it are judged by one sky.
 */
export const CUMULUS_SKY_QUADRATURE: SkyQuadrature = {
  above: 32,
  below: 16,
  azimuths: 42,
  steps: 16,
}

/**
 * A sky given by direction at one height under one sun: radiance per band
 * at a quadrature's own directions (`skyDirections`) and on the level,
 * read between them by `skyByDirection`. A direction is named in the
 * sun's frame: its sine of height over the level, and its bearing from the
 * sun's azimuth, which the sky mirrors across.
 *
 * Its rows are the quadrature's heights, each side's ascending away from
 * the horizon, by `w`, the root of the row's share of its side's span:
 * `z = horizon ± span·w²`. The quadrature crowds its nodes toward the
 * horizon in `w`, where the sky is brightest and changes fastest, so a
 * read in `w` is a read between near neighbors there.
 *
 * Over the horizon one row more stands on the level, z = 0, and a read
 * does not cross it. The air's march lays its samples about the point a
 * ray passes closest to the ground, which is the ray's start from the
 * level up and ahead of it under the level, so its radiance has a kink
 * there: under a sun 15° up at 1.7 km, read across it from the rows either
 * side, the level away from the sun is 3.1% bright in red. A level line of
 * sight is a reference's own, so the read takes that row and not a guess.
 *
 * It holds the logarithm. Under the horizon the sky falls about
 * exponentially away from it, the ground's light fading through more air,
 * and the 16 rows there stand 5.5° apart at 15° down: read linearly in the
 * radiance itself it is 3.3% bright between two of them under the same sun.
 */
export interface SkyByDirection {
  /** The horizon's sine of height from where the sky is taken: under zero, by the dip. */
  readonly horizon: number
  /** Each side's rows' `w`, ascending: over the horizon, the level's among them, and under it. */
  readonly above: readonly number[]
  readonly below: readonly number[]
  /** The row of `above` on the level, which a read does not cross; -1 from the datum, where the level is the horizon. */
  readonly level: number
  /** Azimuths over the half circle from the sun's bearing, at its midpoints. */
  readonly azimuths: number
  /** The radiance's logarithm by row (over the horizon's, then under it), azimuth and band. */
  readonly radiance: Float64Array
}

/** The floor a radiance's logarithm is taken over: no direction of a lit sky is darker. */
const DARKEST = 1e-30

/**
 * The sky at a quadrature's directions from radius `r` (the datum is 1),
 * and on the level at its azimuths: `radiance` fills `out` with the light
 * arriving from (x, y, z), z up and the sun's azimuth +x, as
 * `skyMomentsOf` takes it.
 */
export function skyByDirectionOf(
  r: number,
  quadrature: Pick<SkyQuadrature, 'above' | 'below' | 'azimuths'>,
  radiance: (x: number, y: number, z: number, out: number[]) => void,
): SkyByDirection {
  const { above, below, azimuths } = quadrature
  if (!(above > 0 && below > 0 && azimuths > 1))
    throw new Error(
      'cumulusFixture: a sky by direction needs rows on both sides and two azimuths',
    )
  const horizon = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)))
  const directions = skyDirections(r, quadrature)
  const light = [0, 0, 0]
  /** A row: its `w`, and its directions' radiances' logarithms by azimuth and band. */
  const rows: { w: number; values: number[] }[] = []
  const take = (w: number, x: number, y: number, z: number, at: number[]) => {
    radiance(x, y, z, light)
    for (let c = 0; c < 3; c += 1)
      at.push(Math.log(Math.max(light[c] as number, DARKEST)))
    return w
  }
  for (let i = 0, k = 0; i < directions.length; i += 4, k += 1) {
    const z = directions[i + 2] as number
    if (k % azimuths === 0) {
      const span = k < above * azimuths ? 1 - horizon : -1 - horizon
      rows.push({ w: Math.sqrt(Math.max(0, (z - horizon) / span)), values: [] })
    }
    take(
      0,
      directions[i] as number,
      directions[i + 1] as number,
      z,
      rows[rows.length - 1]!.values,
    )
  }
  const over = rows.slice(0, above)
  const under = rows.slice(above)
  let level = -1
  if (horizon < 0) {
    const values: number[] = []
    const arc = Math.PI / azimuths
    for (let j = 0; j < azimuths; j += 1)
      take(0, Math.cos((j + 0.5) * arc), Math.sin((j + 0.5) * arc), 0, values)
    const w = Math.sqrt(-horizon / (1 - horizon))
    level = over.findIndex((row) => row.w > w)
    if (level < 0) level = over.length
    over.splice(level, 0, { w, values })
  }
  return {
    horizon,
    above: over.map(({ w }) => w),
    below: under.map(({ w }) => w),
    level,
    azimuths,
    radiance: Float64Array.from(
      [...over, ...under].flatMap(({ values }) => values),
    ),
  }
}

/** The bracketing nodes of `w` in ascending `nodes`, and the share of the upper; held past both ends. */
function bracket(nodes: readonly number[], w: number): [number, number] {
  const last = nodes.length - 1
  if (!(w > nodes[0]!)) return [0, 0]
  if (w >= nodes[last]!) return [last, 0]
  let low = 0
  let high = last
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (nodes[middle]! <= w) low = middle
    else high = middle
  }
  return [low, (w - nodes[low]!) / (nodes[low + 1]! - nodes[low]!)]
}

/**
 * A band of a sky by direction, toward the unit direction whose sine of
 * height is `up`, whose component along the sun's azimuth is `toward` and
 * across it `across`, inside the side of the horizon the direction is on,
 * in the logarithm. Across the azimuths it is Catmull–Rom, the nodes past
 * either end taken from their mirrors across the sun's plane. Across the
 * rows, which are not even in `w`, it is Hermite, each node's slope the
 * parabola's through it and its two neighbors and one-sided at a side's
 * ends and at the level. Between the horizon and a side's first row it
 * holds the row, and past its last row it runs across the pole.
 *
 * Measured against the quadrature's own radiance at 512 seeded directions
 * under each of the reference's two suns at 1.7 km, the median is 0.005%;
 * `cumulusFixture.test.ts` holds the rest.
 */
export function skyByDirection(
  sky: SkyByDirection,
  up: number,
  toward: number,
  across: number,
  band: number,
): number {
  const over = up >= sky.horizon
  const span = over ? 1 - sky.horizon : -1 - sky.horizon
  const nodes = over ? sky.above : sky.below
  const first = over ? 0 : sky.above.length
  const level = over ? sky.level : -1
  const [row, rowShare] = bracket(
    nodes,
    Math.sqrt(Math.max(0, (up - sky.horizon) / span)),
  )
  const { azimuths } = sky
  const ring = (i: number, bearing: number): number => {
    const f = (bearing * azimuths) / Math.PI - 0.5
    const j = Math.floor(f)
    const t = f - j
    const node = (k: number): number => {
      const mirrored =
        k < 0 ? -k - 1 : k > azimuths - 1 ? 2 * azimuths - 1 - k : k
      return sky.radiance[((first + i) * azimuths + mirrored) * 3 + band]!
    }
    const p0 = node(j - 1)
    const p1 = node(j)
    const p2 = node(j + 1)
    const p3 = node(j + 2)
    return (
      p1 +
      0.5 *
        t *
        (p2 -
          p0 +
          t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
    )
  }
  const bearing = Math.atan2(Math.abs(across), toward)
  const last = nodes.length - 1
  if (row < last) {
    const value = (i: number): number => ring(i, bearing)
    const y1 = value(row)
    const y2 = value(row + 1)
    const h1 = nodes[row + 1]! - nodes[row]!
    const secant = (y2 - y1) / h1
    // The slope at row `i` of the interval [row, row + 1], from the rows of
    // that interval's own run: no neighbor past a side's end or the level.
    const slope = (i: number, y: number): number => {
      const lower = i > 0 && !(i === level && i === row)
      const upper = i < last && !(i === level && i === row + 1)
      const before = lower
        ? (y - value(i - 1)) / (nodes[i]! - nodes[i - 1]!)
        : NaN
      const after = upper
        ? (value(i + 1) - y) / (nodes[i + 1]! - nodes[i]!)
        : NaN
      if (!lower) return upper ? after : secant
      if (!upper) return before
      const h0 = nodes[i]! - nodes[i - 1]!
      const h = nodes[i + 1]! - nodes[i]!
      return (before * h + after * h0) / (h0 + h)
    }
    const m1 = slope(row, y1) * h1
    const m2 = slope(row + 1, y2) * h1
    const t = rowShare
    const t2 = t * t
    const t3 = t2 * t
    return Math.exp(
      (2 * t3 - 3 * t2 + 1) * y1 +
        (t3 - 2 * t2 + t) * m1 +
        (-2 * t3 + 3 * t2) * y2 +
        (t3 - t2) * m2,
    )
  }
  // Past the last row the rings close on the pole, and a ring held there
  // keeps the sky's slope across it as a step. So the read runs along the
  // great circle through the pole, from the last ring at this bearing to
  // the same ring at the opposite one.
  const toPole = (z: number): number => Math.acos(Math.min(Math.abs(z), 1))
  const z = sky.horizon + span * nodes[last]! ** 2
  const reach = toPole(z)
  const share = reach > 0 ? (toPole(up) + reach) / (2 * reach) : 1
  const opposite = ring(last, Math.PI - bearing)
  return Math.exp(opposite + (ring(last, bearing) - opposite) * share)
}

/**
 * The air's own radiance arriving at radius `r` from (x, y, z), z up, under
 * a sun at cosine `muSun` whose azimuth is +x, per unit of the sun's
 * irradiance and before the gain: what `marchSkyMoments` sums at each of
 * its directions. The air along the ray is `skyRadiance`'s march, which is
 * the quadrature's own; a ray that meets the ground adds the ground's light
 * through the air between, Lambert at `SKY_GROUND_ALBEDO` under the sun and
 * the clear sky at the datum, read between the table's sun columns as the
 * quadrature reads it.
 *
 * The air's transmittance to the ground is the one figure taken otherwise:
 * the quadrature's march keeps it private, so here it is
 * `transmittanceFrom` from the ground over `transmittanceFrom` from the
 * point, both along the reversed ray. `cumulusFixture.test.ts` holds the
 * moments and the four sides this sums to against `marchSkyMoments` and
 * `marchSkyFaces`.
 */
export function airSkyRadiance(
  air: SkyAir,
  quadrature: Pick<SkyQuadrature, 'above' | 'azimuths' | 'steps'>,
  r: number,
  muSun: number,
): (x: number, y: number, z: number, out: number[]) => void {
  const { recipe } = air
  const steps = { steps: quadrature.steps }
  // The ground's light at each of the table's sun cosines, taken when a ray
  // first needs it: from the datum the directions over the level are the
  // whole upper hemisphere, and their z-moment is its irradiance.
  const datum = skyDirections(1, { ...quadrature, below: 0 })
  const columns = new Map<number, readonly number[]>()
  const column = (k: number): readonly number[] => {
    const held = columns.get(k)
    if (held !== undefined) return held
    const mu = (k / (SKY_BLOCK_COLUMNS - 1)) * 2 - 1
    const sky = [0, 0, 0]
    for (let i = 0; i < datum.length; i += 4) {
      const z = datum[i + 2] as number
      const weight = datum[i + 3] as number
      const light = skyRadiance(
        air,
        1,
        mu,
        [datum[i] as number, datum[i + 1] as number, z],
        steps,
      )
      for (let c = 0; c < 3; c += 1) sky[c] = sky[c]! + light[c]! * weight * z
    }
    const sun = sampleLut(air.transmittance, (mu + 1) / 2, 0)
    const lit = [0, 1, 2].map(
      (c) =>
        (SKY_GROUND_ALBEDO / Math.PI) * ((mu > 0 ? mu * sun[c]! : 0) + sky[c]!),
    )
    columns.set(k, lit)
    return lit
  }
  const sx = Math.sqrt(Math.max(0, 1 - muSun * muSun))
  return (x, y, z, out) => {
    const [a, b, c] = skyRadiance(air, r, muSun, [x, y, z], steps)
    out[0] = a
    out[1] = b
    out[2] = c
    if (!(z < 0)) return
    const discriminant = r * r * (z * z - 1) + 1
    if (discriminant < 0) return
    const d = -r * z - Math.sqrt(discriminant)
    if (!(d > 0)) return
    const px = x * d
    const py = y * d
    const pz = r + z * d
    const length = Math.hypot(px, py, pz)
    const cosine = (px * sx + pz * muSun) / length
    const u =
      Math.min(Math.max((cosine + 1) / 2, 0), 1) * (SKY_BLOCK_COLUMNS - 1)
    const k0 = Math.floor(u)
    const k1 = Math.min(k0 + 1, SKY_BLOCK_COLUMNS - 1)
    const share = u - k0
    const g0 = column(k0)
    const g1 = column(k1)
    const fromGround = transmittanceFrom(1, -(d + r * z), recipe)
    const fromHere = transmittanceFrom(r, -z, recipe)
    for (let band = 0; band < 3; band += 1) {
      const through =
        fromHere[band]! > 0 ? fromGround[band]! / fromHere[band]! : 0
      out[band] =
        out[band]! + through * (g0[band]! + (g1[band]! - g0[band]!) * share)
    }
  }
}

/** A height over the datum, meters, as a radius in the air's own units: the datum is 1. */
export function cumulusSkyRadius(height: number): number {
  return 1 + cumulusSkyHeight(height) * (cumulusSkyAir().recipe.topRatio - 1)
}

/**
 * The air's own sky a cumulus stands under (ruling 007): at the height a
 * case's sky was read at and its sun, the quadrature's radiance at each of
 * its 2,016 directions, read between them. Neither the sky table nor its
 * moments: a reference lit by what the march reads could judge neither.
 */
export function cumulusAirSky(
  at: NonNullable<CumulusCase['skyAt']>,
): SkyByDirection {
  const r = cumulusSkyRadius(at.height)
  return skyByDirectionOf(
    r,
    CUMULUS_SKY_QUADRATURE,
    airSkyRadiance(cumulusSkyAir(), CUMULUS_SKY_QUADRATURE, r, at.sunMu),
  )
}

/**
 * The three moments of the air's own sky at the height a case's sky was
 * read at and its sun: `marchSkyMoments` at `CUMULUS_SKY_QUADRATURE`, and
 * not the table's read there. The linear sky on these is the march's form
 * under the right moments, so a reference lit by it judges the march's
 * transport apart from its sky.
 */
export function cumulusQuadratureSky(
  at: NonNullable<CumulusCase['skyAt']>,
): SkyMoments {
  return marchSkyMoments(
    cumulusSkyAir(),
    cumulusSkyRadius(at.height),
    at.sunMu,
    CUMULUS_SKY_QUADRATURE,
  )
}

/** The cloud a reference is traced through: a regime's low level on the datum of an Earth. */
export interface CumulusSubject {
  readonly id: string
  readonly regime: ScenarioId
  /** The low level's thickness, meters, where it is not the regime's own. */
  readonly thickness: number | null
  /** Seconds from J2000. */
  readonly time: number
  readonly place: CumulusFixturePlace
}

/** The datum the subjects stand on, meters. */
export const CUMULUS_DATUM = 6_371_000
const SUBJECT_SEED: Seed = /*@__PURE__*/ rootSeed('cumulus-reference')
/** The sun the subjects' climate is read under: overhead, which a regime's uniform cover does not read. */
export const CUMULUS_FIELD_SUN: Vec3 = { x: 0, y: 1, z: 0 }

/** A subject's weather and its clock. */
export function subjectWeather(subject: CumulusSubject): {
  readonly weather: BodyWeather
  readonly clock: FieldClock
} {
  // A regime's weather reads a body's radius and its surface's seed alone.
  const body = {
    radius: CUMULUS_DATUM,
    surface: { seed: SUBJECT_SEED },
  } as unknown as Body
  const regime = regimeWeather(body, subject.regime)
  const [low, middle, high] = regime.levels
  const weather: BodyWeather =
    subject.thickness === null
      ? regime
      : {
          ...regime,
          levels: [{ ...low, top: low.base + subject.thickness }, middle, high],
        }
  return { weather, clock: fieldClock(weather, subject.time) }
}

/** The genus table's hash: what a reference records, so one traced under other genera is refused. */
export function genusHash(): string {
  return formatSeed(rootSeed(JSON.stringify(GENUS_TABLE)))
}

/** A voxel a reference carries: its index in the fixture and what the field held there. */
export interface RecordedVoxel {
  readonly index: number
  readonly sigma: number
  readonly radius: number
}

/**
 * `count` of a fixture's cloudy voxels, drawn by a seed and sorted: what a
 * reference carries of the fixture it was traced through.
 */
export function recordVoxels(
  fixture: CumulusFixture,
  count: number,
): readonly RecordedVoxel[] {
  const cloudy: number[] = []
  fixture.sigma.forEach((value, index) => {
    if (value > 0) cloudy.push(index)
  })
  const rng = Rng.fromSeed(deriveSeed(SUBJECT_SEED, 'voxels'))
  const taken = Math.min(count, cloudy.length)
  for (let i = 0; i < taken; i += 1) {
    const j = rng.int(i, cloudy.length - 1)
    const a = cloudy[i]!
    cloudy[i] = cloudy[j]!
    cloudy[j] = a
  }
  return cloudy
    .slice(0, taken)
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      sigma: fixture.sigma[index]!,
      radius: fixture.radius[index]!,
    }))
}

/**
 * The recorded voxels the field no longer returns. A reference whose voxels
 * have moved was traced through a cloud the march no longer draws.
 */
export function movedVoxels(
  subject: CumulusSubject,
  recorded: readonly RecordedVoxel[],
): readonly RecordedVoxel[] {
  const { weather, clock } = subjectWeather(subject)
  return recorded.filter(({ index, sigma, radius }) => {
    const at = fixtureVoxel(
      weather,
      clock,
      CUMULUS_FIELD_SUN,
      subject.place,
      index,
    )
    return Math.fround(at.sigma) !== sigma || Math.fround(at.radius) !== radius
  })
}
