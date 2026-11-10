import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import {
  aspectRatio,
  CLOUD_ADVECTION_PERIOD,
  type CloudExtents,
  cloudExtents,
  commonPeriod,
  driftOffset,
  type Extent,
  horizonBasis,
  type Lens,
  type LevelUpdate,
  levelFrames,
  periodIndex,
  reducePoint,
  reduceTurns,
  type RenderBody,
  type RenderScene,
  type ShellHeights,
  shellBoundaries,
  shellHeights,
  verticalFov,
  WEATHER_SCENARIOS,
  type WeatherScenario,
  wetWorld,
} from '@inertialref/rendering'
// Types only: this module reaches no Three at runtime, as `bodyUniforms.ts`.
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import { type CloudLevers, cloudResetKey } from './cloudLevers.ts'

/*
 * A frame's cloud state, built on the CPU from what the engine holds inside
 * `sensor.render()`: the body the trace serves, its heights and sun in
 * float64, every eye-anchored cache's frame, the regime and why it reset.
 * Three-free, so every rule a frame depends on is testable in Node; the
 * uniform bundle copies the result into the GPU's numbers mechanically
 * (`cloudUniforms.ts`).
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Everything the frame is built from, read off the engine inside `sensor.render()`. */
export interface CloudFrameInputs {
  readonly levers: CloudLevers
  /** `engine.scene()`. */
  readonly scene: RenderScene
  /** `engine.bodyFor`: `rotationPeriod`, for the sun under a synthetic clock. */
  readonly record: (address: string) => Body | null
  /** `scatteringOf(engine, body)`. */
  readonly scattering: (body: RenderBody) => AtmosphereScattering | null
  /** `engine.snapshot.renderTime` (rule 38). */
  readonly renderTime: number
  /** `engine.visibilityProcessing`: sunlight staged to 1. */
  readonly visibility: boolean
  /** This frame's processing is 'enhanced'. */
  readonly enhanced: boolean
  readonly pictureEpoch: number
  /** The sensor's own. */
  readonly historyKey: string
  /** Render space, unjittered. */
  readonly camera: { readonly position: Vec3; readonly quaternion: Quat }
  readonly lens: Lens
  readonly css: Extent
  readonly render: Extent
  /** This render call's seconds. */
  readonly delta: number
}

export interface CloudBodyFrame {
  readonly address: string
  /** True meters (`RenderBody.trueRadius`). */
  readonly datumRadius: number
  /** `placement.compression`. */
  readonly compression: number
  /** Render axes → body-fixed: the conjugate of `RenderBody.orientation`. */
  readonly toBodyFixed: Quat
  /**
   * Body-fixed true meters: conj(q)·(eye − center)/compression, float64,
   * plus the synthetic path under force 'fly'.
   */
  readonly eye: Vec3
  /**
   * Body-fixed unit, as `TerrainPatches` forms it, turned about the spin axis
   * by the synthetic interval under 'scrub' and 'warp'.
   */
  readonly sun: Vec3
  readonly shells: ShellHeights
  readonly scattering: AtmosphereScattering | null
  readonly limb: number
  readonly limbFalloff: number
  /** keyColor × (visibility ? 1 : sunlight), as the ground's. */
  readonly dayColor: Rgb
  /** `reducePoint(eye, base period)`. */
  readonly noiseOrigin: Vec3
  /** `reducePoint(eye, detail period)`. */
  readonly detailOrigin: Vec3
  /** `driftOffset(wind, time, base period)`. */
  readonly drift: Vec3
  /** Body-fixed m/s at the eye. */
  readonly wind: Vec3
  /** Six levels, 250 m × 2^k. */
  readonly clipmap: LevelUpdate
  /** Levels 50/200/800 m. */
  readonly volume: LevelUpdate
}

export type CloudRegime = 'converging' | 'immediate'
export type CloudResetReason =
  'none' | 'first' | 'key' | 'jump' | 'resize' | 'motion' | 'cut' | 'force'

export interface CloudCameraFrame {
  readonly right: Vec3
  readonly up: Vec3
  /** Body-fixed. */
  readonly forward: Vec3
  readonly halfTan: number
  readonly aspect: number
  /** Radians a trace texel subtends vertically. */
  readonly pixelAngle: number
}

export interface CloudFrame {
  readonly levers: CloudLevers
  readonly scenario: WeatherScenario
  readonly served: CloudBodyFrame
  readonly second: CloudBodyFrame | null
  /** The instant the field is drawn at; synthetic under force. */
  readonly time: number
  /** time − previous.time: the field's own Δt, which the history moves the wind by. */
  readonly frameSeconds: number
  /** `periodIndex(time, scenario.patternPeriod)`. */
  readonly period: readonly [number, number]
  readonly camera: CloudCameraFrame
  readonly previousCamera: CloudCameraFrame | null
  /** Eye − previous eye, body-fixed, float64. */
  readonly translation: Vec3
  readonly enhanced: boolean
  readonly regime: CloudRegime
  readonly reset: CloudResetReason
  /** The field's time moved discontinuously. */
  readonly jump: boolean
  /** +1 a render call: the jitter's and the interleave's. */
  readonly frameIndex: number
  readonly extents: CloudExtents
  /*
   * What the next frame compares against and no other field carries. Each is
   * optional only so a frame written by hand still types; one `cloudFrame`
   * did not build reads as a changed picture and an eye that has flown
   * nowhere.
   */
  /** The picture epoch this frame was built under: a change is a 'key' reset. */
  readonly pictureEpoch?: number
  /** The sensor's history key this frame was built under: a change is a 'key' reset. */
  readonly historyKey?: string
  /**
   * The synthetic path force 'fly' has carried the eye, served body-fixed
   * true meters, accumulated a step a call from the call `fly` was set.
   */
  readonly flown?: Vec3
}

/* ------------------------------------------------------------------------- */
/* Layouts                                                                    */
/* ------------------------------------------------------------------------- */

/** The clipmap's levels, 250 m × 2^k, each a toroidal window of 256² texels (`cloudClipmap.ts`). */
export const CLOUD_CLIPMAP_TEXELS = [250, 500, 1000, 2000, 4000, 8000] as const
export const CLOUD_CLIPMAP_SIZE = 256

/*
 * The volume's layout and the base noise's cells a period, restated from
 * `cloudVolume.ts` and `cloudNoise.ts`: those modules reach Three at runtime
 * and this one does not. `cloudFrame.test.ts` holds each copy to its source.
 */
const VOLUME_TEXELS = [50, 200, 800] as const
const VOLUME_SIZE = 256
const BASE_CELLS = 8

/**
 * The base and detail noises' periods for a scenario, meters: the least that
 * each layer's own period divides, so one reduced origin serves every layer
 * (`commonPeriod`). A base period is eight of a layer's cells. The detail
 * noise tiles once a base cell — its 32 texels hold four detail cells, each a
 * quarter of a base cell, which is where §5.6 fades it in.
 */
export function cloudNoisePeriods(scenario: WeatherScenario): {
  readonly base: number
  readonly detail: number
} {
  const cells = scenario.layers.map((layer) => layer.cellMeters)
  return {
    base: commonPeriod(cells.map((cell) => cell * BASE_CELLS)),
    detail: commonPeriod(cells),
  }
}

/* ------------------------------------------------------------------------- */
/* The rules' thresholds                                                      */
/* ------------------------------------------------------------------------- */

/** A turn of the camera past this between calls is motion the history cannot follow. */
const MOTION_TURN = (20 * Math.PI) / 180
/** Travel past this share of the eye's height over the nearest boundary is motion. */
const MOTION_SHARE = 0.1
/** A step of the field's time off the expected one by more than the larger of these is a jump. */
const JUMP_FLOOR = 1
const JUMP_SCALE = 4
/**
 * Calls a second `fly`'s step is sized for: flySpeed/60 meters a call, so a
 * held loop moves the eye the same amount every frame whatever its rate.
 */
const FLY_RATE = 60

const POLE: Vec3 = { x: 0, y: 1, z: 0 }
const WHITE: Rgb = { r: 1, g: 1, b: 1 }
const NO_LEVELS: LevelUpdate = { frames: [], dirty: [], rebuilt: [] }

/* ------------------------------------------------------------------------- */
/* The bodies                                                                 */
/* ------------------------------------------------------------------------- */

/** True meters from the body's center to `eye`, a render-space point. */
const trueDistance = (body: RenderBody, eye: Vec3): number =>
  Vec.distance(eye, body.placement.position) / body.placement.compression

const larger = (a: RenderBody | null, b: RenderBody): RenderBody =>
  a === null || b.placement.angularRadius > a.placement.angularRadius ? b : a

/**
 * The body the trace serves: the one whose air the eye is inside, else the
 * largest by angular radius among those with weather; `forced` wins.
 *
 * Both of the first two are among the bodies with weather: the eye in a dry
 * world's air serves the largest wet one in its sky, if any. A forced
 * address that is not in the scene serves nothing, so a measurement never
 * silently prices another body.
 */
export function servedBody(
  bodies: readonly RenderBody[],
  eye: Vec3,
  wet: (body: RenderBody) => boolean,
  forced: string | null,
): RenderBody | null {
  if (forced !== null)
    return bodies.find((body) => body.address === forced) ?? null
  let inside: RenderBody | null = null
  let deepest = 1
  let largest: RenderBody | null = null
  for (const body of bodies) {
    if (!wet(body)) continue
    const depth = trueDistance(body, eye) / (body.airTop * body.trueRadius)
    if (depth < deepest) {
      inside = body
      deepest = depth
    }
    largest = larger(largest, body)
  }
  return inside ?? largest
}

/** The second clouded body: forced, or the largest other one with weather; never the served one. */
function secondBody(
  bodies: readonly RenderBody[],
  served: RenderBody,
  wet: (body: RenderBody) => boolean,
  forced: string | null,
): RenderBody | null {
  if (forced !== null) {
    const found = bodies.find((body) => body.address === forced)
    return found === undefined || found.address === served.address
      ? null
      : found
  }
  let largest: RenderBody | null = null
  for (const body of bodies)
    if (body.address !== served.address && wet(body))
      largest = larger(largest, body)
  return largest
}

/**
 * The body-fixed sun as `TerrainPatches` forms it, from the key star's
 * placement to the body's, turned under a synthetic clock.
 *
 * Under 'scrub' and 'warp' the field's instant runs ahead of the world's,
 * and a body turns under a sun that, over a few hours, holds still: so the
 * sun turns the other way about the body's pole (+Y in its own axes, the
 * spin evaluator's axis) by the interval over the sidereal day, the turn
 * reduced first so a long scrub never asks sin and cos of a large angle.
 * The body's own orbital motion over that interval, 0.12° for Earth over
 * 3 h, is left out.
 */
function bodySun(
  body: RenderBody,
  scene: RenderScene,
  time: number,
  renderTime: number,
): Vec3 {
  const key = scene.stars[0]
  const toStar =
    key === undefined
      ? null
      : Vec.sub(key.placement.position, body.placement.position)
  // A body on its star, or a scene with no star, has no sun to face; a zero
  // vector normalized would be NaN across every sample.
  const sun =
    toStar === null || Vec.length(toStar) === 0
      ? POLE
      : Q.rotate(Q.conjugate(body.orientation), Vec.normalize(toStar))
  const period = body.rotationPeriod
  const interval = time - renderTime
  if (interval === 0 || !Number.isFinite(period) || period === 0) return sun
  const turns = reduceTurns(interval, Math.abs(period)) * Math.sign(period)
  return Q.rotate(Q.fromAxisAngle(POLE, -2 * Math.PI * turns), sun)
}

/** What every body's frame is built from this call. */
interface Context {
  readonly inputs: CloudFrameInputs
  readonly scenario: WeatherScenario
  readonly boundaries: readonly number[]
  readonly periods: { readonly base: number; readonly detail: number }
  readonly time: number
  readonly jump: boolean
}

/**
 * One body's frame. The served body carries its caches' frames, scrolled from
 * `caches` or rebuilt from none; a second body has no eye-anchored caches —
 * it is drawn by its far march alone — and gets empty ones.
 */
function bodyFrame(
  context: Context,
  body: RenderBody,
  eye: Vec3,
  caches: CloudBodyFrame | null | 'none',
): CloudBodyFrame {
  const { inputs, scenario, time } = context
  const datumRadius = body.trueRadius
  const sun = bodySun(body, inputs.scene, time, inputs.renderTime)
  const shells = shellHeights(eye, datumRadius, context.boundaries)
  const { east, north } = horizonBasis(eye)
  const wind = Vec.add(
    Vec.scale(east, scenario.wind.east),
    Vec.scale(north, scenario.wind.north),
  )
  const key = inputs.scene.stars[0]
  const color = key?.color ?? WHITE
  const gain = inputs.visibility ? 1 : body.sunlight
  const served = caches !== 'none'
  return {
    address: body.address,
    datumRadius,
    compression: body.placement.compression,
    toBodyFixed: Q.conjugate(body.orientation),
    eye,
    sun,
    shells,
    scattering: inputs.scattering(body),
    limb: body.limb,
    limbFalloff: body.limbFalloff,
    dayColor: { r: color.r * gain, g: color.g * gain, b: color.b * gain },
    noiseOrigin: reducePoint(eye, context.periods.base),
    detailOrigin: reducePoint(eye, context.periods.detail),
    drift: driftOffset(wind, time, context.periods.base),
    wind,
    clipmap: served
      ? levelFrames(
          eye,
          datumRadius,
          CLOUD_CLIPMAP_TEXELS,
          CLOUD_CLIPMAP_SIZE,
          caches?.clipmap.frames ?? null,
        )
      : NO_LEVELS,
    volume: served
      ? levelFrames(
          eye,
          datumRadius,
          VOLUME_TEXELS,
          VOLUME_SIZE,
          caches?.volume.frames ?? null,
        )
      : NO_LEVELS,
  }
}

/** The eye in a body's own axes, true meters from its center, carried `flown` (render axes). */
function eyeOf(body: RenderBody, eye: Vec3, flown: Vec3): Vec3 {
  const fromCenter = Vec.scale(
    Vec.sub(eye, body.placement.position),
    1 / body.placement.compression,
  )
  return Q.rotate(Q.conjugate(body.orientation), Vec.add(fromCenter, flown))
}

/* ------------------------------------------------------------------------- */
/* Time, the camera and the regime                                            */
/* ------------------------------------------------------------------------- */

/**
 * The instant the field is drawn at. The world's under every force but two:
 * 'scrub' steps the field by `scrubSeconds` a call and 'warp' by
 * `delta·warp`, each from the last frame's instant, and neither touches the
 * world's clock. A first frame starts at the world's.
 */
function frameTime(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
): number {
  if (previous === null) return inputs.renderTime
  const { force, scrubSeconds, warp } = inputs.levers
  if (force === 'scrub') return previous.time + scrubSeconds
  if (force === 'warp') return previous.time + inputs.delta * warp
  return inputs.renderTime
}

/**
 * Whether the field's time moved discontinuously: off the step it should
 * have taken by more than a second or four of it, or into the next hour of
 * the drift, where the field starts over 3,600 s of wind away. Always under
 * 'scrub'. The expected step is the call's own `delta`, or `delta·warp`
 * under 'warp'; a held instant changed by the planetarium reads as a jump.
 */
function jumped(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
  time: number,
): boolean {
  if (previous === null) return false
  const { force, warp } = inputs.levers
  if (force === 'scrub') return true
  const expected = force === 'warp' ? inputs.delta * warp : inputs.delta
  if (
    Math.abs(time - previous.time - expected) >
    Math.max(JUMP_FLOOR, JUMP_SCALE * expected)
  )
    return true
  const [low, high] = periodIndex(time, CLOUD_ADVECTION_PERIOD)
  const [lowBefore, highBefore] = periodIndex(
    previous.time,
    CLOUD_ADVECTION_PERIOD,
  )
  return low !== lowBefore || high !== highBefore
}

/** The camera's basis in the served body's axes, and the trace's ray budget. */
function cameraFrame(
  inputs: CloudFrameInputs,
  toBodyFixed: Quat,
  extents: CloudExtents,
): CloudCameraFrame {
  const turn = Q.multiply(toBodyFixed, inputs.camera.quaternion)
  const halfTan = Math.tan(verticalFov(inputs.lens) / 2)
  return {
    right: Q.rotate(turn, { x: 1, y: 0, z: 0 }),
    up: Q.rotate(turn, { x: 0, y: 1, z: 0 }),
    forward: Q.rotate(turn, { x: 0, y: 0, z: -1 }),
    halfTan,
    aspect: aspectRatio(inputs.css),
    pixelAngle: (2 * Math.atan(halfTan)) / extents.trace.height,
  }
}

/**
 * The synthetic path under 'fly': this call's step along the camera's
 * forward laid flat on the eye's horizontal, added to the path carried from
 * the last call if it was flying the same body too. A camera looking
 * straight up or down has no horizontal heading and takes no step.
 */
function flight(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
  served: RenderBody,
  eye: Vec3,
  forward: Vec3,
): Vec3 {
  if (inputs.levers.force !== 'fly') return Vec.ZERO
  const carried =
    previous !== null &&
    previous.levers.force === 'fly' &&
    previous.served.address === served.address
      ? (previous.flown ?? Vec.ZERO)
      : Vec.ZERO
  const up = Vec.normalize(Vec.add(eye, carried))
  const level = Vec.sub(forward, Vec.scale(up, Vec.dot(forward, up)))
  const length = Vec.length(level)
  if (length < 1e-9) return carried
  return Vec.add(
    carried,
    Vec.scale(level, inputs.levers.flySpeed / FLY_RATE / length),
  )
}

/**
 * Whether the camera turned more than 20° or the eye moved more than a tenth
 * of its height over the nearest shell boundary: farther than the history
 * can follow by reprojecting.
 */
function moved(
  camera: CloudCameraFrame,
  before: CloudCameraFrame,
  translation: Vec3,
  shells: ShellHeights,
): boolean {
  // The relative rotation's angle from the trace of its matrix, the sum of
  // the two bases' matching axes' cosines.
  const trace =
    Vec.dot(camera.right, before.right) +
    Vec.dot(camera.up, before.up) +
    Vec.dot(camera.forward, before.forward)
  const turn = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)))
  if (turn > MOTION_TURN) return true
  const clearance = Math.min(...shells.eyeOver.map(Math.abs))
  return Vec.length(translation) > MOTION_SHARE * clearance
}

const sameExtent = (a: Extent, b: Extent): boolean =>
  a.width === b.width && a.height === b.height

const sameExtents = (a: CloudExtents, b: CloudExtents): boolean =>
  sameExtent(a.render, b.render) &&
  sameExtent(a.css, b.css) &&
  sameExtent(a.trace, b.trace) &&
  sameExtent(a.history, b.history)

/** Whether anything that names what the history holds changed. */
function keyChanged(
  inputs: CloudFrameInputs,
  previous: CloudFrame,
  served: RenderBody,
  second: RenderBody | null,
): boolean {
  return (
    cloudResetKey(inputs.levers) !== cloudResetKey(previous.levers) ||
    inputs.pictureEpoch !== previous.pictureEpoch ||
    inputs.historyKey !== previous.historyKey ||
    served.address !== previous.served.address ||
    (second?.address ?? null) !== (previous.second?.address ?? null)
  )
}

/** Why the history resets, by §3.3's order: the first reason that holds. */
function resetReason(
  force: CloudLevers['force'],
  checks: {
    readonly first: boolean
    readonly key: boolean
    readonly resize: boolean
    readonly jump: boolean
    readonly motion: boolean
  },
): CloudResetReason {
  if (checks.first) return 'first'
  if (checks.key) return 'key'
  if (checks.resize) return 'resize'
  if (checks.jump) return 'jump'
  if (checks.motion) return 'motion'
  if (force === 'cut') return 'cut'
  if (force === 'reset' || force === 'scrub') return 'force'
  return 'none'
}

/* ------------------------------------------------------------------------- */
/* The frame                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The frame, or null when `levers.on` is false or no body is served.
 *
 * Under 'cut', and whenever the picture's key changes, every eye-anchored
 * level and every cascade is rebuilt from no previous frame, as a teleport
 * does: a key change is a new body, epoch or lever set, and what the caches
 * hold is no longer this picture's.
 */
export function cloudFrame(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
): CloudFrame | null {
  const { levers } = inputs
  if (!levers.on) return null
  const wet = (body: RenderBody): boolean => {
    const record = inputs.record(body.address)
    return record !== null && wetWorld(record)
  }
  const eyeRender = inputs.camera.position
  const servedAt = servedBody(
    inputs.scene.bodies,
    eyeRender,
    wet,
    levers.served,
  )
  if (servedAt === null) return null
  const secondAt = secondBody(inputs.scene.bodies, servedAt, wet, levers.second)
  const scenario = WEATHER_SCENARIOS[levers.scenario]
  const time = frameTime(inputs, previous)
  const jump = jumped(inputs, previous, time)
  const extents = cloudExtents(inputs.render, inputs.css, levers.traceScale)
  const toBodyFixed = Q.conjugate(servedAt.orientation)
  const camera = cameraFrame(inputs, toBodyFixed, extents)
  const trueEye = eyeOf(servedAt, eyeRender, Vec.ZERO)
  const flown = flight(inputs, previous, servedAt, trueEye, camera.forward)
  const sameServed =
    previous !== null && previous.served.address === servedAt.address
  const key =
    previous !== null && keyChanged(inputs, previous, servedAt, secondAt)
  const context: Context = {
    inputs,
    scenario,
    boundaries: shellBoundaries(scenario),
    periods: cloudNoisePeriods(scenario),
    time,
    jump,
  }
  const rebuild = previous === null || key || levers.force === 'cut'
  const flownRender = Q.rotate(servedAt.orientation, flown)
  const served = bodyFrame(
    context,
    servedAt,
    Vec.add(trueEye, flown),
    rebuild ? null : previous.served,
  )
  const second =
    secondAt === null
      ? null
      : bodyFrame(
          context,
          secondAt,
          eyeOf(secondAt, eyeRender, flownRender),
          'none',
        )
  const translation = sameServed
    ? Vec.sub(served.eye, previous.served.eye)
    : Vec.ZERO
  const previousCamera = sameServed ? previous.camera : null
  const reset = resetReason(levers.force, {
    first: previous === null,
    key,
    resize: previous !== null && !sameExtents(previous.extents, extents),
    jump,
    motion:
      previousCamera !== null &&
      moved(camera, previousCamera, translation, served.shells),
  })
  return {
    levers,
    scenario,
    served,
    second,
    time,
    frameSeconds: previous === null ? 0 : time - previous.time,
    period: periodIndex(time, scenario.patternPeriod),
    camera,
    previousCamera,
    translation,
    enhanced: inputs.enhanced,
    regime: reset === 'none' ? 'converging' : 'immediate',
    reset,
    jump,
    frameIndex: previous === null ? 0 : previous.frameIndex + 1,
    extents,
    pictureEpoch: inputs.pictureEpoch,
    historyKey: inputs.historyKey,
    flown,
  }
}
