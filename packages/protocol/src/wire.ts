import { ok, type Result } from '@inertialref/shared'
import {
  type FrameId,
  frameId,
  type FrameState,
  type Quat,
  quat,
  type UniverseVector,
  universeVector,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import { decodeNumberTuple, decodeObject, decodeString, type Decoder } from './codec.ts'

/*
 * Wire forms for spatial types.
 *
 * Vectors go over the wire as arrays, not objects: `[x, y, z]` rather than
 * `{"x":…,"y":…,"z":…}` is about 40% smaller in JSON and orders the components
 * unambiguously, which matters when this eventually becomes a binary format.
 * The classes-are-not-serialised rule from the spec is easy to keep here
 * because nothing in `spatial` is a class in the first place.
 */

export type WireVec3 = readonly [number, number, number]
export type WireQuat = readonly [number, number, number, number]
/** [sectorX, sectorY, sectorZ, offsetX, offsetY, offsetZ] */
export type WireUniverseVector = readonly [number, number, number, number, number, number]

export const encodeVec3 = (v: Vec3): WireVec3 => [v.x, v.y, v.z]
export const encodeQuat = (q: Quat): WireQuat => [q.x, q.y, q.z, q.w]
export const encodeUniverseVector = (uv: UniverseVector): WireUniverseVector => [
  uv.sx,
  uv.sy,
  uv.sz,
  uv.ox,
  uv.oy,
  uv.oz,
]

export const decodeVec3: Decoder<Vec3> = (value, path) => {
  const parts = decodeNumberTuple(3)(value, path)
  return parts.ok ? ok(vec3(parts.value[0] as number, parts.value[1] as number, parts.value[2] as number)) : parts
}

export const decodeQuat: Decoder<Quat> = (value, path) => {
  const parts = decodeNumberTuple(4)(value, path)
  return parts.ok
    ? ok(quat(parts.value[0] as number, parts.value[1] as number, parts.value[2] as number, parts.value[3] as number))
    : parts
}

export const decodeUniverseVector: Decoder<UniverseVector> = (value, path) => {
  const parts = decodeNumberTuple(6)(value, path)
  if (!parts.ok) return parts
  const [sx, sy, sz, ox, oy, oz] = parts.value as [number, number, number, number, number, number]
  // universeVector re-validates and re-normalises: a save file that has been
  // hand-edited, or written by an older build with a different sector size, must
  // not be able to install an out-of-range position.
  try {
    return ok(universeVector(sx, sy, sz, ox, oy, oz))
  } catch (cause) {
    return { ok: false, error: `${path}: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

export const decodeFrameId: Decoder<FrameId> = (value, path) => {
  const text = decodeString(value, path)
  return text.ok ? ok(frameId(text.value)) : text
}

export interface WireFrameState {
  readonly frame: string
  readonly position: WireVec3
  readonly orientation: WireQuat
  readonly velocity: WireVec3
  readonly angularVelocity: WireVec3
}

export const encodeFrameState = (state: FrameState): WireFrameState => ({
  frame: state.frame,
  position: encodeVec3(state.position),
  orientation: encodeQuat(state.orientation),
  velocity: encodeVec3(state.velocity),
  angularVelocity: encodeVec3(state.angularVelocity),
})

export const decodeFrameState: Decoder<FrameState> = decodeObject({
  frame: decodeFrameId,
  position: decodeVec3,
  orientation: decodeQuat,
  velocity: decodeVec3,
  angularVelocity: decodeVec3,
}) as Decoder<FrameState>

/** Round-trip check used by the protocol tests and by the harness self-test. */
export function roundTripsFrameState(state: FrameState): Result<FrameState, string> {
  return decodeFrameState(JSON.parse(JSON.stringify(encodeFrameState(state))), 'state')
}

/*
 * Validators that leave the wire form alone.
 *
 * The save decoder needs to check that a stored state is well formed without
 * converting it: `SaveGame` *is* the on-disk shape, and a decoder that quietly
 * turned `[1,2,3]` into `{x,y,z}` while the type still said `WireVec3` is
 * exactly the sort of mismatch a cast hides — it did, until a test caught it.
 */
export const decodeWireVec3: Decoder<WireVec3> = (value, path) => {
  const parts = decodeNumberTuple(3)(value, path)
  return parts.ok ? ok(parts.value as unknown as WireVec3) : parts
}

export const decodeWireQuat: Decoder<WireQuat> = (value, path) => {
  const parts = decodeNumberTuple(4)(value, path)
  return parts.ok ? ok(parts.value as unknown as WireQuat) : parts
}

export const decodeWireFrameState: Decoder<WireFrameState> = decodeObject({
  frame: decodeString,
  position: decodeWireVec3,
  orientation: decodeWireQuat,
  velocity: decodeWireVec3,
  angularVelocity: decodeWireVec3,
})
