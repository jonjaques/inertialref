import { expect, it } from 'vitest'
import {
  decodePictures,
  encodePictures,
} from '../../packages/devtools/src/index.ts'
import { readPictureLink } from '../../apps/game/src/planetarium/presetUrl.ts'
import { cameraReviewPictures, reviewMarkdown } from './preview.mjs'

it('makes matched camera triplets and separately declared long exposures', () => {
  const pictures = cameraReviewPictures()
  expect(pictures).toHaveLength(20)
  expect(decodePictures(JSON.parse(encodePictures(pictures)))).toEqual(pictures)
  for (let offset = 0; offset < pictures.length; offset += 4) {
    const [enhanced, automatic, manual, long] = pictures.slice(
      offset,
      offset + 4,
    )
    expect(enhanced.framing.kind).toBe('camera')
    for (const [picture, mode] of [
      [enhanced, 'enhanced'],
      [automatic, 'automatic'],
      [manual, 'manual'],
    ]) {
      expect(picture.processing.mode).toBe(mode)
      expect(picture.framing).toEqual(enhanced.framing)
      expect(picture.time).toBe(enhanced.time)
      expect(picture.address).toBe(enhanced.address)
      expect(picture.lens).toEqual(enhanced.lens)
      expect(picture.lens).toMatchObject({
        shutter: 1 / 3200,
        fStop: 2.8,
        iso: 100,
        focus: null,
      })
      expect(Object.keys(picture.processing).sort()).toEqual([
        'balance',
        'compensation',
        'look',
        'mode',
        'range',
        'rate',
      ])
    }
    expect(long.framing).toEqual(manual.framing)
    expect(long.processing).toEqual(manual.processing)
    expect(long.lens).toEqual({ ...manual.lens, shutter: 2400 })
  }
  expect(
    pictures.find((one) => one.id === 'camera-review-earth-band-enhanced')
      .framing.state,
  ).toEqual({ azimuth: -Math.PI / 2, elevation: 0, distance: 25_000_000 })
})

it('uses the application codec for every Markdown link on the requested origin', () => {
  const pictures = cameraReviewPictures()
  const markdown = reviewMarkdown(pictures, 'https://example.invalid')
  const links = [...markdown.matchAll(/\]\((https?:\/\/[^)]+)\)/g)]
  expect(links).toHaveLength(pictures.length)
  links.forEach((match, index) => {
    const url = new URL(match[1])
    expect(url.origin).toBe('https://example.invalid')
    expect(readPictureLink(url.searchParams).picture).toEqual(pictures[index])
  })
  expect(markdown).toContain('2400 s')
  expect(markdown).toContain('Bennu')
  expect(markdown).toContain('Luna')
  expect(() => reviewMarkdown(pictures, 'file:///tmp/preview')).toThrow(/HTTP/)
})
