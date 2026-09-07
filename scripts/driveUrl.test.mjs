import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { PICTURES, encodePictures } from '../packages/devtools/src/index.ts'
import { readPictureLink } from '../apps/game/src/planetarium/presetUrl.ts'
import { driveUrl } from './driveUrl.mjs'

describe('driver view URLs', () => {
  it('prints a complete URL from CLI flags without opening a browser', () => {
    const output = execFileSync(
      process.execPath,
      [
        new URL('./drive.mjs', import.meta.url).pathname,
        '--preset',
        'centauri-daybreak',
        '--query',
        'lens.zoom=2',
        '--print-url',
      ],
      { encoding: 'utf8' },
    )
    const url = new URL(output.trim())
    expect(readPictureLink(url.searchParams).picture?.lens?.zoom).toBe(2)
  })
  it('opens a bundled fixture through the public picture URL', () => {
    const url = new URL(
      driveUrl({ url: 'http://localhost:8787/', preset: 'earthrise' }),
    )
    expect(url.origin).toBe('http://localhost:8787')
    expect(url.pathname).toBe('/planetarium')
    expect(url.searchParams.get('shot')).toBe('1')
    expect(url.searchParams.get('presentation')).toBe('occluded')
    expect(readPictureLink(url.searchParams).picture?.id).toBe('earthrise')
  })
  it('opens an exported shot and applies raw-text query overrides in order', () => {
    const picture = PICTURES.find((one) => one.framing.kind === 'camera')
    const url = new URL(
      driveUrl({
        url: 'http://localhost:5173/cinema/tng-intro?timing=trace',
        picture: JSON.parse(encodePictures([picture])),
        query: [
          'lens.zoom=2',
          'label=Night + day & sea=ice',
          'lens.zoom=3',
          'save=1',
        ],
      }),
    )
    const result = readPictureLink(url.searchParams)
    expect(result.picture).toEqual({
      ...picture,
      label: 'Night + day & sea=ice',
      lens: { ...picture.lens, zoom: 3 },
    })
    expect(result.save).toBe(true)
    expect(url.searchParams.get('timing')).toBe('trace')
  })
  it('preserves direct built-in links and supports ordinary non-planetarium queries', () => {
    const builtin = new URL(
      driveUrl({ url: 'http://localhost:5173/planetarium?preset=earthrise' }),
    )
    expect(builtin.searchParams.get('preset')).toBe('earthrise')
    const cinema = new URL(
      driveUrl({
        query: ['t=1150', 'play=1', 'presentation=visible'],
        url: 'http://localhost:5173/cinema/tng-intro',
      }),
    )
    expect(cinema.pathname).toBe('/cinema/tng-intro')
    expect(cinema.searchParams.get('t')).toBe('1150')
    expect(cinema.searchParams.get('presentation')).toBe('occluded')
  })
  it('replaces an existing shot and permits deliberate invalid URL fixtures', () => {
    const first = driveUrl({ preset: 'earthrise' })
    const second = new URL(
      driveUrl({
        url: first,
        preset: 'centauri-daybreak',
        query: ['lens.zoom=invalid'],
      }),
    )
    expect(second.searchParams.get('id')).toBe('centauri-daybreak')
    expect(second.searchParams.get('framing.surface.latitude')).not.toBeNull()
    expect(second.searchParams.get('lens.zoom')).toBe('invalid')
  })
  it('rejects ambiguous fixture sources, broken files and malformed overrides', () => {
    for (const options of [
      {
        preset: 'earthrise',
        picture: JSON.parse(encodePictures([PICTURES[0]])),
      },
      { preset: 'missing' },
      { picture: {} },
      { picture: JSON.parse(encodePictures([])) },
      { picture: JSON.parse(encodePictures(PICTURES)) },
      { query: ['lens.zoom'] },
      { query: ['=value'] },
    ])
      expect(() => driveUrl(options)).toThrow()
  })
})
