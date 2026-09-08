import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { TEXTURE_SOURCES } from './textureSources.ts'
import type { TextureManifest } from './textures.ts'

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
    const entry = manifest.textures.find(
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
