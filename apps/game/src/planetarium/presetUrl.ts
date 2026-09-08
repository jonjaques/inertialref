import {
  decodePictures,
  DEFAULT_PICTURE_PROCESSING,
  findPicture,
  type Picture,
} from '@inertialref/devtools'
import { PLANETARIUM, QUERY } from '../pages/paths.ts'

const MAX_SHOT_LENGTH = 16_000
const SHOT_VERSION = '2'

// Query values have no types. These leaf types keep a seed like "123" a string
// and distinguish infinite focus from a label whose text happens to be "null".
const FIELD_TYPES = {
  id: 'string',
  label: 'string',
  why: 'string',
  seed: 'string',
  address: 'string',
  time: 'number',
  fovDeg: 'number',
  'framing.kind': 'string',
  'framing.composition': 'string',
  'framing.state.azimuth': 'number',
  'framing.state.elevation': 'number',
  'framing.state.distance': 'number',
  'framing.look.yaw': 'number',
  'framing.look.pitch': 'number',
  'framing.basis.x': 'number',
  'framing.basis.y': 'number',
  'framing.basis.z': 'number',
  'framing.basis.w': 'number',
  'framing.tracking.address': 'string',
  'framing.tracking.referenceTime': 'number',
  'framing.surface': 'null',
  'framing.surface.latitude': 'number',
  'framing.surface.longitude': 'number',
  'framing.surface.height': 'number',
  'framing.surface.heading': 'number',
  'framing.surface.pitch': 'number',
  'lens.focalLength': 'number',
  'lens.gauge': 'number',
  'lens.zoom': 'number',
  'lens.fStop': 'number',
  'lens.focus': 'nullable-number',
  'lens.shutter': 'number',
  'lens.iso': 'number',
  'processing.mode': 'string',
  'processing.look': 'string',
  'processing.compensation': 'number',
  'processing.rate': 'number',
  'processing.range.bright': 'number',
  'processing.range.dark': 'number',
  'processing.balance': 'number',
} as const
const SHOT_ROOTS = new Set([
  ...Object.keys(FIELD_TYPES).map((key) => key.split('.')[0]),
  'generation',
])
const isShotField = (key: string) => SHOT_ROOTS.has(key.split('.')[0])
const invalidLink = () =>
  new Error('This shot link is invalid. Ask for a new link or a JSON export.')

function fieldType(
  key: string,
): (typeof FIELD_TYPES)[keyof typeof FIELD_TYPES] {
  if (Object.hasOwn(FIELD_TYPES, key))
    return FIELD_TYPES[key as keyof typeof FIELD_TYPES]
  if (
    /^generation\.[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) &&
    !['__proto__', 'constructor', 'prototype'].includes(key.split('.')[1]!)
  )
    return 'number'
  throw new Error(`Unknown shot field: ${key}`)
}

function flatten(value: unknown, params: URLSearchParams, path = ''): void {
  if (value === undefined) return
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatten(child, params, path ? `${path}.${key}` : key)
    return
  }
  fieldType(path)
  params.set(path, Object.is(value, -0) ? '-0' : String(value))
}

function readField(key: string, value: string): string | number | null {
  const type = fieldType(key)
  if (type === 'string') return value
  if ((type === 'null' || type === 'nullable-number') && value === 'null')
    return null
  if (
    type !== 'null' &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  throw new Error(`Invalid value for shot field: ${key}`)
}

function expand(params: URLSearchParams): Record<string, unknown> {
  const picture: Record<string, unknown> = { generation: {} }
  for (const [key, text] of params) {
    if (!isShotField(key)) continue
    const value = readField(key, text)
    const path = key.split('.')
    let parent = picture
    for (const part of path.slice(0, -1)) {
      if (!Object.hasOwn(parent, part)) parent[part] = {}
      const child = parent[part]
      if (child === null || typeof child !== 'object') throw invalidLink()
      parent = child as Record<string, unknown>
    }
    const leaf = path.at(-1)!
    if (Object.hasOwn(parent, leaf)) throw invalidLink()
    parent[leaf] = value
  }
  return picture
}

export function presetLink(id: string): string {
  findPicture(id)
  return `${PLANETARIUM}?${QUERY.preset}=${encodeURIComponent(id)}`
}

/** Dotted keys mirror the picture object; URLSearchParams owns text escaping. */
export function pictureLink(picture: Picture, save = false): string {
  const [portable] = decodePictures({
    format: 'inertialref/presets',
    version: 2,
    pictures: [
      {
        ...picture,
        processing: picture.processing ?? DEFAULT_PICTURE_PROCESSING,
      },
    ],
  })
  const params = new URLSearchParams({ [QUERY.shot]: SHOT_VERSION })
  flatten(portable, params)
  if (save) params.set(QUERY.save, '1')
  if (params.toString().length > MAX_SHOT_LENGTH)
    throw new Error(
      'This shot is too large for a link. Export its JSON file instead.',
    )
  return `${PLANETARIUM}?${params}`
}

export function readPictureLink(params: URLSearchParams): {
  picture: Picture | null
  save: boolean
} {
  const id = params.get(QUERY.preset)
  const shot = params.get(QUERY.shot)
  const fields = [...params.keys()].filter(isShotField)
  if (pictureQueryKey(params).length > MAX_SHOT_LENGTH)
    throw new Error(
      'This shot link is too large. Import its JSON file instead.',
    )
  for (const key of [...fields, QUERY.preset, QUERY.shot, QUERY.save])
    if (params.getAll(key).length > 1)
      throw new Error(`Repeated shot field: ${key}`)
  const hasFields = fields.some((key) => key !== QUERY.seed)
  if (id !== null && (shot !== null || hasFields))
    throw new Error('This link names two presets. Use either preset or shot.')
  if (id !== null)
    return { picture: findPicture(id), save: params.get(QUERY.save) === '1' }
  if (shot === null && !hasFields) return { picture: null, save: false }
  if (shot !== '1' && shot !== SHOT_VERSION)
    throw new Error('Expected a shot link with shot=1 or shot=2.')
  const pictures = decodePictures({
    format: 'inertialref/presets',
    version: Number(shot),
    pictures: [expand(params)],
  })
  return { picture: pictures[0]!, save: params.get(QUERY.save) === '1' }
}

/** Dialog and diagnostic queries must not restore the camera a second time. */
export function pictureQueryKey(params: URLSearchParams): string {
  const view = new URLSearchParams(
    [...params].filter(
      ([key]) => isShotField(key) || key === QUERY.shot || key === QUERY.preset,
    ),
  )
  view.sort()
  return view.toString()
}

/** A new focus releases the shot, while retaining the running world's seed. */
export function withoutPictureLink(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const key of [...next.keys()])
    if (
      (isShotField(key) && key !== QUERY.seed) ||
      key === QUERY.preset ||
      key === QUERY.shot ||
      key === QUERY.save
    )
      next.delete(key)
  return next
}

/** Keep diagnostics while replacing the view document. */
export function withPictureLink(
  current: URLSearchParams,
  link: string,
): URLSearchParams {
  const next = withoutPictureLink(current)
  next.delete(QUERY.at)
  for (const [key, value] of new URL(link, 'https://inertialref.invalid')
    .searchParams)
    next.set(key, value)
  return next
}
