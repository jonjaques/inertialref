import { decodePictures, findPicture } from '../packages/devtools/src/index.ts'
import {
  pictureLink,
  withPictureLink,
} from '../apps/game/src/planetarium/presetUrl.ts'
import { PLANETARIUM, QUERY } from '../apps/game/src/pages/paths.ts'

/** Build the same URL a person can share, before the driver starts a browser. */
export function driveUrl({
  url = 'http://localhost:5173/',
  preset,
  picture,
  query = [],
} = {}) {
  if (preset !== undefined && picture !== undefined)
    throw new Error('Use either --preset or --picture, not both.')
  let fixture
  if (preset !== undefined) fixture = findPicture(preset)
  if (picture !== undefined) {
    const pictures = decodePictures(picture)
    if (pictures.length !== 1)
      throw new Error(
        '--picture needs a JSON export containing exactly one preset.',
      )
    fixture = pictures[0]
  }
  const target = new URL(url)
  if (fixture !== undefined) {
    target.pathname = PLANETARIUM
    target.hash = ''
    target.search = withPictureLink(
      target.searchParams,
      pictureLink(fixture),
    ).toString()
    target.searchParams.delete('capture')
    target.searchParams.delete('name')
  }
  for (const entry of query) {
    const equals = entry.indexOf('=')
    if (equals < 1) throw new Error('--query expects key=value.')
    // Values are shell arguments, not encoded query strings. Splitting on every
    // equals sign or parsing them as a query would damage labels with & or +.
    target.searchParams.set(entry.slice(0, equals), entry.slice(equals + 1))
  }
  // Overrides may intentionally exercise an invalid link. Let the page report
  // that error; the driver only insists on excluding its own occlusion probe.
  target.searchParams.set(QUERY.presentation, 'occluded')
  return target.toString()
}
