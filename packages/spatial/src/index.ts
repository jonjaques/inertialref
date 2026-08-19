/* Namespaced re-exports: `Vec.add` and `UV.translate` read unambiguously at
   call sites, where "add" alone would not say which space it operates in. */
export * as Vec from './vec3.ts'
export * as Quaternion from './quat.ts'
export * as UV from './universeVector.ts'

export type { Vec3 } from './vec3.ts'
export type { Quat } from './quat.ts'
export type { UniverseVector } from './universeVector.ts'
export { vec3 } from './vec3.ts'
export { quat } from './quat.ts'
export {
  fromMeters,
  POSITION_RESOLUTION,
  SECTOR_EXPONENT,
  SECTOR_SIZE,
  UNIVERSE_HALF_EXTENT,
  UNIVERSE_ORIGIN,
  universeVector,
} from './universeVector.ts'

export * from './frame.ts'
export * from './origin.ts'
