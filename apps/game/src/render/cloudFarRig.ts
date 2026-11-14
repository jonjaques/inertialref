import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
  type UniformNode,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  clamp,
  dot,
  float,
  Fn,
  globalId,
  If,
  normalize,
  select,
  storage,
  uint,
  uniform,
  vec2,
} from 'three/tsl'
import { cubeFaceOf, type ScenarioId } from '@inertialref/rendering'
import { Quaternion as Q, type Vec3, Vec } from '@inertialref/spatial'
import { airEye, depthUnits, skyClass } from './cloudCompositeAir.ts'
import { CLOUD_DEPTH_CLAMP_KM } from './cloudDepth.ts'
import type { CloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import {
  cloudRay,
  shellCrossing,
  traceScreen,
  viewDirection,
} from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { cloudMarch, type CloudMarchDeps, marchFar } from './cloudMarch.ts'
import type { CloudBudget, CloudRay } from './cloudNodes.ts'
import { SUN_GRID_SIZE } from './cloudSunGrid.ts'
import {
  RIG_EARTH_RADIUS,
  RIG_FOV,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import type { GpuSession } from './gpuHarness.ts'

/*
 * What the far march's two instruments share (`cloudFarCompare.gpu.test.ts`,
 * `cloudHandover.gpu.test.ts`): the cases and where each stands, the kernel
 * that marches 256 × 144 rays one way and writes a record a ray, and the
 * score of one march against another by pitch bin.
 *
 * **The field is the system's own** (`createCloudField`): the maps, the
 * clipmap, the media, the far atlas and the sun grid the fine march takes
 * its sun from, baked by frames built as the sensor builds them, over Earth
 * with its own air and its sky table. Each case stands so the middle ray
 * meets the case's cloud at the handover distance of the footprint,
 * `t_far = farFootprint/pixelAngle`: 55 km at 400 m, 110 km at 800 m, the
 * default, and 220 km at 1,600 m, through the rig's 60° lens over 144 rows.
 *
 * **The fine march is the trace's own.** It takes the ray's draw as the
 * trace does: the first step's share, the dither of its switch to a level's
 * statistics, and the sky's light from the body's sky table. A fine march
 * built without them draws a placeholder sky and switches every ray at half
 * a cell, which no pixel of the product draws.
 *
 * **Errors are relative, and by pitch bin.** The pitch is the ray's angle to
 * the local horizontal where it hands over, from the local vertical there:
 * what a crossing's slant is, which the eye's own pitch is not 100 km out.
 * A bin's figure is its rays' mean in one march over its rays' mean in the
 * other, less one, so the anvil's 8 × 10⁻⁵ of light and a cumulus field's
 * 2 × 10⁻³ are read in one unit. The bins are fixed here, before any run.
 */

/** The picture the trace's extent is a quarter of, each way. */
export const FAR_RIG_CSS = { width: 1024, height: 576 } as const
export const FAR_RIG_WIDTH = FAR_RIG_CSS.width / 4
export const FAR_RIG_HEIGHT = FAR_RIG_CSS.height / 4
const RAYS = FAR_RIG_WIDTH * FAR_RIG_HEIGHT
/** Radians a trace row subtends: `cloudFrame`'s `pixelAngle` for this extent and lens. */
export const FAR_RIG_PIXEL_ANGLE = (RIG_FOV * Math.PI) / 180 / FAR_RIG_HEIGHT
export const FAR_FOOTPRINTS = [400, 800, 1600] as const
export type FarFootprint = (typeof FAR_FOOTPRINTS)[number]

/** The shipped budget, and one no ray of these cases spends: the most any took is 1,051 (the anvil). */
export const SHIPPED_STEPS = DEFAULT_CLOUD_LEVERS.maxSteps
export const LONG_STEPS = 8192
/** Render meters: past every span, so a ray ends at the union or the datum. */
export const NO_SCENE = 1e12
/** `cloudMarch`'s exit: under it no far march follows a fine one. */
const EXIT_TRANSMITTANCE = 0.01
/** The share of a cell past which a read with no dither answers statistics: `4^(½ − 1)`, the medium's own default. */
const FAR_SWITCH_SHARE = 0.5

/**
 * The pitch bins' edges, degrees from the local horizontal at the handover
 * point, either side of it. Six bins: two under 5°, where a chord crosses
 * tens of cells, and one past 40°, where it crosses one.
 */
export const PITCH_EDGES = [0, 2, 5, 10, 20, 40, 90] as const
/** Rays a pitch bin needs to hold a figure, and a far texel's footprint to count in its spread. */
export const PITCH_BIN_RAYS = 256
const TEXEL_RAYS = 16
/** Row 11: a bin's radiance is counted where its opacity is over this. */
export const RADIANCE_OPACITY = 0.02
/** Row 11's bars: transmittance and radiance, of the fine march's; and the floor of the first reading. */
export const ROW_11 = {
  transmittance: 0.1,
  radiance: 0.15,
  floor: 0.01,
} as const
/** The fine march's mean transmittance under which a bin's ceiling holds a difference (`PitchBin.held`). */
export const HELD_FLOOR = 0.1
/** A ray's moments are compared where both marches are this opaque. */
const MOMENT_OPACITY = 0.1
/** A far tile's interior texels a face edge (`cloudFarAtlas.ts`). */
const FAR_TILE = 256
/** Frames at a stance before the bakes may owe nothing, and the most it is given. */
const SETTLE_MIN = 50
const SETTLE_MAX = 400

const R = RIG_EARTH_RADIUS
const degrees = (d: number): number => (d * Math.PI) / 180

export interface FarCase {
  readonly id: string
  readonly scenario: ScenarioId
  /** Meters over the datum the middle ray meets at t_far. */
  readonly content: number
  /** Below the horizon, degrees; or the eye's height, when the case names one instead. */
  readonly pitch?: number
  readonly eye?: Readonly<Record<FarFootprint, number>>
  /** At the content point: degrees over its horizon, and round from the view's heading. */
  readonly sun: { readonly elevation: number; readonly azimuth: number }
  /** Whether a form may be chosen on it: the rest are judged once. */
  readonly tuned: boolean
}

const HIGH_SUN = { elevation: 40, azimuth: 120 } as const

export const FAR_CASES: readonly FarCase[] = [
  {
    id: 'broken cumulus',
    scenario: 'broken-horizon',
    content: 1550,
    pitch: 30,
    sun: HIGH_SUN,
    tuned: true,
  },
  {
    id: 'fair cumulus',
    scenario: 'fair-cumulus',
    content: 1700,
    pitch: 30,
    sun: HIGH_SUN,
    tuned: true,
  },
  {
    id: 'cirrus over cumulus',
    scenario: 'cirrus-over-cumulus',
    content: 1700,
    pitch: 30,
    sun: HIGH_SUN,
    tuned: false,
  },
  {
    id: 'anvil',
    scenario: 'anvil',
    content: 8000,
    pitch: 30,
    sun: HIGH_SUN,
    tuned: false,
  },
  {
    id: 'overcast',
    scenario: 'overcast',
    content: 650,
    pitch: 30,
    sun: HIGH_SUN,
    tuned: false,
  },
  {
    // From just over broken cumulus toward a sun 2° up, the rays crossing
    // the layer at under 2°: chords across many far texels.
    id: 'grazing at sunset',
    scenario: 'broken-horizon',
    content: 1550,
    eye: { 400: 2400, 800: 3000, 1600: 4000 },
    sun: { elevation: 2, azimuth: 0 },
    tuned: false,
  },
]

/** The stance that puts a case's middle ray at its content, `t` meters out, float64. */
export function farStance(
  c: FarCase,
  footprint: FarFootprint,
): {
  readonly stance: RigStance
  readonly eye: number
  readonly pitch: number
} {
  const t = footprint / FAR_RIG_PIXEL_ANGLE
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

/**
 * Which statistics each march reads of each level the frame serves, where a
 * trace texel spans `footprint`: the far bake, which reads the medium at
 * `bake` with no dither and so switches at half a cell, and the fine march,
 * whose rays switch at `cell·4^(d − 1)` for a dither `d` drawn evenly, so
 * the share of its rays that still read the resolved field is the share of
 * dithers past `1 + log₄(footprint/cell)`. The cell is the frame's own, the
 * one the medium's switch reads.
 */
export function farReads(
  frame: CloudFrame,
  footprint: number,
  bake: number,
): readonly {
  readonly level: number
  readonly genera: readonly [string, string]
  readonly cellMeters: number
  readonly far: 'resolved' | 'statistics'
  readonly fineResolvedShare: number
}[] {
  const { levels, climate } = frame.served
  return levels.flatMap((level, k) =>
    level.top > level.base
      ? [
          {
            level: k,
            genera: climate.genera[k]!,
            cellMeters: level.cell,
            far:
              bake > level.cell * FAR_SWITCH_SHARE
                ? ('statistics' as const)
                : ('resolved' as const),
            fineResolvedShare:
              1 -
              Math.min(
                1,
                Math.max(0, 1 + Math.log(footprint / level.cell) / Math.log(4)),
              ),
          },
        ]
      : [],
  )
}

/* ------------------------------------------------------------------------- */
/* The kernel                                                                 */
/* ------------------------------------------------------------------------- */

/** The record a kernel writes a ray. */
const SLOTS = 20
const SLOT = {
  light: 0,
  transmittance: 3,
  air: 4,
  mean: 7,
  deviation: 8,
  valid: 9,
  /** The handover point's direction from the body's center. */
  handover: 10,
  floored: 13,
  steps: 14,
  /** The ray's sine to the local horizontal at the handover point. */
  pitch: 15,
  /** 1 where the far march ran: the fine march reached its stop over 1%. */
  handed: 16,
} as const

export interface Marched {
  readonly light: Node<'vec3'>
  readonly air: Node<'vec3'>
  readonly transmittance: Node<'float'>
  readonly mean: Node<'float'>
  readonly deviation: Node<'float'>
  readonly steps: Node<'float'>
  readonly floored: Node<'float'>
  readonly handed: Node<'float'>
}

/** One way to march a ray: its draw is the trace's (`CloudJitterNodes.draw`). */
export type FarVariant = (
  ray: CloudRay,
  draw: Node<'vec4'>,
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
 * The fine march as the trace draws it, from t₀ to its stop: the whole ray
 * where `trace.farDistance` is past every span. `handover` is ξ, where in
 * the band the ray stops; absent, the band's near edge.
 */
const fineOf = (
  field: CloudField,
  ray: CloudRay,
  draw: Node<'vec4'>,
  sky: Node<'bool'>,
  handover?: Node<'float'>,
) =>
  cloudMarch(ray, draw.x, sky, marchDeps(field), null, {
    dither: draw.y,
    skyTable: true,
    ...(handover === undefined ? {} : { handover }),
  })

/** The fine march over whatever span the uniforms give it. */
export const fineVariant =
  (field: CloudField): FarVariant =>
  (ray, draw, sky) => {
    const fine = fineOf(field, ray, draw, sky)
    return {
      light: fine.light,
      air: fine.air,
      transmittance: fine.transmittance,
      mean: fine.reproject,
      deviation: fine.deviation,
      steps: fine.steps,
      floored: fine.exhausted,
      handed: float(0),
    }
  }

/** The far march from t₀, alone. */
export const farVariant =
  (field: CloudField): FarVariant =>
  (ray, _draw, sky) => {
    const far = field.farAtlas.far(ray, ray.start, field.uniforms.served, sky)
    return {
      light: far.light,
      air: far.air,
      transmittance: far.transmittance,
      mean: far.depthMean,
      deviation: far.depthDeviation,
      steps: float(0),
      floored: float(0),
      handed: float(1),
    }
  }

/**
 * The two marches a pixel in the band draws: the fine march to
 * `farDistance·band^ξ`, then the far march from there, composed as the
 * trace composes them (`marchFar`).
 */
export const handoverVariant =
  (field: CloudField, xi: Node<'float'>): FarVariant =>
  (ray, draw, sky) => {
    const far = field.farAtlas.far
    const fine = fineOf(field, ray, draw, sky, xi)
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
      floored: fine.exhausted,
      handed: select(
        fine.stopped
          .lessThan(ray.end)
          .and(fine.transmittance.greaterThanEqual(EXIT_TRANSMITTANCE)),
        float(1),
        float(0),
      ),
    }
  }

/**
 * One kernel over the 256 × 144 rays, writing each ray's record. The rig
 * draws no ground, so the class reads the datum's distance where the ray
 * meets it, as a scene with the ground at the datum would hand the trace.
 * `handover` is the distance the ray's pitch and far texel are taken at.
 */
function rayKernel(
  field: CloudField,
  buffer: StorageBufferAttribute,
  handover: UniformNode<'float', number>,
  variant: FarVariant,
): ComputeNode {
  const { uniforms } = field
  const body = uniforms.served
  const into = storage(buffer, 'float', RAYS * SLOTS)
  return Fn(() => {
    const texel = globalId.xy as unknown as Node<'uvec2'>
    If(
      texel.x
        .lessThan(uint(FAR_RIG_WIDTH))
        .and(texel.y.lessThan(uint(FAR_RIG_HEIGHT))),
      () => {
        const base = texel.y
          .mul(uint(FAR_RIG_WIDTH))
          .add(texel.x)
          .mul(uint(SLOTS))
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
          const draw = field.jitter.draw(texel, uniforms.trace.frame).toVar()
          const marched = variant(traced, draw, sky)
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
          put(SLOT.floored, marched.floored)
          put(SLOT.steps, marched.steps)
          put(SLOT.handed, marched.handed)
          // Where the ray hands over: the far field takes it from here on,
          // so the far texel this point falls in is the one it stands for,
          // and the ray's slant through a level is its pitch here.
          const point = body.up
            .mul(body.datumRadius.add(body.eye))
            .add(direction.mul(clamp(handover, traced.start, traced.end)))
          const toward = normalize(point)
          put(SLOT.handover, toward.x)
          put(SLOT.handover + 1, toward.y)
          put(SLOT.handover + 2, toward.z)
          put(SLOT.pitch, dot(direction, toward))
        })
      },
    )
  })()
    .computeKernel([8, 8, 1])
    .setName('cloud far instrument')
}

/* ------------------------------------------------------------------------- */
/* The score                                                                  */
/* ------------------------------------------------------------------------- */

const luma = (data: Float32Array, ray: number, at: number): number => {
  const k = ray * SLOTS + at
  return 0.2126 * data[k]! + 0.7152 * data[k + 1]! + 0.0722 * data[k + 2]!
}
const slot = (data: Float32Array, ray: number, which: number): number =>
  data[ray * SLOTS + which]!
const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
const rms = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)

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

/** A ray's pitch bin, by the size of its angle to the local horizontal where it hands over. */
function pitchBinOf(data: Float32Array, ray: number): number {
  const sine = Math.min(1, Math.abs(slot(data, ray, SLOT.pitch)))
  const angle = (Math.asin(sine) * 180) / Math.PI
  for (let k = 1; k < PITCH_EDGES.length - 1; k += 1)
    if (angle < PITCH_EDGES[k]!) return k - 1
  return PITCH_EDGES.length - 2
}

export const pitchBinName = (k: number): string =>
  `${PITCH_EDGES[k]}° to ${PITCH_EDGES[k + 1]}°`

/** One pitch bin of one march against the fine march. */
export interface PitchBin {
  readonly bin: string
  readonly rays: number
  /** Far texels the bin's rays hand over in that hold enough of them to count. */
  readonly texels: number
  /** The bin's rays' means: the fine march's, then the march scored. */
  readonly fine: { readonly transmittance: number; readonly light: number }
  readonly scored: { readonly transmittance: number; readonly light: number }
  /** The scored mean over the fine one, less one: null under `PITCH_BIN_RAYS`. */
  readonly transmittance: number | null
  /** The same of the cloud's light, where the fine march's opacity is over 0.02. */
  readonly radiance: number | null
  /**
   * The transmittance's miss as a ceiling holds it: the two means'
   * difference over the fine march's, or over `HELD_FLOOR` where the fine
   * march passes less. Under an opaque deck the plain figure is a ratio of
   * two numbers near nothing, which another adapter's rounding moves by
   * factors; this is the plain figure's size wherever the fine march
   * passes a tenth, and a difference under it.
   */
  readonly held: number | null
  /** Row 11's two readings of the transmittance, and its reading of the radiance. */
  readonly inside: {
    readonly transmittance: boolean | null
    readonly transmittancePlain: boolean | null
    readonly radiance: boolean | null
  }
  /** RMS over the bin's far texels of each one's miss, over the bin's fine mean. */
  readonly texelSpread: {
    readonly transmittance: number
    readonly radiance: number
  }
}

export interface FarScore {
  /** Rays scored: the valid ones, or of those the ones the far march ran on. */
  readonly rays: number
  readonly meanLight: number
  readonly meanTransmittance: number
  readonly bins: readonly PitchBin[]
  /** Bins inside row 11's bars, of the bins that hold a figure. */
  readonly count: {
    readonly transmittance: readonly [number, number]
    readonly transmittancePlain: readonly [number, number]
    readonly radiance: readonly [number, number]
  }
  readonly moments: {
    readonly rays: number
    readonly meanKm: number
    readonly deviationKm: number
  }
}

/**
 * One march's records against the fine march's, by pitch bin. `handedOnly`
 * keeps the rays the far march ran on: the others are the fine march's own
 * in both records, and would stand in every bin as rays that agree.
 */
export function scoreFar(
  fine: Float32Array,
  scored: Float32Array,
  handedOnly: boolean,
): FarScore {
  const rays: number[] = []
  for (let ray = 0; ray < RAYS; ray += 1) {
    if (slot(scored, ray, SLOT.valid) < 0.5) continue
    if (handedOnly && slot(scored, ray, SLOT.handed) < 0.5) continue
    rays.push(ray)
  }
  const through = (data: Float32Array, of: readonly number[]): number =>
    mean(of.map((r) => slot(data, r, SLOT.transmittance)))
  const light = (data: Float32Array, of: readonly number[]): number =>
    mean(of.map((r) => luma(data, r, SLOT.light)))
  const bins = PITCH_EDGES.slice(0, -1).map((_, k): PitchBin => {
    const held = rays.filter((r) => pitchBinOf(scored, r) === k)
    const fineT = through(fine, held)
    const fineL = light(fine, held)
    const scoredT = through(scored, held)
    const scoredL = light(scored, held)
    const counted = held.length >= PITCH_BIN_RAYS
    const lit = counted && 1 - fineT > RADIANCE_OPACITY && fineL > 0
    const transmittance = counted && fineT > 0 ? scoredT / fineT - 1 : null
    const radiance = lit ? scoredL / fineL - 1 : null
    const texels = new Map<string, number[]>()
    for (const r of held) {
      const key = farTexelOf(scored, r)
      const of = texels.get(key)
      if (of === undefined) texels.set(key, [r])
      else of.push(r)
    }
    const whole = [...texels.values()].filter((of) => of.length >= TEXEL_RAYS)
    return {
      bin: pitchBinName(k),
      rays: held.length,
      texels: whole.length,
      fine: { transmittance: fineT, light: fineL },
      scored: { transmittance: scoredT, light: scoredL },
      transmittance,
      radiance,
      held: counted
        ? Math.abs(scoredT - fineT) / Math.max(fineT, HELD_FLOOR)
        : null,
      inside: {
        transmittance:
          transmittance === null
            ? null
            : Math.abs(scoredT - fineT) <=
              Math.max(ROW_11.transmittance * fineT, ROW_11.floor),
        transmittancePlain:
          transmittance === null
            ? null
            : Math.abs(transmittance) <= ROW_11.transmittance,
        radiance:
          radiance === null ? null : Math.abs(radiance) <= ROW_11.radiance,
      },
      texelSpread: {
        transmittance:
          rms(whole.map((of) => through(scored, of) - through(fine, of))) /
          Math.max(fineT, 1e-12),
        radiance:
          rms(whole.map((of) => light(scored, of) - light(fine, of))) /
          Math.max(fineL, 1e-12),
      },
    }
  })
  const tally = (
    read: (bin: PitchBin) => boolean | null,
  ): readonly [number, number] => {
    const figures = bins.map(read).filter((inside) => inside !== null)
    return [figures.filter(Boolean).length, figures.length]
  }
  const opaque = rays.filter(
    (r) =>
      1 - slot(fine, r, SLOT.transmittance) > MOMENT_OPACITY &&
      1 - slot(scored, r, SLOT.transmittance) > MOMENT_OPACITY,
  )
  return {
    rays: rays.length,
    meanLight: light(scored, rays),
    meanTransmittance: through(scored, rays),
    bins,
    count: {
      transmittance: tally((bin) => bin.inside.transmittance),
      transmittancePlain: tally((bin) => bin.inside.transmittancePlain),
      radiance: tally((bin) => bin.inside.radiance),
    },
    moments: {
      rays: opaque.length,
      meanKm:
        rms(
          opaque.map(
            (r) => slot(scored, r, SLOT.mean) - slot(fine, r, SLOT.mean),
          ),
        ) / 1000,
      deviationKm:
        rms(
          opaque.map(
            (r) =>
              slot(scored, r, SLOT.deviation) - slot(fine, r, SLOT.deviation),
          ),
        ) / 1000,
    },
  }
}

/** A march's own numbers over its valid rays: what a reference is recorded by. */
export function marchSummary(data: Float32Array): {
  readonly rays: number
  readonly meanLight: number
  readonly meanTransmittance: number
  readonly mostSteps: number
  readonly flooredRays: number
} {
  let rays = 0
  let lightSum = 0
  let throughSum = 0
  let mostSteps = 0
  let flooredRays = 0
  for (let ray = 0; ray < RAYS; ray += 1) {
    if (slot(data, ray, SLOT.valid) < 0.5) continue
    rays += 1
    lightSum += luma(data, ray, SLOT.light)
    throughSum += slot(data, ray, SLOT.transmittance)
    mostSteps = Math.max(mostSteps, slot(data, ray, SLOT.steps))
    flooredRays += slot(data, ray, SLOT.floored)
  }
  const n = Math.max(rays, 1)
  return {
    rays,
    meanLight: lightSum / n,
    meanTransmittance: throughSum / n,
    mostSteps,
    flooredRays,
  }
}

/* ------------------------------------------------------------------------- */
/* The session                                                                */
/* ------------------------------------------------------------------------- */

/** What a dispatch may set of the march's own numbers, for that dispatch alone. */
export interface FarOverrides {
  readonly farDistance?: number
  readonly maxSteps?: number
}

export interface FarSession {
  /** The distance the kernels take a ray's pitch and far texel at, meters. */
  readonly handover: UniformNode<'float', number>
  /** A kernel over the rays for one way to march them. */
  kernel(variant: FarVariant): ComputeNode
  /** Frames at a case's stance until every bake owes nothing. */
  settle(c: FarCase, footprint: FarFootprint): CloudFrame
  /** One kernel's records. */
  dispatch(kernel: ComputeNode, overrides?: FarOverrides): Promise<Float32Array>
  dispose(): void
}

/** The instruments' session over one field: its kernels share one buffer, read after each dispatch. */
export function farSession(gpu: GpuSession, field: CloudField): FarSession {
  const renderer: WebGPURenderer = gpu.renderer
  const buffer = new StorageBufferAttribute(new Float32Array(RAYS * SLOTS), 1)
  const handover: UniformNode<'float', number> = uniform(0)
  const kernels: ComputeNode[] = []
  let previous: CloudFrame | null = null
  return {
    handover,
    kernel(variant) {
      const kernel = rayKernel(field, buffer, handover, variant)
      kernels.push(kernel)
      return kernel
    },
    settle(c, footprint) {
      const { stance } = farStance(c, footprint)
      const levers: CloudLevers = {
        ...DEFAULT_CLOUD_LEVERS,
        on: true,
        weather: c.scenario,
        farFootprint: footprint,
      }
      let frame: CloudFrame | null = null
      for (let n = 0; n < SETTLE_MAX; n += 1) {
        frame = cloudFrame(
          rigFrameInputs(stance, levers, FAR_RIG_CSS),
          previous,
        )
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
    },
    async dispatch(kernel, overrides = {}) {
      const trace = field.uniforms.trace
      const was = {
        farDistance: trace.farDistance.value,
        maxSteps: trace.maxSteps.value,
      }
      trace.farDistance.value = overrides.farDistance ?? was.farDistance
      trace.maxSteps.value = overrides.maxSteps ?? was.maxSteps
      renderer.compute(kernel, [
        Math.ceil(FAR_RIG_WIDTH / 8),
        Math.ceil(FAR_RIG_HEIGHT / 8),
        1,
      ])
      const data = new Float32Array(await gpu.readBuffer(buffer))
      trace.farDistance.value = was.farDistance
      trace.maxSteps.value = was.maxSteps
      return data
    },
    dispose() {
      for (const kernel of kernels) kernel.dispose()
      buffer.dispose()
    },
  }
}
