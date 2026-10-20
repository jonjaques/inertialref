import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { TEXTURE_SOURCES, type TextureSource } from './textureSources.ts'
import {
  elevationToNormal,
  luminanceToAlpha,
  plainImage,
  type TextureEntry,
  type TextureManifest,
} from './textures.ts'

const NIGHT = new URL(
  '../../../data/textures/earth_night.webp',
  import.meta.url,
)
const MANIFEST = new URL(
  '../../../data/textures/manifest.json',
  import.meta.url,
)

async function region(lon: number, lat: number) {
  const image = sharp(readFileSync(NIGHT))
  const { width, height } = await image.metadata()
  if (width === undefined || height === undefined)
    throw new Error('Earth night map has no dimensions')
  const crop = await image
    .extract({
      left: Math.round(((lon + 180) / 360) * width) - 8,
      top: Math.round(((90 - lat) / 180) * height) - 8,
      width: 16,
      height: 16,
    })
    .toBuffer()
  return sharp(crop).stats()
}

describe('the vendored Earth emission map', () => {
  // Blue Marble's colored land and ocean background is reflected scenery.
  // Emitting it lights almost the whole night side when exposure rises.
  it.each([
    ['Pacific Ocean', -140, 0],
    ['Sahara', 10, 23],
    ['Antarctica', 0, -82],
  ] as const)('keeps unlit %s dark', async (_name, lon, lat) => {
    const { channels } = await region(lon, lat)
    for (const channel of channels) expect(channel.max).toBeLessThanOrEqual(1)
  })

  it.each([
    ['New York', -74, 40.71],
    ['London', -0.12, 51.5],
    ['Tokyo', 139.69, 35.69],
  ] as const)('retains the light around %s', async (_name, lon, lat) => {
    const { channels } = await region(lon, lat)
    for (const channel of channels) expect(channel.max).toBeGreaterThan(128)
  })

  it('stores relative light intensity without a colored basemap', async () => {
    const { data, info } = await sharp(readFileSync(NIGHT))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let largestColorDifference = 0
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      largestColorDifference = Math.max(
        largestColorDifference,
        Math.max(r, g, b) - Math.min(r, g, b),
      )
    }
    expect(largestColorDifference).toBeLessThanOrEqual(1)
  })

  it('records the source and digest of the bytes it ships', () => {
    const manifest = JSON.parse(
      readFileSync(MANIFEST, 'utf8'),
    ) as TextureManifest
    const entry: TextureEntry | undefined = manifest.textures.find(
      ({ body, map }) => body === 'earth' && map === 'night',
    )
    const source = TEXTURE_SOURCES.find(
      ({ body, map }) => body === 'earth' && map === 'night',
    )
    const bytes = readFileSync(NIGHT)
    expect(entry?.source).toBe(source?.url)
    expect(entry?.bytes).toBe(bytes.length)
    expect(entry?.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    )
  })
})

/*
 * The three transforms, on images small enough to know every pixel of.
 *
 * Each source is made here by `sharp` and passed through the transform the
 * build uses, and the output is decoded back to raw channels. The elevation
 * fields are made at the output's own 2:1 size, so the resize is the identity
 * and every gradient is the one written; the others are 8 × 8 and exercise the
 * resize to 8 × 4.
 */

const stub = (overrides: Partial<TextureSource> = {}): TextureSource => ({
  body: 'test',
  map: 'normal',
  url: 'https://example.invalid/test.png',
  file: 'test.png',
  license: 'public-domain',
  credit: '',
  transform: 'elevation',
  width: 16,
  ...overrides,
})

/** A single-channel PNG of `value(x, y)`, at 8 or 16 bits. */
async function field(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
  sixteen = false,
): Promise<Buffer> {
  const pixels = sixteen
    ? new Uint16Array(width * height)
    : new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = value(x, y)
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .toColourspace(sixteen ? 'grey16' : 'b-w')
    .png()
    .toBuffer()
}

async function decode(webp: Buffer) {
  const { data, info } = await sharp(webp)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number, channel: number) =>
    data[(y * info.width + x) * info.channels + channel]!
  return { info, at }
}

/** The byte a unit normal's component is stored as. */
const encoded = (component: number) => Math.round((component * 0.5 + 0.5) * 255)

describe('elevationToNormal', () => {
  /*
   * A radius that makes a pixel 1,000 m on the ground north–south — πR / 8
   * rows — and a relief that makes one step of the ramp 1,000 / 7 m, so the
   * central difference across two rows is a slope of 1/7.
   */
  const radius = (8 * 1_000) / Math.PI
  const relief = 1_000

  it('gives a flat field the normal (0.5, 0.5, 1) everywhere', async () => {
    const flat = await field(8, 8, () => 90)
    const { info, at } = await decode(
      await elevationToNormal(flat, stub({ width: 8 })),
    )
    expect([info.width, info.height, info.channels]).toEqual([8, 4, 3])
    for (let y = 0; y < 4; y += 1)
      for (let x = 0; x < 8; x += 1) {
        expect(at(x, y, 0)).toBe(128)
        expect(at(x, y, 1)).toBe(128)
        expect(at(x, y, 2)).toBe(0)
      }
  })

  it.each([
    ['8-bit', false, 30],
    ['16-bit', true, 7_000],
  ] as const)(
    'gives a %s north–south ramp one constant tilt',
    async (_label, sixteen, step) => {
      // Rising southward: the surface faces north, so +Y (north) is positive.
      const ramp = await field(16, 8, (_x, y) => y * step, sixteen)
      const { at } = await decode(
        await elevationToNormal(ramp, stub({ radius, relief })),
      )
      const slope = 1 / 7
      const tilt = encoded(slope / Math.hypot(slope, 1))
      // The edge rows clamp at the pole and see half the difference.
      for (let y = 1; y < 7; y += 1)
        for (let x = 0; x < 16; x += 1) {
          expect(at(x, y, 0)).toBe(128)
          expect(at(x, y, 1)).toBe(tilt)
        }
    },
  )

  it('steepens an east–west slope by 1 / cos(latitude)', async () => {
    // Rising eastward and wrapping at the seam; the interior columns see
    // one step per pixel, and the pixel narrows toward the poles.
    const ramp = await field(16, 8, (x) => x * 10)
    const { at } = await decode(
      await elevationToNormal(ramp, stub({ radius, relief })),
    )
    const slopeAt = (y: number) => {
      const latitude = ((y + 0.5) / 8 - 0.5) * Math.PI
      return (
        (20 * relief) / 150 / (2 * 1_000) / Math.max(0.15, Math.cos(latitude))
      )
    }
    for (let y = 0; y < 8; y += 1) {
      const slope = slopeAt(y)
      // Facing east, so the normal leans west: −X.
      expect(at(5, y, 0)).toBe(encoded(-slope / Math.hypot(slope, 1)))
    }
    expect(at(5, 0, 0)).toBeLessThan(at(5, 3, 0))
  })

  it('marks the ocean in blue below the fraction of the range it names', async () => {
    const ramp = await field(16, 8, (_x, y) => y * 30)
    const { at } = await decode(
      await elevationToNormal(ramp, stub({ radius, relief, oceanBelow: 0.5 })),
    )
    // The range is 0 to 210; rows 0–3 (0 to 90) are at or below 105.
    for (let y = 0; y < 8; y += 1) expect(at(0, y, 2)).toBe(y <= 3 ? 255 : 0)
  })
})

describe('luminanceToAlpha', () => {
  it('turns a known gray into that alpha over white', async () => {
    const gray = await field(8, 8, () => 80)
    const { info, at } = await decode(
      await luminanceToAlpha(gray, stub({ transform: 'luminance', width: 8 })),
    )
    expect([info.width, info.height, info.channels]).toEqual([8, 4, 4])
    for (let y = 0; y < 4; y += 1)
      for (let x = 0; x < 8; x += 1)
        expect([0, 1, 2, 3].map((c) => at(x, y, c))).toEqual([
          255, 255, 255, 80,
        ])
  })
})

describe('plainImage', () => {
  const image = (channels: 3 | 4) =>
    sharp({
      create: {
        width: 8,
        height: 8,
        channels,
        background: { r: 200, g: 100, b: 50, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer()

  it.each([
    [3, 3],
    [4, 4],
  ] as const)(
    'resizes to 2:1 and keeps alpha only where a %s-channel source has it',
    async (channels, expected) => {
      const { info } = await decode(
        await plainImage(
          await image(channels),
          stub({ transform: 'image', width: 8 }),
        ),
      )
      expect([info.width, info.height, info.channels]).toEqual([8, 4, expected])
    },
  )
})
