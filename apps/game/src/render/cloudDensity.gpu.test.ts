import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  StorageBufferAttribute,
  type Texture,
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
  texture3D,
  textureLoad,
  uint,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CLOUD_GENERA,
  cloudExtents,
  curlNoise,
  genusProfile,
  horizonBasis,
  levelFrames,
  periodIndex,
  scenarioCoverage,
  shellBoundaries,
  shellHeights,
  WEATHER_SCENARIOS,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import { CloudClipmap } from './cloudClipmap.ts'
import {
  analyticMedium,
  fieldMedium,
  SWEEP_READS_MAX,
  SWEEP_STRIDE,
  sweepMedium,
  synopticMedium,
} from './cloudDensity.ts'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudFrame,
} from './cloudFrame.ts'
import { CLOUD_SWEEP_EXTRAS, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { CloudMaps } from './cloudMaps.ts'
import type { CloudBudget, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import { CloudNoise } from './cloudNoise.ts'
import { CloudProfile } from './cloudProfile.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The media against §5.6 on the CPU, at sampled points (§3.10).
 *
 * Every point is placed where each texture it reads is read at a texel
 * center — the base noise's, the detail's, the profile's — so the GPU's
 * filter returns the stored texel exactly and the reference can take the
 * same stored bytes, read back with `textureLoad`. What is left between the
 * two is the recipe's own float32 arithmetic; the noise is held to
 * `weatherNoise.ts` by `cloudNoise.gpu.test.ts`, the coverage by the maps'
 * and the clipmap's tests. A reference that recomputed the noise instead
 * would differ by a rounding of an 8-bit store, amplified by the remap's
 * division by the coverage.
 */

let gpu: GpuSession
let renderer: WebGPURenderer
let noise: CloudNoise
let profile: CloudProfile

const EARTH = 6_371_000
const TIME = 7.3e9
/**
 * float32 against float64 over §5.6's two divisions and two mixes, relative
 * to the layer's σ: parts in 10⁶, held at 10⁻⁴.
 */
const RECIPE = 1e-4

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
  noise = new CloudNoise()
  await noise.warm(renderer)
  profile = new CloudProfile()
})

afterAll(() => {
  noise.dispose()
  profile.dispose()
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
  sunTexelSteps: 0,
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

const EYE = scaled(unit({ x: 0.3, y: 0.9, z: -0.31 }), EARTH + 1200)
const NOISE_ORIGIN: Vec3 = { x: 1234.5, y: 2345.25, z: 3456.125 }
const DRIFT: Vec3 = { x: 10, y: -20, z: 30 }

/**
 * The detail origin's lead on the base's, meters: a base texel center then
 * lands on a detail texel center in every layer, which takes a lead of
 * cell·(1 + 2m)/64 for an integer m in each.
 */
function detailLead(scenario: WeatherScenario): number {
  const cells = scenario.layers.map((layer) => layer.cellMeters)
  for (let m = 0; m < 64; m += 1) {
    const lead = (cells[0]! * (1 + 2 * m)) / 64
    if (
      cells.every((cell) => {
        const odd = (lead * 64) / cell
        return Number.isInteger(odd) && odd % 2 === 1
      })
    )
      return lead
  }
  throw new Error(`no detail lead serves ${scenario.id}'s cells`)
}

/** A frame with every field the bundle writes, copied into `uniforms`. */
function frameAt(
  uniforms: CloudUniforms,
  scenario: WeatherScenario,
  previous: CloudFrame | null,
): CloudFrame {
  const lead = detailLead(scenario)
  const { east, north } = horizonBasis(EYE)
  const frame = {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true, scenario: scenario.id },
    scenario,
    served: {
      address: 'test',
      datumRadius: EARTH,
      compression: 1,
      toBodyFixed: { x: 0, y: 0, z: 0, w: 1 },
      eye: EYE,
      sun: { x: 0, y: 1, z: 0 },
      shells: shellHeights(EYE, EARTH, shellBoundaries(scenario)),
      scattering: null,
      limb: 0,
      limbFalloff: 1,
      dayColor: { r: 1, g: 1, b: 1 },
      noiseOrigin: NOISE_ORIGIN,
      detailOrigin: added(NOISE_ORIGIN, { x: lead, y: lead, z: lead }),
      drift: DRIFT,
      wind: added(
        scaled(east, scenario.wind.east),
        scaled(north, scenario.wind.north),
      ),
      clipmap: levelFrames(
        EYE,
        EARTH,
        CLOUD_CLIPMAP_TEXELS,
        CLOUD_CLIPMAP_SIZE,
        previous?.served.clipmap.frames ?? null,
      ),
      volume: { frames: [], dirty: [], rebuilt: [] },
      cascades: { cascades: [], dirty: [], stale: [] },
    },
    second: null,
    time: TIME,
    frameSeconds: 0,
    period: periodIndex(TIME, scenario.patternPeriod),
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
    jump: false,
    frameIndex: 0,
    extents: cloudExtents({ width: 64, height: 64 }, { width: 64, height: 64 }),
  } satisfies CloudFrame
  uniforms.write(frame)
  return frame
}

/** The served body's field for `scenario`: a cube and a clipmap baked whole at `EYE`. */
interface Field {
  readonly uniforms: CloudUniforms
  readonly maps: CloudMaps
  readonly clipmap: CloudClipmap
  dispose(): void
}

function bakeField(scenario: WeatherScenario): Field {
  const uniforms = createCloudUniforms()
  const maps = new CloudMaps(uniforms)
  const clipmap = new CloudClipmap(uniforms, maps.nodes)
  let frame = frameAt(uniforms, scenario, null)
  for (let k = 0; k < 6; k += 1) maps.render(renderer, frame, budget)
  for (let k = 0; k < 4; k += 1) {
    clipmap.render(renderer, frame, budget)
    frame = frameAt(uniforms, scenario, frame)
  }
  expect(maps.pending).toBe(false)
  expect(clipmap.pending).toBe(false)
  return {
    uniforms,
    maps,
    clipmap,
    dispose() {
      maps.dispose()
      clipmap.dispose()
    },
  }
}

/** A sample's inputs, as a test places them. */
interface Point {
  readonly offset: Vec3
  readonly altitude: number
  readonly footprint: number
}

/** `medium` at each point, one thread each: (fraction, σ, layer, column) and the radius. */
async function evaluate(
  points: readonly Point[],
  medium: CloudMediumFn,
  uniforms: CloudUniforms,
): Promise<Float32Array> {
  const count = points.length
  const input = new StorageBufferAttribute(
    new Float32Array(
      points.flatMap(({ offset, altitude, footprint }) => [
        offset.x,
        offset.y,
        offset.z,
        altitude,
        footprint,
        Math.hypot(offset.x, offset.y, offset.z),
        0,
        0,
      ]),
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
      into.element(instanceIndex.mul(2).add(1)).assign(vec4(m.radius, 0, 0, 0))
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** Texels at integer coordinates, `textureLoad`ed by one thread each: RGBA a texel. */
async function loadTexels(
  map: Texture,
  kind: '2d-array' | '3d',
  at: readonly (readonly [number, number, number])[],
): Promise<Float32Array> {
  const count = at.length
  const input = new StorageBufferAttribute(
    new Int32Array(at.flatMap(([x, y, z]) => [x, y, z, 0])),
    4,
  )
  const output = new StorageBufferAttribute(new Float32Array(count * 4), 4)
  const coordinates = storage(input, 'ivec4', count)
  const into = storage(output, 'vec4', count)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const c = coordinates.element(instanceIndex)
      into
        .element(instanceIndex)
        .assign(
          kind === '3d'
            ? texture3D(map).load(c.xyz)
            : textureLoad(map, c.xy).depth(c.z),
        )
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

const noiseTexture = (name: string): Texture =>
  noise.textures().find((t) => t.name === name)!

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const saturate = (x: number): number => Math.min(1, Math.max(0, x))
const fract = (x: number): number => x - Math.floor(x)

/** Where a point's reads land: the base and detail texels, the profile texel, its layer. */
interface Placed extends Point {
  readonly layer: number
  readonly base: readonly [number, number, number]
  readonly detail: readonly [number, number, number]
  readonly height: number
}

/**
 * Points inside each layer at profile texel heights, with offsets that put
 * the base read on a texel center (the detail follows by `detailLead`), at
 * footprints across resolved, eroded-in-part and unresolved; and a point
 * between the layers and one over them.
 */
function placePoints(
  scenario: WeatherScenario,
  seed: number,
  periods = 1,
): Placed[] {
  const next = draws(seed)
  const lead = detailLead(scenario)
  const points: Placed[] = []
  const footprints = [0, 1 / 12, 1 / 6, 0.5, 2]
  for (let n = 0; n < 240; n += 1) {
    const layer = n % scenario.layers.length
    const spec = scenario.layers[layer]!
    const cell = spec.cellMeters
    const height = 1 + Math.floor(next() * 62)
    const altitude = spec.base + ((spec.top - spec.base) * height) / 63
    const texel = [0, 1, 2].map(() => Math.floor(next() * 128))
    const shift = [0, 1, 2].map(
      () => Math.floor(next() * 2 * periods) - periods,
    )
    const origin = [NOISE_ORIGIN.x, NOISE_ORIGIN.y, NOISE_ORIGIN.z]
    const drift = [DRIFT.x, DRIFT.y, DRIFT.z]
    // The lattice is read at origin − drift + offset: the wind carries it.
    const offset = [0, 1, 2].map(
      (a) =>
        ((texel[a]! + 0.5) / 16 + 8 * shift[a]!) * cell -
        origin[a]! +
        drift[a]!,
    )
    const detail = offset.map((o, a) => {
      const at = (8 * 4 * (origin[a]! + lead - drift[a]! + o)) / cell
      expect(Math.abs(fract(at) - 0.5)).toBeLessThan(1e-6)
      return ((Math.floor(at) % 32) + 32) % 32
    })
    points.push({
      offset: { x: offset[0]!, y: offset[1]!, z: offset[2]! },
      altitude,
      footprint: footprints[n % footprints.length]! * cell,
      layer,
      base: texel as [number, number, number],
      detail: detail as [number, number, number],
      height,
    })
  }
  return points
}

/** §5.6 in float64, from the stored bytes each read takes. */
function reference(
  scenario: WeatherScenario,
  point: Placed,
  cover: number,
  base: number,
  detail: number,
): { readonly fraction: number; readonly sigma: number } {
  const spec = scenario.layers[point.layer]!
  const cell = spec.cellMeters
  const row = CLOUD_GENERA.indexOf(spec.genus)
  const table = profile.texture.image.data as Uint8Array
  const at = (row * 64 + point.height) * 4
  const p = table[at]! / 255
  const mean = table[at + 1]! / 255
  const reach = 1 - smoothstep(cell / 16, cell / 4, point.footprint)
  const erosion = reach > 0 ? detail * spec.erosion * reach : 0
  const shaped = saturate((base * p - (1 - cover)) / Math.max(cover, 1e-6))
  const eroded = saturate((shaped - erosion) / Math.max(1 - erosion, 1e-6))
  const f = smoothstep(cell / 4, cell, point.footprint)
  const fraction = 1 + (cover - 1) * f
  // The two pictures of a cell blend by their mean extinction, fraction × σ.
  const extinction = spec.sigma * (eroded * (1 - f) + cover * mean * f)
  return { fraction, sigma: extinction / Math.max(fraction, 1e-6) }
}

async function storedNoise(
  points: readonly Placed[],
): Promise<{ base: number[]; detail: number[] }> {
  const base = await loadTexels(
    noiseTexture('cloud base noise'),
    '3d',
    points.map((p) => p.base),
  )
  const detail = await loadTexels(
    noiseTexture('cloud detail noise'),
    '3d',
    points.map((p) => p.detail),
  )
  return {
    base: points.map((_, n) => base[n * 4]!),
    detail: points.map((_, n) => detail[n * 4]!),
  }
}

describe('the profile table', () => {
  it('is genusProfile at its 64 heights, and its mean along the row', () => {
    const table = profile.texture.image.data as Uint8Array
    CLOUD_GENERA.forEach((genus, row) => {
      for (let i = 0; i < 64; i += 1) {
        const at = (row * 64 + i) * 4
        expect(
          Math.abs(table[at]! / 255 - genusProfile(genus, i / 63)),
        ).toBeLessThanOrEqual(0.5 / 255)
      }
      expect(table[row * 64 * 4]).toBe(0)
      expect(table[(row * 64 + 63) * 4]).toBe(0)
    })
  })
})

describe('the three media are §5.6, differing only in their coverage', () => {
  it('fieldMedium: the clipmap’s coverage', async () => {
    const scenario = WEATHER_SCENARIOS['two-decks']
    const field = bakeField(scenario)
    const points = placePoints(scenario, 7)
    const stored = await storedNoise(points)
    const read = await evaluate(
      points,
      fieldMedium({
        uniforms: field.uniforms,
        clipmap: field.clipmap.nodes,
        noise: noise.nodes,
        profile,
      }),
      field.uniforms,
    )
    const cover = Math.round(0.6 * 255) / 255
    let worst = 0
    let clouded = 0
    points.forEach((point, n) => {
      const want = reference(
        scenario,
        point,
        cover,
        stored.base[n]!,
        stored.detail[n]!,
      )
      const spec = scenario.layers[point.layer]!
      worst = Math.max(
        worst,
        Math.abs(read[n * 8 + 1]! - want.sigma) / spec.sigma,
        Math.abs(read[n * 8]! - want.fraction),
      )
      if (want.sigma > 0) clouded += 1
      expect(read[n * 8 + 2]).toBe(point.layer)
      // Level 0's texel or level 1's: every point is within 25 km of the eye.
      expect([250, 500]).toContain(read[n * 8 + 3])
      expect(read[n * 8 + 4]).toBe(spec.radius)
    })
    expect(worst).toBeLessThanOrEqual(RECIPE)
    // The recipe draws cloud and clear air both, or the test proves little.
    expect(clouded).toBeGreaterThan(40)
    expect(clouded).toBeLessThan(points.length - 40)
    field.dispose()
  })

  it('synopticMedium: the cube’s, nonzero 1,800 km out where the clipmap holds nothing', async () => {
    const scenario = WEATHER_SCENARIOS['two-decks']
    const field = bakeField(scenario)
    const points = placePoints(scenario, 9)
    const stored = await storedNoise(points)
    const synoptic = synopticMedium({
      uniforms: field.uniforms,
      maps: field.maps.nodes,
      noise: noise.nodes,
      profile,
    })
    const read = await evaluate(points, synoptic, field.uniforms)
    const cover = Math.round(0.6 * 255) / 255
    let worst = 0
    points.forEach((point, n) => {
      const want = reference(
        scenario,
        point,
        cover,
        stored.base[n]!,
        stored.detail[n]!,
      )
      worst = Math.max(
        worst,
        Math.abs(read[n * 8 + 1]! - want.sigma) /
          scenario.layers[point.layer]!.sigma,
        Math.abs(read[n * 8]! - want.fraction),
      )
      // The cube's texel at a face's center.
      expect(read[n * 8 + 3]).toBeCloseTo((EARTH * Math.PI) / 1024, 0)
    })
    expect(worst).toBeLessThanOrEqual(RECIPE)

    // A far bake's sample: (R + h)·d − e, 1,800 km along the surface, inside
    // the low deck, at a footprint no cell resolves.
    const { east } = horizonBasis(EYE)
    const angle = 1.8e6 / EARTH
    const up = unit(EYE)
    const d = added(scaled(up, Math.cos(angle)), scaled(east, Math.sin(angle)))
    const far: Point = {
      offset: added(scaled(d, EARTH + 1200), scaled(EYE, -1)),
      altitude: 1200,
      footprint: 20_000,
    }
    const fieldMedia = fieldMedium({
      uniforms: field.uniforms,
      clipmap: field.clipmap.nodes,
      noise: noise.nodes,
      profile,
    })
    const out = await evaluate([far], synoptic, field.uniforms)
    const near = await evaluate([far], fieldMedia, field.uniforms)
    expect(out[0]).toBeCloseTo(cover, 5)
    expect(out[1]).toBeGreaterThan(0)
    // Past level 5's window the clipmap's coverage has faded to none, so no
    // share of the column is cloud, whatever an unresolved cell's σ would be.
    expect(near[0]).toBe(0)
    field.dispose()
  })

  it('analyticMedium: the placeholder’s function, blobs and all', async () => {
    const scenario = WEATHER_SCENARIOS['fair-cumulus']
    const field = bakeField(scenario)
    // Out to ±480 km, so the points fall in many of the blobs' 156 km cells.
    const points = placePoints(scenario, 13, 50)
    const stored = await storedNoise(points)
    const read = await evaluate(
      points,
      analyticMedium({ uniforms: field.uniforms, noise: noise.nodes, profile }),
      field.uniforms,
    )
    let worst = 0
    let blobbed = 0
    let clear = 0
    points.forEach((point, n) => {
      const direction = unit(added(EYE, point.offset))
      const cover = scenarioCoverage(scenario, point.layer, direction, TIME)
      if (cover > 0.99) blobbed += 1
      if (cover < 0.01) clear += 1
      const want = reference(
        scenario,
        point,
        cover,
        stored.base[n]!,
        stored.detail[n]!,
      )
      worst = Math.max(
        worst,
        Math.abs(read[n * 8 + 1]! - want.sigma) /
          scenario.layers[point.layer]!.sigma,
        Math.abs(read[n * 8]! - want.fraction),
      )
    })
    // The coverage is float32 trigonometry against float64 here, a few
    // parts in 10⁶, and the remap divides by it: 10⁻³ of σ.
    expect(worst).toBeLessThanOrEqual(1e-3)
    expect(blobbed).toBeGreaterThan(10)
    expect(clear).toBeGreaterThan(10)
    field.dispose()
  })

  it('holds no cloud in a cell with no coverage, at any footprint', async () => {
    /*
     * σ and the fraction blended each on its own put (1 − f)·f·σ_k·p̄ of
     * extinction here, a quarter of the mean density at f = ½, where the
     * resolved picture holds no σ and the unresolved one no share. Clear
     * cells of fair-cumulus, at footprints across the blend's band.
     */
    const scenario = WEATHER_SCENARIOS['fair-cumulus']
    const field = bakeField(scenario)
    const spec = scenario.layers[0]!
    const altitude = (spec.base + spec.top) / 2
    const points: Point[] = []
    for (let k = 0; points.length < 18 && k < 400; k += 1) {
      const offset = {
        x: ((k % 20) - 10) * 23_000,
        y: 0,
        z: (Math.floor(k / 20) - 10) * 23_000,
      }
      const direction = unit(added(EYE, offset))
      if (scenarioCoverage(scenario, 0, direction, TIME) > 0) continue
      for (const share of [0.1, 0.3, 0.5, 0.75, 0.95, 2])
        points.push({ offset, altitude, footprint: share * spec.cellMeters })
    }
    expect(points).toHaveLength(18)
    const read = await evaluate(
      points,
      analyticMedium({ uniforms: field.uniforms, noise: noise.nodes, profile }),
      field.uniforms,
    )
    for (let n = 0; n < points.length; n += 1)
      expect(read[n * 8]! * read[n * 8 + 1]!).toBe(0)
    field.dispose()
  })

  it('every medium is empty outside every layer', async () => {
    const scenario = WEATHER_SCENARIOS['two-decks']
    const field = bakeField(scenario)
    const outside: Point[] = [
      { offset: { x: 100, y: 0, z: 0 }, altitude: 2500, footprint: 0 },
      { offset: { x: 0, y: 0, z: 100 }, altitude: 6000, footprint: 0 },
      { offset: { x: 0, y: 100, z: 0 }, altitude: 500, footprint: 2000 },
    ]
    const deps = {
      uniforms: field.uniforms,
      clipmap: field.clipmap.nodes,
      maps: field.maps.nodes,
      noise: noise.nodes,
      profile,
    }
    for (const medium of [
      fieldMedium(deps),
      synopticMedium(deps),
      analyticMedium(deps),
      sweepMedium(deps),
    ]) {
      const read = await evaluate(outside, medium, field.uniforms)
      for (let n = 0; n < outside.length; n += 1) {
        expect(read[n * 8]).toBe(0)
        expect(read[n * 8 + 1]).toBe(0)
        expect(read[n * 8 + 2]).toBe(-1)
        expect(read[n * 8 + 4]).toBe(10)
      }
    }
    field.dispose()
  })

  it('rides the wind: a point the drift has carried reads the density it had', async () => {
    /*
     * The history follows a cloud from X − wind·Δt to X (`cloudHistory.ts`),
     * and the composite writes that motion. So the field at a point moved
     * by δ, under a drift δ longer, is the field where the point was. Two
     * decks' coverage is uniform, so nothing else moves with the point.
     */
    const scenario = WEATHER_SCENARIOS['two-decks']
    const field = bakeField(scenario)
    const medium = analyticMedium({
      uniforms: field.uniforms,
      noise: noise.nodes,
      profile,
    })
    const points = placePoints(scenario, 23)
    const before = await evaluate(points, medium, field.uniforms)
    const carried: Vec3 = { x: 400, y: -250, z: 130 }
    const drift = added(DRIFT, carried)
    field.uniforms.served.drift.value.set(drift.x, drift.y, drift.z)
    const after = await evaluate(
      points.map((point) => ({
        ...point,
        offset: added(point.offset, carried),
      })),
      medium,
      field.uniforms,
    )
    let worst = 0
    let clouded = 0
    points.forEach((point, n) => {
      const sigma = scenario.layers[point.layer]!.sigma
      worst = Math.max(
        worst,
        Math.abs(after[n * 8 + 1]! - before[n * 8 + 1]!) / sigma,
      )
      if (before[n * 8 + 1]! > 0) clouded += 1
    })
    // Whole meters carried, so the two lattice coordinates round alike and
    // the reads measure the same to the bit; with the drift added to the
    // point they measure 0.78 of σ apart. The bound is the references' own.
    expect(worst).toBeLessThanOrEqual(1e-3)
    expect(clouded).toBeGreaterThan(40)
    field.dispose()
  })
})

describe('the sweep', () => {
  it('sums exactly `sweepReads` base fetches, and adds one of `sweepExtra`’s type', async () => {
    const scenario = WEATHER_SCENARIOS['two-decks']
    const field = bakeField(scenario)
    const sweep = sweepMedium({
      uniforms: field.uniforms,
      clipmap: field.clipmap.nodes,
      noise: noise.nodes,
      profile,
    })
    const points = placePoints(scenario, 17).slice(0, 24)
    // R8 is bound: a fetch folds to 0.4·r + 0.1 (WebGPU reads (r, 0, 0, 1)).
    const fetches = await loadTexels(
      noiseTexture('cloud base noise'),
      '3d',
      points.flatMap((p) =>
        Array.from(
          { length: SWEEP_READS_MAX },
          (_, r) =>
            p.base.map((t, a) => (t + SWEEP_STRIDE[a]! * r) % 128) as [
              number,
              number,
              number,
            ],
        ),
      ),
    )
    const trace = field.uniforms.trace
    for (const reads of [1, 2, 4, 6]) {
      trace.sweepReads.value = reads
      trace.sweepExtra.value = 0
      const read = await evaluate(points, sweep, field.uniforms)
      points.forEach((point, n) => {
        let sum = 0
        for (let r = 0; r < reads; r += 1)
          sum += 0.4 * fetches[(n * SWEEP_READS_MAX + r) * 4]! + 0.1
        const spec = scenario.layers[point.layer]!
        const want = spec.sigma * saturate(sum / (reads + 1))
        expect(Math.abs(read[n * 8 + 1]! - want) / spec.sigma).toBeLessThan(
          1e-5,
        )
      })
    }

    // One extra of each type: its value is what that read alone returns.
    trace.sweepReads.value = 1
    const base = await evaluate(points, sweep, field.uniforms)
    const clip = Math.round(0.6 * 255) / 255
    const stored = await storedNoise(points)
    const table = profile.texture.image.data as Uint8Array
    for (const name of CLOUD_SWEEP_EXTRAS) {
      if (name === 'none') continue
      trace.sweepExtra.value = CLOUD_SWEEP_EXTRAS.indexOf(name)
      const read = await evaluate(points, sweep, field.uniforms)
      points.forEach((point, n) => {
        const spec = scenario.layers[point.layer]!
        const row = CLOUD_GENERA.indexOf(spec.genus)
        const cell = spec.cellMeters
        const cells = [point.offset.x, point.offset.z].map(
          (o, a) =>
            (o +
              [NOISE_ORIGIN.x, NOISE_ORIGIN.z][a]! -
              [DRIFT.x, DRIFT.z][a]!) /
            cell,
        )
        const curl = curlNoise(cells[0]! / 8, cells[1]! / 8)[0]
        const extra =
          name === 'clipmap' || name === 'level'
            ? clip
            : name === 'profile'
              ? table[(row * 64 + point.height) * 4]! / 255
              : name === 'detail'
                ? stored.detail[n]!
                : curl
        const sum = (base[n * 8 + 1]! / spec.sigma) * 2
        const want = spec.sigma * saturate((sum + extra) / 2)
        // The curl is read filtered between its texels, at 8-bit storage.
        const bound = name === 'curl' ? 0.02 : 1e-5
        expect(
          Math.abs(read[n * 8 + 1]! - want) / spec.sigma,
          `${name} at ${n}`,
        ).toBeLessThan(bound)
      })
    }
    trace.sweepExtra.value = 0
    trace.sweepReads.value = 0
    field.dispose()
  })
})

/*
 * The structure test. A fragment shader reading a texture with
 * `textureSample` in non-uniform control flow — after a `Break` in a loop —
 * is a module Tint refuses, so every medium must name level 0 at every read.
 * The check runs on the WGSL a fragment material running each medium in such
 * a loop compiles to, and a variant with one plain `.sample()` shows the
 * check can fail.
 */
describe('every read names level 0', () => {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2)
  camera.position.z = 1
  camera.updateMatrixWorld()

  async function marched(
    medium: CloudMediumFn,
    uniforms: CloudUniforms,
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

  it.each([
    ['fieldMedium', 5],
    ['synopticMedium', 4],
    ['analyticMedium', 3],
    ['sweepMedium', SWEEP_READS_MAX + 5],
  ] as const)(
    '%s: no bare textureSample, and a textureSampleLevel for each of its %i reads',
    async (name, count) => {
      const field = bakeField(WEATHER_SCENARIOS['two-decks'])
      const deps = {
        uniforms: field.uniforms,
        clipmap: field.clipmap.nodes,
        maps: field.maps.nodes,
        noise: noise.nodes,
        profile,
      }
      const medium = {
        fieldMedium,
        synopticMedium,
        analyticMedium,
        sweepMedium,
      }[name](deps)
      const wgsl = await marched(medium, field.uniforms, false)
      expect(reads(wgsl, 'textureSample')).toBe(0)
      expect(reads(wgsl, 'textureSampleLevel')).toBe(count)
      const control = await marched(medium, field.uniforms, true)
      expect(reads(control, 'textureSample')).toBe(1)
      field.dispose()
    },
  )
})
