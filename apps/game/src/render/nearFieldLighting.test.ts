import { expect, it } from 'vitest'
import {
  CAMERA_MODES,
  DEFAULT_SENSOR_SETTINGS,
  LENS_PRESETS,
  resolveCameraPolicy,
} from '@inertialref/rendering'
import { nearFieldLighting } from './nearFieldLighting.ts'

it.each(CAMERA_MODES)(
  'scopes hull visibility lighting to the %s camera policy',
  (mode) => {
    const settings = { ...DEFAULT_SENSOR_SETTINGS, mode }
    const ordinary = resolveCameraPolicy(settings, LENS_PRESETS.flight)
    expect(nearFieldLighting(ordinary, false)).toEqual(
      mode === 'enhanced'
        ? { ambient: 0.16, fill: 0.35 }
        : { ambient: 0, fill: 0 },
    )
    const authored = resolveCameraPolicy(settings, LENS_PRESETS.cinematic, 0)
    expect(nearFieldLighting(authored, false)).toEqual({ ambient: 0, fill: 0 })
    expect(nearFieldLighting(authored, true)).toEqual({
      ambient: 0.16,
      fill: 1.6,
    })
    expect(nearFieldLighting(ordinary, false)).toEqual(
      mode === 'enhanced'
        ? { ambient: 0.16, fill: 0.35 }
        : { ambient: 0, fill: 0 },
    )
  },
)
