/*
 * The share card — `og.png`, 1200x630.
 *
 * It is the front door, reduced to the parts that survive being 300 px wide in
 * a chat window: a column of type on the left, and behind it a real frame of
 * the simulation. `pages/HomePage.tsx` composes the same poster live — type
 * over a lit world with the star's flare running under the wordmark — and this
 * reproduces that composition rather than inventing one, because the card is a
 * promise about what the link opens.
 *
 * **The background is a render, and it is checked in.** It used to be drawn:
 * an SVG planet with six continent paths, a seeded starfield and a hand-built
 * anamorphic blade. That was the right call while the reason stood — a
 * screenshot pipeline would put a GPU in the build, and a frame captured on
 * every regeneration would make `pnpm brand --check` mean nothing — and it
 * produced a cyan marble with grey amoebas on it, because six bezier blobs is
 * not what Earth looks like and a drawn flare is not what a lens does.
 *
 * Both objections are about the *build*, not about the picture, and a
 * committed plate answers both. `design/brand/og-plate.png` is one frame of
 * the real renderer, captured once, sitting beside `brandmark.svg` as the
 * other thing the brand is drawn from. The build composites type over it with
 * `sharp` and never touches a GPU; the card is the same card every time
 * because the plate is a file in the tree. Re-capturing it is a deliberate
 * commit, which is exactly the property the drawing had.
 *
 * **What is in the plate, so nothing here draws it twice:** the star, its
 * ghosts and its anamorphic streak — a real one, from
 * `apps/game/src/render/flare.ts` — the atmosphere on the limb, the terminator,
 * the ocean's specular glint, the clouds, the terrain and the stars behind it
 * all. This file draws the scrim and the type and nothing else.
 *
 * **How the plate was framed**, so it can be framed again. Earth at ~1020 km,
 * a hair past the terminator, looking along the limb into a sunrise, with the
 * star clear of the horizon so the flare has room. In `pnpm dev` at
 * `/play/solo`, with `engine.showShip = false`:
 *
 *     camera 1.16 body radii from Earth's centre
 *     phase (sun–body–camera) 95°, so the near ground is at dusk
 *     the camera around the terminator ring far enough to bring the Red Sea
 *       and the Gulf under it, rolled 6° so the limb climbs to the right
 *     aimed so the star lands at (0.865, 0.205) of the frame
 *     captured at 3200x1680 and reduced to 1200x630, which is the only
 *       antialiasing the limb gets
 *
 * Every colour below is a Tailwind step already in `index.css`, written as a
 * hex literal with the step named — the same convention that file uses, and for
 * the same reason: a bare triple is unreadable next to the palette it belongs
 * to. The type steps are quoted from `index.css` too, axis by axis, so a change
 * to the display voice is one number here.
 */
import { SITE } from '../../apps/game/src/site.ts'
import { readMark, fit, measure } from './mark.mjs'
import { outline } from './type.mjs'

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

/** The rendered frame the type sits on. Already 1200x630; see the header. */
export const OG_PLATE = new URL(
  '../../design/brand/og-plate.png',
  import.meta.url,
)

const SLATE_950 = '#020617'
const SLATE_800 = '#1e293b'
const SLATE_500 = '#64748b'
const SLATE_400 = '#94a3b8'
const SLATE_300 = '#cbd5e1'
const SLATE_50 = '#f8fafc'
const SKY_400 = '#38bdf8'
const SKY_200 = '#bae6fd'

/** The left margin, and the type column's left edge. */
const GUTTER = 80

/** A text path, placed by its baseline. */
const place = (run, x, y, fill) =>
  `<path transform="translate(${x} ${y})" d="${run.d}" fill="${fill}" />`

export async function composeOgCard() {
  const mark = await readMark()
  const box = await measure(mark)

  /* The mark, at the size a favicon is not: 52 px, where the shear on each bar
     is a form rather than a suggestion. */
  const MARK_SIZE = 52
  const markFit = fit(box, { canvas: MARK_SIZE, size: MARK_SIZE })

  /*
   * `type-display`: Archivo, wdth 70%, wght 700, tracking -0.005em.
   *
   * Two runs rather than one, because the name is two tones — the same move the
   * mark makes, one form and the brighter half leading. Laid out separately and
   * placed end to end, which costs the l→R kern pair; Archivo has no kern
   * there, and the alternative is splitting a shaped run by glyph index, which
   * breaks the first time a ligature crosses the seam.
   */
  const display = {
    role: 'display',
    size: 104,
    wdth: 70,
    wght: 700,
    tracking: -0.005,
  }
  const first = await outline('Inertial', display)
  const second = await outline('Ref', display)

  /* `type-body` at poster scale: IBM Plex Sans, regular, no tracking. */
  const lead = { role: 'sans', size: 25, wght: 400 }
  const leadOne = await outline(
    'A spaceflight simulator, built in the open.',
    lead,
  )
  const leadTwo = await outline('The galaxy is derived, not downloaded.', lead)

  /*
   * The three figures from the front door's `SPEC`, in the registers it uses
   * them in: the number is Instrument (`type-stat` — Plex Mono at 600, because
   * it is a measurement) and the label is structure (Archivo caps at 78%).
   *
   * The number carries no width: Plex Mono has no width axis, and per ADR-0024
   * it needs none — its advance sets the same reading at natural width that
   * Martian Mono only reached compressed to 87.5%.
   *
   * The captions are uppercased *here*, at the draw, for the same reason
   * `type-label` does it in CSS: the strings stay title case wherever they are
   * written, so nothing that reads them aloud or copies them inherits a shout.
   */
  const figures = [
    ['7,123', 'Real Systems'],
    ['150 ly', 'Cataloged'],
    ['0', 'To Install'],
  ]
  const spec = []
  let column = GUTTER
  for (const [value, label] of figures) {
    const number = await outline(value, {
      role: 'mono',
      size: 27,
      wght: 600,
      tracking: -0.01,
    })
    const caption = await outline(label.toUpperCase(), {
      role: 'display',
      size: 15,
      wdth: 78,
      wght: 600,
      tracking: 0.1,
    })
    spec.push({ number, caption, x: column })
    column += Math.max(number.width, caption.width) + 46
  }

  const host = await outline(SITE.host, {
    role: 'mono',
    size: 17,
    wght: 400,
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <!--
      The scrim, and why it is nearly nothing.

      The drawn card needed a slab: it painted a planet across the right two
      thirds and then had to take the left third back to have anywhere to set
      type. The plate is framed so the type column is already open sky, so what
      is left for a scrim to do is guarantee the two places the picture reaches
      into the column — the star's third ghost, a dark red ring that lands
      behind the rule, and the limb climbing into the bottom left — and to sink
      the sky from the render's pure black to the site's slate-950, so the card
      and the page it opens are the same colour.

      It therefore ends at 62%, well short of the terminator. A slab wide enough
      to cover the old planet would erase the sunrise, which is the picture.
    -->
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${SLATE_950}" stop-opacity="0.88" />
      <stop offset="28%" stop-color="${SLATE_950}" stop-opacity="0.8" />
      <stop offset="44%" stop-color="${SLATE_950}" stop-opacity="0.52" />
      <stop offset="56%" stop-color="${SLATE_950}" stop-opacity="0.2" />
      <stop offset="68%" stop-color="${SLATE_950}" stop-opacity="0" />
    </linearGradient>
    <!--
      The floor. The limb climbs into the bottom left corner under the last two
      lines of type, and the scrim above is horizontal, so it cannot see that.
      The same guarantee in the axis the scrim has nothing to say about.

      Radial, and painted across the whole canvas rather than a rectangle over
      the corner, because **a partial rectangle has an edge**. The first version
      of this was a vertical gradient in a 672-wide box and the box's right side
      was a visible seam running down through the terminator — a straight line
      across a photograph, which is the one thing a scrim must never be. A
      gradient that reaches zero before it reaches anything can be as wide as
      the card.
    -->
    <radialGradient id="floor" cx="0.16" cy="1" r="0.66">
      <stop offset="0%" stop-color="${SLATE_950}" stop-opacity="0.82" />
      <stop offset="48%" stop-color="${SLATE_950}" stop-opacity="0.4" />
      <stop offset="78%" stop-color="${SLATE_950}" stop-opacity="0.1" />
      <stop offset="100%" stop-color="${SLATE_950}" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#scrim)" />
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#floor)" />

  <g transform="translate(${GUTTER} 72)">
    <g transform="${markFit.attribute()}">
${mark.paths.map(({ d, fill }) => `      <path d="${d}" fill="${fill}" />`).join('\n')}
    </g>
  </g>

  ${place(first, GUTTER, 236, SLATE_50)}
  ${place(second, GUTTER + first.width, 236, SKY_400)}

  ${place(leadOne, GUTTER, 296, SLATE_300)}
  ${place(leadTwo, GUTTER, 332, SLATE_400)}

  <rect x="${GUTTER}" y="380" width="470" height="1" fill="${SLATE_800}" />

${spec
  .map(
    ({ number, caption, x }) =>
      `  ${place(number, x, 428, SKY_200)}\n  ${place(caption, x, 456, SLATE_400)}`,
  )
  .join('\n')}

  ${place(host, GUTTER, 556, SLATE_500)}
</svg>
`
}
