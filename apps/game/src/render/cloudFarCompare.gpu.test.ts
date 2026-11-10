import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
  type Texture,
  type UniformNode,
} from 'three/webgpu'
import {
  clamp,
  float,
  Fn,
  globalId,
  If,
  instanceIndex,
  int,
  ivec2,
  normalize,
  select,
  storage,
  textureLoad,
  uint,
  uniform,
  vec2,
} from 'three/tsl'
import { cubeFaceOf, type ScenarioId } from '@inertialref/rendering'
import { Quaternion as Q, type Vec3, Vec } from '@inertialref/spatial'
import { airEye, depthUnits, skyClass } from './cloudCompositeAir.ts'
import { CLOUD_DEPTH_CLAMP_KM } from './cloudDepth.ts'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import {
  cloudRay,
  shellCrossing,
  traceScreen,
  viewDirection,
} from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { cloudMarch, type CloudMarchDeps, marchFar } from './cloudMarch.ts'
import { traceJitter } from './cloudJitter.ts'
import type { CloudBudget, CloudRay } from './cloudNodes.ts'
import { SUN_GRID_SIZE } from './cloudSunGrid.ts'
import {
  RIG_EARTH_RADIUS,
  RIG_FOV,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The far atlas against the fine march on the real field (§8.6): an
 * instrument, opt-in by IR_CLOUD_MEASURE=1, that writes
 * `.data/clouds/farCompare.json` and asserts only that every figure is
 * finite and sane. Its headline is the worst footprint-averaged radiance
 * error over the four cases at farFootprint 400 m (§8.7).
 *
 * The field is the system's own (`createCloudField`): the maps, the
 * clipmap, the media, the far atlas and the sun grid the fine march takes
 * its sun from, baked by frames built as the sensor builds them, over Earth
 * with its own air. 256 × 144 rays, the trace's extent for a 1024 × 576
 * picture through the rig's 60° lens, each case placed so the middle ray
 * meets the case's cloud at the handover distance of the footprint:
 * t_far = farFootprint / pixelAngle: 55 km at 400 m, 110 km at 800 m, the
 * default, and 220 km at 1,600 m.
 *
 * Per case and footprint, every ray is marched three ways:
 *
 * - the fine march over the whole ray, the reference: the handover pushed
 *   past the span (farFootprint → ∞) and a budget no ray exhausts;
 * - the far atlas from t₀, alone;
 * - the handover by an exhausted budget: the fine march at a budget most
 *   rays run out of, then the atlas from where it stopped, as the trace
 *   composes them (`marchFar`).
 *
 * The headline averages over each far texel's footprint: rays are binned by
 * the far texel their handover point falls in, and the bins' means
 * compared, because per-pixel error at a fixed handover measures the
 * atlas's resolution rather than its representation. The per-pixel error is recorded beside it, for phase
 * 1's cross-fade, with the depth moments' and the blocked air's.
 *
 * The radiance is the cloud's own light, L_c's luminance per unit sun
 * irradiance; the transmittance is T_c. Errors are relative to the
 * reference's mean light over the bins that hold cloud, and absolute in T.
 * The reference takes its sun from the sun grid, as the fine march does,
 * and past the grid's window (25.6 km either side of the eye) from the taps
 * alone, so at every footprint, 55 to 220 km out, its light is an upper
 * bound: every case's content lies past the window.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/farCompare.json'

const CSS = { width: 1024, height: 576 } as const
const WIDTH = CSS.width / 4
const HEIGHT = CSS.height / 4
const RAYS = WIDTH * HEIGHT
/** Radians a trace row subtends: cloudFrame's pixelAngle for this extent and lens. */
const PIXEL_ANGLE = (RIG_FOV * Math.PI) / 180 / HEIGHT
const FOOTPRINTS = [400, 800, 1600] as const
/** Steps no ray of these cases reaches in the reference: the most any took is 1,051 (the anvil). */
const REFERENCE_STEPS = 8192
/** A budget most rays through cloud run out of, so the far march takes the rest. */
const EXHAUSTED_STEPS = 24
/** Render meters: past every span, so a ray ends at the union or the datum. */
const NO_SCENE = 1e12
/** Rays a bin needs to count, and the opacity its rays must average to hold cloud. */
const BIN_RAYS = 16
const BIN_OPACITY = 0.02
/** A ray's moments are compared where both marches are this opaque. */
const MOMENT_OPACITY = 0.1
/** A far tile's interior texels a face edge, and its gutter (`cloudFarAtlas.ts`). */
const FAR_TILE = 256
const FAR_SPAN = FAR_TILE + 2
/** Whole far cycles and the maps' rebake, before the bakes owe nothing. */
const SETTLE_MIN = 50
const SETTLE_MAX = 240
const FAR_PROBE_ARC = 1_800_000

/** The record each kernel writes a ray: light, T, blocked air, the moments, and the handover's direction. */
const SLOTS = 16
const SLOT = {
  light: 0,
  transmittance: 3,
  air: 4,
  mean: 7,
  deviation: 8,
  valid: 9,
  handover: 10,
  exhausted: 13,
  steps: 14,
} as const

const R = RIG_EARTH_RADIUS
const degrees = (d: number): number => (d * Math.PI) / 180

interface Case {
  readonly id: string
  readonly scenario: ScenarioId
  /** Meters over the datum the middle ray meets at t_far. */
  readonly content: number
  /** Below the horizon, degrees; or the eye's height, when the case names one instead. */
  readonly pitch?: number
  readonly eye?: Readonly<Record<(typeof FOOTPRINTS)[number], number>>
  /** At the content point: degrees over its horizon, and round from the view's heading. */
  readonly sun: { readonly elevation: number; readonly azimuth: number }
}

const CASES: readonly Case[] = [
  {
    id: 'cirrus over cumulus',
    scenario: 'cirrus-over-cumulus',
    content: 1700,
    pitch: 30,
    sun: { elevation: 40, azimuth: 120 },
  },
  {
    id: 'broken cumulus',
    scenario: 'broken-horizon',
    content: 1550,
    pitch: 30,
    sun: { elevation: 40, azimuth: 120 },
  },
  {
    id: 'anvil',
    scenario: 'anvil',
    content: 8000,
    pitch: 30,
    sun: { elevation: 40, azimuth: 120 },
  },
  {
    // From just over broken cumulus toward a sun 2° up, the rays crossing
    // the layer at under 2°: chords across many far texels.
    id: 'grazing at sunset',
    scenario: 'broken-horizon',
    content: 1550,
    eye: { 400: 2400, 800: 3000, 1600: 4000 },
    sun: { elevation: 2, azimuth: 0 },
  },
]

/** The stance that puts a case's middle ray at its content, `t` meters out, float64. */
function stanceOf(
  c: Case,
  footprint: (typeof FOOTPRINTS)[number],
): {
  readonly stance: RigStance
  readonly eye: number
  readonly pitch: number
} {
  const t = footprint / PIXEL_ANGLE
  const rc = R + c.content
  let re: number
  let sine: number
  if (c.eye !== undefined) {
    re = R + c.eye[footprint]
    sine = (re * re + t * t - rc * rc) / (2 * re * t)
  } else {
    sine = Math.sin(degrees(c.pitch!))
    const cosine = Math.cos(degrees(c.pitch!))
    re = t * sine + Math.sqrt(rc * rc - t * t * cosine * cosine)
  }
  const pitch = Math.asin(sine)
  // Looking down `pitch` along −Z; Earth's center straight below the eye.
  const forward: Vec3 = { x: 0, y: -Math.sin(pitch), z: -Math.cos(pitch) }
  const content = Vec.add({ x: 0, y: re, z: 0 }, Vec.scale(forward, t))
  const up = Vec.normalize(content)
  const ahead = Vec.normalize(
    Vec.sub(forward, Vec.scale(up, Vec.dot(forward, up))),
  )
  const side = Vec.normalize(Vec.cross(up, ahead))
  const { elevation, azimuth } = c.sun
  const horizontal = Vec.add(
    Vec.scale(ahead, Math.cos(degrees(azimuth))),
    Vec.scale(side, Math.sin(degrees(azimuth))),
  )
  const sun = Vec.add(
    Vec.scale(up, Math.sin(degrees(elevation))),
    Vec.scale(horizontal, Math.cos(degrees(elevation))),
  )
  return {
    stance: {
      eye: re - R,
      looking: Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, -pitch),
      sun,
      air: true,
    },
    eye: re - R,
    pitch: (pitch * 180) / Math.PI,
  }
}

/* ------------------------------------------------------------------------- */
/* The kernels                                                                */
/* ------------------------------------------------------------------------- */

interface Marched {
  readonly light: Node<'vec3'>
  readonly air: Node<'vec3'>
  readonly transmittance: Node<'float'>
  readonly mean: Node<'float'>
  readonly deviation: Node<'float'>
  readonly steps: Node<'float'>
  readonly exhausted: Node<'float'>
}

type Variant = (
  ray: CloudRay,
  jitter: Node<'float'>,
  sky: Node<'bool'>,
) => Marched

function marchDeps(field: CloudField): CloudMarchDeps {
  return {
    uniforms: field.uniforms,
    phase: field.phase,
    medium: field.medium,
    sun: field.sun,
    sky: field.sky,
    source: field.source,
    jitter: field.jitter,
  }
}

/**
 * One kernel over the 256 × 144 rays, writing each ray's record. The rig
 * draws no ground, so the class reads the datum's distance where the ray
 * meets it, as a scene with the ground at the datum would hand the trace.
 */
function rayKernel(
  field: CloudField,
  buffer: StorageBufferAttribute,
  handover: UniformNode<'float', number>,
  variant: Variant,
): ComputeNode {
  const { uniforms } = field
  const body = uniforms.served
  const into = storage(buffer, 'float', RAYS * SLOTS)
  return Fn(() => {
    const texel = globalId.xy as unknown as Node<'uvec2'>
    If(
      texel.x.lessThan(uint(WIDTH)).and(texel.y.lessThan(uint(HEIGHT))),
      () => {
        const base = texel.y.mul(uint(WIDTH)).add(texel.x).mul(uint(SLOTS))
        const put = (slot: number, value: Node<'float'>): void => {
          into.element(base.add(uint(slot))).assign(value)
        }
        for (let k = 0; k < SLOTS; k += 1) put(k, float(0))
        const screen = traceScreen(texel, vec2(0), uniforms.trace.size)
        const direction = viewDirection(uniforms.camera, screen).toVar()
        const ray = cloudRay(direction, body, float(NO_SCENE))
        const ground = shellCrossing(body, ray.mu, body.eye, float(0))
        const depthKm = select(
          ground.hit.and(ground.near.greaterThan(0)),
          ground.near.mul(body.compression).mul(1e-3),
          float(CLOUD_DEPTH_CLAMP_KM),
        )
        const sky = skyClass(
          body.air,
          airEye(body),
          direction,
          depthKm,
          depthUnits(body),
        ).toVar()
        const traced: CloudRay = {
          direction,
          mu: ray.mu.toVar(),
          nu: ray.nu.toVar(),
          start: ray.start.toVar(),
          end: ray.end.toVar(),
        }
        If(ray.hit, () => {
          const marched = variant(
            traced,
            traceJitter(texel, uniforms.trace.frame).x,
            sky,
          )
          put(SLOT.light, marched.light.x)
          put(SLOT.light + 1, marched.light.y)
          put(SLOT.light + 2, marched.light.z)
          put(SLOT.transmittance, marched.transmittance)
          put(SLOT.air, marched.air.x)
          put(SLOT.air + 1, marched.air.y)
          put(SLOT.air + 2, marched.air.z)
          put(SLOT.mean, marched.mean)
          put(SLOT.deviation, marched.deviation)
          put(SLOT.valid, float(1))
          put(SLOT.exhausted, marched.exhausted)
          put(SLOT.steps, marched.steps)
          // Where the ray hands over: the far field takes it from here on, so
          // the far texel this point falls in is the one it stands for.
          const point = body.up
            .mul(body.datumRadius.add(body.eye))
            .add(direction.mul(clamp(handover, traced.start, traced.end)))
          const toward = normalize(point)
          put(SLOT.handover, toward.x)
          put(SLOT.handover + 1, toward.y)
          put(SLOT.handover + 2, toward.z)
        })
      },
    )
  })()
    .computeKernel([8, 8, 1])
    .setName('cloud far compare')
}

const fineVariant =
  (field: CloudField): Variant =>
  (ray, jitter, sky) => {
    const fine = cloudMarch(ray, jitter, sky, marchDeps(field), null)
    return {
      light: fine.light,
      air: fine.air,
      transmittance: fine.transmittance,
      mean: fine.reproject,
      deviation: fine.deviation,
      steps: fine.steps,
      exhausted: fine.exhausted,
    }
  }

const farVariant =
  (field: CloudField): Variant =>
  (ray, _jitter, sky) => {
    const far = field.farAtlas.far(ray, ray.start, field.uniforms.served, sky)
    return {
      light: far.light,
      air: far.air,
      transmittance: far.transmittance,
      mean: far.depthMean,
      deviation: far.depthDeviation,
      steps: float(0),
      exhausted: float(0),
    }
  }

const handoverVariant =
  (field: CloudField): Variant =>
  (ray, jitter, sky) => {
    const far = field.farAtlas.far
    const fine = cloudMarch(ray, jitter, sky, marchDeps(field), null)
    const both = marchFar(
      fine,
      ray,
      (from) => far(ray, from, field.uniforms.served, sky),
      null,
    )
    return {
      light: both.light,
      air: both.air,
      transmittance: both.transmittance,
      mean: both.reproject,
      deviation: both.deviation,
      steps: fine.steps,
      exhausted: fine.exhausted,
    }
  }

/* ------------------------------------------------------------------------- */
/* The comparison                                                             */
/* ------------------------------------------------------------------------- */

const luma = (data: Float32Array, ray: number): number => {
  const at = ray * SLOTS + SLOT.light
  return 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!
}
const blocked = (data: Float32Array, ray: number): number => {
  const at = ray * SLOTS + SLOT.air
  return 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!
}
const slot = (data: Float32Array, ray: number, which: number): number =>
  data[ray * SLOTS + which]!

/** The far texel a ray's handover point falls in: face, column and row of its tile. */
function farTexelOf(data: Float32Array, ray: number): string {
  const at = ray * SLOTS + SLOT.handover
  const { face, a, b } = cubeFaceOf({
    x: data[at]!,
    y: data[at + 1]!,
    z: data[at + 2]!,
  })
  const index = (w: number) =>
    Math.min(FAR_TILE - 1, Math.floor(((w + 1) / 2) * FAR_TILE))
  return `${face}:${index(a)}:${index(b)}`
}

const rms = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)
const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length

interface Scored {
  /** The march's own means over every ray, beside the reference's. */
  readonly meanLight: number
  readonly meanTransmittance: number
  readonly footprint: {
    readonly radiance: number
    readonly radianceWorst: number
    readonly transmittance: number
    readonly transmittanceWorst: number
    readonly blocked: number
  }
  readonly pixel: { readonly radiance: number; readonly transmittance: number }
  readonly moments: {
    readonly rays: number
    readonly meanKm: number
    readonly deviationKm: number
  }
}

/** One march's record against the reference's, over the reference's bins. */
function score(
  reference: Float32Array,
  other: Float32Array,
  bins: ReadonlyMap<string, readonly number[]>,
): Scored {
  const cloudy = [...bins.values()].filter(
    (rays) =>
      rays.length >= BIN_RAYS &&
      Math.max(
        mean(rays.map((r) => 1 - slot(reference, r, SLOT.transmittance))),
        mean(rays.map((r) => 1 - slot(other, r, SLOT.transmittance))),
      ) > BIN_OPACITY,
  )
  const light = (data: Float32Array, rays: readonly number[]) =>
    mean(rays.map((r) => luma(data, r)))
  const through = (data: Float32Array, rays: readonly number[]) =>
    mean(rays.map((r) => slot(data, r, SLOT.transmittance)))
  const air = (data: Float32Array, rays: readonly number[]) =>
    mean(rays.map((r) => blocked(data, r)))
  const scale = Math.max(
    mean(cloudy.map((rays) => light(reference, rays))),
    1e-12,
  )
  const airScale = Math.max(
    mean(cloudy.map((rays) => Math.abs(air(reference, rays)))),
    1e-12,
  )
  const lightMiss = cloudy.map(
    (rays) => light(other, rays) - light(reference, rays),
  )
  const throughMiss = cloudy.map(
    (rays) => through(other, rays) - through(reference, rays),
  )
  const airMiss = cloudy.map((rays) => air(other, rays) - air(reference, rays))
  const valid = [...bins.values()].flat()
  const pixelScale = Math.max(mean(valid.map((r) => luma(reference, r))), 1e-12)
  const opaque = valid.filter(
    (r) =>
      1 - slot(reference, r, SLOT.transmittance) > MOMENT_OPACITY &&
      1 - slot(other, r, SLOT.transmittance) > MOMENT_OPACITY,
  )
  return {
    meanLight: mean(valid.map((r) => luma(other, r))),
    meanTransmittance: mean(
      valid.map((r) => slot(other, r, SLOT.transmittance)),
    ),
    footprint: {
      radiance: rms(lightMiss) / scale,
      radianceWorst: Math.max(0, ...lightMiss.map(Math.abs)) / scale,
      transmittance: rms(throughMiss),
      transmittanceWorst: Math.max(0, ...throughMiss.map(Math.abs)),
      blocked: rms(airMiss) / airScale,
    },
    pixel: {
      radiance:
        rms(valid.map((r) => luma(other, r) - luma(reference, r))) / pixelScale,
      transmittance: rms(
        valid.map(
          (r) =>
            slot(other, r, SLOT.transmittance) -
            slot(reference, r, SLOT.transmittance),
        ),
      ),
    },
    moments: {
      rays: opaque.length,
      meanKm:
        rms(
          opaque.map(
            (r) => slot(other, r, SLOT.mean) - slot(reference, r, SLOT.mean),
          ),
        ) / 1000,
      deviationKm:
        rms(
          opaque.map(
            (r) =>
              slot(other, r, SLOT.deviation) -
              slot(reference, r, SLOT.deviation),
          ),
        ) / 1000,
    },
  }
}

/* ------------------------------------------------------------------------- */
/* The run                                                                    */
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

/** The atlas texel at a body-fixed direction, layer 0, by `textureLoad`. */
async function atlasTexel(
  atlas: Texture,
  direction: Vec3,
): Promise<readonly [number, number, number, number]> {
  const { face, a, b } = cubeFaceOf(direction)
  const index = (w: number) =>
    Math.min(FAR_TILE - 1, Math.floor(((w + 1) / 2) * FAR_TILE))
  const x = face * FAR_SPAN + 1 + index(a)
  const y = 1 + index(b)
  const out = new StorageBufferAttribute(new Float32Array(4), 1)
  const into = storage(out, 'float', 4)
  const kernel = Fn(() => {
    If(instanceIndex.equal(uint(0)), () => {
      const read = textureLoad(atlas, ivec2(int(x), int(y)))
      into.element(uint(0)).assign(read.x)
      into.element(uint(1)).assign(read.y)
      into.element(uint(2)).assign(read.z)
      into.element(uint(3)).assign(read.w)
    })
  })().compute(1)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  kernel.dispose()
  out.dispose()
  return [values[0]!, values[1]!, values[2]!, values[3]!]
}

describe.skipIf(!MEASURE)('the far field against the fine march', () => {
  it('scores the atlas over each far texel’s footprint on the real field, and writes the figures', async () => {
    const renderer = gpu.renderer
    const buffer = new StorageBufferAttribute(new Float32Array(RAYS * SLOTS), 1)
    const handover = uniform(0)
    const kernels = {
      fine: rayKernel(field, buffer, handover, fineVariant(field)),
      atlas: rayKernel(field, buffer, handover, farVariant(field)),
      atlasHandover: rayKernel(field, buffer, handover, handoverVariant(field)),
    }
    let previous: CloudFrame | null = null
    /** Frames at a stance until every bake owes nothing, past two far cycles. */
    const settle = (stance: RigStance, levers: CloudLevers): CloudFrame => {
      let frame: CloudFrame | null = null
      for (let n = 0; n < SETTLE_MAX; n += 1) {
        frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
        if (frame === null) throw new Error('no frame: nothing served')
        previous = frame
        const budget: CloudBudget = {
          slices: 8,
          tiles: 1,
          jump: frame.jump,
          sunSlices: SUN_GRID_SIZE[2],
        }
        field.write(frame)
        field.render(renderer, frame, budget)
        if (n >= SETTLE_MIN && field.bakes.every((bake) => !bake.pending))
          return frame
      }
      throw new Error(`the bakes still owe work after ${SETTLE_MAX} frames`)
    }
    /** One kernel's records, with the march's own numbers overridden for it. */
    const dispatch = async (
      kernel: ComputeNode,
      overrides: { farDistance?: number; maxSteps?: number },
    ): Promise<Float32Array> => {
      const trace = field.uniforms.trace
      const was = {
        farDistance: trace.farDistance.value,
        maxSteps: trace.maxSteps.value,
      }
      trace.farDistance.value = overrides.farDistance ?? was.farDistance
      trace.maxSteps.value = overrides.maxSteps ?? was.maxSteps
      renderer.compute(kernel, [Math.ceil(WIDTH / 8), Math.ceil(HEIGHT / 8), 1])
      const data = new Float32Array(await gpu.readBuffer(buffer))
      trace.farDistance.value = was.farDistance
      trace.maxSteps.value = was.maxSteps
      return data
    }

    const results: unknown[] = []
    for (const c of CASES)
      for (const footprint of FOOTPRINTS) {
        const { stance, eye, pitch } = stanceOf(c, footprint)
        const tFar = footprint / PIXEL_ANGLE
        handover.value = tFar
        const levers: CloudLevers = {
          ...DEFAULT_CLOUD_LEVERS,
          on: true,
          weather: c.scenario,
          farFootprint: footprint,
        }
        const frame = settle(stance, levers)
        expect(frame.extents.trace).toEqual({ width: WIDTH, height: HEIGHT })
        expect(frame.camera.pixelAngle).toBeCloseTo(PIXEL_ANGLE, 9)
        const reference = await dispatch(kernels.fine, {
          farDistance: NO_SCENE,
          maxSteps: REFERENCE_STEPS,
        })
        const atlas = await dispatch(kernels.atlas, {})
        const atlasHandover = await dispatch(kernels.atlasHandover, {
          maxSteps: EXHAUSTED_STEPS,
        })
        // The far texel 1,800 km from the eye along the view's heading.
        const arc = FAR_PROBE_ARC / R
        const probe = await atlasTexel(field.farAtlas.textures()[0]!, {
          x: 0,
          y: Math.cos(arc),
          z: -Math.sin(arc),
        })

        const bins = new Map<string, number[]>()
        let referenceSteps = 0
        let referenceExhausted = 0
        for (let ray = 0; ray < RAYS; ray += 1) {
          if (slot(reference, ray, SLOT.valid) < 0.5) continue
          const key = farTexelOf(reference, ray)
          const held = bins.get(key)
          if (held === undefined) bins.set(key, [ray])
          else held.push(ray)
          referenceSteps = Math.max(
            referenceSteps,
            slot(reference, ray, SLOT.steps),
          )
          referenceExhausted += slot(reference, ray, SLOT.exhausted)
        }
        const valid = [...bins.values()].flat()
        const exhaustedShare =
          mean(valid.map((r) => slot(atlasHandover, r, SLOT.exhausted))) || 0
        results.push({
          case: c.id,
          weather: c.scenario,
          footprintMeters: footprint,
          tFarKm: tFar / 1000,
          eyeMeters: eye,
          pitchDegrees: -pitch,
          sun: c.sun,
          rays: valid.length,
          bins: bins.size,
          cloudyBins: [...bins.values()].filter(
            (rays) =>
              rays.length >= BIN_RAYS &&
              mean(
                rays.map((r) => 1 - slot(reference, r, SLOT.transmittance)),
              ) > BIN_OPACITY,
          ).length,
          reference: {
            meanLight: mean(valid.map((r) => luma(reference, r))),
            meanTransmittance: mean(
              valid.map((r) => slot(reference, r, SLOT.transmittance)),
            ),
            mostSteps: referenceSteps,
            exhaustedRays: referenceExhausted,
          },
          atlas: score(reference, atlas, bins),
          handover: {
            budget: EXHAUSTED_STEPS,
            exhaustedShare,
            atlas: score(reference, atlasHandover, bins),
          },
          farTexel1800km: { fraction: probe[0], logTau: probe[1] },
        })
      }

    // Instruments, not gates: every figure finite and inside a bound past
    // which the instrument, not the field, is what broke.
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
      case: string
      reference: { exhaustedRays: number }
      cloudyBins: number
      farTexel1800km: { fraction: number }
    }[]) {
      // The reference reaches every ray's end, and every case holds cloud.
      expect(row.reference.exhaustedRays, row.case).toBe(0)
      expect(row.cloudyBins, row.case).toBeGreaterThan(0)
    }
    // Broken cumulus is uniform cover: a far texel 1,800 km out holds cloud.
    const broken = results.find(
      (row) => (row as { case: string }).case === 'broken cumulus',
    ) as { farTexel1800km: { fraction: number } }
    expect(broken.farTexel1800km.fraction).toBeGreaterThan(0)

    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          note: 'cloudFarCompare.gpu.test.ts: the far atlas against the fine march over the whole ray, on the real field (§8.6)',
          body: 'Earth',
          trace: { width: WIDTH, height: HEIGHT, pixelAngle: PIXEL_ANGLE },
          units: {
            radiance:
              'relative to the reference mean light over the cloudy bins',
            transmittance: 'absolute',
            moments: 'km, RMS over rays both marches find over 10% opaque',
          },
          cases: results,
        },
        null,
        2,
      )}\n`,
    )
  }, 600_000)
})
