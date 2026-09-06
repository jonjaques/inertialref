import { describe, expect, it } from 'vitest'
import { PICTURES } from '@inertialref/devtools'
import { pictureLink, readPictureLink, presetLink } from './presetUrl.ts'

const query = (path: string) =>
  new URL(path, 'https://inertialref.test').searchParams

describe('preset URLs', () => {
  it('opens a built-in by its stable ID', () => {
    expect(presetLink('earthrise')).toBe('/planetarium?preset=earthrise')
    expect(readPictureLink(query(presetLink('earthrise'))).picture?.id).toBe(
      'earthrise',
    )
  })
  it('carries every camera and lens setting and the optional save prompt', () => {
    const picture = {
      ...PICTURES.find((one) => one.framing.kind === 'camera')!,
      label: 'A shoreline / 夜 🌒',
    }
    const path = pictureLink(picture, true)
    const result = readPictureLink(query(path))
    expect(result.picture).toEqual(picture)
    expect(result.save).toBe(true)
    expect(query(path).get('seed')).toBe(picture.seed)
  })
  it('rejects malformed, ambiguous, unknown and oversized shots', () => {
    for (const search of [
      'preset=missing',
      'shot=broken',
      'preset=earthrise&shot={}',
      `shot=${'x'.repeat(20000)}`,
    ])
      expect(() => readPictureLink(new URLSearchParams(search))).toThrow()
  })
})
