import { PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV, vec3 } from '@inertialref/spatial'
import { lensForFov } from './lens.ts'

/** Fixed outside instruments; the journey shares the face-on lens. */
export const GALAXY_VIEWS = {
  'face-on': {
    label: 'Face-on',
    pose: {
      position: UV.fromMeters(0, 30000 * PARSEC, 0),
      orientation: Q.fromBasis(vec3(1, 0, 0), vec3(0, 0, -1), vec3(0, 1, 0)),
    },
    lens: {
      ...lensForFov(90),
      fStop: 2,
      focus: Infinity,
      shutter: 2400,
      iso: 400,
    },
  },
  'edge-on': {
    label: 'Edge-on',
    pose: {
      position: UV.fromMeters(0, 0, 40000 * PARSEC),
      orientation: Q.IDENTITY,
    },
    lens: {
      ...lensForFov(55),
      fStop: 2,
      focus: Infinity,
      shutter: 600,
      iso: 400,
    },
  },
} as const

/**
 * The views, as a type. `keyof` rather than a written union, because the union
 * was the fourth place the two ids were spelled out — beside the record, beside
 * `Observatory.viewGalaxy`'s guard and beside the harness's — and a third
 * instrument added here would have been rejected by both guards while
 * typechecking clean. Everything that enumerates them reads this record.
 */
export type GalaxyView = keyof typeof GALAXY_VIEWS

/** Whether an unchecked string names one. `in` would accept `constructor`. */
export const isGalaxyView = (value: unknown): value is GalaxyView =>
  typeof value === 'string' && Object.hasOwn(GALAXY_VIEWS, value)

/** Preview bolometric-to-visible efficacy, pending M6 bandpass calibration. */
export const GALAXY_LUMINOUS_EFFICACY = 100
