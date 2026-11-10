import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  StorageBufferAttribute,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Break,
  float,
  Fn,
  If,
  instanceIndex,
  Loop,
  storage,
  texture,
  uint,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import {
  type BodyWeather,
  bodyWeather,
  cloudExtents,
  cloudFieldAt,
  type FieldClock,
  fieldClock,
  horizonBasis,
  levelFrames,
  levelProfile,
  regimeWeather,
  shellHeights,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { CloudClipmap } from './cloudClipmap.ts'
import { analyticMedium, fieldMedium, synopticMedium } from './cloudDensity.ts'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudFrame,
  weatherClimate,
  weatherLevels,
} from './cloudFrame.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { CloudMaps } from './cloudMaps.ts'
import type { CloudBudget, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import { CloudNoise } from './cloudNoise.ts'
import {
  bodyLevelSpecs,
  type CloudProfile,
  createCloudProfile,
} from './cloudProfile.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The media against the CPU field they port, `cloudFieldAt` (phase 1
 * design §4.3, §5.2, §5.3): the drawn extinction at a body point and an
 * instant equals the oracle's, through the real chain — the climate baked
 * into the cube, resampled into the clipmap with the mesoscale displacement,
 * the profile table's bytes, the noise's bytes — at three stances; one body
 * point from two eyes, one over a pole, reads one density; the field turns
 * as the CPU's does; a footprint's fade keeps the field's transmittance; and
 * every read names level 0.
 *
 * What the drawn field may differ by, and its sources, are measured here
 * and named at each bound: the climate's bytes, the sampler's fixed-point
 * weights, the displacement carried by the clipmap as a value and a rate
 * and stored in half floats, and float32 against float64.
 */

let gpu: GpuSession
let renderer: WebGPURenderer
let noise: CloudNoise

const TIME = 7.3e9

const ROOT = rootSeed('inertialref')
const SOL: ReadonlyMap<string, Body> = (() => {
  const stub = resolveSystem(
    galaxySeedOf(ROOT, MILKY_WAY),
    SOL_ONLY_CATALOG,
    systemId('SOL'),
  )!
  const system = generateSystem(ROOT, MILKY_WAY, stub)
  return new Map(
    [...walkBodies(system)].map((body) => [formatAddress(body.address), body]),
  )
})()
const EARTH_RECORD = SOL.get('g:milky-way/s:SOL/b:2')!
const SERVED_EARTH: Body = {
  ...EARTH_RECORD,
  appearance: { ...EARTH_RECORD.appearance, clouds: null },
}
const EARTH = SERVED_EARTH.radius

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
  noise = new CloudNoise()
  await noise.warm(renderer)
})

afterAll(() => {
  noise.dispose()
  gpu.dispose()
})

function draws(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const budget: CloudBudget = {
  slices: 0,
  tiles: 0,
  jump: false,
  sunSlices: 0,
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}
const scaled = (v: Vec3, s: number): Vec3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
})
const added = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})
const less = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
})

const SUN = unit({ x: 0.9, y: 0.42, z: 0.1 })

/** A frame with every field the bundle writes, written into `uniforms`: the weather's own levels and climate. */
function frameAt(
  uniforms: CloudUniforms,
  weather: BodyWeather,
  key: string,
  eye: Vec3,
  time = TIME,
  previous: CloudFrame | null = null,
): CloudFrame {
  const drawn = { weather, regime: null } as const
  const levels = weatherLevels(drawn, time, eye)
  const frame = {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true },
    scenario: WEATHER_SCENARIOS['fair-cumulus'],
    served: {
      address: 'test',
      datumRadius: EARTH,
      compression: 1,
      toBodyFixed: { x: 0, y: 0, z: 0, w: 1 },
      eye,
      sun: SUN,
      shells: shellHeights(
        eye,
        EARTH,
        levels.flatMap((level) => [level.base, level.top]),
      ),
      scattering: null,
      limb: 0,
      limbFalloff: 1,
      dayColor: { r: 1, g: 1, b: 1 },
      noiseOrigin: { x: 0, y: 0, z: 0 },
      detailOrigin: { x: 0, y: 0, z: 0 },
      drift: { x: 0, y: 0, z: 0 },
      wind: { x: 0, y: 0, z: 0 },
      clipmap: levelFrames(
        eye,
        EARTH,
        CLOUD_CLIPMAP_TEXELS,
        CLOUD_CLIPMAP_SIZE,
        previous?.served.clipmap.frames ?? null,
      ),
      volume: { frames: [], dirty: [], rebuilt: [] },
      weatherKey: key,
      levels,
      climate: weatherClimate(drawn, time, SUN),
    },
    second: null,
    time,
    frameSeconds: previous === null ? 0 : time - previous.time,
    period: [0, 0],
    camera: {
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      forward: { x: 0, y: 0, z: -1 },
      halfTan: 0.5,
      aspect: 1,
      pixelAngle: 0.002,
    },
    previousCamera: null,
    translation: { x: 0, y: 0, z: 0 },
    enhanced: false,
    regime: 'converging',
    reset: 'none',
    jump: previous !== null && time !== previous.time,
    frameIndex: 0,
    extents: cloudExtents({ width: 64, height: 64 }, { width: 64, height: 64 }),
  } satisfies CloudFrame
  uniforms.write(frame)
  return frame
}

/** The served body's field at `eye`: a cube and a clipmap baked whole, the profile written. */
interface Field {
  readonly uniforms: CloudUniforms
  readonly profile: CloudProfile
  readonly maps: CloudMaps
  readonly clipmap: CloudClipmap
  readonly frame: CloudFrame
  readonly media: {
    readonly field: CloudMediumFn
    readonly synoptic: CloudMediumFn
    readonly analytic: CloudMediumFn
  }
  dispose(): void
}

function bakeField(
  weather: BodyWeather,
  key: string,
  eye: Vec3,
  time = TIME,
): Field {
  const uniforms = createCloudUniforms()
  const profile = createCloudProfile({ uniforms })
  const maps = new CloudMaps(uniforms, noise.nodes)
  const clipmap = new CloudClipmap(uniforms, maps.nodes)
  let frame = frameAt(uniforms, weather, key, eye, time)
  for (let k = 0; k < 8; k += 1) {
    maps.render(renderer, frame, budget)
    clipmap.render(renderer, frame, budget)
    frame = frameAt(uniforms, weather, key, eye, time, frame)
  }
  expect(maps.pending).toBe(false)
  expect(clipmap.pending).toBe(false)
  const recipe = { uniforms, noise: noise.nodes, profile }
  return {
    uniforms,
    profile,
    maps,
    clipmap,
    frame,
    media: {
      field: fieldMedium({ ...recipe, clipmap: clipmap.nodes }),
      synoptic: synopticMedium({ ...recipe, maps: maps.nodes }),
      analytic: analyticMedium(recipe),
    },
    dispose() {
      maps.dispose()
      clipmap.dispose()
      profile.dispose()
    },
  }
}

/** A sample's inputs: its body point, and the meters it stands for. */
interface Point {
  readonly position: Vec3
  readonly footprint: number
}

/** `medium` at each point seen from `eye`, one thread each: (fraction, σ′, level, column), and (radius, depth). */
async function evaluate(
  points: readonly Point[],
  eye: Vec3,
  medium: CloudMediumFn,
  uniforms: CloudUniforms,
): Promise<Float32Array> {
  const count = points.length
  const input = new StorageBufferAttribute(
    new Float32Array(
      points.flatMap(({ position, footprint }) => {
        const offset = less(position, eye)
        const altitude = Math.hypot(position.x, position.y, position.z) - EARTH
        return [
          offset.x,
          offset.y,
          offset.z,
          altitude,
          footprint,
          Math.hypot(offset.x, offset.y, offset.z),
          0,
          0,
        ]
      }),
    ),
    4,
  )
  const output = new StorageBufferAttribute(new Float32Array(count * 8), 4)
  const from = storage(input, 'vec4', count * 2)
  const into = storage(output, 'vec4', count * 2)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const a = from.element(instanceIndex.mul(2))
      const b = from.element(instanceIndex.mul(2).add(1))
      const sample: CloudSample = {
        offset: a.xyz,
        distance: b.y,
        altitude: a.w,
        sunMu: float(0.5),
        footprint: b.x,
      }
      const m = medium(sample, uniforms.served)
      into
        .element(instanceIndex.mul(2))
        .assign(vec4(m.fraction, m.sigma, float(m.layer), m.column))
      into
        .element(instanceIndex.mul(2).add(1))
        .assign(vec4(m.radius, m.depth, 0))
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** The scaled reference σ′ of a weather's level: what an error in extinction is measured against. */
const referenceSigma = (weather: BodyWeather, level: number): number =>
  levelProfile(weather.levels[level]!).scaled

interface Errors {
  /** |Δ(fraction·σ′)| over the level's σ′, at every point either side holds cloud. */
  readonly errors: number[]
  readonly clouded: number
  readonly levels: number
}

/** The drawn medium against `cloudFieldAt` at every point. */
function against(
  weather: BodyWeather,
  clock: FieldClock,
  points: readonly Point[],
  read: Float32Array,
): Errors {
  const errors: number[] = []
  let clouded = 0
  let levels = 0
  points.forEach(({ position, footprint }, n) => {
    const want = cloudFieldAt(weather, clock, SUN, position, footprint)
    const level = read[n * 8 + 2]!
    if (level === want.level) levels += 1
    if (want.level < 0) return
    const drawn = read[n * 8]! * read[n * 8 + 1]!
    const expected = want.fraction * want.sigma
    if (expected > 0) clouded += 1
    // Where either side holds cloud: a clear point agreeing with a clear
    // point says nothing of the port.
    if (drawn > 0 || expected > 0)
      errors.push(
        Math.abs(drawn - expected) / referenceSigma(weather, want.level),
      )
  })
  return { errors, clouded, levels }
}

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

/** Points in a weather's levels around a ground point, uniform in height through each level and in area out to `reach`. */
function pointsAround(
  weather: BodyWeather,
  ground: Vec3,
  reach: number,
  seed: number,
  count = 1000,
  footprints: readonly number[] = [0],
): Point[] {
  const next = draws(seed)
  const { east, north, up } = horizonBasis(ground)
  const filled = weather.levels
    .map((level, k) => ({ level, k }))
    .filter(({ level }) => level.top > level.base)
  return Array.from({ length: count }, (_, n) => {
    const { level } = filled[n % filled.length]!
    const angle = next() * 2 * Math.PI
    const distance = reach * Math.sqrt(next())
    const height = level.base + (level.top - level.base) * next()
    const across = added(
      scaled(east, distance * Math.cos(angle)),
      scaled(north, distance * Math.sin(angle)),
    )
    const radial = unit(added(scaled(up, EARTH), across))
    return {
      position: scaled(radial, EARTH + height),
      footprint: footprints[n % footprints.length]!,
    }
  })
}

/* ------------------------------------------------------------------------- */

describe('the profile table', () => {
  it('is each body’s levels’ `levelProfile`, byte for byte, in its slot', () => {
    const weather = bodyWeather(SERVED_EARTH)!
    const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
    const field = bakeField(weather, 'climate', scaled(ground, EARTH + 1500))
    const table = field.profile.texture.image.data as Uint8Array
    const specs = bodyLevelSpecs(field.frame.served)
    expect(specs.map((spec) => [spec.stratiform, spec.cumuliform])).toEqual(
      weather.levels.map((level) => [level.stratiform, level.cumuliform]),
    )
    for (const slot of [0, 1])
      specs.forEach((spec, k) => {
        const rows = levelProfile(spec).texels
        const at = (slot * 24 + k * 8) * 64 * 4
        expect([...table.subarray(at, at + rows.length)]).toEqual([...rows])
      })
    field.dispose()
  })
})

/*
 * Three stances of the cornerstones that the system rig can draw: the
 * horizon from 1.5 km, a deck seen from above at 6 km, and straight down
 * from 400 km. The points are the field's, around the ground under the
 * eye, out to where each stance looks.
 */
const STANCES = [
  { name: 'the horizon from 1.5 km', height: 1500, reach: 30_000 },
  { name: 'above the deck at 6 km', height: 6000, reach: 20_000 },
  { name: 'straight down from 400 km', height: 400_000, reach: 100_000 },
] as const

/**
 * The drawn field's error against `cloudFieldAt`, in the level's σ′, at the
 * points either side holds cloud. Measured on this Mac mini (Apple M6), the
 * median is 1.7 × 10⁻⁴ to 2.6 × 10⁻³ and the 99th percentile 5.0 × 10⁻⁴ to
 * 1.08 × 10⁻² over the three stances, three regimes and the far media, and
 * the worst point 1.51 × 10⁻² (from 400 km). Its sources: the cover's
 * bytes, amplified by the remap's division by the cover; the sampler's
 * fixed-point weights on the noise; and the displacement carried by the
 * clipmap as a value and a rate in half floats, whose linearization is
 * worth up to 27 m at a level's edge. The bounds are twice the measured.
 */
const ORACLE_MEDIAN = 0.005
const ORACLE_P99 = 0.02

describe('each medium is cloudFieldAt', () => {
  it.each(STANCES)(
    'fieldMedium, under Earth’s zonal climate: $name',
    async ({ height, reach }) => {
      const weather = bodyWeather(SERVED_EARTH)!
      const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
      const eye = scaled(ground, EARTH + height)
      const field = bakeField(weather, 'climate', eye)
      const points = pointsAround(weather, ground, reach, 7)
      const read = await evaluate(
        points,
        eye,
        field.media.field,
        field.uniforms,
      )
      const { errors, clouded, levels } = against(
        weather,
        fieldClock(weather, TIME),
        points,
        read,
      )
      expect(levels).toBe(points.length)
      expect(clouded).toBeGreaterThan(100)
      const median = quantile(errors, 0.5)
      const p99 = quantile(errors, 0.99)
      console.info(
        `oracle, fieldMedium, ${height} m: median ${median.toExponential(2)}, p99 ${p99.toExponential(2)}, worst ${Math.max(...errors).toExponential(2)}, clouded ${clouded}`,
      )
      expect(median).toBeLessThanOrEqual(ORACLE_MEDIAN)
      expect(p99).toBeLessThanOrEqual(ORACLE_P99)
      field.dispose()
    },
    60_000,
  )

  it.each(['broken-horizon', 'stratocumulus', 'two-decks'] as const)(
    'fieldMedium, under %s as a weather',
    async (id) => {
      const weather = regimeWeather(SERVED_EARTH, id)
      const ground = unit({ x: -0.6, y: 0.1, z: 0.79 })
      const eye = scaled(ground, EARTH + 1500)
      const field = bakeField(weather, id, eye)
      const points = pointsAround(weather, ground, 20_000, 11)
      const read = await evaluate(
        points,
        eye,
        field.media.field,
        field.uniforms,
      )
      const { errors, clouded } = against(
        weather,
        fieldClock(weather, TIME),
        points,
        read,
      )
      expect(clouded).toBeGreaterThan(100)
      console.info(
        `oracle, fieldMedium, ${id}: median ${quantile(errors, 0.5).toExponential(2)}, p99 ${quantile(errors, 0.99).toExponential(2)}, worst ${Math.max(...errors).toExponential(2)}, clouded ${clouded}`,
      )
      expect(quantile(errors, 0.5)).toBeLessThanOrEqual(ORACLE_MEDIAN)
      expect(quantile(errors, 0.99)).toBeLessThanOrEqual(ORACLE_P99)
      field.dispose()
    },
    60_000,
  )

  it.each(['synoptic', 'analytic'] as const)(
    '%sMedium, which evaluates the displacement where it reads it',
    async (name) => {
      const weather = bodyWeather(SERVED_EARTH)!
      const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
      const eye = scaled(ground, EARTH + 1500)
      const field = bakeField(weather, 'climate', eye)
      // Out to 1,500 km: past the clipmap, where the far bakes read.
      const points = pointsAround(weather, ground, 1_500_000, 17)
      const read = await evaluate(
        points,
        eye,
        field.media[name],
        field.uniforms,
      )
      const { errors, clouded } = against(
        weather,
        fieldClock(weather, TIME),
        points,
        read,
      )
      expect(clouded).toBeGreaterThan(100)
      console.info(
        `oracle, ${name}Medium: median ${quantile(errors, 0.5).toExponential(2)}, p99 ${quantile(errors, 0.99).toExponential(2)}, worst ${Math.max(...errors).toExponential(2)}, clouded ${clouded}`,
      )
      expect(quantile(errors, 0.5)).toBeLessThanOrEqual(ORACLE_MEDIAN)
      expect(quantile(errors, 0.99)).toBeLessThanOrEqual(ORACLE_P99)
      field.dispose()
    },
    60_000,
  )
})

describe('nothing in the lookup is the observer’s (§5.3)', () => {
  it('one body point, one instant, two eyes — 10 km off and 2,000 km over a pole — read one density', async () => {
    const weather = bodyWeather(SERVED_EARTH)!
    // Points around the pole, in every level: one eye 10 km from them, the
    // other over the pole itself, 2,000 km up.
    const pole = { x: 0, y: 1, z: 0 }
    const points = pointsAround(weather, pole, 3000, 29, 600)
    const near = added(scaled(unit({ x: 0.0016, y: 1, z: 0 }), EARTH + 1500), {
      x: 0,
      y: 0,
      z: 0,
    })
    const far = scaled(pole, EARTH + 2_000_000)
    const fieldNear = bakeField(weather, 'climate', near)
    const fromNear = await evaluate(
      points,
      near,
      fieldNear.media.field,
      fieldNear.uniforms,
    )
    fieldNear.dispose()
    const fieldFar = bakeField(weather, 'climate', far)
    const fromFar = await evaluate(
      points,
      far,
      fieldFar.media.field,
      fieldFar.uniforms,
    )
    fieldFar.dispose()
    let worst = 0
    let clouded = 0
    points.forEach((_, n) => {
      const a = fromNear[n * 8]! * fromNear[n * 8 + 1]!
      const b = fromFar[n * 8]! * fromFar[n * 8 + 1]!
      if (a > 0) clouded += 1
      const level = fromNear[n * 8 + 2]!
      worst = Math.max(worst, Math.abs(a - b) / referenceSigma(weather, level))
    })
    expect(clouded).toBeGreaterThan(50)
    // One 8-bit step of the level's σ′.
    expect(worst).toBeLessThanOrEqual(1 / 255)
  }, 60_000)

  it('a feature keeps its turned place over 10⁴ s: the drawn field then equals the CPU’s then', async () => {
    const weather = bodyWeather(SERVED_EARTH)!
    const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
    const eye = scaled(ground, EARTH + 1500)
    const later = TIME + 1e4
    const field = bakeField(weather, 'climate', eye, later)
    const points = pointsAround(weather, ground, 20_000, 31)
    const read = await evaluate(points, eye, field.media.field, field.uniforms)
    const now = against(weather, fieldClock(weather, later), points, read)
    const then = against(weather, fieldClock(weather, TIME), points, read)
    expect(quantile(now.errors, 0.5)).toBeLessThanOrEqual(ORACLE_MEDIAN)
    // The same points against the field 10⁴ s earlier: the turn has carried
    // the cells 80 to 250 km, so the two are unrelated.
    expect(quantile(then.errors, 0.9)).toBeGreaterThan(0.1)
    field.dispose()
  }, 60_000)
})

/** What the port's footprint test measured, for the pin beside it. */
const footprintFade: { drawn: number[] } = { drawn: [] }

describe('a footprint’s fade', () => {
  it('draws the CPU field’s transmittance through a level at a quarter, a half and a whole cell of footprint', async () => {
    const weather = regimeWeather(SERVED_EARTH, 'broken-horizon')
    const ground = unit({ x: -0.6, y: 0.1, z: 0.79 })
    const eye = scaled(ground, EARTH + 1500)
    const field = bakeField(weather, 'broken-horizon', eye)
    const level = weather.levels[0]!
    const cell = levelProfile(level).cell
    const { east, north, up } = horizonBasis(ground)
    const columns = 400
    const steps = 32
    const next = draws(37)
    const feet = [0, cell / 4, cell / 2, cell]
    const points: Point[] = []
    for (let c = 0; c < columns; c += 1) {
      const across = added(
        scaled(east, (next() - 0.5) * 20_000),
        scaled(north, (next() - 0.5) * 20_000),
      )
      const radial = unit(added(scaled(up, EARTH), across))
      for (const footprint of feet)
        for (let s = 0; s < steps; s += 1) {
          const height =
            level.base + ((s + 0.5) / steps) * (level.top - level.base)
          points.push({
            position: scaled(radial, EARTH + height),
            footprint,
          })
        }
    }
    const read = await evaluate(points, eye, field.media.field, field.uniforms)
    const clock = fieldClock(weather, TIME)
    const oracle = points.map(({ position, footprint }) =>
      cloudFieldAt(weather, clock, SUN, position, footprint),
    )
    const step = (level.top - level.base) / steps
    // The march's segment law: a crossing's transmittance is
    // `1 − F + F·e^(−Σσ′Δs)`, F the largest fraction along it.
    const transmittance = (
      at: (n: number) => { readonly fraction: number; readonly sigma: number },
    ) =>
      feet.map((_, f) => {
        let sum = 0
        for (let c = 0; c < columns; c += 1) {
          let depth = 0
          let fraction = 0
          for (let s = 0; s < steps; s += 1) {
            const { fraction: share, sigma } = at((c * feet.length + f) * steps + s)
            depth += sigma * step
            fraction = Math.max(fraction, share)
          }
          sum += 1 - fraction + fraction * Math.exp(-depth)
        }
        return sum / columns
      })
    const drawn = transmittance((n) => ({
      fraction: read[n * 8]!,
      sigma: read[n * 8 + 1]!,
    }))
    const cpu = transmittance((n) => oracle[n]!)
    console.info(
      `footprints 0, ¼, ½, 1 cell: drawn ${drawn.map((t) => t.toFixed(4)).join(', ')}; cloudFieldAt ${cpu.map((t) => t.toFixed(4)).join(', ')}`,
    )
    // The port: the drawn transmittance is the CPU field's at every footprint.
    drawn.forEach((t, f) => {
      expect(Math.abs(t - cpu[f]!)).toBeLessThanOrEqual(0.01)
    })
    footprintFade.drawn = drawn
    field.dispose()
  }, 60_000)

  /*
   * §6.2's pin: the fade keeps the resolved field's transmittance within
   * 10%. The recipe the CPU field and this port share does not: between a
   * sixteenth and a quarter of a cell the detail's erosion fades out with
   * nothing added back, so the cells thicken and the crossing darkens,
   * then the unresolved share's mean density lightens it again. Measured
   * on broken-horizon on this Mac mini: 0.725 resolved, 0.548, 0.132 and
   * 0.498 at a quarter, a half and a whole cell, both sides alike. The
   * recipe is `weatherField.ts`'s (`levelSample`), and this flips green
   * when it conserves the crossing.
   */
  it.fails('keeps the resolved field’s transmittance within 10% (§6.2): it does not yet', () => {
    const [resolved, ...faded] = footprintFade.drawn
    expect(faded).toHaveLength(3)
    for (const t of faded)
      expect(Math.abs(t - resolved!) / resolved!).toBeLessThanOrEqual(0.1)
  })
})

describe('every read names level 0', () => {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2)
  camera.position.z = 1
  camera.updateMatrixWorld()

  async function marched(
    medium: CloudMediumFn,
    uniforms: CloudUniforms,
    profile: CloudProfile,
    plain: boolean,
  ): Promise<string> {
    const material = new MeshBasicNodeMaterial()
    const control = texture(profile.texture)
    material.fragmentNode = Fn(() => {
      const sigma = float(0).toVar()
      Loop(16, ({ i }) => {
        const t = float(i).mul(250)
        const sample: CloudSample = {
          offset: vec3(t, uv().x.mul(100), t.mul(0.5)),
          distance: t,
          altitude: float(1100).add(t.mul(0.2)),
          sunMu: float(0.5),
          footprint: t.mul(0.002),
        }
        sigma.addAssign(medium(sample, uniforms.served).sigma)
        if (plain) sigma.addAssign(control.sample(uv()).x)
        If(sigma.greaterThan(0.5), () => {
          Break()
        })
      })
      return vec4(sigma, 0, 0, 1)
    })()
    const mesh = new Mesh(new PlaneGeometry(2, 2), material)
    const scene = new Scene()
    scene.add(mesh)
    try {
      return (await gpu.shader(mesh, camera, scene)).fragmentShader
    } finally {
      mesh.geometry.dispose()
      material.dispose()
    }
  }

  const reads = (wgsl: string, call: string): number =>
    wgsl.split(`${call}(`).length - 1

  /*
   * The fine march's step: the clipmap's two targets in a level and in the
   * next one's fade band, the profile, the base noise and the detail, and
   * no sine (the displacement is the clipmap's). The cube's medium reads
   * its two targets once; the climate's, the base noise once more for its
   * synoptic field. The two far media evaluate the displacement, which is
   * a bake's cost and never a march step's.
   */
  it.each([
    ['fieldMedium', 7, 0],
    ['synopticMedium', 5, 12],
    ['analyticMedium', 4, 12],
  ] as const)(
    '%s: no bare textureSample, a textureSampleLevel for each of its %i reads, and %i sines',
    async (name, count, sines) => {
      const weather = regimeWeather(SERVED_EARTH, 'two-decks')
      const ground = unit({ x: -0.6, y: 0.1, z: 0.79 })
      const field = bakeField(
        weather,
        'two-decks',
        scaled(ground, EARTH + 1500),
      )
      const medium = {
        fieldMedium: field.media.field,
        synopticMedium: field.media.synoptic,
        analyticMedium: field.media.analytic,
      }[name]
      const wgsl = await marched(medium, field.uniforms, field.profile, false)
      expect(reads(wgsl, 'textureSample')).toBe(0)
      expect(reads(wgsl, 'textureSampleLevel')).toBe(count)
      expect(reads(wgsl, 'sin') + reads(wgsl, 'cos')).toBeLessThanOrEqual(sines)
      const control = await marched(medium, field.uniforms, field.profile, true)
      expect(reads(control, 'textureSample')).toBe(1)
      field.dispose()
    },
    60_000,
  )
})
