import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { decompress } from 'wawoff2'

/*
 * Glyph coverage is a fact about a file, not a family.
 *
 * A browser routes a codepoint to an `@font-face` by its declared
 * `unicode-range`, and when that file has no glyph for it the fallback is
 * silent — no tofu, just a platform font mid-figure. So every glyph the
 * interface depends on is checked twice, per vendored file: the stylesheet
 * routes it there, and the file's own cmap carries it. Never the foundry's
 * spec sheet, and never the declared range alone — the Plex subsets declare
 * U+2200-22FF and do not hold `⊕`.
 */

const CSS = new URL('../../apps/game/src/index.css', import.meta.url)
const FONTS = new URL('../../apps/game/src/assets/fonts/', import.meta.url)

/** The glyphs each vendored subset exists to carry. */
const REQUIRED = {
  'ibm-plex-mono-symbols.woff2': '′″⁰₀→≈∞≤π',
  'ibm-plex-sans-symbols.woff2': '′″⁰₀→≈∞≤Δμ',
  'noto-sans-math-symbols.woff2': '☉⊕Δμ',
}

/** `unicode-range` of each `@font-face` whose source is a vendored file. */
async function declaredRanges() {
  const css = await readFile(CSS, 'utf8')
  const ranges = new Map()
  for (const [block] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const file = /assets\/fonts\/([^'")]+)/.exec(block)?.[1]
    const range = /unicode-range:([^;]+);/.exec(block)?.[1]
    if (file === undefined || range === undefined) continue
    ranges.set(
      file,
      range.split(',').map((part) => {
        const [lo, hi = lo] = part.trim().replace(/^U\+/i, '').split('-')
        return [parseInt(lo, 16), parseInt(hi, 16)]
      }),
    )
  }
  return ranges
}

async function characterSet(file) {
  const sfnt = Buffer.from(
    await decompress(await readFile(fileURLToPath(new URL(file, FONTS)))),
  )
  return new Set(fontkit.create(sfnt).characterSet)
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

describe('the vendored symbol subsets', () => {
  for (const [file, glyphs] of Object.entries(REQUIRED)) {
    it(`${file} is routed every glyph it carries for the interface, and has it`, async () => {
      const range = (await declaredRanges()).get(file)
      expect(
        range,
        `index.css declares no @font-face for ${file}`,
      ).toBeDefined()
      const cmap = await characterSet(file)
      for (const glyph of glyphs) {
        const cp = glyph.codePointAt(0)
        expect(
          range.some(([lo, hi]) => lo <= cp && cp <= hi),
          `${glyph} ${hex(cp)} is outside ${file}'s unicode-range`,
        ).toBe(true)
        expect(
          cmap.has(cp),
          `${file} has no glyph for ${glyph} ${hex(cp)}`,
        ).toBe(true)
      }
    })
  }
})
