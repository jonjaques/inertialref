import { describe, expect, it } from 'vitest'
import { composeOgCard, OG_HEIGHT, OG_WIDTH } from './og.mjs'

/*
 * The share card is a drawing, not a screenshot, and this file is the check
 * that it is still the drawing we think it is. Pixel diffs against `og.png`
 * would fail on a sharp bump; these assertions fail when a rewrite drops the
 * planet, the streak, the type column, or the seed that makes the starfield
 * the same card every time.
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

  it('has the front-door pieces: planet, star, streak, type column', async () => {
    const svg = await svgOf()
    expect(svg).toContain('id="planet"')
    expect(svg).toContain('id="streak"')
    expect(svg).toContain('id="panel"')
    expect(svg).toContain('id="glow"')
    expect(svg).toContain('id="rim"')
  })

  it('lights land, ocean and cloud with one terminator', async () => {
    const svg = await svgOf()
    expect(svg).toContain('id="disk"')
    expect(svg).toContain('id="day"')
    expect(svg).toContain('id="land"')
    expect(svg).toContain('id="clouds"')
    expect(svg).toContain('mask="url(#day)"')
    expect(svg).toContain('clip-path="url(#disk)"')
  })

  it('scatters a seeded starfield rather than a texture of identical dots', async () => {
    const svg = await svgOf()
    const stars = [...svg.matchAll(/<circle [^>]*fill="#e0f2fe"/g)]
    expect(stars.length).toBeGreaterThan(100)
    const radii = new Set(
      stars.map((match) => /r="([^"]+)"/.exec(match[0])?.[1]),
    )
    expect(radii.size).toBeGreaterThan(20)
  })
})
