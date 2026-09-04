import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
} from 'three/webgpu'

/*
 * Ring strips for ring systems that ship no photograph.
 *
 * A mapless ring used to fall back to an opaque white texel, which drew the
 * whole annulus as one uniform slab at the body's tint — Uranus wore its ring
 * system as a cyan charcoal compact disc four radii across, occluding the
 * starfield. The real thing is the opposite of a slab: Uranus is a dozen
 * threads of near-black rubble a few kilometers wide with thousands of
 * kilometers of nothing between them, and even a gas giant's sheet is banded
 * with gaps. So a mapless ring gets a strip *generated* from a character —
 * what kind of system it is and what its particles are made of — seeded from
 * the body's address where the record does not say, deterministic like
 * everything else generation does, so the same world always wears the same
 * rings.
 *
 * The strip feeds both consumers of a ring texture — the ring slab itself and
 * the shadow it casts on its planet — so the shadow bands match the rings that
 * cast them.
 */

const STRIP_WIDTH = 512

const cache = new Map<string, Texture>()

/** Deterministic 32-bit hash of a string; the seed for a body's ring look. */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32: tiny, deterministic, good enough for band placement. */
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (random: () => number, low: number, high: number): number =>
  low + random() * (high - low)

type Rgb = readonly [number, number, number]

/**
 * What kind of system this is.
 *
 * A thread system is Uranus: a dozen hairlines of dark rubble with thousands
 * of kilometers of nothing between them. A sheet is Saturn: broad bands
 * separated by gaps, bright, filling most of the annulus, with a fine grain
 * of ringlets and density waves across every band and a sharp division or
 * two cut through. Mixed is a sheet inside with threads shepherded outside
 * it — Saturn's F ring past the A ring, at a scale the F ring is not — and
 * dust between. The three are the range, and the draw is what puts a body
 * somewhere on it.
 */
type Architecture = 'sheet' | 'threads' | 'mixed'

/**
 * A ring system's character: its architecture and its particle population,
 * which is one population for the whole system rather than a draw per band,
 * because a ring is the debris of one event.
 */
interface Character {
  readonly architecture: Architecture
  /**
   * The particles' reflectance, as the strip's grey before tint, in the
   * strip's own sRGB encoding. Saturn's clean water ice is near 0.5; Uranus's
   * processed rubble is charcoal at 0.03.
   */
  readonly albedo: number
  /** The population's colour, as per-lane multipliers on the albedo. */
  readonly tint: Rgb
  /** The thread count, where the record states one. */
  readonly threads: number | null
}

/*
 * The palette the population's colour is drawn from. Real rings run from
 * Saturn's cream — water ice with a trace of tholin — through Uranus's
 * neutral charcoal to the reddened dust of a Jovian ring; the pale blue is
 * the license, for fresh ice that has not been weathered, and it is drawn
 * rarely because it is the one nothing in Sol shows.
 */
const CREAM: Rgb = [1, 0.93, 0.8]
const ICE: Rgb = [1, 1, 1]
const PALE_BLUE: Rgb = [0.9, 0.95, 1]
const TAWNY: Rgb = [1, 0.84, 0.62]
const CHARCOAL: Rgb = [1, 0.98, 0.96]
const RUST: Rgb = [1, 0.86, 0.74]
const SLATE: Rgb = [0.88, 0.92, 1]

/** One of `choices`, by the weight beside it. */
function pick<T>(
  random: () => number,
  choices: readonly (readonly [T, number])[],
): T {
  let total = 0
  for (const [, weight] of choices) total += weight
  let at = random() * total
  for (const [choice, weight] of choices) {
    at -= weight
    if (at <= 0) return choice
  }
  return (choices[choices.length - 1] as readonly [T, number])[0]
}

/**
 * Sol's mapless ring systems, by address: their architecture is published
 * and not a coin the seed gets to toss.
 *
 * The draw below leans on the host's class, and a lean is a probability —
 * which for Uranus would be a two-in-five chance of a Saturn sheet, on the
 * one body whose thirteen narrow rings are the reason the thread
 * architecture exists. The art doctrine settles every Sol body's look by
 * what is published, so these seven are looked up. The small bodies are
 * keyed by the same issue-ordinal address the catalog gives them, and
 * `proceduralRings.test.ts` holds each key to a mapless ringed body in Sol.
 */
const PUBLISHED: ReadonlyMap<string, Character> = new Map<string, Character>([
  /*
   * Jupiter: one main ring of dust, a sheet by structure, at an optical
   * depth of 3 × 10⁻⁶ that draws nothing whatever the strip says. Reddened,
   * because it is the dust knocked off Metis and Adrastea.
   */
  [
    'g:milky-way/s:SOL/b:4',
    { architecture: 'sheet', albedo: 0.3, tint: RUST, threads: null },
  ],
  /*
   * Uranus: thirteen narrow rings of charcoal rubble, ε widest and brightest
   * at the outer edge. Karkoschka's albedo for the particles is 0.03; the
   * strip's grey encodes sRGB, so the same darkness is 0.06 here.
   */
  [
    'g:milky-way/s:SOL/b:6',
    { architecture: 'threads', albedo: 0.06, tint: CHARCOAL, threads: 13 },
  ],
  /*
   * Neptune: five faint dusty rings — Galle, Le Verrier, Lassell, Arago,
   * Adams with its arcs — reddish and as dark as Uranus's.
   */
  [
    'g:milky-way/s:SOL/b:7',
    { architecture: 'threads', albedo: 0.06, tint: RUST, threads: 5 },
  ],
  /* Haumea: one ring, 70 km wide, in 3:1 resonance with its four-hour day. */
  [
    'g:milky-way/s:SOL/b:11',
    { architecture: 'threads', albedo: 0.3, tint: ICE, threads: 1 },
  ],
  /* Quaoar: two narrow rings, both outside the Roche limit. */
  [
    'g:milky-way/s:SOL/b:13',
    { architecture: 'threads', albedo: 0.1, tint: CHARCOAL, threads: 2 },
  ],
  /* Chariklo: two rings, 7 and 3 km wide, found by a star blinking twice. */
  [
    'g:milky-way/s:SOL/b:53',
    { architecture: 'threads', albedo: 0.12, tint: CHARCOAL, threads: 2 },
  ],
  /* Chiron: probable rings, argued from the same kind of occultation. */
  [
    'g:milky-way/s:SOL/b:54',
    { architecture: 'threads', albedo: 0.1, tint: RUST, threads: 2 },
  ],
])

/**
 * The character of one mapless ring system.
 *
 * **Drawn from the body's own seed, not from the host's kind, and that is
 * the choice worth explaining.** Branching on `ice-giant` gave every
 * generated ice giant in the galaxy the same near-invisible threads and every
 * gas giant the same sheet — two looks across a hundred worlds, for a feature
 * whose own frequency docstring says it exists to be a find. No exoplanetary
 * ring system has ever been photographed, so its architecture is exactly the
 * kind of claim the seed should make, and the design bible's license is for
 * this: the rings of the galaxy should be rich and various.
 *
 * The host still leans the draw, because the two facts are not independent —
 * a body massive enough to hold a sheet is likelier to have one. It leans it
 * rather than deciding it. The albedo follows the architecture, because the
 * two have a common cause: a sheet is held up by a large mass of clean water
 * ice and reflects like Saturn's, a thread system is sparse collisional
 * rubble, dark by the same processing that ground it. The tint follows the
 * albedo the same way — cream and ice are bright, charcoal and rust are
 * dark — with the pale blue of unweathered ice as the rare find.
 */
function character(
  kind: string,
  address: string,
  random: () => number,
): Character {
  const published = PUBLISHED.get(address)
  if (published !== undefined) return published
  const giant = kind === 'gas-giant'
  const architecture = pick<Architecture>(random, [
    ['sheet', giant ? 0.55 : 0.3],
    ['mixed', 0.25],
    ['threads', giant ? 0.2 : 0.45],
  ])
  if (architecture === 'threads') {
    return {
      architecture,
      albedo: between(random, 0.05, 0.26),
      tint: pick<Rgb>(random, [
        [CHARCOAL, 0.5],
        [RUST, 0.35],
        [SLATE, 0.15],
      ]),
      threads: null,
    }
  }
  return {
    architecture,
    albedo:
      architecture === 'sheet'
        ? between(random, 0.34, 0.74)
        : between(random, 0.22, 0.56),
    tint: pick<Rgb>(random, [
      [CREAM, 0.45],
      [ICE, 0.22],
      [TAWNY, 0.18],
      [PALE_BLUE, 0.15],
    ]),
    threads: null,
  }
}

/**
 * One band of the radial profile.
 *
 * A band is a plateau `half` wide about `centre`, falling off over `inner`
 * on the planetward side and `outer` on the far side — Saturn's A ring has a
 * diffuse inner edge and a knife-sharp outer one held by Janus, and drawing
 * both sides alike is the first thing that reads as a decal. `ripple` is the
 * fine grain across the plateau: density waves and ringlets, at `frequency`
 * cycles across the strip, which is what Cassini's pictures are mostly made
 * of and what a smooth band lacks.
 */
interface Band {
  readonly centre: number
  readonly half: number
  readonly inner: number
  readonly outer: number
  readonly alpha: number
  readonly colour: Rgb
  readonly ripple: number
  readonly frequency: number
  readonly phase: number
}

/** A sharp gap cut through whatever band it falls in — a Cassini division. */
interface Division {
  readonly centre: number
  readonly width: number
}

interface Profile {
  readonly bands: readonly Band[]
  readonly divisions: readonly Division[]
}

/** The population's colour with one band's jitter about it. */
function bandColour(
  albedo: number,
  tint: Rgb,
  random: () => number,
  shade = 1,
): Rgb {
  const grey = albedo * shade * between(random, 0.82, 1.12)
  const chroma = between(random, 0.94, 1.06)
  return [
    grey * tint[0] * chroma,
    grey * tint[1],
    grey * tint[2] * (2 - chroma),
  ]
}

/** A hairline: a gaussian, no plateau, the same fall-off both sides. */
function thread(
  centre: number,
  width: number,
  alpha: number,
  colour: Rgb,
): Band {
  return {
    centre,
    half: 0,
    inner: width,
    outer: width,
    alpha,
    colour,
    ripple: 0,
    frequency: 0,
    phase: 0,
  }
}

/**
 * Broad bands across `[from, to]`: the annulus partitioned into `count`
 * segments of drawn proportion, each holding a plateau with a gap beside it.
 * One of them is the densest, at alpha one, which is where the record's
 * optical depth lands.
 */
function sheetBands(
  random: () => number,
  from: number,
  to: number,
  count: number,
  albedo: number,
  tint: Rgb,
): Band[] {
  const weights: number[] = []
  let total = 0
  for (let i = 0; i < count; i += 1) {
    const weight = between(random, 0.5, 1.5)
    weights.push(weight)
    total += weight
  }
  const densest = Math.floor(random() * count)
  const bands: Band[] = []
  let at = from
  for (let i = 0; i < count; i += 1) {
    const span = ((weights[i] as number) / total) * (to - from)
    const fill = between(random, 0.6, 0.92)
    const half = (span * fill) / 2
    const centre = at + span / 2
    bands.push({
      centre,
      half,
      inner: half * between(random, 0.12, 0.35),
      outer: half * between(random, 0.03, 0.14),
      alpha: i === densest ? 1 : between(random, 0.35, 0.9),
      colour: bandColour(albedo, tint, random),
      ripple: between(random, 0.06, 0.36),
      // At most sixty cycles across 512 texels: eight and a half texels a
      // cycle, so the grain is drawn rather than aliased.
      frequency: between(random, 18, 60),
      phase: random() * Math.PI * 2,
    })
    at += span
  }
  return bands
}

/**
 * Hairlines across `[from, to]`, one in five paired with a twin a little
 * further out, and the last one dominant: wider, denser, the one worth
 * naming — Uranus's ε, which is the ring the record's depth describes.
 */
function threadBands(
  random: () => number,
  from: number,
  to: number,
  count: number,
  albedo: number,
  tint: Rgb,
): Band[] {
  const bands: Band[] = []
  const lesser = Math.max(0, count - 1)
  for (let i = 0; i < lesser; i += 1) {
    const centre = between(random, from, to - 0.05)
    const width = between(random, 0.0012, 0.006)
    const alpha = between(random, 0.35, 0.85)
    bands.push(thread(centre, width, alpha, bandColour(albedo, tint, random)))
    if (random() < 0.2 && i + 1 < lesser) {
      i += 1
      bands.push(
        thread(
          centre + between(random, 0.006, 0.014),
          width * between(random, 0.6, 1.2),
          alpha * between(random, 0.6, 1),
          bandColour(albedo, tint, random),
        ),
      )
    }
  }
  bands.push(
    thread(
      between(random, to - 0.06, to),
      between(random, 0.008, 0.02),
      1,
      bandColour(albedo, tint, random, 1.15),
    ),
  )
  return bands
}

/** A broad, faint, dark band of dust — a C ring, or the haze between threads. */
function dust(
  random: () => number,
  from: number,
  to: number,
  albedo: number,
  tint: Rgb,
  alpha: number,
): Band {
  const half = (to - from) / 2
  return {
    centre: from + half,
    half: half * 0.8,
    inner: half * 0.3,
    outer: half * 0.2,
    alpha,
    // Dust is darker than the ice it was ground from, and bluer for being fine.
    colour: bandColour(
      albedo,
      [tint[0] * 0.9, tint[1] * 0.95, tint[2]],
      random,
      0.7,
    ),
    ripple: between(random, 0, 0.15),
    frequency: between(random, 10, 30),
    phase: random() * Math.PI * 2,
  }
}

/** The radial profile for one character. */
function profileFor(who: Character, random: () => number): Profile {
  const { albedo, tint } = who
  const bands: Band[] = []
  const divisions: Division[] = []
  if (who.architecture === 'threads') {
    const count = who.threads ?? 4 + Math.floor(random() * 9)
    bands.push(...threadBands(random, 0.06, 0.96, count, albedo, tint))
    if (who.threads === null && random() < 0.5) {
      bands.push(
        dust(random, 0.1, 0.85, albedo, tint, between(random, 0.03, 0.08)),
      )
    }
    return { bands, divisions }
  }

  const sheetTo = who.architecture === 'sheet' ? 0.97 : 0.62
  const count =
    who.architecture === 'sheet'
      ? 3 + Math.floor(random() * 5)
      : 2 + Math.floor(random() * 3)
  const sheet = sheetBands(random, 0.03, sheetTo, count, albedo, tint)
  bands.push(...sheet)

  // A division or two, cut through the plateau of a band wide enough to
  // hold one — Cassini's is a gap 4,800 km across in a sheet ten times that.
  const cuts = Math.floor(random() * 3)
  const wide = sheet.filter((band) => band.half > 0.05)
  for (let i = 0; i < cuts && wide.length > 0; i += 1) {
    const host = wide[Math.floor(random() * wide.length)] as Band
    divisions.push({
      centre: host.centre + between(random, -0.6, 0.6) * host.half,
      width: between(random, 0.004, 0.015),
    })
  }

  // A ringlet or two in the gaps: an F ring, narrow and bright, shepherded
  // where the sheet is not.
  const ringlets = Math.floor(random() * 3)
  for (let i = 0; i < ringlets && i + 1 < sheet.length; i += 1) {
    const before = sheet[i] as Band
    const after = sheet[i + 1] as Band
    const gapFrom = before.centre + before.half
    const gapTo = after.centre - after.half
    if (gapTo - gapFrom < 0.02) continue
    bands.push(
      thread(
        between(random, gapFrom + 0.005, gapTo - 0.005),
        between(random, 0.002, 0.004),
        between(random, 0.3, 0.7),
        bandColour(albedo, tint, random, 1.1),
      ),
    )
  }

  // A C ring: the faint inner dust most sheets carry planetward of the first
  // bright band.
  if (random() < 0.6) {
    const first = sheet[0] as Band
    bands.push(
      dust(
        random,
        0.0,
        first.centre - first.half,
        albedo,
        tint,
        between(random, 0.08, 0.22),
      ),
    )
  }

  if (who.architecture === 'mixed') {
    bands.push(
      ...threadBands(
        random,
        sheetTo + 0.06,
        0.97,
        3 + Math.floor(random() * 4),
        albedo,
        tint,
      ),
    )
    bands.push(
      dust(
        random,
        sheetTo + 0.02,
        0.97,
        albedo,
        tint,
        between(random, 0.02, 0.06),
      ),
    )
  }
  return { bands, divisions }
}

/** A band's coverage at `at`: the plateau, then a fall-off per side. */
function coverage(band: Band, at: number): number {
  const offset = at - band.centre
  const beyond = Math.abs(offset) - band.half
  if (beyond <= 0) return 1
  const scale = offset < 0 ? band.inner : band.outer
  const s = beyond / Math.max(scale, 1e-4)
  return Math.exp(-s * s * 2)
}

/**
 * The strip for one mapless ring system, cached per body.
 *
 * RGBA like the shipped Saturn strip: color in RGB, the radial profile of
 * optical depth in alpha — the shader reads alpha as thickness per band, so
 * the space between bands is genuinely empty rather than faintly fogged, and
 * the densest band carries about the depth the record states.
 *
 * **The alpha is deliberately not normalized to the annulus.** `RingSystem`
 * calls its number a mean normal optical depth, and read that way the strip
 * should be scaled so its own mean is one — which for a thread system, whose
 * bands cover a few percent of the annulus, asks each hairline to carry
 * thirty times the quoted depth. The published numbers refuse it: Uranus is
 * recorded at 0.5 and its ε ring is measured at 0.5 to 2.3, so the figure in
 * the record behaves as the main ring's depth rather than as an average over
 * thousands of kilometers of gap. The profile therefore peaks at one and the
 * quoted depth lands on the densest band, which is the reading the data
 * supports. [The rings plan](../../../../design/plans/rings.md) has the
 * measurement and the decline.
 *
 * Mipmapped, the way `planetTextures.ts` loads a photographed strip, because
 * the grain is what needs it: sixty cycles across 512 texels is a cycle every
 * eight texels, and a ring a hundred pixels across samples one texel in five
 * — a moiré that crawls with the camera. The mip chain is the anti-aliasing,
 * and it changes no program: filtering is sampler state, and the stand-in
 * the pipeline was warmed with is linear already.
 */
export function proceduralRingStrip(kind: string, address: string): Texture {
  const key = `${kind}:${address}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const random = rng(hash(key))
  const who = character(kind, address, random)
  const { bands, divisions } = profileFor(who, random)

  const data = new Uint8Array(STRIP_WIDTH * 4)
  for (let x = 0; x < STRIP_WIDTH; x += 1) {
    const at = (x + 0.5) / STRIP_WIDTH
    let alpha = 0
    let colour: Rgb = [0, 0, 0]
    for (const band of bands) {
      const grain =
        band.ripple === 0
          ? 1
          : 1 -
            band.ripple *
              0.5 *
              (1 + Math.sin(at * band.frequency * Math.PI * 2 + band.phase))
      const contribution = band.alpha * coverage(band, at) * grain
      // The densest band at this radius is the one seen: a hairline over
      // dust is the hairline, and dust over nothing is dust.
      if (contribution > alpha) {
        alpha = contribution
        colour = band.colour
      }
    }
    for (const division of divisions) {
      const s = (at - division.centre) / division.width
      // Flat-bottomed and steep-sided: a gap, not a dip.
      alpha *= 1 - 0.92 * Math.exp(-(s * s * s * s))
    }
    const index = x * 4
    data[index] = Math.round(Math.min(1, colour[0]) * 255)
    data[index + 1] = Math.round(Math.min(1, colour[1]) * 255)
    data[index + 2] = Math.round(Math.min(1, colour[2]) * 255)
    data[index + 3] = Math.round(Math.min(1, alpha) * 255)
  }

  const texture = new DataTexture(data, STRIP_WIDTH, 1, RGBAFormat)
  texture.colorSpace = SRGBColorSpace
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  cache.set(key, texture)
  return texture
}

/** The seven Sol systems whose character is looked up rather than drawn. */
export const PUBLISHED_RING_ADDRESSES: readonly string[] = [...PUBLISHED.keys()]
