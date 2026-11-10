import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
} from 'three/webgpu'
import {
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  length,
  Loop,
  max,
  select,
  storage,
  uint,
  uniform,
} from 'three/tsl'
import {
  type ScenarioId,
  scenarioCoverage,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { altitudeAt, shellCrossingFrom, sunMuAt } from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudBudget, CloudSample } from './cloudNodes.ts'
import { SUN_DEPTH_FRAME_CAP } from './cloudSunGrid.ts'
import {
  LOOKING_UP,
  RIG_EARTH_RADIUS,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sun grid's optical depth against a march through the field (§8.6):
 * an instrument, opt-in by IR_CLOUD_MEASURE=1, that writes
 * `.data/clouds/sunAccuracy.json` and asserts only that every figure is
 * finite and sane. Its headline is T_cloud's RMS error in all five
 * scenarios at both suns, at lightTaps 2 and 4 (§8.7's 3%).
 *
 * The field is the system's own (`createCloudField`), its bakes driven by
 * frames built as the sensor builds them, over Earth turned so the eye, 2 m
 * up, stands where the scenario's cover is thickest: under a blob or a band
 * a fixed place may hold no cloud for kilometers. The samples are a lattice
 * of 24 × 24 columns 4 km either side of the eye, eight heights through
 * each layer, and every one the field holds cloud at is scored: the
 * light's T_cloud — its taps, then the grid's optical depth beyond them —
 * against exp(−∫σ·f ds) by 256 steps of the same field medium to the
 * union's top along the sun, f the medium's fraction, as the grid stores
 * σ·f. Every sample is resolved, its footprint 0.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/sunAccuracy.json'

const CSS = { width: 1024, height: 576 } as const
const SCENARIOS: readonly ScenarioId[] = [
  'fair-cumulus',
  'two-decks',
  'anvil',
  'overcast',
  'cirrus-over-cumulus',
]
/** Degrees over the eye's horizon. */
const SUNS = [37.5, 5] as const
const TAPS = [2, 4] as const
const REFERENCE_STEPS = 256
const ACROSS = 24
/** Meters either side of the eye: inside the grid's window (25.6 km). */
const REACH = 4000
const HEIGHTS_A_LAYER = 8
const EYE = 2
const POINTS = ACROSS * ACROSS * HEIGHTS_A_LAYER * 3
/** The rig's instant: the blobs' period index the CPU's cover is read at. */
const TIME = 50_000
const SETTLE_MIN = 12
const SETTLE_MAX = 240
/** Directions the place is chosen from: a Fibonacci sphere. */
const PLACES = 4096

const R = RIG_EARTH_RADIUS
const radians = (d: number): number => (d * Math.PI) / 180

/** The body-fixed direction where every layer's cover is thickest, its least layer's first. */
function thickest(scenario: ScenarioId): Vec3 {
  const s = WEATHER_SCENARIOS[scenario]
  let best: Vec3 = { x: 0, y: 1, z: 0 }
  let score = -1
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let k = 0; k < PLACES; k += 1) {
    const y = 1 - (2 * (k + 0.5)) / PLACES
    const ring = Math.sqrt(1 - y * y)
    const d = {
      x: Math.cos(golden * k) * ring,
      y,
      z: Math.sin(golden * k) * ring,
    }
    const cover = Math.min(
      ...s.layers.map((_, layer) => scenarioCoverage(s, layer, d, TIME)),
    )
    if (cover > score) {
      score = cover
      best = d
    }
  }
  return best
}

/** The turn that carries a body-fixed direction onto the render's +Y, over which the rig's eye stands. */
function turnOnto(direction: Vec3): Quat {
  const up = { x: 0, y: 1, z: 0 }
  const axis = Vec.cross(direction, up)
  const sine = Vec.length(axis)
  if (sine < 1e-12) return Q.IDENTITY
  return Q.fromAxisAngle(
    Vec.scale(axis, 1 / sine),
    Math.atan2(sine, Vec.dot(direction, up)),
  )
}

/**
 * The lattice, eye-relative and body-fixed, float64 then float32: a column
 * `d` meters out along the ground stands on the sphere, its height's point
 * (R + h)·(sin φ, cos φ) from the center at φ = d/R, less the eye's.
 */
function lattice(scenario: ScenarioId, turn: Quat): Float32Array {
  const into = new Float32Array(POINTS * 4)
  const back = Q.conjugate(turn)
  let n = 0
  const heights = WEATHER_SCENARIOS[scenario].layers.flatMap((layer) =>
    Array.from(
      { length: HEIGHTS_A_LAYER },
      (_, k) =>
        layer.base + ((k + 0.5) / HEIGHTS_A_LAYER) * (layer.top - layer.base),
    ),
  )
  for (const h of heights)
    for (let j = 0; j < ACROSS; j += 1)
      for (let i = 0; i < ACROSS; i += 1) {
        const x = REACH * ((2 * (i + 0.5)) / ACROSS - 1)
        const z = REACH * ((2 * (j + 0.5)) / ACROSS - 1)
        const d = Math.hypot(x, z)
        const phi = d / R
        const out = d === 0 ? 0 : ((R + h) * Math.sin(phi)) / d
        const render: Vec3 = {
          x: x * out,
          y: (R + h) * Math.cos(phi) - (R + EYE),
          z: z * out,
        }
        const fixed = Q.rotate(back, render)
        into.set([fixed.x, fixed.y, fixed.z, 0], 4 * n)
        n += 1
      }
  return into
}

/* ------------------------------------------------------------------------- */

let gpu: GpuSession
let field: CloudField

beforeAll(async () => {
  if (!MEASURE) return
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  if (!MEASURE) return
  field.dispose()
  gpu.dispose()
})

interface Scored {
  readonly rms: number
  readonly worst: number
  /** Mean signed error: positive where the grid passes more sun. */
  readonly bias: number
}

describe.skipIf(!MEASURE)('the sun’s optical depth against the field', () => {
  it('scores the grid at both tap counts on the real field, and writes the figures', async () => {
    const renderer = gpu.renderer
    const offsets = new StorageBufferAttribute(new Float32Array(POINTS * 4), 4)
    const out = new StorageBufferAttribute(new Float32Array(POINTS * 2), 1)
    const count = uniform(0, 'uint')
    const body = field.uniforms.served

    const sampleOf = (offset: Node<'vec3'>): CloudSample => ({
      offset,
      distance: length(offset),
      altitude: altitudeAt(body, offset),
      sunMu: sunMuAt(body, offset),
      footprint: float(0),
    })
    const pointKernel = (
      scored: (sample: CloudSample) => Node<'float'>,
    ): ComputeNode => {
      const from = storage(offsets, 'vec4', POINTS)
      const into = storage(out, 'float', POINTS * 2)
      return Fn(() => {
        If(instanceIndex.lessThan(count), () => {
          const offset = from.element(instanceIndex).xyz.toVar()
          const sample = sampleOf(offset)
          const medium = field.medium(sample, body)
          const at = instanceIndex.mul(uint(2))
          into.element(at).assign(medium.sigma.mul(medium.fraction))
          into.element(at.add(uint(1))).assign(scored(sample))
        })
      })().compute(POINTS)
    }
    // exp(−∫σ·f ds) by 256 steps of the field to the union's top along the sun.
    const reference = pointKernel((sample) => {
      const top = shellCrossingFrom(
        body,
        sample.offset,
        body.sun,
        body.boundariesHigh.y,
      )
      const reach = select(top.hit, max(top.far, 0), float(0))
      const step = reach.div(REFERENCE_STEPS).toVar()
      const tau = float(0).toVar()
      Loop(REFERENCE_STEPS, ({ i }: { i: Node<'int'> }) => {
        const point = sample.offset.add(
          body.sun.mul(float(i).add(0.5).mul(step)),
        )
        const medium = field.medium(sampleOf(point), body)
        tau.addAssign(medium.sigma.mul(medium.fraction).mul(step))
      })
      return exp(tau.negate())
    })
    const grid = pointKernel(
      (sample) => field.sun(sample, field.medium(sample, body), body).cloud,
    )

    let previous: CloudFrame | null = null
    const frameAt = (stance: RigStance, levers: CloudLevers): CloudFrame => {
      const frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
      if (frame === null) throw new Error('no frame: nothing served')
      previous = frame
      const budget: CloudBudget = {
        slices: 8,
        tiles: 1,
        jump: frame.jump,
        sunTexelSteps: SUN_DEPTH_FRAME_CAP,
      }
      field.write(frame)
      field.render(renderer, frame, budget)
      return frame
    }
    const settle = (stance: RigStance, levers: CloudLevers): void => {
      for (let n = 0; n < SETTLE_MAX; n += 1) {
        frameAt(stance, levers)
        if (n >= SETTLE_MIN && field.bakes.every((bake) => !bake.pending))
          return
      }
      throw new Error(`the bakes still owe work after ${SETTLE_MAX} frames`)
    }
    const read = async (kernel: ComputeNode): Promise<Float32Array> => {
      await gpu.compute(kernel)
      return new Float32Array(await gpu.readBuffer(out))
    }

    const results: unknown[] = []
    for (const scenario of SCENARIOS) {
      const place = thickest(scenario)
      const turn = turnOnto(place)
      const points = lattice(scenario, turn)
      ;(offsets.array as Float32Array).set(points)
      offsets.needsUpdate = true
      count.value = points.length / 4
      for (const elevation of SUNS) {
        const stance: RigStance = {
          eye: EYE,
          looking: LOOKING_UP,
          turn,
          air: true,
          sun: {
            x: 0,
            y: Math.sin(radians(elevation)),
            z: -Math.cos(radians(elevation)),
          },
        }
        const levers = (lightTaps: (typeof TAPS)[number]): CloudLevers => ({
          ...DEFAULT_CLOUD_LEVERS,
          on: true,
          scenario,
          lightTaps,
        })
        settle(stance, levers(2))
        const truth = await read(reference)
        const inCloud: number[] = []
        for (let k = 0; k < count.value; k += 1)
          if (truth[2 * k]! > 0) inCloud.push(k)
        const scored: Record<string, Scored> = {}
        for (const taps of TAPS) {
          // The taps are a uniform: one frame writes it, and builds nothing.
          frameAt(stance, levers(taps))
          const got = await read(grid)
          const miss = inCloud.map((k) => got[2 * k + 1]! - truth[2 * k + 1]!)
          scored[taps] = {
            rms: Math.sqrt(
              miss.reduce((s, v) => s + v * v, 0) / Math.max(miss.length, 1),
            ),
            worst: Math.max(0, ...miss.map(Math.abs)),
            bias: miss.reduce((s, v) => s + v, 0) / Math.max(miss.length, 1),
          }
        }
        results.push({
          scenario,
          sunDegrees: elevation,
          place: {
            latitude: (Math.asin(place.y) * 180) / Math.PI,
            longitude: (Math.atan2(place.x, place.z) * 180) / Math.PI,
          },
          samples: count.value,
          inCloud: inCloud.length,
          meanReference:
            inCloud.reduce((s, k) => s + truth[2 * k + 1]!, 0) /
            Math.max(inCloud.length, 1),
          grid: scored,
        })
      }
    }

    const figures = (value: unknown, path: string): [string, number][] =>
      typeof value === 'number'
        ? [[path, value]]
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([key, inner]) =>
              figures(inner, `${path}.${key}`),
            )
          : []
    for (const [path, value] of figures(results, 'results')) {
      expect(Number.isFinite(value), path).toBe(true)
      expect(Math.abs(value), path).toBeLessThan(1e7)
    }
    for (const row of results as {
      scenario: string
      sunDegrees: number
      inCloud: number
      grid: Record<string, Scored>
    }[]) {
      // Every case holds cloud to score, and a transmittance error is at most 1.
      expect(
        row.inCloud,
        `${row.scenario} at ${row.sunDegrees}°`,
      ).toBeGreaterThan(0)
      for (const s of Object.values(row.grid))
        expect(s.worst, row.scenario).toBeLessThanOrEqual(1)
    }

    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          note: 'cloudSunAccuracy.gpu.test.ts: T_cloud through the sun grid against a 256-step march of the field to the union top, at in-cloud samples (§8.6)',
          body: 'Earth',
          eyeMeters: EYE,
          lattice: {
            columns: ACROSS * ACROSS,
            reachMeters: REACH,
            heightsALayer: HEIGHTS_A_LAYER,
          },
          referenceSteps: REFERENCE_STEPS,
          units: 'transmittance, absolute',
          cases: results,
        },
        null,
        2,
      )}\n`,
    )
  }, 600_000)
})
