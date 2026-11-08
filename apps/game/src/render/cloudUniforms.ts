import {
  Color,
  Matrix3,
  type UniformNode,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import {
  CLOUD_GENERA,
  type LevelFrame,
  MAX_CLOUD_LAYERS,
  shellUnion,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Quat, Vec3 } from '@inertialref/spatial'
import { type AirUniforms, createAirUniforms } from './air.ts'
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import type {
  CloudBodyFrame,
  CloudCameraFrame,
  CloudFrame,
} from './cloudFrame.ts'
import { CLOUD_SWEEP_EXTRAS } from './cloudLevers.ts'

/*
 * The one uniform bundle every cloud module is constructed with and reads.
 *
 * Everything here is formed on the CPU in float64 by `cloudFrame` and copied
 * in by `write`, mechanically: no arithmetic a shader is held to happens in
 * this file, so a frame's numbers have one source. The bundle carries no
 * absolute direction or position — no `eyeDirection` — because nothing may
 * form a lattice coordinate or a level lookup from one (rule 58): a level is
 * read through its eye-relative `along` terms, a crossing through `eyeOver`.
 */

/** The clipmap's levels, 250 m × 2^k, and the volume's, 50, 200 and 800 m. */
export const CLOUD_CLIPMAP_LEVELS = 6
export const CLOUD_VOLUME_LEVELS = 3

export interface CloudLevelUniforms {
  readonly anchor: UniformNode<'vec3', Vector3>
  readonly east: UniformNode<'vec3', Vector3>
  readonly north: UniformNode<'vec3', Vector3>
  /** The eye's plane coordinates about the anchor, meters (float64-formed). */
  readonly eye: UniformNode<'vec2', Vector2>
  /** (e·A, e·E, e·N), meters (float64-formed): §3.9's eye-relative lookup. */
  readonly along: UniformNode<'vec3', Vector3>
  /** The window's integer low corner, texels. */
  readonly origin: UniformNode<'vec2', Vector2>
  /** Meters. */
  readonly texel: UniformNode<'float', number>
}

export interface CloudBodyUniforms {
  readonly datumRadius: UniformNode<'float', number>
  /** The eye over the datum, meters. */
  readonly eye: UniformNode<'float', number>
  /** eye − [base₀, top₀, base₁, top₁]. */
  readonly eyeOver: UniformNode<'vec4', Vector4>
  /** eye − [base₂, top₂]. */
  readonly eyeOverHigh: UniformNode<'vec2', Vector2>
  readonly boundaries: UniformNode<'vec4', Vector4>
  readonly boundariesHigh: UniformNode<'vec2', Vector2>
  /** h_e·(2R + h_e), float64-formed: §5.3's numerator. */
  readonly eyeTerm: UniformNode<'float', number>
  /** The eye's local vertical, body-fixed. */
  readonly up: UniformNode<'vec3', Vector3>
  /** Body-fixed, unit. */
  readonly sun: UniformNode<'vec3', Vector3>
  /** dot(up, sun) at the eye. */
  readonly sunUp: UniformNode<'float', number>
  /** Render axes → body-fixed. */
  readonly toBodyFixed: UniformNode<'mat3', Matrix3>
  readonly noiseOrigin: UniformNode<'vec3', Vector3>
  readonly detailOrigin: UniformNode<'vec3', Vector3>
  readonly drift: UniformNode<'vec3', Vector3>
  readonly compression: UniformNode<'float', number>
  /** limb × enhanced: `clearedFromOrbit`'s value. */
  readonly cleared: UniformNode<'float', number>
  readonly dayColor: UniformNode<'color', Color>
  /** The second body's has its own stand-ins (rule 57). */
  readonly air: AirUniforms
  readonly clipmap: readonly CloudLevelUniforms[]
  readonly volume: readonly CloudLevelUniforms[]
  readonly active: UniformNode<'float', number>
}

/** Three layers, packed by component. */
export interface CloudLayerUniforms {
  readonly base: UniformNode<'vec3', Vector3>
  readonly top: UniformNode<'vec3', Vector3>
  readonly coverage: UniformNode<'vec3', Vector3>
  readonly sigma: UniformNode<'vec3', Vector3>
  readonly cell: UniformNode<'vec3', Vector3>
  readonly erosion: UniformNode<'vec3', Vector3>
  readonly radius: UniformNode<'vec3', Vector3>
  /** The genus's index in `CLOUD_GENERA`, as a float. */
  readonly genus: UniformNode<'vec3', Vector3>
  /** The volume's encoding scale: the largest σ. */
  readonly sigmaScale: UniformNode<'float', number>
}

export interface CloudCameraUniforms {
  readonly right: UniformNode<'vec3', Vector3>
  readonly up: UniformNode<'vec3', Vector3>
  readonly forward: UniformNode<'vec3', Vector3>
  /** (halfTan·aspect, halfTan). */
  readonly plane: UniformNode<'vec2', Vector2>
  readonly previousRight: UniformNode<'vec3', Vector3>
  readonly previousUp: UniformNode<'vec3', Vector3>
  readonly previousForward: UniformNode<'vec3', Vector3>
  readonly previousPlane: UniformNode<'vec2', Vector2>
  /** Eye − previous eye, body-fixed, meters. */
  readonly translation: UniformNode<'vec3', Vector3>
  readonly pixelAngle: UniformNode<'float', number>
  /** The scene camera's, for the depth copy: the system writes them, `write` does not. */
  readonly near: UniformNode<'float', number>
  readonly far: UniformNode<'float', number>
}

export interface CloudTraceUniforms {
  /** The trace's extent: every dispatch, the immediate regime's four included. */
  readonly size: UniformNode<'vec2', Vector2>
  readonly history: UniformNode<'vec2', Vector2>
  /** The scene target, for depth and the composite. */
  readonly render: UniformNode<'vec2', Vector2>
  /** The interleave's (φx, φy): written by the trace before each dispatch, not by `write`. */
  readonly phase: UniformNode<'vec2', Vector2>
  /** The jitter's index. */
  readonly frame: UniformNode<'uint', number>
  /** farFootprint / pixelAngle. */
  readonly farDistance: UniformNode<'float', number>
  /** maxSteps, or maxSteps/4 in the immediate regime. */
  readonly maxSteps: UniformNode<'float', number>
  readonly fixedSteps: UniformNode<'float', number>
  readonly sweepReads: UniformNode<'float', number>
  /** `CLOUD_SWEEP_EXTRAS`'s index. */
  readonly sweepExtra: UniformNode<'float', number>
  readonly lightTaps: UniformNode<'float', number>
  readonly immediate: UniformNode<'float', number>
  readonly thin: UniformNode<'float', number>
  /** `CloudFrame.frameSeconds`: the field's Δt, which the wind moves by. */
  readonly frameSeconds: UniformNode<'float', number>
  /** Body-fixed m/s. */
  readonly wind: UniformNode<'vec3', Vector3>
}

export interface CloudUniforms {
  readonly served: CloudBodyUniforms
  readonly second: CloudBodyUniforms
  readonly layers: CloudLayerUniforms
  readonly camera: CloudCameraUniforms
  readonly trace: CloudTraceUniforms
  /** `periodIndex`'s two u32 halves. */
  readonly period: UniformNode<'uvec2', Vector2>
  /** Copy a frame in, each write compared first, as Bodies' setters are. */
  write(frame: CloudFrame): void
}

/* ------------------------------------------------------------------------- */
/* The writes, each compared first                                            */
/* ------------------------------------------------------------------------- */

/*
 * A uniform is read by reference every frame, so a write that changes nothing
 * is pure cost, and most of a frame's cloud numbers are the last frame's.
 */

function setNumber(target: { value: number }, value: number): void {
  if (target.value !== value) target.value = value
}

function setVector2(target: Vector2, x: number, y: number): void {
  if (target.x !== x || target.y !== y) target.set(x, y)
}

function setVector3(target: Vector3, x: number, y: number, z: number): void {
  if (target.x !== x || target.y !== y || target.z !== z) target.set(x, y, z)
}

function setVec3(target: Vector3, value: Vec3): void {
  setVector3(target, value.x, value.y, value.z)
}

function setVector4(
  target: Vector4,
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  if (target.x !== x || target.y !== y || target.z !== z || target.w !== w)
    target.set(x, y, z, w)
}

function setColor(target: Color, r: number, g: number, b: number): void {
  if (target.r !== r || target.g !== g || target.b !== b) target.setRGB(r, g, b)
}

/** The rotation a unit quaternion is, written only when the quaternion moved. */
function setRotation(target: Matrix3, last: number[], q: Quat): void {
  if (last[0] === q.x && last[1] === q.y && last[2] === q.z && last[3] === q.w)
    return
  last[0] = q.x
  last[1] = q.y
  last[2] = q.z
  last[3] = q.w
  const { x, y, z, w } = q
  target.set(
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  )
}

/* ------------------------------------------------------------------------- */
/* The bundle                                                                 */
/* ------------------------------------------------------------------------- */

const vec3Uniform = (x = 0, y = 0, z = 0) => uniform(new Vector3(x, y, z))
const vec2Uniform = (x = 0, y = 0) => uniform(new Vector2(x, y))

function createLevelUniforms(): CloudLevelUniforms {
  return {
    anchor: vec3Uniform(0, 1, 0),
    east: vec3Uniform(1, 0, 0),
    north: vec3Uniform(0, 0, 1),
    eye: vec2Uniform(),
    along: vec3Uniform(1, 0, 0),
    origin: vec2Uniform(),
    texel: uniform(1),
  }
}

function writeLevel(level: CloudLevelUniforms, frame: LevelFrame): void {
  setVec3(level.anchor.value, frame.anchor)
  setVec3(level.east.value, frame.east)
  setVec3(level.north.value, frame.north)
  setVector2(level.eye.value, frame.eye[0], frame.eye[1])
  setVector3(level.along.value, frame.along[0], frame.along[1], frame.along[2])
  setVector2(level.origin.value, frame.origin[0], frame.origin[1])
  setNumber(level.texel, frame.texelMeters)
}

interface BodyBundle {
  readonly uniforms: CloudBodyUniforms
  write(frame: CloudBodyFrame, enhanced: boolean): void
  idle(): void
}

function createBodyBundle(air: AirUniforms): BodyBundle {
  const uniforms: CloudBodyUniforms = {
    datumRadius: uniform(1),
    eye: uniform(0),
    eyeOver: uniform(new Vector4()),
    eyeOverHigh: vec2Uniform(),
    boundaries: uniform(new Vector4()),
    boundariesHigh: vec2Uniform(),
    eyeTerm: uniform(0),
    up: vec3Uniform(0, 1, 0),
    sun: vec3Uniform(0, 1, 0),
    sunUp: uniform(1),
    toBodyFixed: uniform(new Matrix3()),
    noiseOrigin: vec3Uniform(),
    detailOrigin: vec3Uniform(),
    drift: vec3Uniform(),
    compression: uniform(1),
    cleared: uniform(0),
    dayColor: uniform(new Color(1, 1, 1)),
    air,
    clipmap: Array.from({ length: CLOUD_CLIPMAP_LEVELS }, createLevelUniforms),
    volume: Array.from({ length: CLOUD_VOLUME_LEVELS }, createLevelUniforms),
    active: uniform(0),
  }
  const rotation = [0, 0, 0, 1]
  let tables: AtmosphereScattering | null | undefined
  return {
    uniforms,
    write(frame, enhanced) {
      const { shells } = frame
      const [b0 = 0, t0 = 0, b1 = 0, t1 = 0, b2 = 0, t2 = 0] = shells.boundaries
      const [o0 = 0, o1 = 0, o2 = 0, o3 = 0, o4 = 0, o5 = 0] = shells.eyeOver
      setNumber(uniforms.datumRadius, frame.datumRadius)
      setNumber(uniforms.eye, shells.eye)
      setVector4(uniforms.eyeOver.value, o0, o1, o2, o3)
      setVector2(uniforms.eyeOverHigh.value, o4, o5)
      setVector4(uniforms.boundaries.value, b0, t0, b1, t1)
      setVector2(uniforms.boundariesHigh.value, b2, t2)
      // float64 here, so the shader's numerator carries no cancellation
      // between two terms of a planetary radius's size (rule 52).
      setNumber(
        uniforms.eyeTerm,
        shells.eye * (2 * frame.datumRadius + shells.eye),
      )
      const { eye, sun } = frame
      const distance = Math.hypot(eye.x, eye.y, eye.z)
      const ux = distance > 0 ? eye.x / distance : 0
      const uy = distance > 0 ? eye.y / distance : 1
      const uz = distance > 0 ? eye.z / distance : 0
      setVector3(uniforms.up.value, ux, uy, uz)
      setVec3(uniforms.sun.value, sun)
      setNumber(uniforms.sunUp, ux * sun.x + uy * sun.y + uz * sun.z)
      setRotation(uniforms.toBodyFixed.value, rotation, frame.toBodyFixed)
      setVec3(uniforms.noiseOrigin.value, frame.noiseOrigin)
      setVec3(uniforms.detailOrigin.value, frame.detailOrigin)
      setVec3(uniforms.drift.value, frame.drift)
      setNumber(uniforms.compression, frame.compression)
      setNumber(uniforms.cleared, enhanced ? frame.limb : 0)
      setColor(
        uniforms.dayColor.value,
        frame.dayColor.r,
        frame.dayColor.g,
        frame.dayColor.b,
      )
      if (frame.scattering !== tables) {
        if (frame.scattering === null) air.clear()
        else
          air.set(
            frame.scattering.recipe,
            frame.scattering.transmittance,
            frame.scattering.multiScatter,
          )
        tables = frame.scattering
      }
      if (
        air.limb.value !== frame.limb ||
        air.limbFalloff.value !== frame.limbFalloff
      )
        air.lift(frame.limb, frame.limbFalloff)
      frame.clipmap.frames.forEach((level, k) => {
        const target = uniforms.clipmap[k]
        if (target !== undefined) writeLevel(target, level)
      })
      frame.volume.frames.forEach((level, k) => {
        const target = uniforms.volume[k]
        if (target !== undefined) writeLevel(target, level)
      })
      setNumber(uniforms.active, 1)
    },
    idle() {
      setNumber(uniforms.active, 0)
      if (tables !== null) {
        air.clear()
        tables = null
      }
    },
  }
}

function createLayerUniforms(): CloudLayerUniforms {
  return {
    base: vec3Uniform(),
    top: vec3Uniform(),
    coverage: vec3Uniform(),
    sigma: vec3Uniform(),
    cell: vec3Uniform(1, 1, 1),
    erosion: vec3Uniform(),
    radius: vec3Uniform(10, 10, 10),
    genus: vec3Uniform(),
    sigmaScale: uniform(1),
  }
}

/**
 * Three layers by component. An absent layer sits at the union's top with no
 * thickness and no cover, as `ShellHeights` lays out its boundaries, so a
 * march that unrolls over all three finds nothing in it.
 */
function writeLayers(
  uniforms: CloudLayerUniforms,
  scenario: WeatherScenario,
): void {
  const { top: ceiling } = shellUnion(scenario)
  const at = (k: number) => scenario.layers[k]
  const field = (
    target: Vector3,
    read: (k: number) => number,
    absent: number,
  ): void => {
    const pick = (k: number) => (at(k) === undefined ? absent : read(k))
    setVector3(target, pick(0), pick(1), pick(2))
  }
  field(uniforms.base.value, (k) => at(k)!.base, ceiling)
  field(uniforms.top.value, (k) => at(k)!.top, ceiling)
  field(uniforms.coverage.value, (k) => at(k)!.coverage, 0)
  field(uniforms.sigma.value, (k) => at(k)!.sigma, 0)
  field(uniforms.cell.value, (k) => at(k)!.cellMeters, 1)
  field(uniforms.erosion.value, (k) => at(k)!.erosion, 0)
  field(uniforms.radius.value, (k) => at(k)!.radius, 10)
  field(uniforms.genus.value, (k) => CLOUD_GENERA.indexOf(at(k)!.genus), 0)
  let largest = 0
  for (const layer of scenario.layers.slice(0, MAX_CLOUD_LAYERS))
    largest = Math.max(largest, layer.sigma)
  // Never zero: the volume divides by it to decode.
  setNumber(uniforms.sigmaScale, Math.max(largest, 1e-9))
}

function createCameraUniforms(): CloudCameraUniforms {
  return {
    right: vec3Uniform(1, 0, 0),
    up: vec3Uniform(0, 1, 0),
    forward: vec3Uniform(0, 0, -1),
    plane: vec2Uniform(1, 1),
    previousRight: vec3Uniform(1, 0, 0),
    previousUp: vec3Uniform(0, 1, 0),
    previousForward: vec3Uniform(0, 0, -1),
    previousPlane: vec2Uniform(1, 1),
    translation: vec3Uniform(),
    pixelAngle: uniform(0),
    near: uniform(0.1),
    far: uniform(1),
  }
}

function writeCamera(uniforms: CloudCameraUniforms, frame: CloudFrame): void {
  const now: CloudCameraFrame = frame.camera
  const before: CloudCameraFrame = frame.previousCamera ?? now
  setVec3(uniforms.right.value, now.right)
  setVec3(uniforms.up.value, now.up)
  setVec3(uniforms.forward.value, now.forward)
  setVector2(uniforms.plane.value, now.halfTan * now.aspect, now.halfTan)
  setVec3(uniforms.previousRight.value, before.right)
  setVec3(uniforms.previousUp.value, before.up)
  setVec3(uniforms.previousForward.value, before.forward)
  setVector2(
    uniforms.previousPlane.value,
    before.halfTan * before.aspect,
    before.halfTan,
  )
  setVec3(uniforms.translation.value, frame.translation)
  setNumber(uniforms.pixelAngle, now.pixelAngle)
}

function createTraceUniforms(): CloudTraceUniforms {
  return {
    size: vec2Uniform(1, 1),
    history: vec2Uniform(2, 2),
    render: vec2Uniform(1, 1),
    phase: vec2Uniform(),
    frame: uniform(0, 'uint'),
    farDistance: uniform(0),
    maxSteps: uniform(0),
    fixedSteps: uniform(0),
    sweepReads: uniform(0),
    sweepExtra: uniform(0),
    lightTaps: uniform(0),
    immediate: uniform(0),
    thin: uniform(0),
    frameSeconds: uniform(0),
    wind: vec3Uniform(),
  }
}

function writeTrace(uniforms: CloudTraceUniforms, frame: CloudFrame): void {
  const { levers, extents } = frame
  const immediate = frame.regime === 'immediate'
  setVector2(uniforms.size.value, extents.trace.width, extents.trace.height)
  setVector2(
    uniforms.history.value,
    extents.history.width,
    extents.history.height,
  )
  setVector2(uniforms.render.value, extents.render.width, extents.render.height)
  // A u32 wraps; a frame index past it starts the jitter's sequence over.
  setNumber(uniforms.frame, frame.frameIndex >>> 0)
  const pixelAngle = frame.camera.pixelAngle
  setNumber(
    uniforms.farDistance,
    pixelAngle > 0 ? levers.farFootprint / pixelAngle : 0,
  )
  // The immediate regime's four dispatches together spend one converging
  // frame's ray budget (§5.14).
  setNumber(
    uniforms.maxSteps,
    immediate ? Math.ceil(levers.maxSteps / 4) : levers.maxSteps,
  )
  setNumber(uniforms.fixedSteps, levers.fixedSteps)
  setNumber(uniforms.sweepReads, levers.sweepReads)
  setNumber(uniforms.sweepExtra, CLOUD_SWEEP_EXTRAS.indexOf(levers.sweepExtra))
  setNumber(uniforms.lightTaps, levers.lightTaps)
  setNumber(uniforms.immediate, immediate ? 1 : 0)
  setNumber(uniforms.thin, levers.composite === 'thin' ? 1 : 0)
  setNumber(uniforms.frameSeconds, frame.frameSeconds)
  setVec3(uniforms.wind.value, frame.served.wind)
}

export function createCloudUniforms(): CloudUniforms {
  const served = createBodyBundle(createAirUniforms())
  // The composite binds both bodies' air in one program: two table nodes over
  // the shared stand-ins would compile to one binding (rule 57).
  const second = createBodyBundle(createAirUniforms({ ownStandIns: true }))
  const layers = createLayerUniforms()
  const camera = createCameraUniforms()
  const trace = createTraceUniforms()
  const period = uniform(new Vector2(), 'uvec2')
  return {
    served: served.uniforms,
    second: second.uniforms,
    layers,
    camera,
    trace,
    period,
    write(frame) {
      served.write(frame.served, frame.enhanced)
      if (frame.second === null) second.idle()
      else second.write(frame.second, frame.enhanced)
      writeLayers(layers, frame.scenario)
      writeCamera(camera, frame)
      writeTrace(trace, frame)
      setVector2(period.value, frame.period[0], frame.period[1])
    },
  }
}
