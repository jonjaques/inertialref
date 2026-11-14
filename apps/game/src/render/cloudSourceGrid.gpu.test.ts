import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  If,
  instanceIndex,
  length,
  storage,
  uniform,
  vec3,
} from 'three/tsl'
import { cloudFieldAt, fieldClock, regimeWeather } from '@inertialref/rendering'
import { type Vec3 } from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudSample } from './cloudNodes.ts'
import type { CloudSunTaps } from './cloudSunlight.ts'
import {
  LOOKING_UP,
  RIG_EARTH,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sun's two depths as the light after first order reads them, through
 * the real field, its taps and its grid: `CloudSun.depth`, asked for as the
 * sun is formed, which is how the march forms its sun (`cloudMarch.ts`).
 * A sample with taps and a sample the sun's early out skipped fill the
 * depth from two reads of the cache, so the read is held here against a
 * march of the CPU field at both kinds.
 *
 * An overcast, where a cell's mean depth is a ray's: a deck with no lit
 * face inside a cell. In broken cloud a mean of cells is no one ray's
 * depth, and the sun's own instrument scores that
 * (`cloudSunAccuracy.gpu.test.ts`).
 */

const CSS = { width: 480, height: 270 } as const
const EYE = 100
/** The sun's elevation over the rig's eye, degrees. */
const SUN_UP = 37.5
/** Steps of the CPU's march along the sun's ray, each way. */
const STEPS = 2048
/**
 * How far the read may stand from the CPU's march: a share of the depth,
 * and a floor in depth. On the Mac mini (Mac18,5, Apple M6) the depth to
 * the sun is within 5.5% from 1 to 21 and the whole within 8.4%, over the
 * march by 0.4 to 1.6 in the deck's upper half and under it by 0.5 to 0.9
 * in its lower, through four taps and the mean depth of 400 m cells; an
 * unset value is none of it.
 */
const TOLERANCE = 0.1
const FLOOR = 0.3

let gpu: GpuSession
let field: CloudField
let previous: CloudFrame | null = null

beforeAll(async () => {
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

const radians = (degrees: number): number => (degrees * Math.PI) / 180

/** A frame of the field at a stance, its caches given their share. */
function frameAt(stance: RigStance, levers: CloudLevers): CloudFrame {
  const frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
  if (frame === null) throw new Error('no frame: nothing served')
  previous = frame
  field.write(frame)
  field.render(gpu.renderer, frame, {
    slices: levers.sunSlices,
    tiles: 1,
    jump: frame.jump,
    sunSlices: levers.sunSlices,
  })
  return frame
}

/** Frames until every cache holds the field and has for eight more. */
function settled(stance: RigStance, levers: CloudLevers): CloudFrame {
  let frame = frameAt(stance, levers)
  for (let n = 0; n < 64; n += 1) frame = frameAt(stance, levers)
  for (let n = 0, rest = 0; n < 400 && rest < 8; n += 1) {
    frame = frameAt(stance, levers)
    rest = field.bakes.some((bake) => bake.pending) ? 0 : rest + 1
  }
  return frame
}

const add = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
})

describe('the sun’s two depths, asked for as the sun is formed, through the real grid', () => {
  it('are a march of the CPU field’s, at samples with taps and at samples the early out skipped', async () => {
    const levers: CloudLevers = {
      ...DEFAULT_CLOUD_LEVERS,
      on: true,
      weather: 'overcast',
    }
    const sun: Vec3 = {
      x: 0,
      y: Math.sin(radians(SUN_UP)),
      z: -Math.cos(radians(SUN_UP)),
    }
    const stance: RigStance = { eye: EYE, looking: LOOKING_UP, air: true, sun }
    const frame = settled(stance, levers)
    const body = field.uniforms.served
    const [low] = frame.served.levels
    // Heights through the deck: under its top, where a sample takes its
    // taps, and down into it, where the cache calls it dark.
    const heights = [0.97, 0.9, 0.8, 0.65, 0.5, 0.35, 0.2].map(
      (share) => low.base + share * (low.top - low.base),
    )
    const input = new StorageBufferAttribute(new Float32Array(heights), 1)
    const output = new StorageBufferAttribute(
      new Float32Array(heights.length * 4),
      1,
    )
    const from = storage(input, 'float', heights.length)
    const into = storage(output, 'float', heights.length * 4)
    const count = uniform(heights.length, 'uint')
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(count), () => {
        const offset = body.up.mul(from.element(instanceIndex).sub(body.eye))
        const sample: CloudSample = {
          offset: vec3(offset),
          distance: length(offset),
          altitude: altitudeAt(body, offset),
          sunMu: sunMuAt(body, offset),
          footprint: uniform(0),
        }
        const seen = field.sun(sample, field.medium(sample, body), body, {
          depth: true,
        }) as CloudSunTaps
        // As the march reads it: asked for as the sun is formed.
        const sunDepth = seen.depth.toVar()
        const to = instanceIndex.mul(4)
        into.element(to).assign(sunDepth.x)
        into.element(to.add(1)).assign(sunDepth.y)
        into.element(to.add(2)).assign(seen.taken)
        into.element(to.add(3)).assign(seen.skipped)
      })
    })().compute(heights.length)
    await gpu.compute(kernel)
    const out = new Float32Array(await gpu.readBuffer(output))

    // The same two depths on the CPU: the field's own extinction summed
    // along the sun's ray from the sample to where it leaves the level,
    // and back along it.
    const record = rigFrameInputs(stance, levers, CSS).record(RIG_EARTH)!
    const weather = regimeWeather(record, 'overcast')
    const clock = fieldClock(weather, frame.time)
    const toSun = frame.served.sun
    const eye = frame.served.eye
    const radius = Math.hypot(eye.x, eye.y, eye.z)
    const up: Vec3 = { x: eye.x / radius, y: eye.y / radius, z: eye.z / radius }
    const datum = radius - EYE
    const marched = (height: number, direction: 1 | -1): number => {
      const start = add(eye, up, height - EYE)
      // Far enough to leave a level 1.5 km thick at this sun, whichever way.
      const reach = (low.top - low.base) / Math.sin(radians(SUN_UP))
      const step = reach / STEPS
      let depth = 0
      for (let k = 0; k < STEPS; k += 1) {
        const at = add(start, toSun, direction * (k + 0.5) * step)
        const over = Math.hypot(at.x, at.y, at.z) - datum
        if (over > low.top || over < low.base) break
        const cell = cloudFieldAt(weather, clock, toSun, at, 0)
        depth += cell.fraction * cell.sigma * step
      }
      return depth
    }
    const lines: string[] = []
    let tapped = 0
    let skipped = 0
    heights.forEach((height, i) => {
      const [depth, whole, taken, left] = out.subarray(4 * i, 4 * i + 4)
      const want = marched(height, 1)
      const wantWhole = want + marched(height, -1)
      lines.push(
        `  ${Math.round(height)} m: to the sun ${depth!.toFixed(2)} against ${want.toFixed(2)}, whole ${whole!.toFixed(2)} against ${wantWhole.toFixed(2)}; ${taken} taps read, ${left} skipped`,
      )
      expect(Number.isFinite(depth)).toBe(true)
      expect(whole!).toBeGreaterThanOrEqual(depth! - 1e-3)
      if (left! > 0) skipped += 1
      else tapped += 1
      // A value unset is nothing where the field has depth.
      if (want > 0.5) expect(depth!).toBeGreaterThan(0.5 * want)
      expect(Math.abs(depth! - want)).toBeLessThan(TOLERANCE * want + FLOOR)
      expect(Math.abs(whole! - wantWhole)).toBeLessThan(
        TOLERANCE * wantWhole + FLOOR,
      )
    })
    console.info(
      `cloudSourceGrid: the sun's two depths under an overcast, a ${SUN_UP}° sun:\n${lines.join('\n')}`,
    )
    // Both kinds of sample are among them, or the test holds half of it.
    expect(tapped).toBeGreaterThan(0)
    expect(skipped).toBeGreaterThan(0)
    kernel.dispose()
    input.dispose()
    output.dispose()
  }, 300_000)
})
