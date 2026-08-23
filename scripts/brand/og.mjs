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
 * Every color below is a Tailwind step already in `index.css`, written as a
 * hex literal with the step named — the same convention that file uses, and for
 * the same reason: a bare triple is unreadable next to the palette it belongs
 * to. The type steps are quoted from `index.css` too, axis by axis, so a change
 * to the display voice is one number here.
 *
 * The planet is Earth in the brand's sky/slate register, not a cyan marble.
 * A screenshot of `b:2` would be the honest picture and the wrong artifact:
 * it would move with the camera and it would need a GPU. Continents, clouds
 * and a terminator that shares one mask are how a drawing reads as a world
 * at 300 px without becoming a second renderer.
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
 * The planet's center sits just below the bottom edge so the visible face is a
 * northern hemisphere, not a stock globe parked in the right third. The star
 * sits above the limb, which is what puts the terminator across the visible
 * face instead of flattening it. Numbers chosen so more of the disk survives a
 * 300 px preview than the earlier limb-only crop — a cyan sliver there read as
 * a glow, not as a world.
 */
const STAR = { x: 1076, y: 152, r: 16 }
const PLANET = { x: 1116, y: 678, r: 488 }

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
 * How far past the limb the falloff runs, as a fraction of the disk.
 *
 * The one number on this card that is a picture rather than a fact. At 0.5 the
 * gradient ends exactly on the limb, which is the honest reading — and the
 * star is nearly edge-on here, so the honest reading is a two-pixel crescent
 * and a black ball. 0.70 keeps the terminator running the right way across the
 * visible face and leaves enough day side that a chat preview still reads as a
 * lit world rather than as a dark circle with a cyan rim.
 */
const LIT_SPREAD = 0.7

/*
 * A hundred and forty stars, from a fixed seed, plus a handful of brighter
 * ones with diffraction spikes in the open sky.
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
const BRIGHT_COUNT = 7

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
  for (let index = 0; index < BRIGHT_COUNT; index += 1) {
    const x = 560 + next() * 620
    const y = 24 + next() * 280
    const dx = x - PLANET.x
    const dy = y - PLANET.y
    if (dx * dx + dy * dy < PLANET.r * PLANET.r) continue
    const spike = 7 + next() * 8
    const opacity = 0.45 + next() * 0.35
    stars.push(
      `    <g opacity="${opacity.toFixed(3)}" fill="#e0f2fe" stroke="#e0f2fe">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.4" />
      <path d="M ${x.toFixed(1)} ${(y - spike).toFixed(1)} L ${x.toFixed(1)} ${(y + spike).toFixed(1)}" stroke-width="0.7" />
      <path d="M ${(x - spike * 1.6).toFixed(1)} ${y.toFixed(1)} L ${(x + spike * 1.6).toFixed(1)} ${y.toFixed(1)}" stroke-width="0.9" />
    </g>`,
    )
  }
  return stars.join('\n')
}

const STARFIELD = scatter()

/*
 * Continents, in planet-local coordinates, origin at the disk center, y down.
 *
 * The visible crop is the top of the disk, so these are a northern-hemisphere
 * reading of Earth — Americas on the left, Europe and Africa toward the
 * terminator — simplified until they read at 300 px. A NASA coastline at this
 * size is noise; four blobs with the right relative positions are a planet.
 * Land is slate-400 on a sky-700 ocean, and it is painted *after* the day-side
 * wash. Darker fill of the same hue reads as maria; the wash on top of land
 * turns continents into more cyan, which is how the first pass became a
 * cratered moon at 300 px.
 */
const LAND = [
  // North America: Alaska, a Hudson bite, the Gulf, a Mexico taper.
  'M -305 -255 C -355 -235 -350 -155 -300 -95 C -270 -55 -230 -35 -195 -55 C -175 -15 -160 20 -175 58 C -205 28 -220 -8 -200 -52 C -145 -28 -95 -75 -82 -140 C -68 -205 -95 -295 -165 -338 C -225 -365 -280 -310 -305 -255 Z',
  // Alaska, as its own mass so the west coast does not read as a bump.
  'M -330 -275 C -375 -255 -368 -210 -325 -205 C -295 -215 -300 -265 -330 -275 Z',
  // Greenland
  'M -100 -410 C -132 -370 -95 -325 -52 -348 C -28 -378 -58 -430 -100 -410 Z',
  // Europe, with a Scandinavian lift
  'M 8 -268 C -18 -240 2 -188 58 -198 C 78 -228 52 -270 28 -285 C 18 -300 12 -282 8 -268 Z',
  // British Isles
  'M -8 -282 C -22 -268 -4 -252 14 -264 C 8 -278 -2 -290 -8 -282 Z',
  // North Africa, just in frame at the bottom of the crop
  'M 22 -148 C -8 -88 48 -28 118 -62 C 128 -112 82 -172 22 -148 Z',
]

const CLOUDS = [
  { x: -200, y: -225, rx: 88, ry: 16, a: -16, o: 0.14 },
  { x: 48, y: -210, rx: 72, ry: 14, a: -10, o: 0.12 },
]

function surface() {
  const land = LAND.map((d) => `      <path d="${d}" />`).join('\n')
  const clouds = CLOUDS.map(
    ({ x, y, rx, ry, a, o }) =>
      `      <ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" transform="rotate(${a} ${x} ${y})" opacity="${o}" />`,
  ).join('\n')
  return `    <g id="land" fill="#94a3b8" transform="translate(${PLANET.x} ${PLANET.y})">
${land}
    </g>
    <g id="clouds" fill="#e0f2fe" transform="translate(${PLANET.x} ${PLANET.y})">
${clouds}
    </g>`
}

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
    ['150 ly', 'Cataloged'],
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

  const fx = SUBSTELLAR.x.toFixed(3)
  const fy = SUBSTELLAR.y.toFixed(3)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <!-- Day-side illumination, as a mask. White is lit; black is night. Ocean,
         land and cloud share this so the terminator is one edge, not three. -->
    <radialGradient id="daylight" cx="0.5" cy="0.5" r="${LIT_SPREAD}" fx="${fx}" fy="${fy}">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="42%" stop-color="#d4d4d8" />
      <stop offset="62%" stop-color="#71717a" />
      <stop offset="82%" stop-color="#27272a" />
      <stop offset="100%" stop-color="#000000" />
    </radialGradient>
    <mask id="day" maskUnits="userSpaceOnUse">
      <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r}" fill="url(#daylight)" />
    </mask>
    <clipPath id="disk">
      <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r}" />
    </clipPath>
    <!-- Kept so a card that still names the planet fill does not silently
         become a flat disk if a later pass drops the mask. The ocean uses this
         as a wash on top of the base, not as the only colour. -->
    <radialGradient id="planet" cx="0.5" cy="0.5" r="${LIT_SPREAD}" fx="${fx}" fy="${fy}">
      <stop offset="0%" stop-color="#bae6fd" stop-opacity="0.55" />
      <stop offset="28%" stop-color="#38bdf8" stop-opacity="0.22" />
      <stop offset="58%" stop-color="#0369a1" stop-opacity="0.08" />
      <stop offset="100%" stop-color="${SLATE_950}" stop-opacity="0" />
    </radialGradient>
    <!-- Atmosphere: a stroke on the limb, brightest where the star is and gone
         by the terminator. Filled behind the disk instead it is a halo all the
         way round, which reads as a glow effect rather than as air. -->
    <linearGradient id="rim" x1="0.1" y1="0.95" x2="0.7" y2="0">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0" />
      <stop offset="40%" stop-color="#7dd3fc" stop-opacity="0.22" />
      <stop offset="100%" stop-color="#e0f2fe" stop-opacity="0.95" />
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0%" stop-color="#e0f2fe" stop-opacity="0.95" />
      <stop offset="30%" stop-color="#7dd3fc" stop-opacity="0.4" />
      <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0" />
    </radialGradient>
    <!-- The anamorphic streak. A blade, not a halo: it is the artifact the
         front door is composed around, and it is what carries light across the
         type instead of leaving the left third flat. -->
    <linearGradient id="streak" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0" />
      <stop offset="32%" stop-color="#bae6fd" stop-opacity="0.38" />
      <stop offset="50%" stop-color="#f0f9ff" stop-opacity="0.82" />
      <stop offset="68%" stop-color="#bae6fd" stop-opacity="0.38" />
      <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="core" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="42%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.9" />
      <stop offset="58%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="spike" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="blade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="50%" stop-color="#ffffff" stop-opacity="1" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <mask id="bladeMask">
      <rect x="0" y="${STAR.y - 80}" width="${OG_WIDTH}" height="160" fill="url(#blade)" />
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

  <ellipse cx="780" cy="220" rx="740" ry="64" fill="#1e293b" opacity="0.45" transform="rotate(-20 780 220)" />

  <g>
${STARFIELD}
  </g>

  <g id="world">
    <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r}" fill="#020617" />
    <g clip-path="url(#disk)" mask="url(#day)">
      <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r}" fill="#0369a1" />
      <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r}" fill="url(#planet)" />
${surface()}
      <ellipse cx="${PLANET.x - 70}" cy="${PLANET.y - 300}" rx="56" ry="28" fill="#f0f9ff" opacity="0.18" />
    </g>
    <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r + 4}" fill="none" stroke="url(#rim)" stroke-width="11" filter="url(#soft)" opacity="0.9" />
    <circle cx="${PLANET.x}" cy="${PLANET.y}" r="${PLANET.r + 1}" fill="none" stroke="url(#rim)" stroke-width="2.8" />
  </g>

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

  <!-- Streak after the type so it actually crosses the column, the way the
       front door's anamorphic blade does. The title sits below it; the mark
       sits above it. -->
  <circle cx="${STAR.x}" cy="${STAR.y}" r="${STAR.r * 10}" fill="url(#glow)" />
  <rect x="${STAR.x - 7}" y="${STAR.y - 90}" width="14" height="180" fill="url(#spike)" />
  <rect x="0" y="${STAR.y - 80}" width="${OG_WIDTH}" height="160" fill="url(#streak)" mask="url(#bladeMask)" />
  <rect x="0" y="${STAR.y - 1.5}" width="${OG_WIDTH}" height="3" fill="url(#core)" />
  <circle cx="${STAR.x}" cy="${STAR.y}" r="${STAR.r}" fill="#f0f9ff" />
</svg>
`
}
