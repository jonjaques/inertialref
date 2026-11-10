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
  type WeatherScenario,
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
import { SUN_GRID_SIZE } from './cloudSunGrid.ts'
import {
  LOOKING_UP,
  RIG_EARTH_RADIUS,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import landed from './cloudSunAccuracy.landed.json' with { type: 'json' }
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sun grid's optical depth against a march through the field (§5.5):
 * T_cloud's error at in-cloud samples, at lightTaps 2 and 4, in seven
 * regimes under three suns.
 *
 * **The population.** A regime is scored at five places, drawn by a seed
 * between 60° S and 60° N among the directions where every layer holds at
 * least its mean cover: a pole is a special place, where a layer's texture
 * stands still under the rigid turn, and under a blob or a band a place
 * drawn blind may hold no cloud for kilometers. The samples are columns
 * 937.5 m apart over a disc 22.5 km about the eye, eight heights through
 * each layer: the light reads the grid a kilometer sunward of a sample, and
 * that point is inside the grid's weight, which ends 24 km out along its
 * axes, whichever way the disc is turned to them. Every sample the field
 * holds cloud at, and whose sun ray clears the ground, is scored: the
 * light's T_cloud, its taps and then the grid's optical depth beyond them,
 * against exp(−∫σ·f ds) by 256 steps of the same field medium through each
 * stretch of the ray inside the union, f the medium's fraction, as the grid
 * stores σ·f. A sun over the horizon has one stretch, to the union's top. A
 * sun under it has two where the ray leaves through the base: to that exit,
 * and from where the ray comes back up through the base to the top. Every
 * sample is resolved, its footprint 0.
 *
 * **The suns** are phase 0's two, 37.5° and 5°, and the dusk cornerstone's,
 * 1.5° under the horizon. `dusk-altocumulus`, the cornerstone's own regime,
 * holds cloud only where the sun is low and is scored under the third alone.
 *
 * **A case is a regime, a sun and a place,** and its figures are its RMS,
 * its bias, its worst sample and its 99th percentile, with the same four by
 * ring: within 4 km of the eye, 4 to 6.4 km, and beyond. A point sample at a
 * cloud's edge takes the far end of the transmittance range against a cell
 * of 400 m, so the worst sample is near one wherever a field is broken; the
 * percentile is the tail a bound can hold.
 *
 * **Every figure is held to the landed one.** `cloudSunAccuracy.landed.json`
 * is this instrument's own document, written by a run under
 * IR_CLOUD_MEASURE=1 on the Mac mini (Mac18,5, Apple M6) and committed. A
 * case's RMS, its bias, its worst sample and its percentile may each pass
 * the landed value by a tenth and no more, or stand under a thousandth of
 * the sun. One case runs in every
 * `pnpm test:gpu`; every case runs under the flag, which also writes
 * `.data/clouds/sunAccuracy.json`. The bound is this adapter's: it is
 * asserted where the adapter offers timestamps, which is how the suite
 * tells a workstation from CI's hosted device, and there the figures are
 * still taken and held finite.
 *
 * The bounds tighten and are never loosened. A change that moves a figure
 * replaces the landed document in the commit that moves it, so the diff
 * shows the old figure and the new.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/sunAccuracy.json'
/** The adapter the landed figures were taken on is a workstation's: it offers timestamps. */
const WORKSTATION = await adapterOffers('timestamp-query')
/** A figure may pass its landed value by a tenth (phase 1 design §6.3). */
const SLACK = 1.1
/**
 * A figure under a thousandth of the sun is held to that and not to its
 * landed value: under the horizon most cases read a transmittance of nothing
 * as nothing, their figures are 10⁻⁶, and a tenth over one of those is the
 * last bit of a float. A thousandth is a quarter of a display step.
 */
const FLOOR = 1e-3

const CSS = { width: 1024, height: 576 } as const
/** Degrees over the eye's horizon: phase 0's two, and the dusk cornerstone's. */
const SUNS = [37.5, 5, -1.5] as const
const POPULATION: readonly {
  readonly scenario: ScenarioId
  readonly suns: readonly number[]
}[] = [
  { scenario: 'fair-cumulus', suns: SUNS },
  { scenario: 'two-decks', suns: SUNS },
  { scenario: 'anvil', suns: SUNS },
  { scenario: 'overcast', suns: SUNS },
  { scenario: 'cirrus-over-cumulus', suns: SUNS },
  { scenario: 'altocumulus', suns: SUNS },
  // Its cover ends where the local sun clears the horizon: clear at noon.
  { scenario: 'dusk-altocumulus', suns: [-1.5] },
]
/**
 * The cases every run of the suite takes, each at its regime's first place.
 *
 * Cirrus over cumulus is the one regime whose figures follow the grid's
 * depth: its cirrus is thin, so a fifth of the depth lost moves the bias
 * under the 5° sun from 0.0012 to 0.0138 at four taps and from 0.0021 to
 * 0.0149 at two. Every other regime's cloud is thick enough that 0.8 of its
 * depth still passes nothing, and its figures do not move in the fourth
 * decimal. Two decks under the high sun are what follows where a shadow
 * falls: the lower deck is lit or not by the upper one's gaps.
 */
const ALWAYS: typeof POPULATION = [
  { scenario: 'cirrus-over-cumulus', suns: SUNS },
  { scenario: 'two-decks', suns: [37.5] },
]

const TAPS = [2, 4] as const
const REFERENCE_STEPS = 256
const PLACES = 5
/** Degrees: the places stand between this latitude south and north. */
const LATITUDE = 60
const PLACE_SEED = 0x5eed
/** Columns across the disc's diameter. */
const ACROSS = 48
/** Meters: the disc's radius about the eye. */
const REACH = 22_500
/** Meters from the eye: the rings' outer edges. Phase 0's reach, the 50 m level's, the disc's. */
const RINGS = [4000, 6400, REACH] as const
const HEIGHTS_A_LAYER = 8
const EYE = 2
const POINTS = ACROSS * ACROSS * HEIGHTS_A_LAYER * 3
/** The rig's instant: the blobs' period index the CPU's cover is read at. */
const TIME = 50_000
/**
 * Frames the maps take to hold a new weather or a new sun whole: the cube's
 * six faces, then one refresh of the clipmap's six levels at an eighth of a
 * level a frame.
 */
const MAPS_FRAMES = 64
/** Frames a settle rests with nothing owed: a refresh of the volume and of the grid from it, where they refresh at rest. */
const REST_FRAMES = 24
const SETTLE_MAX = 400

const R = RIG_EARTH_RADIUS
const radians = (d: number): number => (d * Math.PI) / 180

/** A seeded uniform draw, so a population is the same on every run. */
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

/** The regimes in the order the rendering package lists them: a regime's place seed is its index. */
const WEATHER_SCENARIO_ORDER = Object.keys(WEATHER_SCENARIOS)

/**
 * The body-fixed directions a regime is scored over: uniform over the
 * sphere between the two latitudes, kept where every layer holds at least
 * its mean cover. The cover is the pattern's, with no terminator: a regime
 * that ends against the sun is placed by its pattern and lit by the stance.
 */
function placesOf(scenario: ScenarioId): Vec3[] {
  const { terminator: _, ...pattern } = WEATHER_SCENARIOS[scenario]
  const s: WeatherScenario = pattern
  const next = draws(PLACE_SEED + WEATHER_SCENARIO_ORDER.indexOf(scenario))
  const band = Math.sin(radians(LATITUDE))
  const found: Vec3[] = []
  for (let n = 0; n < 100_000 && found.length < PLACES; n += 1) {
    const y = (2 * next() - 1) * band
    const longitude = 2 * Math.PI * next()
    const ring = Math.sqrt(1 - y * y)
    const d = {
      x: Math.cos(longitude) * ring,
      y,
      z: Math.sin(longitude) * ring,
    }
    const held = s.layers.every(
      (layer, k) => scenarioCoverage(s, k, d, TIME) >= layer.coverage - 1e-9,
    )
    if (held) found.push(d)
  }
  if (found.length < PLACES)
    throw new Error(`${scenario}: fewer than ${PLACES} places hold its cover`)
  return found
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

interface Lattice {
  /** Eye-relative and body-fixed, four floats a sample, the fourth unused. */
  readonly offsets: Float32Array
  /** Meters along the ground from the eye to each sample's column. */
  readonly ground: Float64Array
  /** Each sample from the body's center, body-fixed, float64: what a ground test reads. */
  readonly fromCenter: Float64Array
  readonly count: number
}

/**
 * The samples, float64 then float32: a column `d` meters out along the
 * ground stands on the sphere, its height's point (R + h)·(sin φ, cos φ)
 * from the center at φ = d/R, less the eye's.
 */
function lattice(scenario: ScenarioId, turn: Quat): Lattice {
  const offsets = new Float32Array(POINTS * 4)
  const ground = new Float64Array(POINTS)
  const fromCenter = new Float64Array(POINTS * 3)
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
        if (d > REACH) continue
        const phi = d / R
        const out = d === 0 ? 0 : ((R + h) * Math.sin(phi)) / d
        const point: Vec3 = {
          x: x * out,
          y: (R + h) * Math.cos(phi),
          z: z * out,
        }
        const fixed = Q.rotate(back, { ...point, y: point.y - (R + EYE) })
        const center = Q.rotate(back, point)
        offsets.set([fixed.x, fixed.y, fixed.z, 0], 4 * n)
        fromCenter.set([center.x, center.y, center.z], 3 * n)
        ground[n] = d
        n += 1
      }
  return { offsets, ground, fromCenter, count: n }
}

/** Whether the ray from a point toward the sun meets the datum: the planet's own shadow. */
function grounded(at: Float64Array, k: number, sun: Vec3): boolean {
  const x = at[3 * k]!
  const y = at[3 * k + 1]!
  const z = at[3 * k + 2]!
  const along = x * sun.x + y * sun.y + z * sun.z
  return along < 0 && x * x + y * y + z * z - along * along < R * R
}

/* ------------------------------------------------------------------------- */

let gpu: GpuSession
let field: CloudField

beforeAll(async () => {
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

interface Scored {
  readonly samples: number
  readonly rms: number
  /** Mean signed error: positive where the grid passes more sun. */
  readonly bias: number
  readonly worst: number
  /** The 99th percentile of the error's size. */
  readonly p99: number
}

interface Case {
  readonly scenario: string
  readonly sunDegrees: number
  /** The place's index among the regime's five. */
  readonly place: number
  readonly latitude: number
  readonly longitude: number
  /** Samples in the lattice, those the field holds cloud at, and those of them the planet shadows. */
  readonly samples: number
  readonly inCloud: number
  readonly shadowed: number
  readonly meanReference: number
  /** By tap count: every scored sample, then each ring's. */
  readonly grid: Readonly<Record<string, Scored>>
  readonly rings: Readonly<Record<string, readonly Scored[]>>
}

function score(miss: readonly number[]): Scored {
  const n = Math.max(miss.length, 1)
  const sizes = miss.map(Math.abs).sort((a, b) => a - b)
  return {
    samples: miss.length,
    rms: Math.sqrt(miss.reduce((s, v) => s + v * v, 0) / n),
    bias: miss.reduce((s, v) => s + v, 0) / n,
    worst: sizes[sizes.length - 1] ?? 0,
    p99:
      sizes[Math.min(sizes.length - 1, Math.floor(0.99 * sizes.length))] ?? 0,
  }
}

/** Every case of one regime under one sun, as one population: the gate's row. */
function pooled(cases: readonly Case[], taps: number): Scored {
  const n = cases.reduce((s, one) => s + one.grid[taps]!.samples, 0)
  const sum = (of: (scored: Scored) => number): number =>
    cases.reduce(
      (s, one) => s + of(one.grid[taps]!) * one.grid[taps]!.samples,
      0,
    )
  return {
    samples: n,
    rms: Math.sqrt(sum((scored) => scored.rms ** 2) / Math.max(n, 1)),
    bias: sum((scored) => scored.bias) / Math.max(n, 1),
    worst: Math.max(0, ...cases.map((one) => one.grid[taps]!.worst)),
    // A percentile does not pool from its parts: the largest of the places'.
    p99: Math.max(0, ...cases.map((one) => one.grid[taps]!.p99)),
  }
}

const same = (a: Case, b: Case): boolean =>
  a.scenario === b.scenario &&
  a.sunDegrees === b.sunDegrees &&
  a.place === b.place

/** The landed figures of a case, or a failure: a case with no bound is a case that cannot fail. */
function landedCase(found: Case): Case {
  const pinned = (landed.cases as unknown as readonly Case[]).find((one) =>
    same(one, found),
  )
  if (pinned === undefined)
    throw new Error(
      `no landed figures for ${found.scenario} at ${found.sunDegrees}°, place ${found.place}`,
    )
  return pinned
}

/** Hold a case's every figure to its landed one, at both tap counts. */
function hold(found: Case): void {
  const what = `${found.scenario} at ${found.sunDegrees}°, place ${found.place}`
  const pinned = landedCase(found)
  // The population itself: a case that lost its cloud scores nothing.
  expect(found.inCloud, what).toBe(pinned.inCloud)
  for (const taps of TAPS) {
    const now = found.grid[taps]!
    const then = pinned.grid[taps]!
    const figures = [
      ['rms', now.rms, then.rms],
      ['bias', Math.abs(now.bias), Math.abs(then.bias)],
      ['worst', now.worst, then.worst],
      ['p99', now.p99, then.p99],
    ] as const
    for (const [name, figure] of figures)
      expect(Number.isFinite(figure), `${what}, ${taps} taps: ${name}`).toBe(
        true,
      )
    if (!WORKSTATION) continue
    for (const [name, figure, bound] of figures)
      expect(figure, `${what}, ${taps} taps: ${name}`).toBeLessThanOrEqual(
        Math.max(bound * SLACK, FLOOR),
      )
  }
}

describe('the sun’s optical depth against the field', () => {
  /** Score the grid at both tap counts on the real field: each regime at its places, under each of its suns. */
  async function measure(
    population: typeof POPULATION,
    places: number,
  ): Promise<Case[]> {
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
    // exp(−∫σ·f ds) by 256 steps of the field through each stretch of the
    // sun's ray inside the union.
    const reference = pointKernel((sample) => {
      const { sun } = body
      const top = shellCrossingFrom(
        body,
        sample.offset,
        sun,
        body.boundariesHigh.y,
      )
      const base = shellCrossingFrom(
        body,
        sample.offset,
        sun,
        body.boundaries.x,
      )
      const end = select(top.hit, max(top.far, 0), float(0)).toVar()
      // Heading down to a base it has yet to cross: out through it, and back.
      const dips = sample.sunMu
        .lessThan(0)
        .and(base.hit)
        .and(base.far.greaterThan(0))
      const out = select(dips, max(base.near, 0), end).toVar()
      const back = select(dips, base.far, end).toVar()
      const tau = float(0).toVar()
      const stretch = (from: Node<'float'>, to: Node<'float'>): void => {
        const step = max(to.sub(from), 0).div(REFERENCE_STEPS).toVar()
        Loop(REFERENCE_STEPS, ({ i }: { i: Node<'int'> }) => {
          const point = sample.offset.add(
            sun.mul(from.add(float(i).add(0.5).mul(step))),
          )
          const medium = field.medium(sampleOf(point), body)
          tau.addAssign(medium.sigma.mul(medium.fraction).mul(step))
        })
      }
      stretch(float(0), out)
      stretch(back, end)
      return exp(tau.negate())
    })
    const grid = pointKernel(
      (sample) => field.sun(sample, field.medium(sample, body), body).cloud,
    )

    let previous: CloudFrame | null = null
    const frameAt = (
      stance: RigStance,
      levers: CloudLevers,
      rebuild = false,
    ): CloudFrame => {
      const frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
      if (frame === null) throw new Error('no frame: nothing served')
      previous = frame
      const budget: CloudBudget = {
        slices: 8,
        tiles: 1,
        jump: frame.jump || rebuild,
        sunSlices: SUN_GRID_SIZE[2],
      }
      field.write(frame)
      field.render(renderer, frame, budget)
      return frame
    }
    /*
     * A case's field is its own, whatever case ran before it. The maps owe
     * nothing from the frame their levels are redrawn, while those levels
     * still hold texels drawn from cube faces of the last weather or the
     * last sun, and a slice of the volume baked from them holds that field
     * until it is next redrawn. So the maps are given the frames they take
     * to hold this case whole, and then every cache is rebuilt from them.
     */
    const settle = (stance: RigStance, levers: CloudLevers): void => {
      for (let n = 0; n < MAPS_FRAMES; n += 1) frameAt(stance, levers)
      frameAt(stance, levers, true)
      let rest = 0
      for (let n = 0; n < SETTLE_MAX; n += 1) {
        frameAt(stance, levers)
        rest = field.bakes.some((bake) => bake.pending) ? 0 : rest + 1
        if (rest >= REST_FRAMES) return
      }
      throw new Error(`the bakes still owe work after ${SETTLE_MAX} frames`)
    }
    const read = async (kernel: ComputeNode): Promise<Float32Array> => {
      await gpu.compute(kernel)
      return new Float32Array(await gpu.readBuffer(out))
    }

    const results: Case[] = []
    for (const { scenario, suns } of population) {
      const stood = placesOf(scenario).slice(0, places)
      for (const [index, place] of stood.entries()) {
        const turn = turnOnto(place)
        const points = lattice(scenario, turn)
        ;(offsets.array as Float32Array).set(points.offsets)
        offsets.needsUpdate = true
        count.value = points.count
        for (const elevation of suns) {
          const toward = {
            x: 0,
            y: Math.sin(radians(elevation)),
            z: -Math.cos(radians(elevation)),
          }
          const stance: RigStance = {
            eye: EYE,
            looking: LOOKING_UP,
            turn,
            air: true,
            sun: toward,
          }
          const sun = Q.rotate(Q.conjugate(turn), toward)
          const levers = (lightTaps: (typeof TAPS)[number]): CloudLevers => ({
            ...DEFAULT_CLOUD_LEVERS,
            on: true,
            weather: scenario,
            lightTaps,
          })
          settle(stance, levers(2))
          const truth = await read(reference)
          const inCloud: number[] = []
          for (let k = 0; k < points.count; k += 1)
            if (truth[2 * k]! > 0) inCloud.push(k)
          const lit = inCloud.filter(
            (k) => !grounded(points.fromCenter, k, sun),
          )
          const all: Record<string, Scored> = {}
          const rings: Record<string, Scored[]> = {}
          for (const taps of TAPS) {
            // The taps are a uniform: one frame writes it, and builds nothing.
            frameAt(stance, levers(taps))
            const got = await read(grid)
            const miss = (k: number): number =>
              got[2 * k + 1]! - truth[2 * k + 1]!
            all[taps] = score(lit.map(miss))
            rings[taps] = RINGS.map((edge, ring) => {
              const from = ring === 0 ? 0 : RINGS[ring - 1]!
              return score(
                lit
                  .filter(
                    (k) =>
                      points.ground[k]! >= from && points.ground[k]! < edge,
                  )
                  .map(miss),
              )
            })
          }
          results.push({
            scenario,
            sunDegrees: elevation,
            place: index,
            latitude: (Math.asin(place.y) * 180) / Math.PI,
            longitude: (Math.atan2(place.x, place.z) * 180) / Math.PI,
            samples: points.count,
            inCloud: inCloud.length,
            shadowed: inCloud.length - lit.length,
            meanReference:
              lit.reduce((s, k) => s + truth[2 * k + 1]!, 0) /
              Math.max(lit.length, 1),
            grid: all,
            rings,
          })
        }
      }
    }

    for (const kernel of [reference, grid]) kernel.dispose()
    offsets.dispose()
    out.dispose()
    return results
  }

  it('holds cirrus over cumulus under the three suns, and two decks under the high one, to the landed figures, in every run of the suite', async () => {
    const found = await measure(ALWAYS, 1)
    expect(found.map((one) => [one.scenario, one.sunDegrees])).toEqual(
      ALWAYS.flatMap(({ scenario, suns }) =>
        suns.map((sun) => [scenario, sun]),
      ),
    )
    for (const one of found) hold(one)
  }, 120_000)

  it.skipIf(!MEASURE)(
    'holds every case to its landed figures, and writes them',
    async () => {
      const results = await measure(POPULATION, PLACES)
      // Written before anything is held, so a figure that moved is on disk
      // beside the failure that names it.
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudSunAccuracy.gpu.test.ts: T_cloud through the sun grid against a 256-step march of the field through each stretch of the sun’s ray inside the union, at in-cloud samples the planet does not shadow (phase 1 design §5.5)',
            body: 'Earth',
            eyeMeters: EYE,
            population: {
              placesARegime: PLACES,
              latitudeDegrees: LATITUDE,
              placeSeed: PLACE_SEED,
              columnsAcross: ACROSS,
              reachMeters: REACH,
              ringEdgesMeters: RINGS,
              heightsALayer: HEIGHTS_A_LAYER,
            },
            referenceSteps: REFERENCE_STEPS,
            units: 'transmittance, absolute',
            pooled: POPULATION.flatMap(({ scenario, suns }) =>
              suns.map((sunDegrees) => {
                const cases = results.filter(
                  (one) =>
                    one.scenario === scenario && one.sunDegrees === sunDegrees,
                )
                return {
                  scenario,
                  sunDegrees,
                  grid: Object.fromEntries(
                    TAPS.map((taps) => [taps, pooled(cases, taps)]),
                  ),
                }
              }),
            ),
            cases: results,
          },
          null,
          2,
        )}\n`,
      )
      expect(results).toHaveLength(landed.cases.length)
      for (const found of results) hold(found)
    },
    1_800_000,
  )
})
