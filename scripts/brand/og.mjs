/*
 * The share card — `og.png`, 1200x630.
 *
 * It is the front door, reduced to the parts that survive being 300 px wide in
 * a chat window. `pages/HomePage.tsx` composes a poster: a gradient panel of
 * type on the left, a lit planet filling the right, and the star's anamorphic
 * streak running under the wordmark. That composition is reproduced here rather
 * than invented, because the card is a promise about what the link opens.
 *
 * What it deliberately is *not* is a screenshot. The real frame is a WebGPU
 * render of a generated world at a wall-clock camera phase, so a screenshot
 * pipeline would need a GPU in the build, and the picture would change every
 * time somebody regenerated it. This is drawn, so it is the same card every
 * time and `pnpm brand --check` can hold it to that.
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

/*
 * The star, and the planet it lights.
 *
 * The planet's centre is off the bottom-right corner so only its limb is in
 * frame — a full disc centred in the right third reads as a stock globe, where
 * an arc leaving the frame reads as being near something. The star sits above
 * and outside it, which is what puts the terminator across the visible limb
 * instead of flattening it.
 */
const STAR = { x: 1094, y: 148, r: 15 }
const PLANET = { x: 1130, y: 720, r: 470 }

/**
 * The sub-stellar point, in the planet gradient's own coordinates.
 *
 * Derived rather than eyeballed: move the star or the planet above and the
 * terminator follows, which is the whole reason those two are constants and
 * this is not a third one to keep in step with them.
 */
const SUBSTELLAR = {
  x: 0.5 + (STAR.x - PLANET.x) / (2 * PLANET.r),
  y: 0.5 + (STAR.y - PLANET.y) / (2 * PLANET.r),
}

/**
 * How far past the limb the falloff runs, as a fraction of the disc.
 *
 * The one number on this card that is a picture rather than a fact. At 0.5 the
 * gradient ends exactly on the limb, which is the honest reading — and the
 * star is nearly edge-on here, so the honest reading is a two-pixel crescent
 * and a black ball. Stretching the scale to 0.72 keeps the terminator running
 * the right way across the visible face and gives it something to run across.
 * The card is a drawing of the front door, not a render of it.
 */
const LIT_SPREAD = 0.62

/*
 * A hundred and forty stars, from a fixed seed.
 *
 * Hand-placing them would be forty lines of magic numbers; `Math.random()`
 * would make the card different on every build and turn `pnpm brand --check`
 * into noise. This is the same trade the simulation makes everywhere — a seed
 * is a decision you can re-read — so it is the same 32-bit mix, spelled out
 * rather than imported because `packages/*` has no business being a build
 * dependency of a poster.
 *
 * They are drawn *behind* the planet and the panel, which is what keeps them
 * out of the type: only the wedge of open sky above the limb ever shows any.
 */
const STAR_SEED = 0x9e3779b9
const STAR_COUNT = 140

function scatter() {
  let state = STAR_SEED
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const stars = []
  for (let index = 0; index < STAR_COUNT; index += 1) {
    const x = next() * OG_WIDTH
    const y = next() * OG_HEIGHT
    // Apparent magnitude, roughly: many faint, few bright. The cube is what
    // stops an even scatter of identical dots reading as a texture.
    const brightness = next() ** 3
    const radius = 0.5 + brightness * 1.6
    const opacity = 0.18 + brightness * 0.62
    stars.push(
      `    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" fill="#e0f2fe" opacity="${opacity.toFixed(3)}" />`,
    )
  }
  return stars.join('\n')
}

const STARFIELD = scatter()

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

  /* `type-body` at poster scale: Instrument Sans, regular, no tracking. */
  const lead = { role: 'sans', size: 25, wght: 400 }
  const leadOne = await outline(
    'A spaceflight simulator, built in the open.',
    lead,
  )
  const leadTwo = await outline('The galaxy is derived, not downloaded.', lead)

  /*
   * The three figures from the front door's `SPEC`, in the registers it uses
   * them in: the number is Instrument (Martian Mono at 87.5%, because it is a
   * measurement) and the label is structure (Archivo caps at 78%).
   *
   * The captions are uppercased *here*, at the draw, for the same reason
   * `type-label` does it in CSS: the strings stay title case wherever they are
   * written, so nothing that reads them aloud or copies them inherits a shout.
   */
  const figures = [
    ['7,123', 'Real Systems'],
    ['150 ly', 'Catalogued'],
    ['0', 'To Install'],
  ]
  const spec = []
  let column = GUTTER
  for (const [value, label] of figures) {
    const number = await outline(value, {
      role: 'mono',
      size: 27,
      wdth: 87.5,
      wght: 500,
      tracking: -0.015,
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
    wdth: 87.5,
    wght: 400,
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <!-- The lit hemisphere. The gradient's end circle is the planet's own
         circle and its focal point is the sub-stellar point, so an offset is
         distance from where the star is overhead. That is what makes the
         falloff a terminator rather than a vignette: a radial fill centred on
         the disc lights the middle and darkens the rim, which is the one thing
         a lit sphere never does. -->
    <radialGradient id="planet" cx="0.5" cy="0.5" r="${LIT_SPREAD}" fx="${SUBSTELLAR.x.toFixed(3)}" fy="${SUBSTELLAR.y.toFixed(3)}">
      <stop offset="0%" stop-color="#bae6fd" stop-opacity="1" />
      <stop offset="10%" stop-color="#7dd3fc" stop-opacity="1" />
      <stop offset="24%" stop-color="#38bdf8" stop-opacity="1" />
      <stop offset="38%" stop-color="#0ea5e9" stop-opacity="1" />
      <stop offset="52%" stop-color="#0369a1" stop-opacity="1" />
      <stop offset="66%" stop-color="#075985" stop-opacity="1" />
      <stop offset="79%" stop-color="#0c2b45" stop-opacity="1" />
      <stop offset="91%" stop-color="#050d1c" stop-opacity="1" />
      <stop offset="100%" stop-color="${SLATE_950}" stop-opacity="1" />
    </radialGradient>
    <!-- Atmosphere: a stroke on the limb, brightest where the star is and gone
         by the terminator. Filled behind the disc instead it is a halo all the
         way round, which reads as a glow effect rather than as air. -->
    <linearGradient id="rim" x1="0.1" y1="0.95" x2="0.7" y2="0">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0" />
      <stop offset="45%" stop-color="#7dd3fc" stop-opacity="0.18" />
      <stop offset="100%" stop-color="#e0f2fe" stop-opacity="0.85" />
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0%" stop-color="#e0f2fe" stop-opacity="0.9" />
      <stop offset="35%" stop-color="#7dd3fc" stop-opacity="0.28" />
      <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0" />
    </radialGradient>
    <!-- The anamorphic streak. A blade, not a halo: it is the artefact the
         front door is composed around, and it is what carries light across the
         type instead of leaving the left third flat. -->
    <linearGradient id="streak" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0" />
      <stop offset="38%" stop-color="#bae6fd" stop-opacity="0.30" />
      <stop offset="50%" stop-color="#f0f9ff" stop-opacity="0.55" />
      <stop offset="62%" stop-color="#bae6fd" stop-opacity="0.30" />
      <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="blade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="50%" stop-color="#ffffff" stop-opacity="1" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <mask id="bladeMask">
      <rect x="0" y="${STAR.y - 60}" width="${OG_WIDTH}" height="120" fill="url(#blade)" />
    </mask>
    <!-- The poster's dark side. It has to be solid *past* the type column and
         only then fade, or the last words of a line dissolve into the planet —
         a lovely effect and an unreadable sentence. -->
    <!-- The limb's scatter. A stroke alone is a drawn line; the same stroke
         blurred under it is the width of atmosphere the stroke is claiming. -->
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="9" />
    </filter>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${SLATE_950}" stop-opacity="1" />
      <stop offset="52%" stop-color="${SLATE_950}" stop-opacity="1" />
      <stop offset="74%" stop-color="${SLATE_950}" stop-opacity="0.86" />
      <stop offset="100%" stop-color="${SLATE_950}" stop-opacity="0" />
    </linearGradient>
  </defs>

  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${SLATE_950}" />

  <g>
${STARFIELD}
  </g>

  <g>
    <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r}" fill="url(#planet)" />
    <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r + 3}" fill="none" stroke="url(#rim)" stroke-width="9" filter="url(#soft)" opacity="0.85" />
    <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r + 1}" fill="none" stroke="url(#rim)" stroke-width="2.5" />
  </g>

  <circle cx="${STAR.x}" cy="${STAR.y}" r="${STAR.r * 8}" fill="url(#glow)" />
  <rect x="0" y="${STAR.y - 60}" width="${OG_WIDTH}" height="120" fill="url(#streak)" mask="url(#bladeMask)" />
  <circle cx="${STAR.x}" cy="${STAR.y}" r="${STAR.r}" fill="#f0f9ff" />

  <rect width="${OG_WIDTH * 0.78}" height="${OG_HEIGHT}" fill="url(#panel)" />

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
