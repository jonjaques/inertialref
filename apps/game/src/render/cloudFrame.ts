import type { Quat, Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import type {
  CascadeUpdate,
  CloudExtents,
  Extent,
  Lens,
  LevelUpdate,
  RenderBody,
  RenderScene,
  ShellHeights,
  WeatherScenario,
} from '@inertialref/rendering'
// Types only: this module reaches no Three at runtime, as `bodyUniforms.ts`.
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import type { CloudLevers } from './cloudLevers.ts'

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
  readonly cascades: CascadeUpdate
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
}

/**
 * The frame, or null when `levers.on` is false or no body is served.
 *
 * Null for every input here: no frame is built until the served body, its
 * heights and its caches' frames are.
 */
export function cloudFrame(
  _inputs: CloudFrameInputs,
  _previous: CloudFrame | null,
): CloudFrame | null {
  return null
}

/**
 * The body the trace serves: the one whose air the eye is inside, else the
 * largest by angular radius among those with weather; `forced` wins.
 *
 * None here, as `cloudFrame` builds none.
 */
export function servedBody(
  _bodies: readonly RenderBody[],
  _eye: Vec3,
  _wet: (body: RenderBody) => boolean,
  _forced: string | null,
): RenderBody | null {
  return null
}
