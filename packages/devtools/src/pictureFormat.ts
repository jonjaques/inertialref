import {
  findComposition,
  ELEVATION_LIMIT,
  MAX_OBSERVER_DISTANCE,
} from '@inertialref/rendering'
import { parseAddress } from '@inertialref/universe'
import type { Picture } from './pictures.ts'

export const MAX_PICTURES = 500
export const MAX_FILE_PICTURES = 1000
export const MAX_PICTURE_BYTES = 2_000_000
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
const angle = (value: unknown): boolean => number(value, -1e9, 1e9)
const pitch = (value: unknown): boolean =>
  number(value, -ELEVATION_LIMIT, ELEVATION_LIMIT)

export function isPicture(value: unknown): value is Picture {
  if (
    !record(value) ||
    !text(value.id, 128) ||
    !/^[a-zA-Z0-9_-]+$/.test(value.id) ||
    !text(value.label, 120) ||
    typeof value.why !== 'string' ||
    value.why.length > 1000 ||
    !record(value.generation) ||
    Object.keys(value.generation).length > 16 ||
    !Object.values(value.generation).every(
      (version) => number(version, 1, 1000000) && Number.isInteger(version),
    ) ||
    !text(value.seed, 256) ||
    !number(value.time, -3.15576e12, 3.15576e12) ||
    !text(value.address, 256)
  )
    return false
  try {
    parseAddress(
      value.address.startsWith('g:')
        ? value.address
        : `g:milky-way/${value.address}`,
    )
  } catch {
    return false
  }
  if (value.fovDeg !== undefined && !number(value.fovDeg, 0.1, 150))
    return false
  if (value.lens !== undefined) {
    const lens = value.lens
    if (
      !record(lens) ||
      !number(lens.focalLength, 0.001, 1e6) ||
      !number(lens.gauge, 1, 1000) ||
      !number(lens.zoom, 0.001, 1e6) ||
      !number(lens.fStop, 0.1, 128) ||
      !number(lens.shutter, 0.000001, 3600) ||
      !number(lens.iso, 1, 1e7) ||
      !(lens.focus === null || number(lens.focus, 0.001, 1e20))
    )
      return false
  }
  const f = value.framing
  if (!record(f)) return false
  switch (f.kind) {
    case 'rise':
      return true
    case 'compose':
      if (!text(f.composition, 128)) return false
      try {
        findComposition(f.composition)
        return true
      } catch {
        return false
      }
    case 'camera': {
      if (value.lens === undefined || !record(f.state) || !record(f.look))
        return false
      if (
        !angle(f.state.azimuth) ||
        !pitch(f.state.elevation) ||
        !number(f.state.distance, 0.001, MAX_OBSERVER_DISTANCE) ||
        !angle(f.look.yaw) ||
        !pitch(f.look.pitch)
      )
        return false
      if (f.surface === null) return true
      const s = f.surface
      return (
        record(s) &&
        number(s.latitude, -Math.PI / 2, Math.PI / 2) &&
        angle(s.longitude) &&
        number(s.height, 0, MAX_OBSERVER_DISTANCE) &&
        angle(s.heading) &&
        pitch(s.pitch)
      )
    }
    default:
      return false
  }
}

/** Validate the whole file before a host changes its library or camera. */
export function decodePictures(data: unknown): readonly Picture[] {
  if (
    !record(data) ||
    data.format !== 'inertialref/presets' ||
    data.version !== 1 ||
    !Array.isArray(data.pictures) ||
    data.pictures.length > MAX_FILE_PICTURES
  )
    throw new Error(
      'Expected an InertialRef presets file, version 1 (up to 1,000 shots).',
    )
  const ids = new Set<string>()
  for (const [index, picture] of data.pictures.entries()) {
    if (!isPicture(picture))
      throw new Error(`Invalid preset at position ${index + 1}.`)
    if (ids.has(picture.id))
      throw new Error(`Duplicate preset ID: ${picture.id}`)
    ids.add(picture.id)
  }
  return data.pictures as Picture[]
}

export function encodePictures(pictures: readonly Picture[]): string {
  return (
    JSON.stringify(
      { format: 'inertialref/presets', version: 1, pictures },
      null,
      2,
    ) + '\n'
  )
}

/** Importing the same file again is harmless. ID conflicts preserve both shots. */
export function mergePictures(
  held: readonly Picture[],
  incoming: readonly Picture[],
  limit = MAX_PICTURES,
): readonly Picture[] {
  const result = [...held]
  for (const picture of incoming) {
    if (result.some((one) => signature(one) === signature(picture))) continue
    let id = picture.id
    let suffix = 2
    while (result.some((one) => one.id === id))
      id = `${picture.id.slice(0, 115)}-${suffix++}`
    result.push({ ...picture, id })
  }
  if (result.length > limit)
    throw new Error(`This library can hold up to ${limit} presets.`)
  return result
}

function signature(picture: Picture): string {
  return JSON.stringify({ ...picture, id: '' }, (_key, value: unknown) =>
    record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  )
}
