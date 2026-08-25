import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { composeOgCard, OG_HEIGHT, OG_PLATE, OG_WIDTH } from './og.mjs'

/*
 * The share card is a captured frame with type over it, and this file is the
 * check that both halves are still what we think they are. Pixel diffs against
 * `og.png` would fail on a `sharp` bump; these assertions fail when a rewrite
 * drops the type column or the scrim, when the scrim grows back into the slab
 * that used to erase the picture, or when the plate goes missing or stops being
 * the size the card is composited at — which is the one thing about the plate a
 * test in Node can actually know.
 */

const svgOf = async () => await composeOgCard()

describe('the share card', () => {
  it('is the Open Graph canvas, 1200 by 630', async () => {
    const svg = await svgOf()
    expect(svg).toContain(`width="${OG_WIDTH}"`)
    expect(svg).toContain(`height="${OG_HEIGHT}"`)
    expect(svg).toContain(`viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}"`)
    expect(OG_WIDTH).toBe(1200)
    expect(OG_HEIGHT).toBe(630)
  })

  it('is the same drawing on every call', async () => {
    expect(await svgOf()).toBe(await svgOf())
  })

  it('draws the type column and the scrim, and nothing of the scene', async () => {
    const svg = await svgOf()
    expect(svg).toContain('id="scrim"')
    expect(svg).toContain('id="floor"')
    // The star, the planet and the starfield are in the plate now. A drawn one
    // reappearing means a merge put the old poster back on top of the render.
    expect(svg).not.toContain('id="planet"')
    expect(svg).not.toContain('id="streak"')
    expect(svg).not.toContain('id="land"')
  })

  it('keeps the scrim clear of the terminator', async () => {
    const svg = await svgOf()
    /*
     * The last stop of the horizontal scrim is fully transparent, and it is the
     * last one — so however the ramp is retuned, the right half of the card is
     * the render. The failure this catches is a solid `stop-opacity="1"` slab
     * creeping back in to fix a contrast problem that belongs to the framing.
     */
    const scrim = /<linearGradient id="scrim"[\s\S]*?<\/linearGradient>/.exec(
      svg,
    )?.[0]
    expect(scrim).toBeDefined()
    const stops = [...(scrim ?? '').matchAll(/stop-opacity="([\d.]+)"/g)].map(
      (match) => Number(match[1]),
    )
    expect(stops.at(-1)).toBe(0)
    expect(Math.max(...stops)).toBeLessThan(1)
  })

  it("has a plate to composite onto, at the card's own size", async () => {
    const png = await readFile(OG_PLATE)
    expect(png.length).toBeGreaterThan(0)
    // PNG signature, then IHDR: width and height are big-endian at 16 and 20.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH)
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT)
  })
})
