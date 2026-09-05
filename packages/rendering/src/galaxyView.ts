import { PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV, vec3 } from '@inertialref/spatial'
import { lensForFov } from './lens.ts'

export type GalaxyView = 'face-on' | 'edge-on'
/** Fixed external instruments. The continuous interior camera belongs to M4. */
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

/** Preview bolometric-to-visible efficacy, pending M6 bandpass calibration. */
export const GALAXY_LUMINOUS_EFFICACY = 100
