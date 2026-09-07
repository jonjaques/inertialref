import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import {
  createGalaxyField,
  integrateGalaxyRay,
  LOCAL_CLOUDS,
  SUN_POSITION,
} from '@inertialref/universe'
import {
  GALAXY_CACHE_RADIUS_PARSECS,
  GalaxyCacheSchedule,
} from './galaxyCache.ts'

const field = createGalaxyField(rootSeed('inertialref'))
const front = (name: string) => {
  const cloud = LOCAL_CLOUDS.find((entry) => entry.name === name)!
  const center = UV.fromMeters(
    cloud.center.x * PARSEC,
    cloud.center.y * PARSEC,
    cloud.center.z * PARSEC,
  )
  const delta = UV.difference(SUN_POSITION, center),
    length = Math.hypot(delta.x, delta.y, delta.z)
  const direction = vec3(delta.x / length, delta.y / length, delta.z / length)
  const sigma =
    1 /
    Math.sqrt(
      (direction.x / cloud.sigma.x) ** 2 +
        (direction.y / cloud.sigma.y) ** 2 +
        (direction.z / cloud.sigma.z) ** 2,
    )
  return UV.translate(
    center,
    vec3(
      direction.x * 2 * sigma * PARSEC,
      direction.y * 2 * sigma * PARSEC,
      direction.z * 2 * sigma * PARSEC,
    ),
  )
}
const ray = (index: number) => {
  const y = 1 - (2 * (index + 0.5)) / 10
  return vec3(
    Math.cos(index * 2.39996323) * Math.sqrt(1 - y * y),
    y,
    Math.sin(index * 2.39996323) * Math.sqrt(1 - y * y),
  )
}

// Worst directions from the 21-origin sweep, refined to 0.25 pc. These
// measure the actual field including cloud fronts and 1080p pixel filtering.
it.each([
  { name: 'Sol', origin: SUN_POSITION, direction: ray(5), sign: -1 },
  {
    name: 'Aquila front',
    origin: front('Aquila Rift'),
    direction: ray(5),
    sign: 1,
  },
  { name: 'Taurus front', origin: front('Taurus'), direction: ray(4), sign: 1 },
])(
  'keeps cached RGB within one percent at $name and rejects travel beyond the measured radius',
  ({ origin, direction, sign }) => {
    const options = { maxStepParsecs: 0.25, pixelAngle: Math.PI / 3 / 1920 }
    const cached = integrateGalaxyRay(
      field,
      origin,
      direction,
      options,
    ).rgbNanowatts
    const translated = UV.translate(
      origin,
      vec3(0, sign * GALAXY_CACHE_RADIUS_PARSECS * PARSEC, 0),
    )
    const current = integrateGalaxyRay(
      field,
      translated,
      direction,
      options,
    ).rgbNanowatts
    current.forEach((value, channel) =>
      expect(Math.abs(value / cached[channel]! - 1)).toBeLessThan(0.01),
    )

    const schedule = new GalaxyCacheSchedule({ faceSize: 16, tileSize: 8 })
    schedule.configure(origin, field)
    for (let tile = schedule.next(); tile !== null; tile = schedule.next())
      schedule.complete(tile)
    const baked = schedule.selected
    schedule.configure(
      UV.translate(origin, vec3(0, sign * 0.149 * PARSEC, 0)),
      field,
    )
    expect(schedule.selected).toBe(baked)
    schedule.configure(
      UV.translate(origin, vec3(0, sign * 0.151 * PARSEC, 0)),
      field,
    )
    expect(schedule.selected).toBeNull()
    schedule.configure(origin, field)
    expect(schedule.selected).toBe(baked)
  },
)
