import {
  decodePictures,
  encodePictures,
  findPicture,
  type Picture,
} from '@inertialref/devtools'
import { PLANETARIUM, QUERY } from '../pages/paths.ts'

const MAX_SHOT_LENGTH = 16_000

export function presetLink(id: string): string {
  findPicture(id)
  return `${PLANETARIUM}?${QUERY.preset}=${encodeURIComponent(id)}`
}

/** The public file envelope travels unchanged in a link; no server owns the shot. */
export function pictureLink(picture: Picture, save = false): string {
  const shot = JSON.stringify(JSON.parse(encodePictures([picture])))
  if (shot.length > MAX_SHOT_LENGTH)
    throw new Error(
      'This shot is too large for a link. Export its JSON file instead.',
    )
  const params = new URLSearchParams({
    [QUERY.shot]: shot,
    [QUERY.seed]: picture.seed,
  })
  if (save) params.set(QUERY.save, '1')
  return `${PLANETARIUM}?${params}`
}

export function readPictureLink(params: URLSearchParams): {
  picture: Picture | null
  save: boolean
} {
  const id = params.get(QUERY.preset)
  const shot = params.get(QUERY.shot)
  if (id !== null && shot !== null)
    throw new Error('This link names two presets. Use either preset or shot.')
  if (id !== null)
    return { picture: findPicture(id), save: params.get(QUERY.save) === '1' }
  if (shot === null) return { picture: null, save: false }
  if (shot.length > MAX_SHOT_LENGTH)
    throw new Error(
      'This shot link is too large. Import its JSON file instead.',
    )
  let pictures: readonly Picture[]
  try {
    pictures = decodePictures(JSON.parse(shot))
  } catch {
    throw new Error(
      'This shot link is invalid. Ask for a new link or a JSON export.',
    )
  }
  if (pictures.length !== 1)
    throw new Error('A shot link must contain exactly one preset.')
  return { picture: pictures[0]!, save: params.get(QUERY.save) === '1' }
}

/** Keep diagnostics while replacing the view document. */
export function withPictureLink(
  current: URLSearchParams,
  link: string,
): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const key of [QUERY.at, QUERY.preset, QUERY.shot, QUERY.save])
    next.delete(key)
  for (const [key, value] of new URL(link, 'https://inertialref.invalid')
    .searchParams)
    next.set(key, value)
  return next
}
