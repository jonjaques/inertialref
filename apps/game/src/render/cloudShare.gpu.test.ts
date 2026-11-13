import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StorageBufferAttribute, Vector3 } from 'three/webgpu'
import {
  bool,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  length,
  mix,
  select,
  storage,
  uniform,
  vec3,
} from 'three/tsl'
import { bodyWeather, fieldClock } from '@inertialref/rendering'
import { Quaternion as Q, type Vec3 } from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { altitudeAt, cloudRay, sunMuAt } from './cloudGeometry.ts'
import {
  CLOUD_TRANSPORTS,
  type CloudLevers,
  DEFAULT_CLOUD_LEVERS,
} from './cloudLevers.ts'
import { cloudMarch, type CloudMarchDeps } from './cloudMarch.ts'
import {
  CLOUD_STAND_INS,
  type CloudMediumFn,
  type CloudSample,
  type CloudSkyNodes,
  type CloudSunFn,
} from './cloudNodes.ts'
import {
  LOOKING_UP,
  RIG_EARTH,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The cumuliform share of a column, through the shipped field under a
 * climate that is no regime's. A regime's level is one share everywhere,
 * which the climate's uniforms hold and the march reads from them; Earth's
 * own climate is a zonal law whose share varies by place, and there the
 * march has the share only where the medium hands it its column's
 * (`CloudMedium.convective`). Without it every column is taken as
 * stratiform: a cumulus under a 15° sun takes no factor of the sun, 1 for
 * 1.38, and the sky's term takes the two sides' mean off it, which is the
 * form a cumulus is the worse for.
 *
 * The place is 20° of latitude on the rig's Earth, where the zonal law
 * gives the low level a share of 0.82 and the middle level 0.41: neither
 * none nor all, so a share read as either shows.
 */

const CSS = { width: 256, height: 144 } as const
const EYE = 100
const radians = (degrees: number): number => (degrees * Math.PI) / 180
/** The sun 15° over the eye's horizon, where the factor of the sun is furthest from one. */
const SUN: Vec3 = {
  x: 0,
  y: Math.sin(radians(15)),
  z: -Math.cos(radians(15)),
}
const STANCE: RigStance = {
  eye: EYE,
  looking: LOOKING_UP,
  sun: SUN,
  // The eye over 20° of latitude: the pole is the body's +Y.
  turn: Q.fromAxisAngle({ x: 0, y: 0, z: 1 }, radians(70)),
}
const LEVERS: CloudLevers = {
  ...DEFAULT_CLOUD_LEVERS,
  on: true,
  weather: 'climate',
}
/**
 * How far the medium's share may stand from the climate's at the column:
 * a step of the clipmap's eight bits, 0.0039, which holds the law to half
 * of it. 0.0019 at worst on the Mac mini.
 */
const SHARE = 0.004
/**
 * How far the march over the shipped medium may stand from the same march
 * told the climate's share outright, as a share of its light: that half
 * step through the factor of the sun and the sky's term, under 0.1%. 0.01%
 * on the Mac mini, where the march told none stands 14% to 44% off.
 */
const READ = 0.002

let gpu: GpuSession
let field: CloudField
let frame: CloudFrame
let previous: CloudFrame | null = null

/** A frame of the field at the stance, its caches given their share. */
function frameAt(): CloudFrame {
  const built = cloudFrame(rigFrameInputs(STANCE, LEVERS, CSS), previous)
  if (built === null) throw new Error('no frame: nothing served')
  previous = built
  field.write(built)
  field.render(gpu.renderer, built, {
    slices: LEVERS.sunSlices,
    tiles: 1,
    jump: built.jump,
    sunSlices: LEVERS.sunSlices,
  })
  return built
}

beforeAll(async () => {
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
  // Frames until every cache holds the field and has for eight more.
  frame = frameAt()
  for (let n = 0; n < 64; n += 1) frame = frameAt()
  for (let n = 0, rest = 0; n < 400 && rest < 8; n += 1) {
    frame = frameAt()
    rest = field.bakes.some((bake) => bake.pending) ? 0 : rest + 1
  }
}, 180_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

type Triple = readonly [number, number, number]

/** The eye's vertical and two directions across it, in the axes the frame's eye and sun are in. */
function axes(): { up: Vec3; east: Vec3; north: Vec3 } {
  const { eye } = frame.served
  const r = Math.hypot(eye.x, eye.y, eye.z)
  const up = { x: eye.x / r, y: eye.y / r, z: eye.z / r }
  const cross = (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  })
  const across = cross(up, { x: 0, y: 0, z: 1 })
  const n = Math.hypot(across.x, across.y, across.z)
  const east = { x: across.x / n, y: across.y / n, z: across.z / n }
  return { up, east, north: cross(up, east) }
}

/** The climate's cumuliform share of each level at an eye-relative point, as the CPU field has it. */
function climateShare(offset: Vec3): Triple {
  const record = rigFrameInputs(STANCE, LEVERS, CSS).record(RIG_EARTH)!
  const weather = bodyWeather(record)!
  const clock = fieldClock(weather, frame.time)
  const { eye } = frame.served
  const at = { x: eye.x + offset.x, y: eye.y + offset.y, z: eye.z + offset.z }
  const r = Math.hypot(at.x, at.y, at.z)
  const { convective } = weather.climate.sample(
    { x: at.x / r, y: at.y / r, z: at.z / r },
    frame.served.sun,
    clock.time,
  )
  return [convective[0]!, convective[1]!, convective[2]!]
}

describe('the column’s cumuliform share, through the shipped field under a zonal climate', () => {
  it('is the climate’s at the column, in the low level and the middle one, and neither none nor all', async () => {
    expect(frame.served.climate.kind).not.toBe('regime')
    const { up, east, north } = axes()
    const [low, middle] = frame.served.levels
    // Three heights of the low level and one of the middle, each over the
    // eye and at two places up to a kilometer off.
    const samples: { level: number; offset: Vec3 }[] = []
    for (const [level, share] of [
      [0, 0.2],
      [0, 0.5],
      [0, 0.8],
      [1, 0.5],
    ] as const) {
      const span = level === 0 ? low : middle
      const height = span.base + share * (span.top - span.base)
      for (const [e, n] of [
        [0, 0],
        [500, 0],
        [-300, 800],
      ] as const)
        samples.push({
          level,
          offset: {
            x: up.x * (height - EYE) + east.x * e + north.x * n,
            y: up.y * (height - EYE) + east.y * e + north.y * n,
            z: up.z * (height - EYE) + east.z * e + north.z * n,
          },
        })
    }
    const input = new StorageBufferAttribute(
      new Float32Array(
        samples.flatMap(({ offset }) => [offset.x, offset.y, offset.z]),
      ),
      1,
    )
    const output = new StorageBufferAttribute(
      new Float32Array(samples.length * 2),
      1,
    )
    const from = storage(input, 'float', samples.length * 3)
    const into = storage(output, 'float', samples.length * 2)
    const count = uniform(samples.length, 'uint')
    const body = field.uniforms.served
    let held = false
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(count), () => {
        const read = (k: number) => from.element(instanceIndex.mul(3).add(k))
        const offset = vec3(read(0), read(1), read(2))
        const sample: CloudSample = {
          offset,
          distance: length(offset),
          altitude: altitudeAt(body, offset),
          sunMu: sunMuAt(body, offset),
          footprint: uniform(0),
        }
        const medium = field.medium(sample, body)
        held = medium.convective !== undefined
        const to = instanceIndex.mul(2)
        into.element(to).assign(medium.convective ?? float(-1))
        into.element(to.add(1)).assign(float(medium.layer))
      })
    })().compute(samples.length)
    await gpu.compute(kernel)
    const out = new Float32Array(await gpu.readBuffer(output))
    kernel.dispose()
    input.dispose()
    output.dispose()
    // The shipped field's medium hands the march its column's share.
    expect(held).toBe(true)
    const lines: string[] = []
    let worst = 0
    samples.forEach(({ level, offset }, i) => {
      const [got, layer] = out.subarray(2 * i, 2 * i + 2)
      const want = climateShare(offset)[level]!
      expect(layer).toBe(level)
      expect(Number.isFinite(got)).toBe(true)
      worst = Math.max(worst, Math.abs(got! - want))
      lines.push(
        `  level ${level}, ${Math.round(frame.served.levels[level]!.base)} to ${Math.round(frame.served.levels[level]!.top)} m: ${got!.toFixed(4)} for the climate's ${want.toFixed(4)}`,
      )
      expect(Math.abs(got! - want)).toBeLessThan(SHARE)
      // Neither none nor all: a share read as either would show.
      expect(want).toBeGreaterThan(0.2)
      expect(want).toBeLessThan(0.95)
    })
    console.info(
      `cloudShare: the medium's cumuliform share under a ${frame.served.climate.kind} climate, off the climate's by ${worst.toFixed(4)} at worst:\n${lines.join('\n')}`,
    )
  }, 300_000)

  it('is what the factor of the sun and the sky’s term read: the march over the shipped medium is the march told the climate’s share, and not the march told none', async () => {
    const { up, east, north } = axes()
    const body = field.uniforms.served
    // A bundle of rays about the vertical, 12 by 12, to 31° off it: at the
    // low level's middle they stand over a square 1.8 km across.
    const SIDE = 12
    const directions: number[] = []
    for (let a = 0; a < SIDE; a += 1)
      for (let b = 0; b < SIDE; b += 1) {
        const e = ((a + 0.5) / SIDE - 0.5) * 1.2
        const n = ((b + 0.5) / SIDE - 0.5) * 1.2
        const d = {
          x: up.x + east.x * e + north.x * n,
          y: up.y + east.y * e + north.y * n,
          z: up.z + east.z * e + north.z * n,
        }
        const size = Math.hypot(d.x, d.y, d.z)
        directions.push(d.x / size, d.y / size, d.z / size)
      }
    const rays = SIDE * SIDE
    const input = new StorageBufferAttribute(new Float32Array(directions), 1)
    const output = new StorageBufferAttribute(new Float32Array(rays * 4), 1)
    const from = storage(input, 'float', rays * 3)
    const into = storage(output, 'float', rays * 4)
    const count = uniform(rays, 'uint')
    // What a draw switches: the share the medium hands the march (its own,
    // or one a level it is told), the sun, and the sky's four numbers.
    const useTold = uniform(0)
    const told = uniform(new Vector3())
    const sunOn = uniform(1)
    const sides = {
      mean: uniform(new Vector3()),
      up: uniform(new Vector3()),
      sunward: uniform(new Vector3()),
      upper: uniform(new Vector3()),
    }
    const medium: CloudMediumFn = (sample, of) => {
      const shipped = field.medium(sample, of)
      const toldAt = select(
        shipped.layer.equal(int(0)),
        told.x,
        select(shipped.layer.equal(int(1)), told.y, told.z),
      )
      return {
        ...shipped,
        // A medium that holds no share is read as one that holds none.
        convective: mix(shipped.convective ?? float(0), toldAt, useTold),
      }
    }
    const sun: CloudSunFn = (sample, lit, of, options) => {
      const shipped = field.sun(sample, lit, of, options)
      return {
        cloud: shipped.cloud,
        air: shipped.air.mul(sunOn),
        get depth() {
          return shipped.depth
        },
        octave: shipped.octave,
      }
    }
    const sky: CloudSkyNodes = { at: () => sides }
    const deps: CloudMarchDeps = {
      uniforms: field.uniforms,
      medium,
      sun,
      // No first order: the light after it and the sky's alone.
      phase: CLOUD_STAND_INS.phase(0),
      sky,
      source: field.source,
      jitter: field.jitter,
    }
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(count), () => {
        const read = (k: number) => from.element(instanceIndex.mul(3).add(k))
        const ray = cloudRay(
          vec3(read(0), read(1), read(2)),
          body,
          float(60_000),
        )
        const fine = cloudMarch(ray, float(0.5), bool(true), deps, null, {
          skyTable: true,
        })
        const to = instanceIndex.mul(4)
        into.element(to).assign(fine.light.x)
        into.element(to.add(1)).assign(fine.light.y)
        into.element(to.add(2)).assign(fine.light.z)
        into.element(to.add(3)).assign(fine.transmittance)
      })
    })().compute(rays)

    const NONE: Triple = [0, 0, 0]
    /** The bundle's light, summed a band, and its mean opacity. */
    const draw = async (lit: {
      /** The share a level the medium is told, or its own. */
      readonly told: Triple | null
      readonly transport: (typeof CLOUD_TRANSPORTS)[number]
      readonly sun: boolean
      readonly sky: {
        readonly mean: Triple
        readonly up: Triple
        readonly sunward: Triple
        readonly upper: Triple
      } | null
    }): Promise<{ light: Triple; opacity: number }> => {
      field.write(frame)
      field.uniforms.trace.transport.value = CLOUD_TRANSPORTS.indexOf(
        lit.transport,
      )
      useTold.value = lit.told === null ? 0 : 1
      told.value.set(...(lit.told ?? NONE))
      sunOn.value = lit.sun ? 1 : 0
      sides.mean.value.set(...(lit.sky?.mean ?? NONE))
      sides.up.value.set(...(lit.sky?.up ?? NONE))
      sides.sunward.value.set(...(lit.sky?.sunward ?? NONE))
      sides.upper.value.set(...(lit.sky?.upper ?? NONE))
      await gpu.compute(kernel)
      const out = new Float32Array(await gpu.readBuffer(output))
      const light: [number, number, number] = [0, 0, 0]
      let opacity = 0
      for (let i = 0; i < rays; i += 1) {
        for (const band of [0, 1, 2] as const) {
          expect(Number.isFinite(out[4 * i + band])).toBe(true)
          light[band] += out[4 * i + band]!
        }
        opacity += (1 - out[4 * i + 3]!) / rays
      }
      return { light, opacity }
    }
    // The climate's share of each level over the eye: what the medium holds
    // at every column of the bundle, to the law's turn over two kilometers.
    const climate = climateShare({ x: 0, y: 0, z: 0 })
    const apart = (a: Triple, b: Triple): number =>
      Math.max(...a.map((value, k) => Math.abs(value / b[k]! - 1)))

    // The factor of the sun: the sun's light past first order, no sky.
    const sunlit = { sun: true, sky: null } as const
    const shipped = await draw({ ...sunlit, told: null, transport: 'slab' })
    const asTold = await draw({ ...sunlit, told: climate, transport: 'slab' })
    const none = await draw({ ...sunlit, told: NONE, transport: 'slab' })
    const plane = await draw({ ...sunlit, told: null, transport: 'plane' })
    expect(shipped.opacity).toBeGreaterThan(0.05)
    for (const band of [0, 1, 2] as const)
      expect(shipped.light[band]).toBeGreaterThan(0)
    // The factor off is the factor at a share of none.
    expect(apart(plane.light, none.light)).toBeLessThan(1e-6)
    expect(apart(shipped.light, asTold.light)).toBeLessThan(READ)
    expect(apart(shipped.light, none.light)).toBeGreaterThan(0.1)

    // The sky's term: no sun, and a sky with a horizon's band (1.7 km under
    // a 15° sun, by the quadrature) whose `c` a stratiform column takes.
    const band = {
      mean: [0.02179, 0.03, 0.01],
      up: [0.088, -0.4, 0.6],
      sunward: [1.118, 0.5, -0.3],
      upper: [-0.378, -0.2, -0.15],
    } as const
    const skylit = { sun: false, sky: band, transport: 'slab' } as const
    const skyShipped = await draw({ ...skylit, told: null })
    const skyTold = await draw({ ...skylit, told: climate })
    const skyNone = await draw({ ...skylit, told: NONE })
    for (const k of [0, 1, 2] as const)
      expect(skyShipped.light[k]).toBeGreaterThan(0)
    expect(apart(skyShipped.light, skyTold.light)).toBeLessThan(READ)
    // `c` is under zero: a column read as stratiform is the darker.
    for (const k of [0, 1, 2] as const)
      expect(skyShipped.light[k]).toBeGreaterThan(skyNone.light[k] * 1.03)

    const percent = (value: number): string => `${(value * 100).toFixed(2)}%`
    console.info(
      [
        `cloudShare: a bundle of ${rays} rays under a ${frame.served.climate.kind} climate, mean opacity ${shipped.opacity.toFixed(3)}; the climate's share ${climate.map((v) => v.toFixed(3)).join(', ')}`,
        `  the sun past first order, the shipped medium over the medium told the climate's share: ${percent(apart(shipped.light, asTold.light))} apart; over the medium told none ${shipped.light.map((v, k) => percent(v / none.light[k]! - 1)).join(', ')}`,
        `  the sky's term, the shipped medium over the medium told the climate's share: ${percent(apart(skyShipped.light, skyTold.light))} apart; over the medium told none ${skyShipped.light.map((v, k) => percent(v / skyNone.light[k]! - 1)).join(', ')}`,
      ].join('\n'),
    )
    kernel.dispose()
    input.dispose()
    output.dispose()
  }, 300_000)
})
