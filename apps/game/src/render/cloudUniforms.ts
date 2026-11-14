import {
  Color,
  Matrix3,
  Matrix4,
  type UniformNode,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import {
  CLOUD_GENERA,
  type LevelFrame,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Quat, Vec3 } from '@inertialref/spatial'
import { type AirUniforms, createAirUniforms } from './air.ts'
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import type {
  CloudBodyFrame,
  CloudCameraFrame,
  CloudClimateFrame,
  CloudFrame,
  CloudLevelFrame,
} from './cloudFrame.ts'
import { CLOUD_JITTERS, CLOUD_TRANSPORTS } from './cloudLevers.ts'

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

/**
 * A body's three levels, packed by component: `x` the low level's, `y` the
 * middle's, `z` the high's. One bundle a body, so two clouded bodies in one
 * frame draw two layer sets.
 */
export interface CloudLayerUniforms {
  readonly base: UniformNode<'vec3', Vector3>
  readonly top: UniformNode<'vec3', Vector3>
  /** Each level's mean cover under a regime: what the scenario's pattern is scaled by. */
  readonly coverage: UniformNode<'vec3', Vector3>
  /** Each level's reference in-cloud extinction, 1/m. */
  readonly sigma: UniformNode<'vec3', Vector3>
  readonly cell: UniformNode<'vec3', Vector3>
  readonly erosion: UniformNode<'vec3', Vector3>
  /** Reference effective radius, µm, and the level's least and greatest. */
  readonly radius: UniformNode<'vec3', Vector3>
  readonly radiusMin: UniformNode<'vec3', Vector3>
  readonly radiusMax: UniformNode<'vec3', Vector3>
  /** The genus's index in `CLOUD_GENERA`, as a float. */
  readonly genus: UniformNode<'vec3', Vector3>
  /** The volume's encoding scale: the largest σ. */
  readonly sigmaScale: UniformNode<'float', number>
  /** 1/(1 − f_δ) at the level's reference radius: what the far march, which reads one radius a level, gains first order by. */
  readonly gain: UniformNode<'vec3', Vector3>
  /** 1 − g′ at the reference radius: a scaled depth times it is a transport depth. */
  readonly transport: UniformNode<'vec3', Vector3>
  /** The level's first row in the profile table. */
  readonly profileRow: UniformNode<'vec3', Vector3>
  /** The class's first row in the phase atlas, its row count, and its first row's radius, µm, for the row mapping. */
  readonly phaseRow: UniformNode<'vec3', Vector3>
  readonly phaseRows: UniformNode<'vec3', Vector3>
  readonly phaseRadius: UniformNode<'vec3', Vector3>
  /** The level's mean in-cloud optical depth where it is stratiform, and where it is cumuliform. */
  readonly depthStratiform: UniformNode<'vec3', Vector3>
  readonly depthCumuliform: UniformNode<'vec3', Vector3>
  /** Each level's noise frame: its turn about the spin axis as a matrix, and its reduced origins. */
  readonly turn: readonly [
    UniformNode<'mat3', Matrix3>,
    UniformNode<'mat3', Matrix3>,
    UniformNode<'mat3', Matrix3>,
  ]
  readonly noiseOrigin: readonly [
    UniformNode<'vec3', Vector3>,
    UniformNode<'vec3', Vector3>,
    UniformNode<'vec3', Vector3>,
  ]
  readonly detailOrigin: readonly [
    UniformNode<'vec3', Vector3>,
    UniformNode<'vec3', Vector3>,
    UniformNode<'vec3', Vector3>,
  ]
  /** Each level's six mesoscale waves' phases at the eye, three and three (`CloudLevelFrame.mesoscale`). */
  readonly mesoscale: readonly [
    readonly [UniformNode<'vec3', Vector3>, UniformNode<'vec3', Vector3>],
    readonly [UniformNode<'vec3', Vector3>, UniformNode<'vec3', Vector3>],
    readonly [UniformNode<'vec3', Vector3>, UniformNode<'vec3', Vector3>],
  ]
}

/** The zonal law's kind and a regime's pattern, as numbers a shader compares. */
export const CLOUD_CLIMATE_KINDS = { regime: 0, zonal: 1, measured: 2 } as const
export const CLOUD_PATTERN_KINDS = { uniform: 0, bands: 1, blobs: 2 } as const

/** A body's climate: how much of each level is cloud at a place under a sun. */
export interface CloudClimateUniforms {
  /** `CLOUD_CLIMATE_KINDS`. */
  readonly kind: UniformNode<'uint', number>
  /** The zonal law's sixteen coefficients. */
  readonly law: UniformNode<'mat4', Matrix4>
  /** A regime's pattern: (`CLOUD_PATTERN_KINDS`, its angular scale in radians, blob cells a face edge, 0). */
  readonly pattern: UniformNode<'vec4', Vector4>
  /** The pattern's period index as two u32 halves: what a blob cell is hashed with. */
  readonly period: UniformNode<'uvec2', Vector2>
  /** The terminator's sines, full and clear. */
  readonly terminator: UniformNode<'vec2', Vector2>
  /** Each level's blob threshold, a u32 the CPU formed (rule 58), and its cover between blobs. */
  readonly blobThreshold: UniformNode<'uvec3', Vector3>
  readonly blobFloor: UniformNode<'vec3', Vector3>
  /** Each level's mean cover and cumuliform share under a regime. */
  readonly cover: UniformNode<'vec3', Vector3>
  readonly convective: UniformNode<'vec3', Vector3>
  /** The middle level's ice share, and the deep-convection rate. */
  readonly ice: UniformNode<'float', number>
  readonly deep: UniformNode<'float', number>
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
  /** The body's own levels and climate: its weather. */
  readonly layers: CloudLayerUniforms
  readonly climate: CloudClimateUniforms
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
  readonly lightTaps: UniformNode<'float', number>
  readonly immediate: UniformNode<'float', number>
  readonly thin: UniformNode<'float', number>
  /** `CloudFrame.frameSeconds`: the field's Δt, which the wind moves by. */
  readonly frameSeconds: UniformNode<'float', number>
  /** Body-fixed m/s. */
  readonly wind: UniformNode<'vec3', Vector3>
  /** Each of the served body's levels' turn about its spin axis, rad/s: what the history reprojects a level by. */
  readonly turn: UniformNode<'vec3', Vector3>
  /** Radius bins a level under the `phaseMode: 'bins'` kernel. */
  readonly phaseBins: UniformNode<'uint', number>
  /** The `jitter` lever, by its index in `CLOUD_JITTERS`. */
  readonly jitter: UniformNode<'uint', number>
  /** The `transport` lever, by its index in `CLOUD_TRANSPORTS`. */
  readonly transport: UniformNode<'uint', number>
  /** The handover band's far edge over its near one, in footprint. */
  readonly handoverBand: UniformNode<'float', number>
  /** The history clip's half-width, in standard deviations. */
  readonly clip: UniformNode<'float', number>
  /**
   * How far the sun grid's depth replaces the layers' statistics, 0..1: the
   * rebuild's ramp times the wake's height. The grid's schedule writes it
   * before the trace reads it; `write` does not. Zero until a grid is whole.
   */
  readonly sunWeight: UniformNode<'float', number>
}

export interface CloudUniforms {
  readonly served: CloudBodyUniforms
  readonly second: CloudBodyUniforms
  readonly camera: CloudCameraUniforms
  readonly trace: CloudTraceUniforms
  /** `periodIndex`'s two u32 halves. */
  readonly period: UniformNode<'uvec2', Vector2>
  /** Copy a frame in, each write compared first, as Bodies' setters are. */
  write(frame: CloudFrame): void
  /** Frees the second body's own table stand-ins: the only textures the bundle makes. */
  dispose(): void
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
  /** The body's levels and climate alone: a body that is not drawn still holds a weather. */
  writeWeather(frame: CloudBodyFrame, scenario: WeatherScenario): void
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
    layers: createLayerUniforms(),
    climate: createClimateUniforms(),
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
        // The body's table set as one object: a table more is a member of
        // it, bound by `air.bind`, and this call does not change.
        if (frame.scattering === null) air.clear()
        else air.bind(frame.scattering)
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
    writeWeather(frame, scenario) {
      writeLayers(uniforms.layers, frame.levels)
      writeScenarioLayers(uniforms.layers, scenario)
      writeClimate(uniforms.climate, frame.climate)
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

const triple = <T>(make: () => T): readonly [T, T, T] => [
  make(),
  make(),
  make(),
]

function createLayerUniforms(): CloudLayerUniforms {
  return {
    base: vec3Uniform(),
    top: vec3Uniform(),
    coverage: vec3Uniform(),
    sigma: vec3Uniform(),
    cell: vec3Uniform(1, 1, 1),
    erosion: vec3Uniform(),
    radius: vec3Uniform(10, 10, 10),
    radiusMin: vec3Uniform(10, 10, 10),
    radiusMax: vec3Uniform(10, 10, 10),
    genus: vec3Uniform(),
    sigmaScale: uniform(1),
    gain: vec3Uniform(1, 1, 1),
    transport: vec3Uniform(1, 1, 1),
    profileRow: vec3Uniform(),
    phaseRow: vec3Uniform(),
    phaseRows: vec3Uniform(1, 1, 1),
    phaseRadius: vec3Uniform(1, 1, 1),
    depthStratiform: vec3Uniform(),
    depthCumuliform: vec3Uniform(),
    turn: triple(() => uniform(new Matrix3())),
    noiseOrigin: triple(() => vec3Uniform()),
    detailOrigin: triple(() => vec3Uniform()),
    mesoscale: triple(() => [vec3Uniform(), vec3Uniform()] as const),
  }
}

function createClimateUniforms(): CloudClimateUniforms {
  return {
    kind: uniform(CLOUD_CLIMATE_KINDS.regime, 'uint'),
    law: uniform(
      new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    ),
    pattern: uniform(new Vector4(CLOUD_PATTERN_KINDS.uniform, 0, 1, 0)),
    period: uniform(new Vector2(), 'uvec2'),
    terminator: vec2Uniform(2, 3),
    blobThreshold: uniform(new Vector3(), 'uvec3'),
    blobFloor: vec3Uniform(),
    cover: vec3Uniform(),
    convective: vec3Uniform(),
    ice: uniform(0),
    deep: uniform(0),
  }
}

/**
 * A square matrix from its numbers in rows, written only when one moved.
 * `elements` holds columns, so row r, column c of a matrix `size` wide is
 * `elements[c·size + r]`.
 */
function setMatrix(
  target: Matrix3 | Matrix4,
  size: 3 | 4,
  rows: readonly number[],
): void {
  const { elements } = target
  let same = true
  for (let r = 0; r < size; r += 1)
    for (let c = 0; c < size; c += 1)
      if (elements[c * size + r] !== (rows[r * size + c] ?? 0)) same = false
  if (same) return
  for (let r = 0; r < size; r += 1)
    for (let c = 0; c < size; c += 1)
      elements[c * size + r] = rows[r * size + c] ?? 0
}

/**
 * A body's three levels by component, copied from its frame. An absent
 * level sits at the union's top with no thickness and nothing in it, as
 * `ShellHeights` lays out its boundaries, so a march that unrolls over all
 * three finds nothing there.
 */
function writeLayers(
  uniforms: CloudLayerUniforms,
  levels: readonly [CloudLevelFrame, CloudLevelFrame, CloudLevelFrame],
): void {
  const field = (
    target: Vector3,
    read: (level: CloudLevelFrame) => number,
  ): void => {
    setVector3(target, read(levels[0]), read(levels[1]), read(levels[2]))
  }
  field(uniforms.base.value, (level) => level.base)
  field(uniforms.top.value, (level) => level.top)
  field(uniforms.sigma.value, (level) => level.sigma)
  field(uniforms.cell.value, (level) => level.cell)
  field(uniforms.erosion.value, (level) => level.erosion)
  field(uniforms.radius.value, (level) => level.radius)
  field(uniforms.radiusMin.value, (level) => level.radiusRange[0])
  field(uniforms.radiusMax.value, (level) => level.radiusRange[1])
  field(uniforms.gain.value, (level) => level.gain)
  field(uniforms.transport.value, (level) => level.transport)
  field(uniforms.profileRow.value, (level) => level.profileRow)
  field(uniforms.phaseRow.value, (level) => level.phaseRow)
  field(uniforms.phaseRows.value, (level) => level.phaseRows)
  field(uniforms.phaseRadius.value, (level) => level.phaseRadius)
  field(uniforms.depthStratiform.value, (level) => level.meanDepth[0])
  field(uniforms.depthCumuliform.value, (level) => level.meanDepth[1])
  levels.forEach((level, k) => {
    setMatrix(uniforms.turn[k]!.value, 3, level.turn)
    setVec3(uniforms.noiseOrigin[k]!.value, level.noiseOrigin)
    setVec3(uniforms.detailOrigin[k]!.value, level.detailOrigin)
    const phases = level.mesoscale ?? []
    const [first, second] = uniforms.mesoscale[k]!
    setVector3(first.value, phases[0] ?? 0, phases[1] ?? 0, phases[2] ?? 0)
    setVector3(second.value, phases[3] ?? 0, phases[4] ?? 0, phases[5] ?? 0)
  })
  // Never zero: the volume divides by it to decode.
  setNumber(
    uniforms.sigmaScale,
    Math.max(levels[0].sigma, levels[1].sigma, levels[2].sigma, 1e-9),
  )
}

/**
 * The two members a level's frame does not carry, from the frame's
 * scenario: each layer's mean cover, which the scenario's pattern is scaled
 * by, and its genus, the profile table's row.
 */
function writeScenarioLayers(
  uniforms: CloudLayerUniforms,
  scenario: WeatherScenario,
): void {
  const at = (k: number) => scenario.layers[k]
  const cover = (k: number): number => at(k)?.coverage ?? 0
  const genus = (k: number): number => {
    const layer = at(k)
    return layer === undefined ? 0 : CLOUD_GENERA.indexOf(layer.genus)
  }
  setVector3(uniforms.coverage.value, cover(0), cover(1), cover(2))
  setVector3(uniforms.genus.value, genus(0), genus(1), genus(2))
}

function writeClimate(
  uniforms: CloudClimateUniforms,
  climate: CloudClimateFrame,
): void {
  setNumber(uniforms.kind, CLOUD_CLIMATE_KINDS[climate.kind])
  setMatrix(uniforms.law.value, 4, climate.law)
  setVector4(
    uniforms.pattern.value,
    CLOUD_PATTERN_KINDS[climate.pattern],
    climate.patternScale,
    climate.patternCells,
    0,
  )
  setVector2(uniforms.period.value, climate.period[0], climate.period[1])
  setVector2(
    uniforms.terminator.value,
    climate.terminator[0],
    climate.terminator[1],
  )
  setVector3(uniforms.blobThreshold.value, ...climate.blobThreshold)
  setVector3(uniforms.blobFloor.value, ...climate.blobFloor)
  setVector3(uniforms.cover.value, ...climate.cover)
  setVector3(uniforms.convective.value, ...climate.convective)
  setNumber(uniforms.ice, climate.ice)
  setNumber(uniforms.deep, climate.deep)
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
    lightTaps: uniform(0),
    immediate: uniform(0),
    thin: uniform(0),
    frameSeconds: uniform(0),
    wind: vec3Uniform(),
    turn: vec3Uniform(),
    phaseBins: uniform(4, 'uint'),
    jitter: uniform(0, 'uint'),
    transport: uniform(0, 'uint'),
    handoverBand: uniform(1),
    clip: uniform(1),
    sunWeight: uniform(0),
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
  // `jitterFrame` holds the jitter alone: the interleave and every cache's
  // schedule still step with `frameIndex`, so a held still keeps filling all
  // four phases and repeats itself every four frames.
  setNumber(uniforms.frame, (levers.jitterFrame ?? frame.frameIndex) >>> 0)
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
  setNumber(uniforms.lightTaps, levers.lightTaps)
  setNumber(uniforms.immediate, immediate ? 1 : 0)
  setNumber(uniforms.thin, levers.composite === 'thin' ? 1 : 0)
  setNumber(uniforms.frameSeconds, frame.frameSeconds)
  setVec3(uniforms.wind.value, frame.served.wind)
  const [low, middle, high] = frame.served.levels
  setVector3(uniforms.turn.value, low.turnRate, middle.turnRate, high.turnRate)
  setNumber(uniforms.phaseBins, levers.phaseBins)
  setNumber(uniforms.jitter, CLOUD_JITTERS.indexOf(levers.jitter))
  setNumber(uniforms.transport, CLOUD_TRANSPORTS.indexOf(levers.transport))
  setNumber(uniforms.handoverBand, levers.handoverBand)
  setNumber(uniforms.clip, levers.clip)
}

export function createCloudUniforms(): CloudUniforms {
  const served = createBodyBundle(createAirUniforms())
  // The composite binds both bodies' air in one program: two table nodes over
  // the shared stand-ins would compile to one binding (rule 57).
  const second = createBodyBundle(createAirUniforms({ ownStandIns: true }))
  const camera = createCameraUniforms()
  const trace = createTraceUniforms()
  const period = uniform(new Vector2(), 'uvec2')
  return {
    served: served.uniforms,
    second: second.uniforms,
    camera,
    trace,
    period,
    write(frame) {
      served.write(frame.served, frame.enhanced)
      served.writeWeather(frame.served, frame.scenario)
      if (frame.second === null) second.idle()
      else second.write(frame.second, frame.enhanced)
      // With no second body its weather is the served one's: a pass built
      // over the second body's bundle reads levels that lay out, never the
      // last body's that stood there.
      second.writeWeather(frame.second ?? frame.served, frame.scenario)
      writeCamera(camera, frame)
      writeTrace(trace, frame)
      setVector2(period.value, frame.period[0], frame.period[1])
    },
    dispose() {
      served.uniforms.air.dispose()
      second.uniforms.air.dispose()
    },
  }
}
