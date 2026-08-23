/*
 * Type, as outlines.
 *
 * The share card is a PNG, so every word on it has to become a path before a
 * rasterizer ever sees it. Three things ruled out the obvious routes:
 *
 *   - **Pango, through sharp's `text` input.** It ignores `fontfile` for a
 *     WOFF2 and silently falls back — measured: the same 447x75 bitmap for
 *     Archivo, Martian Mono and no font at all. A share card that renders in
 *     whatever font the build machine happens to have is worse than one with no
 *     type on it, because it looks fine locally.
 *   - **resvg / librsvg with `@font-face`.** Neither loads a font out of the
 *     document, and neither reads WOFF2.
 *   - **fontkit's `getVariation()` on the WOFF2 directly.** It rebuilds a
 *     `TTFFont` from the *compressed* stream, so the new font's table directory
 *     is garbage and the first `cmap` lookup throws. `wawoff2` decompresses to
 *     a real SFNT first, and then it works.
 *
 * So: the same `@fontsource` files the site loads (`standard` — the subset that
 * carries both axes), decompressed in memory, varied on `wdth`/`wght`, laid out
 * with kerning and ligatures, and emitted as one path per string.
 *
 * The axes matter more than they sound. `type-display` is Archivo at
 * `font-stretch: 70%` and weight 700 — the condensed voice is the wordmark, and
 * a card set at the default 100% width is a different brand. Nothing here
 * hard-codes a width; `apps/game/src/index.css` is where the nine type steps
 * are defined and the callers below quote it.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { decompress } from 'wawoff2'

const FONT_DIR = new URL(
  '../../apps/game/node_modules/@fontsource-variable/',
  import.meta.url,
)

/**
 * The three faces, by the name `index.css` gives them.
 *
 * `-latin-standard-normal` is the exact file `standard.css` serves to a Latin
 * page — see the `@import`s at the top of `index.css` and the note there about
 * why it is `standard.css` and not `index.css`.
 */
const FILES = {
  display: 'archivo/files/archivo-latin-standard-normal.woff2',
  sans: 'instrument-sans/files/instrument-sans-latin-standard-normal.woff2',
  mono: 'martian-mono/files/martian-mono-latin-standard-normal.woff2',
}

/** Decompressed and parsed at most once each; a build asks for several strings. */
const loaded = new Map()

async function face(role) {
  const cached = loaded.get(role)
  if (cached !== undefined) return cached
  const path = fileURLToPath(new URL(FILES[role], FONT_DIR))
  let sfnt
  try {
    sfnt = Buffer.from(await decompress(await readFile(path)))
  } catch (cause) {
    throw new Error(
      `could not read ${FILES[role]} — run \`pnpm install\` first (${cause.message})`,
    )
  }
  const font = fontkit.create(sfnt)
  loaded.set(role, font)
  return font
}

/**
 * One string, as a single SVG path.
 *
 * The result is in **SVG coordinates with the baseline at y = 0** — x grows
 * right, y grows down — so a caller places it by translating to where it wants
 * the baseline, which is the one anchor that stays put when the size changes.
 * `capHeight` and `width` come back because a poster is laid out against cap
 * height and measured text, never against a line box.
 *
 * `tracking` is in em, the same unit `letter-spacing` takes in the stylesheet,
 * so a caller can copy the number out of the type step it is reproducing.
 */
export async function outline(
  text,
  { role = 'display', size, wdth, wght, tracking = 0 },
) {
  const base = await face(role)
  const varied =
    wdth === undefined && wght === undefined
      ? base
      : base.getVariation({
          ...(wdth === undefined ? {} : { wdth }),
          ...(wght === undefined ? {} : { wght }),
        })

  const scale = size / varied.unitsPerEm
  const step = tracking * varied.unitsPerEm
  const run = varied.layout(text)

  let pen = 0
  let d = ''
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index]
    // y is negated: font outlines grow up from the baseline, SVG grows down.
    const path = glyph.path.transform(
      scale,
      0,
      0,
      -scale,
      (pen + position.xOffset) * scale,
      -position.yOffset * scale,
    )
    const segment = path.toSVG()
    if (segment !== '') d += `${d === '' ? '' : ' '}${segment}`
    pen += position.xAdvance + step
  })

  return {
    d,
    // The trailing letter-space is not part of the word's width — including it
    // would push a right-aligned string off by a track.
    width: (pen - (run.glyphs.length > 0 ? step : 0)) * scale,
    capHeight: varied.capHeight * scale,
    ascent: varied.ascent * scale,
    descent: varied.descent * scale,
  }
}
