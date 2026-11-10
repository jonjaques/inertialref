import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  DataUtils,
  StorageBufferAttribute,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Break,
  exp2,
  float,
  Fn,
  If,
  instanceIndex,
  Loop,
  select,
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
  levelStatistics,
  MESOSCALE_WAVES,
  mesoscaleDisplacement,
  regimeWeather,
  shellHeights,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import { createInlineWorker, WorkerPool } from '@inertialref/workers'
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
  type DrawnWeather,
  drawnWeather,
  weatherClimate,
  weatherLevels,
} from './cloudFrame.ts'
import { type CloudWeather, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { CloudMaps } from './cloudMaps.ts'
import type { CloudBudget, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import {
  CloudNoise,
  createMesoscaleRay,
  MESOSCALE_STEP_MAX,
} from './cloudNoise.ts'
import {
  bodyLevelSpecs,
  type CloudProfile,
  createCloudProfile,
} from './cloudProfile.ts'
import { createGameTaskRegistry } from '../workers/registry.ts'
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
  // The frame's own path: a named regime is `drawnWeather`'s, and the
  // climate the body's fitted one.
  const drawn: DrawnWeather =
    key === 'climate'
      ? { weather, regime: null }
      : drawnWeather(key as CloudWeather, SERVED_EARTH)
  expect(drawn.weather?.levels).toEqual(weather.levels)
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
  const clipmap = new CloudClipmap(uniforms, maps.nodes, profile)
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

/** A sample's inputs: its body point, the meters it stands for, and its ray's dither (0.5 where absent). */
interface Point {
  readonly position: Vec3
  readonly footprint: number
  readonly dither?: number
}

/**
 * `medium` at each point seen from `eye`: (fraction, σ′, level, column), and
 * (radius, depth). A thread takes `chain` consecutive points in order, as a
 * march takes its steps and taps, so the fine medium's displacement is
 * carried from one to the next; with a chain of one every point starts it
 * over.
 */
async function evaluate(
  points: readonly Point[],
  eye: Vec3,
  medium: CloudMediumFn,
  uniforms: CloudUniforms,
  chain = 1,
): Promise<Float32Array> {
  const count = points.length
  const threads = Math.ceil(count / chain)
  const input = new StorageBufferAttribute(
    new Float32Array(
      points.flatMap(({ position, footprint, dither = 0.5 }) => {
        const offset = less(position, eye)
        const altitude = Math.hypot(position.x, position.y, position.z) - EARTH
        return [
          offset.x,
          offset.y,
          offset.z,
          altitude,
          footprint,
          Math.hypot(offset.x, offset.y, offset.z),
          dither,
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
    If(instanceIndex.lessThan(uint(threads)), () => {
      Loop(chain, ({ i }) => {
        const at = instanceIndex.mul(chain).add(uint(i)).toVar()
        If(at.lessThan(uint(count)), () => {
          const a = from.element(at.mul(2))
          const b = from.element(at.mul(2).add(1))
          const sample: CloudSample = {
            offset: a.xyz,
            distance: b.y,
            altitude: a.w,
            sunMu: float(0.5),
            footprint: b.x,
            dither: b.z,
          }
          const m = medium(sample, uniforms.served)
          into
            .element(at.mul(2))
            .assign(vec4(m.fraction, m.sigma, float(m.layer), m.column))
          into.element(at.mul(2).add(1)).assign(vec4(m.radius, m.depth, 0))
        })
      })
    })
  })().compute(threads)
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
  points.forEach(({ position, footprint, dither = 0.5 }, n) => {
    const want = cloudFieldAt(weather, clock, SUN, position, footprint, dither)
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
  it('is each body’s levels’ `levelProfile`, byte for byte, in its slot, and their statistics under them', () => {
    const weather = bodyWeather(SERVED_EARTH)!
    const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
    const field = bakeField(weather, 'climate', scaled(ground, EARTH + 1500))
    const table = field.profile.texture.image.data as Uint16Array
    const specs = bodyLevelSpecs(field.frame.served)
    expect(specs.map((spec) => [spec.stratiform, spec.cumuliform])).toEqual(
      weather.levels.map((level) => [level.stratiform, level.cumuliform]),
    )
    for (const slot of [0, 1])
      specs.forEach((spec, k) => {
        // The CPU's bytes over 255, in half floats: within a half float's
        // step, 2⁻¹¹ of a value under one (the conversion truncates).
        const rows = levelProfile(spec).texels
        const at = (slot * 24 + k * 8) * 64 * 4
        rows.forEach((byte, n) => {
          expect(
            Math.abs(DataUtils.fromHalfFloat(table[at + n]!) - byte / 255),
          ).toBeLessThanOrEqual(2 ** -11)
        })
      })
    // And each level's statistics, cover by cover, under the profile's rows.
    for (const slot of [0, 1])
      specs.forEach((spec, k) => {
        const stats = levelStatistics(spec)
        const cell = levelProfile(spec).cell
        for (let row = 0; row < 8; row += 1)
          for (let i = 0; i < 17; i += 1) {
            const at = ((48 + slot * 24 + k * 8 + row) * 64 + i) * 4
            const from = i * 8 + row
            const near = (half: number, want: number) =>
              expect(
                Math.abs(DataUtils.fromHalfFloat(half) - want),
              ).toBeLessThanOrEqual(Math.abs(want) * 2 ** -10 + 1e-7)
            near(table[at]!, stats.fraction[from]!)
            near(table[at + 1]!, stats.depth[from]!)
            near(table[at + 2]!, stats.shape[from]!)
            near(table[at + 3]!, stats.sight[from]! / cell)
            near(table[at + 17 * 4]!, stats.gain[from]!)
          }
      })
    field.dispose()
  }, 60_000)
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
 * The drawn field's error against `cloudFieldAt`, in the level's reference
 * σ′ (`levelProfile`'s `scaled`), at the points either side holds cloud.
 * The field holds its genus's extinction inside its clouds (the gain), about
 * twice what the reference's share of it was, so an error of the same share
 * of a cloud is about twice the reference's share. Measured on this Mac
 * mini (Apple M6) over the three stances, three regimes through the frame's
 * own layout, the far media, every footprint to four cells and every
 * dither, and the light taps on a ray's own chain: the median at most
 * 5.2 × 10⁻³ (the taps from 400 km), the 99th percentile at most
 * 8.8 × 10⁻³, the worst point 1.4 × 10⁻². Its sources: the cover's bytes,
 * amplified by the remap's division by the cover; the gain's two bytes and
 * the bytes of the cover and share it is read at; the sampler's fixed-point
 * weights on the noise and the statistics; half floats in the profile. The
 * displacement, carried along the ray by its series, adds under 2.1 × 10⁻⁵
 * of a cell. The bounds are twice the measured.
 */
const ORACLE_MEDIAN = 0.0105
const ORACLE_P99 = 0.0175
/**
 * Earth's zonal climate, read through the cube, at its 99th percentile:
 * measured 1.7 × 10⁻² to 2.6 × 10⁻² over the three stances and the cube's
 * medium, against 6.7 × 10⁻³ where the climate itself is read (the second
 * body's medium). The difference is the cube's cover in a byte, read where
 * the blended levels' gain is steep: it runs to 20 and 30 at small covers,
 * and one byte of cover moves it by several percent there
 * (`cloudClipmap.gpu.test.ts`). Twice the measured; a cube and clipmap that
 * held the cover in sixteen bits would take it to the climate's own.
 */
const ZONAL_P99 = 0.052
/**
 * How far either side of a ray's switch, `cell·4^(dither − 1)`, a footprint
 * is read, as a share of it. A footprint of a quarter, a half or a whole
 * cell at a dither of 0, 0.5 or 1 is the switch exactly, in float32 as in
 * float64, so `footprint > threshold` there is decided by the last bit of
 * the kernel's `exp2`. WGSL allows `exp2(x)` 3 + 2|x| ULP, 7 steps at the
 * switch's x of −2, and the threshold's product and the footprint's upload
 * round half a step each: two adapters may put the switch 8 float32 steps
 * apart. CI's hosted adapter reads such a footprint as past the switch and
 * this Mac mini (Apple M6) as before it. 2⁻¹⁶ of the footprint is 128 to
 * 256 steps, sixteen times the most the adapters may differ by, and moves
 * nothing else a read depends on: the CPU field is read at the same
 * footprint.
 */
const SWITCH_MARGIN = 2 ** -16
/** WGSL's bound on `exp2(x)` at the switch's x of −2, −1 and 0: 3 + 2|x| ULP. */
const EXP2_STEPS = 7

describe('each medium is cloudFieldAt', () => {
  it.each(STANCES)(
    'fieldMedium, under Earth’s zonal climate: $name',
    async ({ height, reach }) => {
      const weather = bodyWeather(SERVED_EARTH)!
      const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
      const eye = scaled(ground, EARTH + height)
      const field = bakeField(weather, 'climate', eye)
      const points = pointsAround(weather, ground, reach, 7, 3000)
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
      expect(p99).toBeLessThanOrEqual(ZONAL_P99)
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
      const points = pointsAround(weather, ground, 1_500_000, 17, 3000)
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
      expect(quantile(errors, 0.99)).toBeLessThanOrEqual(ZONAL_P99)
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
    const points = pointsAround(weather, pole, 3000, 29, 3000)
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
    console.info(
      `two eyes: worst ${worst.toExponential(4)} of the level's σ′ over ${points.length} points, ${clouded} clouded`,
    )
    expect(clouded).toBeGreaterThan(50)
    // One 8-bit step of the level's σ′ and a 32nd of one. The two bakes
    // round alike only on one adapter: measured 3.580 × 10⁻³ (0.913 of a
    // step) on this Mac mini (Apple M6) and 3.984 × 10⁻³ (1.016) on CI's
    // hosted adapter, which runs the same graph with its own rounding. The
    // 32nd is that 1.6% excess rounded up to a power-of-two share of a step.
    expect(worst).toBeLessThanOrEqual((1 / 255) * (1 + 1 / 32))
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

describe('a footprint’s read', () => {
  /*
   * `SWITCH_MARGIN`'s premise, on whichever adapter runs the suite: the
   * switch's `exp2` lands within WGSL's 7 steps of the power of two. Which
   * side of an exact tie the adapter takes is printed, not asserted: that is
   * the rounding the margin exists to stay clear of.
   */
  it('takes the switch’s exp2 within WGSL’s 7 float32 steps of 4^(dither − 1), and the margin is 16 times that', async () => {
    const dithers = [0, 0.5, 1]
    const cell = 1200
    const input = new StorageBufferAttribute(
      new Float32Array(
        dithers.flatMap((d) => [d, cell, cell * 4 ** (d - 1), 0]),
      ),
      4,
    )
    const output = new StorageBufferAttribute(
      new Float32Array(dithers.length * 4),
      4,
    )
    const from = storage(input, 'vec4', dithers.length)
    const into = storage(output, 'vec4', dithers.length)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(dithers.length)), () => {
        const a = from.element(instanceIndex)
        // As the kernel takes it: `exp2(2·dither − 2)`, from a value the
        // compiler cannot fold.
        const share = exp2(a.x.mul(2).sub(2))
        const past = a.z.greaterThan(a.y.mul(share))
        into
          .element(instanceIndex)
          .assign(vec4(share, select(past, float(1), float(0)), 0, 0))
      })
    })().compute(dithers.length)
    await gpu.compute(kernel)
    const read = new Float32Array(await gpu.readBuffer(output))
    kernel.dispose()
    const bits = new Uint32Array(read.buffer)
    const exact = new Uint32Array(
      new Float32Array(dithers.map((d) => 4 ** (d - 1))).buffer,
    )
    const steps = dithers.map((_, k) => bits[k * 4]! - exact[k]!)
    console.info(
      `exp2 at the switch, dithers 0, 0.5, 1: ${steps.join(', ')} float32 steps off 4^(dither − 1); a footprint on the switch reads ${dithers.map((_, k) => (read[k * 4 + 1] === 1 ? 'past it' : 'before it')).join(', ')}`,
    )
    for (const off of steps)
      expect(Math.abs(off)).toBeLessThanOrEqual(EXP2_STEPS)
    // The margin's floor, 2⁻¹⁶ of a footprint in [2^k, 2^(k+1)), is 2⁷
    // steps; the adapters may differ by WGSL's 7 and two half-step roundings.
    expect(SWITCH_MARGIN / 2 ** -23).toBeGreaterThanOrEqual(
      16 * (EXP2_STEPS + 1),
    )
  }, 60_000)

  /*
   * D's pin, on the GPU: broken-horizon straight down, a vertical crossing
   * of its level by the march's segment law, `1 − F + F·e^(−Σσ′Δs)` with F
   * the largest fraction along it, at footprints from none to four cells
   * and a dither of 0.5, so a quarter cell and just short of a half are
   * resolved and just past a half and more read the statistics; half a cell
   * itself is the switch (`SWITCH_MARGIN`). Held to the CPU field's own
   * figure computed here, not to a literal: a regime's thickness may move
   * under the test with the calibration.
   */
  it('passes what the CPU field passes, resolved and past the switch, and keeps the resolved field’s transmittance within 10%', async () => {
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
    // Half a cell is the switch at a dither of 0.5: read either side of it.
    const feet = [
      0,
      cell / 4,
      (cell / 2) * (1 - SWITCH_MARGIN),
      (cell / 2) * (1 + SWITCH_MARGIN),
      cell,
      2 * cell,
      4 * cell,
    ]
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
    // A thread a column at a footprint, its steps in order, as a march.
    const read = await evaluate(
      points,
      eye,
      field.media.field,
      field.uniforms,
      steps,
    )
    const clock = fieldClock(weather, TIME)
    const oracle = points.map(({ position, footprint }) =>
      cloudFieldAt(weather, clock, SUN, position, footprint),
    )
    const step = (level.top - level.base) / steps
    const transmittance = (
      at: (n: number) => { readonly fraction: number; readonly sigma: number },
    ) =>
      feet.map((_, f) => {
        let sum = 0
        for (let c = 0; c < columns; c += 1) {
          let depth = 0
          let fraction = 0
          for (let s = 0; s < steps; s += 1) {
            const { fraction: share, sigma } = at(
              (c * feet.length + f) * steps + s,
            )
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
      `footprints 0, ¼, ½ − 2⁻¹⁶, ½ + 2⁻¹⁶, 1, 2, 4 cells: drawn ${drawn.map((t) => t.toFixed(4)).join(', ')}; cloudFieldAt ${cpu.map((t) => t.toFixed(4)).join(', ')}`,
    )
    // The port: the drawn crossing is the CPU field's at every footprint.
    drawn.forEach((t, f) => {
      expect(Math.abs(t - cpu[f]!)).toBeLessThanOrEqual(0.01)
    })
    // The pin (§6.2): no footprint moves the crossing a tenth off the
    // resolved field's.
    for (const t of drawn.slice(1))
      expect(Math.abs(t - drawn[0]!) / drawn[0]!).toBeLessThanOrEqual(0.1)
    field.dispose()
  }, 60_000)

  it.each([
    ['Earth’s zonal climate', 'climate'],
    ['broken-horizon', 'broken-horizon'],
    ['stratocumulus', 'stratocumulus'],
    ['two-decks', 'two-decks'],
  ] as const)(
    '%s: each read is cloudFieldAt at footprints 2⁻¹⁶ either side of a quarter, a half, one and four cells and dithers of 0, 0.5 and 1',
    async (_, key) => {
      const weather =
        key === 'climate'
          ? bodyWeather(SERVED_EARTH)!
          : regimeWeather(SERVED_EARTH, key)
      const ground =
        key === 'climate'
          ? unit({ x: 0.3, y: 0.85, z: -0.43 })
          : unit({ x: -0.6, y: 0.1, z: 0.79 })
      const eye = scaled(ground, EARTH + 1500)
      const field = bakeField(weather, key, eye)
      const base = pointsAround(weather, ground, 20_000, 43, 1200)
      const points: Point[] = []
      base.forEach((point, n) => {
        const length = Math.hypot(
          point.position.x,
          point.position.y,
          point.position.z,
        )
        const level = weather.levels.findIndex(
          ({ base: b, top }) => length - EARTH >= b && length - EARTH < top,
        )
        const cell = levelProfile(weather.levels[Math.max(level, 0)]!).cell
        // One share in four is its dither's switch: each is read either
        // side of it, never on it.
        for (const share of [0.25, 0.5, 1, 4])
          for (const side of [-1, 1])
            points.push({
              position: point.position,
              footprint: share * cell * (1 + side * SWITCH_MARGIN),
              dither: [0, 0.5, 1][n % 3]!,
            })
      })
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
      console.info(
        `footprints and dithers, ${key}: median ${quantile(errors, 0.5).toExponential(2)}, p99 ${quantile(errors, 0.99).toExponential(2)}, worst ${Math.max(...errors).toExponential(2)}, clouded ${clouded}`,
      )
      expect(clouded).toBeGreaterThan(100)
      expect(quantile(errors, 0.5)).toBeLessThanOrEqual(ORACLE_MEDIAN)
      expect(quantile(errors, 0.99)).toBeLessThanOrEqual(ORACLE_P99)
      field.dispose()
    },
    60_000,
  )

  it('holds a cumulus’s genus extinction inside its clouds: 52 per kilometer within 3%', async () => {
    const weather = regimeWeather(SERVED_EARTH, 'broken-horizon')
    const ground = unit({ x: -0.6, y: 0.1, z: 0.79 })
    const eye = scaled(ground, EARTH + 1500)
    const field = bakeField(weather, 'broken-horizon', eye)
    const points = pointsAround(weather, ground, 20_000, 47, 40_000)
    const read = await evaluate(points, eye, field.media.field, field.uniforms)
    const profile = levelProfile(weather.levels[0]!)
    const unscale = profile.sigma / profile.scaled
    let sum = 0
    let count = 0
    for (let n = 0; n < points.length; n += 1) {
      const sigma = read[n * 8 + 1]!
      if (sigma > 0) {
        sum += sigma * unscale
        count += 1
      }
    }
    const mean = sum / count
    // The same points through the CPU field: what this sample of the level
    // holds, which need not be D's 51.7 over its own sample.
    const clock = fieldClock(weather, TIME)
    let cpuSum = 0
    let cpuCount = 0
    for (const { position } of points) {
      const at = cloudFieldAt(weather, clock, SUN, position, 0)
      if (at.sigma > 0) {
        cpuSum += at.sigma * unscale
        cpuCount += 1
      }
    }
    const cpu = cpuSum / cpuCount
    console.info(
      `cumulus inside its clouds: ${(mean * 1000).toFixed(2)} per km drawn over ${count} samples, ${(cpu * 1000).toFixed(2)} on the CPU over ${cpuCount}`,
    )
    expect(count).toBeGreaterThan(3000)
    expect(Math.abs(mean - cpu) / cpu).toBeLessThanOrEqual(0.01)
    expect(Math.abs(mean - 0.052) / 0.052).toBeLessThanOrEqual(0.03)
    field.dispose()
  }, 60_000)
})

describe('the statistics are the field’s generation', () => {
  it('a body whose tables are not in draws nothing, and draws once they land', async () => {
    // A world the session has not built tables for: its own scale height.
    const world: Body = {
      ...SERVED_EARTH,
      atmosphere: { ...SERVED_EARTH.atmosphere!, scaleHeight: 7_777 },
    }
    const weather = bodyWeather(world)!
    const ground = unit({ x: 0.3, y: 0.85, z: -0.43 })
    const eye = scaled(ground, EARTH + 1500)
    const uniforms = createCloudUniforms()
    const profile = createCloudProfile({ uniforms })
    // A pool that never answers: the tables are owed for as long as it runs.
    profile.pool = {
      submit: () => ({ result: new Promise(() => {}) }),
    } as unknown as WorkerPool
    const medium = analyticMedium({ uniforms, noise: noise.nodes, profile })
    const frame = frameAt(uniforms, weather, 'climate', eye)
    profile.write(frame)
    expect(profile.ready[0].value).toBe(0)
    const points = pointsAround(weather, ground, 20_000, 53, 2000)
    const owed = await evaluate(points, eye, medium, uniforms)
    let drawn = 0
    for (let n = 0; n < points.length; n += 1)
      drawn = Math.max(drawn, owed[n * 8]! * owed[n * 8 + 1]!)
    expect(drawn).toBe(0)
    // The pool the browser's worker serves, inline: each table lands, and
    // the frame after draws the body.
    const pool = new WorkerPool({
      factory: () => createInlineWorker(createGameTaskRegistry()),
      size: 1,
    })
    profile.pool = pool
    const before = profile.generation
    const start = performance.now()
    profile.write(frame)
    while (profile.ready[0].value === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      profile.write(frame)
    }
    const body = performance.now() - start
    console.info(
      `the tables in the pool: ${profile.builds.map((ms) => ms.toFixed(0)).join(', ')} ms a level, ${body.toFixed(0)} ms for the body`,
    )
    expect(profile.generation).toBeGreaterThan(before)
    const landed = await evaluate(points, eye, medium, uniforms)
    let clouded = 0
    for (let n = 0; n < points.length; n += 1)
      if (landed[n * 8]! * landed[n * 8 + 1]! > 0) clouded += 1
    expect(clouded).toBeGreaterThan(50)
    pool.terminate()
    profile.dispose()
  }, 120_000)
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
   * The fine march's step: the clipmap's one texture in a level and in the
   * next one's fade band, the profile, and either the base noise and the
   * detail (resolved) or the statistics (past the switch): six reads in its
   * text, four a resolved step runs and three a statistical one. Its only
   * sines and cosines are the displacement's start over, two of each over
   * three waves a vector, in the one branch a ray takes on entering a level
   * (`createMesoscaleRay`); a step turns them by their series. The cube's
   * medium reads its two targets once and the gain, a bake's read; the
   * climate's, the base noise once more for its synoptic field, and the
   * gain.
   * The two far media evaluate the displacement where they read it, which
   * is a bake's cost and never a march step's.
   */
  it.each([
    ['fieldMedium', 6, 4],
    ['synopticMedium', 7, 12],
    ['analyticMedium', 6, 12],
  ] as const)(
    '%s: no bare textureSample, a textureSampleLevel for each of its %i reads, and at most %i calls of sin and cos in its text',
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
      const calls = reads(wgsl, 'sin') + reads(wgsl, 'cos')
      if (name === 'fieldMedium') expect(calls).toBe(sines)
      else expect(calls).toBeLessThanOrEqual(sines)
      const control = await marched(medium, field.uniforms, field.profile, true)
      expect(reads(control, 'textureSample')).toBe(1)
      field.dispose()
    },
    60_000,
  )
})

/* ------------------------------------------------------------------------- */
/* No tile from orbit                                                         */
/* ------------------------------------------------------------------------- */

/** In-place radix-2 FFT of one row or column: `weatherField.test.ts`'s. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const turn = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(turn)
    const wi = Math.sin(turn)
    for (let start = 0; start < n; start += size) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < size / 2; j += 1) {
        const a = start + j
        const b = a + size / 2
        const vr = re[b]! * cr - im[b]! * ci
        const vi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - vr
        im[b] = im[a]! - vi
        re[a] = re[a]! + vr
        im[a] = im[a]! + vi
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
}

/** A map's correlation with itself at every lag, as sums, on a grid padded to twice its size. */
function selfCorrelation(
  map: Float64Array,
  n: number,
  size: number,
): Float64Array {
  const re = new Float64Array(size * size)
  const im = new Float64Array(size * size)
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) re[y * size + x] = map[y * n + x]!
  const pass = (inverse: boolean) => {
    const r = new Float64Array(size)
    const i = new Float64Array(size)
    for (const rows of [true, false])
      for (let a = 0; a < size; a += 1) {
        for (let b = 0; b < size; b += 1) {
          const at = rows ? a * size + b : b * size + a
          r[b] = re[at]!
          i[b] = im[at]!
        }
        fft(r, i, inverse)
        for (let b = 0; b < size; b += 1) {
          const at = rows ? a * size + b : b * size + a
          re[at] = r[b]!
          im[at] = i[b]!
        }
      }
  }
  pass(false)
  for (let k = 0; k < size * size; k += 1) {
    re[k] = re[k]! * re[k]! + im[k]! * im[k]!
    im[k] = 0
  }
  pass(true)
  return re
}

/** The largest normalized autocorrelation at any lag from 2 km to half the map's width, and its cloudy share. */
function largestRepeat(
  map: Uint8Array,
  n: number,
  grid: number,
): { readonly peak: number; readonly cloudy: number } {
  let cloudy = 0
  for (const value of map) cloudy += value
  cloudy /= map.length
  let size = 1
  while (size < 2 * n) size <<= 1
  const centered = new Float64Array(n * n)
  const ones = new Float64Array(n * n).fill(1)
  map.forEach((value, k) => (centered[k] = value - cloudy))
  const sums = selfCorrelation(centered, n, size)
  const counts = selfCorrelation(ones, n, size)
  const variance = cloudy * (1 - cloudy)
  const reach = Math.floor((n - 1) / 2)
  let peak = -1
  for (let dy = -reach; dy <= reach; dy += 1)
    for (let dx = 0; dx <= reach; dx += 1) {
      const lag = Math.hypot(dx, dy) * grid
      if (lag < 2000 || lag > reach * grid) continue
      const k = ((dy + size) % size) * size + dx
      peak = Math.max(peak, sums[k]! / Math.round(counts[k]!) / variance)
    }
  return { peak, cloudy }
}

describe('no tile from orbit, as drawn', () => {
  /*
   * D's measure, through the drawn field: a cloud-or-clear map at 200 m
   * over 80 km about E1's stance at its instant, a column cloudy where any
   * of five heights through the low level holds σ′·fraction over 10⁻⁵ 1/m.
   * D's CPU field peaks at 0.249 there, 0.876 without the displacement.
   */
  it('E1: no lag from 2 to 40 km repeats the field by 0.3, and the map is the CPU’s', async () => {
    const latitude = -0.08726646259971647
    const longitude = -1.0471975511965976
    const time = 17424.925169385428
    const up = {
      x: Math.cos(latitude) * Math.cos(longitude),
      y: Math.sin(latitude),
      z: -Math.cos(latitude) * Math.sin(longitude),
    }
    const east = { x: -Math.sin(longitude), y: 0, z: -Math.cos(longitude) }
    const north = {
      x: -Math.sin(latitude) * Math.cos(longitude),
      y: Math.cos(latitude),
      z: Math.sin(latitude) * Math.sin(longitude),
    }
    const weather = regimeWeather(SERVED_EARTH, 'fair-cumulus')
    const eye = scaled(up, EARTH + 1500)
    const field = bakeField(weather, 'fair-cumulus', eye, time)
    const half = 40_000
    const grid = 200
    const n = Math.round((2 * half) / grid) + 1
    const level = weather.levels[0]!
    const heights = [0.15, 0.3, 0.45, 0.6, 0.75]
    const points: Point[] = []
    for (let j = 0; j < n; j += 1)
      for (let i = 0; i < n; i += 1) {
        const d = unit(
          added(
            up,
            added(
              scaled(east, (-half + i * grid) / EARTH),
              scaled(north, (-half + j * grid) / EARTH),
            ),
          ),
        )
        for (const h of heights)
          points.push({
            position: scaled(
              d,
              EARTH + level.base + h * (level.top - level.base),
            ),
            footprint: 0,
          })
      }
    // A thread a column, its five heights in order, as a march would take
    // them: the displacement is carried up the column.
    const read = await evaluate(
      points,
      eye,
      field.media.field,
      field.uniforms,
      heights.length,
    )
    const clock = fieldClock(weather, time)
    const drawn = new Uint8Array(n * n)
    const cpu = new Uint8Array(n * n)
    for (let c = 0; c < n * n; c += 1)
      for (let h = 0; h < heights.length; h += 1) {
        const at = c * heights.length + h
        if (read[at * 8]! * read[at * 8 + 1]! > 1e-5) drawn[c] = 1
        const want = cloudFieldAt(weather, clock, up, points[at]!.position, 0)
        if (want.fraction * want.sigma > 1e-5) cpu[c] = 1
      }
    let agree = 0
    for (let c = 0; c < n * n; c += 1) if (drawn[c] === cpu[c]) agree += 1
    const drawnRepeat = largestRepeat(drawn, n, grid)
    const cpuRepeat = largestRepeat(cpu, n, grid)
    console.info(
      `E1 as drawn: peak ${drawnRepeat.peak.toFixed(3)}, cloudy ${drawnRepeat.cloudy.toFixed(3)}; cloudFieldAt: peak ${cpuRepeat.peak.toFixed(3)}, cloudy ${cpuRepeat.cloudy.toFixed(3)}; columns agreeing ${(agree / (n * n)).toFixed(4)}`,
    )
    expect(drawnRepeat.peak).toBeLessThan(0.3)
    expect(drawnRepeat.cloudy).toBeGreaterThan(0.19)
    expect(drawnRepeat.cloudy).toBeLessThan(0.24)
    expect(agree / (n * n)).toBeGreaterThan(0.99)
    field.dispose()
  }, 120_000)
})

/* ------------------------------------------------------------------------- */
/* The frame                                                                  */
/* ------------------------------------------------------------------------- */

describe('the frame’s clouds are the CPU field’s', () => {
  /*
   * Each stance's frame drawn through the fine medium and through
   * `cloudFieldAt`, ray for ray: 64 × 64 rays of the stance's lens, each
   * marched in 96 midpoint steps through the levels' union, its
   * transmittance the product of `e^(−fraction·σ′·Δs)` and its footprint the
   * lens's pixel at the step's distance. After each step the medium is read
   * at the four light taps toward the sun, as the march reads them, and one
   * thread takes a ray's steps and taps in order: the fine medium carries
   * its displacement through all 480 calls, which is the recurrence the
   * march runs. The march is this test's, the same on both sides, so what
   * differs is the medium alone. The CPU field has no cube: a line
   * at the cube cell's frequency, or at a clipmap level's edge, is a
   * difference between the two frames, and the per-pixel bound bounds it.
   */
  const SIDE = 64
  const STEPS = 96
  /** The four taps' midpoints toward the sun, meters (`LIGHT_TAPS[4]`). */
  const TAPS = [50, 200, 450, 800] as const
  /** A step and its taps: the medium's calls a step. */
  const CALLS = 1 + TAPS.length

  /** A ray's span through the shell from radius `low` to `high`, from an eye at `eye` along unit `d`: [t₀, t₁], or null. */
  function span(
    eye: Vec3,
    d: Vec3,
    low: number,
    high: number,
    reach: number,
  ): readonly [number, number] | null {
    const b = eye.x * d.x + eye.y * d.y + eye.z * d.z
    const c = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z
    const hit = (r: number): readonly [number, number] | null => {
      const disc = b * b - (c - r * r)
      if (disc < 0) return null
      const root = Math.sqrt(disc)
      return [-b - root, -b + root]
    }
    const top = hit(high)
    if (top === null || top[1] <= 0) return null
    const ground = hit(low)
    const start = Math.max(0, top[0])
    const end = Math.min(
      reach,
      ground !== null && ground[0] > 0 ? ground[0] : top[1],
    )
    return end > start ? [start, end] : null
  }

  it.each([
    {
      name: 'the horizon from 1.5 km, under stratocumulus',
      regime: 'stratocumulus',
      height: 1500,
      // Along east, 3° down, through a 60° lens.
      pitch: -0.05,
      fov: Math.PI / 3,
      reach: 80_000,
    },
    {
      name: 'above the deck at 6 km, 40° down',
      regime: 'stratocumulus',
      height: 6000,
      pitch: -0.7,
      fov: Math.PI / 3,
      reach: 40_000,
    },
    {
      // Through a 1° lens: 7 km of ground, a pixel 110 m, under a quarter
      // of a cumulus cell, so the frame is resolved cells and clear sky.
      // Wider, the footprint's unresolved share spreads the cells' mean
      // density over every clear column, on both sides alike, and every
      // ray of the frame is over half opaque.
      name: 'straight down from 400 km, over fair-cumulus',
      regime: 'fair-cumulus',
      height: 400_000,
      pitch: -Math.PI / 2,
      fov: Math.PI / 180,
      reach: 500_000,
    },
  ] as const)(
    '$name',
    async ({ regime, height, pitch, fov, reach }) => {
      const weather = regimeWeather(SERVED_EARTH, regime)
      const ground = unit({ x: -0.6, y: 0.1, z: 0.79 })
      const eye = scaled(ground, EARTH + height)
      const field = bakeField(weather, regime, eye)
      const pixelAngle = fov / SIDE
      const { east, north, up } = horizonBasis(ground)
      const forward = unit(
        added(scaled(east, Math.cos(pitch)), scaled(up, Math.sin(pitch))),
      )
      const right = unit({
        x: forward.y * up.z - forward.z * up.y,
        y: forward.z * up.x - forward.x * up.z,
        z: forward.x * up.y - forward.y * up.x,
      })
      const above =
        pitch < -1.5
          ? north
          : unit({
              x: right.y * forward.z - right.z * forward.y,
              y: right.z * forward.x - right.x * forward.z,
              z: right.x * forward.y - right.y * forward.x,
            })
      const across = pitch < -1.5 ? east : right
      const lows = weather.levels.filter((level) => level.top > level.base)
      const low = EARTH + Math.min(...lows.map((level) => level.base))
      const high = EARTH + Math.max(...lows.map((level) => level.top))
      const tan = Math.tan(fov / 2)
      const points: Point[] = []
      const lengths: number[] = []
      const crossed: boolean[] = []
      for (let j = 0; j < SIDE; j += 1)
        for (let i = 0; i < SIDE; i += 1) {
          const d = unit(
            added(
              forward,
              added(
                scaled(across, ((2 * (i + 0.5)) / SIDE - 1) * tan),
                scaled(above, (1 - (2 * (j + 0.5)) / SIDE) * tan),
              ),
            ),
          )
          const through = span(eye, d, low, high, reach)
          crossed.push(through !== null)
          const [t0, t1] = through ?? [0, 0]
          const length = (t1 - t0) / STEPS
          lengths.push(length)
          for (let s = 0; s < STEPS; s += 1) {
            const t = t0 + (s + 0.5) * length
            const at = added(eye, scaled(d, t))
            points.push({ position: at, footprint: t * pixelAngle })
            for (const midpoint of TAPS)
              points.push({
                position: added(at, scaled(SUN, midpoint)),
                footprint: t * pixelAngle,
              })
          }
        }
      const read = await evaluate(
        points,
        eye,
        field.media.field,
        field.uniforms,
        STEPS * CALLS,
      )
      const clock = fieldClock(weather, TIME)
      let drawnCloudy = 0
      let cpuCloudy = 0
      let rays = 0
      const differences: number[] = []
      const taps: number[] = []
      for (let r = 0; r < SIDE * SIDE; r += 1) {
        if (!crossed[r]) continue
        rays += 1
        let drawn = 0
        let cpu = 0
        for (let s = 0; s < STEPS; s += 1)
          for (let q = 0; q < CALLS; q += 1) {
            const n = (r * STEPS + s) * CALLS + q
            const want = cloudFieldAt(
              weather,
              clock,
              SUN,
              points[n]!.position,
              points[n]!.footprint,
            )
            const extinction = read[n * 8]! * read[n * 8 + 1]!
            const expected = want.fraction * want.sigma
            if (q === 0) {
              drawn += extinction * lengths[r]!
              cpu += expected * lengths[r]!
            } else if (want.level >= 0 && (extinction > 0 || expected > 0))
              taps.push(
                Math.abs(extinction - expected) /
                  referenceSigma(weather, want.level),
              )
          }
        const opacity = 1 - Math.exp(-drawn)
        const expected = 1 - Math.exp(-cpu)
        if (opacity > 0.5) drawnCloudy += 1
        if (expected > 0.5) cpuCloudy += 1
        differences.push(Math.abs(opacity - expected))
      }
      console.info(
        `frame, ${height} m: cloud fraction drawn ${(drawnCloudy / rays).toFixed(4)}, cloudFieldAt ${(cpuCloudy / rays).toFixed(4)}; opacity difference p99 ${quantile(differences, 0.99).toExponential(2)}, worst ${Math.max(...differences).toExponential(2)}; rays ${rays}; taps' extinction median ${quantile(taps, 0.5).toExponential(2)}, p99 ${quantile(taps, 0.99).toExponential(2)} of σ′ over ${taps.length}`,
      )
      // The light taps, read between the steps on the ray's own chain: the
      // oracle's bounds.
      expect(quantile(taps, 0.5)).toBeLessThanOrEqual(ORACLE_MEDIAN)
      expect(quantile(taps, 0.99)).toBeLessThanOrEqual(ORACLE_P99)
      expect(rays).toBeGreaterThan(SIDE * SIDE * 0.4)
      expect(Math.abs(drawnCloudy - cpuCloudy) / rays).toBeLessThanOrEqual(0.01)
      // Opacity, measured: p99 at most 1.9 × 10⁻², worst 3.3 × 10⁻²; held at
      // twice the p99.
      expect(quantile(differences, 0.99)).toBeLessThanOrEqual(0.04)
      expect(drawnCloudy).toBeGreaterThan(0)
      expect(drawnCloudy).toBeLessThan(rays)
      field.dispose()
    },
    180_000,
  )
})

/* ------------------------------------------------------------------------- */
/* The recurrence                                                             */
/* ------------------------------------------------------------------------- */

describe('the displacement carried along a ray', () => {
  /*
   * The fine medium's displacement turns each wave's sine and cosine from
   * call to call by its series (`createMesoscaleRay`). Here one invocation
   * runs the march's longest chain: 192 steps of 1 km, the march's longest,
   * each followed by its four taps toward the sun, 960 calls, against each
   * wave's sine of its phase taken directly in float64. The cell is the
   * smallest a level has, 1,000 m, and fog's 500 m, where a step from the
   * last tap back to the ray is 1.33 rad.
   */
  it.each([1000, 500])(
    'holds the displacement over 960 calls at a %i m cell, with no renormalization',
    async (cell) => {
      const steps = 192
      const taps = [50, 200, 450, 800]
      const direction = unit({ x: 0.6, y: -0.3, z: 0.74 })
      const sun = unit({ x: -0.2, y: 0.9, z: 0.4 })
      const offsets: Vec3[] = []
      for (let s = 0; s < steps; s += 1) {
        const at = scaled(direction, 500 + 1000 * s)
        offsets.push(at)
        for (const m of taps) offsets.push(added(at, scaled(sun, m)))
      }
      const next = draws(41)
      const eye = Array.from({ length: 6 }, () => next() * 2 * Math.PI)
      const count = offsets.length
      const input = new StorageBufferAttribute(
        new Float32Array(offsets.flatMap(({ x, y, z }) => [x, y, z, 0])),
        4,
      )
      const output = new StorageBufferAttribute(new Float32Array(count * 4), 4)
      const from = storage(input, 'vec4', count)
      const into = storage(output, 'vec4', count)
      const ray = createMesoscaleRay()
      const kernel = Fn(() => {
        If(instanceIndex.lessThan(uint(1)), () => {
          Loop(count, ({ i }) => {
            const w = ray(
              from.element(i).xyz,
              [
                vec3(eye[0]!, eye[1]!, eye[2]!),
                vec3(eye[3]!, eye[4]!, eye[5]!),
              ],
              float(cell),
              float(0),
            )
            into.element(i).assign(vec4(w, 0))
          })
        })
      })().compute(1)
      await gpu.compute(kernel)
      const read = new Float32Array(await gpu.readBuffer(output))
      let worst = 0
      let first = 0
      let largestStep = 0
      let previous: number[] | null = null
      offsets.forEach((offset, n) => {
        const phases = MESOSCALE_WAVES.map(
          ({ along, wavelength }, j) =>
            eye[j]! +
            ((2 * Math.PI) / (wavelength * cell)) *
              (along.x * offset.x + along.y * offset.y + along.z * offset.z),
        )
        if (previous !== null)
          phases.forEach((phase, j) => {
            largestStep = Math.max(largestStep, Math.abs(phase - previous![j]!))
          })
        previous = phases
        const want = mesoscaleDisplacement(phases, cell)
        const error =
          Math.max(
            Math.abs(read[n * 4]! - want.x),
            Math.abs(read[n * 4 + 1]! - want.y),
            Math.abs(read[n * 4 + 2]! - want.z),
          ) / cell
        if (n < 5) first = Math.max(first, error)
        worst = Math.max(worst, error)
      })
      console.info(
        `recurrence at a ${cell} m cell: largest step ${largestStep.toFixed(3)} rad, error ${first.toExponential(2)} of a cell over the first step, ${worst.toExponential(2)} over 960 calls`,
      )
      expect(largestStep).toBeLessThan(MESOSCALE_STEP_MAX)
      // A thousandth of a cell, 1 m at 1,000 m: a 64th of a base texel.
      expect(worst).toBeLessThanOrEqual(1e-3)
    },
    60_000,
  )
})
