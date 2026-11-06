/*
 * Precomputed atmospheric scattering, in the Bruneton/Hillaire family.
 *
 * The analytic shell in the client was a placeholder with a named successor —
 * "Bruneton's precomputed transmittance and multiple-scattering LUTs", spike 2
 * — and this is that successor's precompute half. Two small tables per
 * atmosphere:
 *
 * **Transmittance** T(r, μ): how much of each wavelength survives the trip
 * from a point at radius r, along zenith-cosine μ, out to space. This is the
 * table that makes sunsets: a grazing ray crosses so much air that the blue
 * coefficient extinguishes first, and everything lit by that ray — cloud,
 * limb, the air itself — reddens with no hand-tuned "sunset color" anywhere.
 *
 * **Multiple scattering** Ψ(r, μs): Hillaire's isotropic estimate of every
 * scattering order past the first, as a single lookup. Single scattering
 * alone leaves the twilight side too dark and the thick-air limb too blue;
 * Ψ is why a dusk sky glows instead of switching off.
 *
 * Everything is in **planet radii** — the ground is r = 1 — because that is
 * the one unit that survives the renderer's distance compression: both shell
 * radii are rescaled together every time the LOD tier moves, so anything
 * baked in meters would be wrong by whatever the compressor chose that frame.
 *
 * Pure arrays in, pure arrays out, no GPU and no three.js: the bake runs
 * identically in a worker, a test, or the main thread, and the *physics* is
 * what the tests in `atmosphere.test.ts` hold still, on any Node at all — the
 * shader that consumes these tables needs a GPU, and gets one only from
 * `pnpm test:gpu`.
 *
 * Coefficients derive from the authored `HazeLayer`, not from a gas mix: the
 * zenith color *is* the scattering spectrum (a sky's color is β, up to
 * normalization), the limb color tints the aerosol where the column cannot
 * make that color itself (`aerosolTint`), and `thickness` scales the column.
 * Where the aerosol is the sky (`aerosolDepth`), the dust or the haze
 * carries the two colors itself, the sky's sideways and the limb's forward.
 * Mars therefore keeps its butterscotch sky and its blue sunset — both are in
 * its authored colors — without this file knowing what CO₂ is.
 *
 * The column's shape is measured rather than authored: the gas falls off over
 * the body's own scale height and the aerosol over the haze's, and the
 * optical depths, the aerosol's albedo and its asymmetry are Earth's
 * published ones. ADR-0056 has the sources and the one calibrated factor.
 */

import type { AirHeights } from './datum.ts'

export interface HazeAuthoring {
  readonly color: {
    readonly r: number
    readonly g: number
    readonly b: number
  }
  readonly limb: { readonly r: number; readonly g: number; readonly b: number }
  readonly thickness: number
  /** The aerosol's Ångström exponent: its optical depth goes as λ^−α. */
  readonly aerosolAngstrom: number
  /** The ozone column, Dobson units. Earth's is about 300. */
  readonly ozone: number
  /**
   * The aerosol's vertical extinction depth at 550 nm, where it is measured
   * apart from the gas's: Mars's clear-season dust at 0.3, Titan's haze at
   * 4.5. Authored,
   * the aerosol is the sky, and its color is the authored `color` sideways
   * and `limb` forward (`atmosphereRecipe`). Absent, the aerosol is Earth's
   * column scaled by `thickness` (`TAU_MIE`) in the gray the limb cannot
   * account for (`aerosolTint`), which is right where the gas is the sky.
   */
  readonly aerosolDepth?: number
  /**
   * The aerosol's single-scattering albedo in its brightest channel, where
   * `aerosolDepth` is authored: how much of what it takes it scatters. The
   * other channels sit under it by the authored colors' own ratios.
   * `AEROSOL_ALBEDO` absent.
   */
  readonly aerosolAlbedo?: number
  /** A thin layer of small particles high over the main haze, or none. */
  readonly detached?: DetachedHaze
}

/**
 * A detached haze layer: small particles in a thin layer high over the main
 * haze, like Titan's at 300 to 500 km — the blue-violet ring outside its
 * orange limb in every Cassini natural-color frame — and the ice hazes 30 to
 * 50 km over Mars's dust, the pale line over its butterscotch limb. A tent
 * in height like the ozone's, authored in scale heights of the gas so the
 * recipe stays free of the radius; it scatters its authored color with
 * Rayleigh's phase, as small particles do, and takes gray.
 */
export interface DetachedHaze {
  /** The layer's peak over the datum, in scale heights of the gas. */
  readonly center: number
  /** Its half-width in the same unit; the tent reaches zero there. */
  readonly halfWidth: number
  /** Its vertical extinction depth at 550 nm. */
  readonly depth: number
  /** What it scatters, scaled so its brightest channel scatters all it takes. */
  readonly color: { readonly r: number; readonly g: number; readonly b: number }
}

export interface AtmosphereRecipe {
  /** Shell top over ground radius; the ground is 1. */
  readonly topRatio: number
  /** Rayleigh scale height, planet radii. */
  readonly hRayleigh: number
  /** Aerosol scale height, planet radii — aerosols hug the ground. */
  readonly hMie: number
  /** Rayleigh scattering coefficient per planet radius, RGB. */
  readonly betaRayleigh: readonly [number, number, number]
  /** Aerosol scattering coefficient per planet radius, RGB (tinted). */
  readonly mieScatter: readonly [number, number, number]
  /** Aerosol extinction per planet radius, RGB — the slope, untinted. */
  readonly mieExtinction: readonly [number, number, number]
  /**
   * Aerosol scattering coefficient straight toward the sun, RGB: the
   * `mieScatter` of a haze whose forward color is its sideways one, and the
   * limb's color at the same albedo where the aerosol is the sky. The march
   * turns between the two along the lobe's own share of its peak
   * (`AEROSOL_FORWARD_PEAK`).
   */
  readonly mieForward: readonly [number, number, number]
  /**
   * Whether the aerosol is the sky, 0 or 1: how Enhanced's limb from orbit
   * (`marchLimb` in `render/air.ts`) carries it. A gas-lit haze's aerosol
   * rides in the ring at its lobe alone, the orange at the foot, and takes
   * nothing. A dust that is the whole column rides at its whole column and
   * takes as it scatters, so six times an opaque column is six times its
   * lit surface and not six times its depth: without its extinction Mars's
   * sunset limb from low orbit read 219 : 192 : 191 at its foot, a white
   * band, and with no aerosol in the ring at all its full face wore a rim
   * of 141 : 116 : 105, dimmer than the disk beside it (171 : 94 : 71).
   */
  readonly aerosolSky: number
  /** Ozone absorption per planet radius at the layer's peak, RGB. */
  readonly ozone: readonly [number, number, number]
  /** Where the ozone layer peaks, and its half-width, planet radii. */
  readonly ozonePeak: number
  readonly ozoneHalfWidth: number
  /**
   * The detached layer's tent, planet radii, and its coefficients at the
   * peak: a gray extinction and an RGB scattering, both per planet radius.
   * Zero extinction where a haze has none.
   */
  readonly detachedPeak: number
  readonly detachedHalfWidth: number
  readonly detachedExtinction: number
  readonly detachedScatter: readonly [number, number, number]
}

export interface ScatteringLut {
  readonly width: number
  readonly height: number
  /** RGBA32F texels, alpha 1 — sized for a direct GPU upload. */
  readonly data: Float32Array
}

export const TRANSMITTANCE_WIDTH = 512
export const TRANSMITTANCE_HEIGHT = 64
/** Ψ's columns, over the sun's cosine. */
export const MULTI_SCATTER_WIDTH = 32
/**
 * Ψ's rows, over altitude. Half its columns: Ψ is smooth in height, and the
 * value at 16 rows is within 5% of the value at 32 through −15° of twilight,
 * for half the bake.
 */
export const MULTI_SCATTER_HEIGHT = 16
/**
 * The smallest Ψ the table can say, so its logarithm is finite. A vacuum, or
 * a point the sun cannot reach by any second bounce, reads as this.
 */
export const MULTI_SCATTER_FLOOR = 1e-30

/**
 * Earth's vertical Rayleigh optical depth, summed over RGB, at thickness 1.
 *
 * Bodhaine et al. (1999) at sea level: 0.041, 0.097 and 0.243 at 680, 550 and
 * 440 nm. Splitting the sum by the authored zenith color reproduces that
 * spectrum within a few percent, which is what licenses deriving physics from
 * art direction in the first place.
 */
const TAU_RAYLEIGH_SUM = 0.38

/**
 * Earth's vertical aerosol optical depth at thickness 1: 0.12, the global mean
 * at 550 nm in the MACv2 climatology (Kinne 2017), inside MODIS's 0.13–0.19.
 *
 * It is also what the anchor asks for. The CIE clear sky's zenith falls by a
 * factor of eight between a 60° and a 10° sun, because at a high sun most of
 * the zenith's light is the aerosol's forward lobe; a cleaner column of 0.05
 * falls by three, which makes a low sun's sky as bright as a noon one beside
 * the sun that lights it. At 0.12 the model's luminous turbidity is 2.3,
 * where CIE type 12 puts a standard clear sky at 2.5.
 */
const TAU_MIE = 0.12

/**
 * The three bands' wavelengths, nm: where Bodhaine's column above is read,
 * and where an aerosol's Ångström slope is evaluated against its 550 nm depth.
 */
const BANDS = [680, 550, 440] as const

/** The aerosol's single-scattering albedo where none is authored: 0.94,
 * MACv2's global mean. Extinction over scattering is its inverse. */
export const AEROSOL_ALBEDO = 0.94
const MIE_EXTINCTION_RATIO = 1 / AEROSOL_ALBEDO

/** Aerosol asymmetry: 0.70, MACv2's global mean. Pathfinder measured Martian
 * dust at 0.72–0.77 across the visible; one value serves every haze here. */
export const AEROSOL_ASYMMETRY = 0.7

/**
 * The Henyey–Greenstein lobe's value straight toward the sun, per
 * steradian, which the lobe at any other angle is a share of: 0.37 twenty
 * degrees off the sun, 0.04 at sixty. An aerosol whose forward color
 * differs from its sideways one (`mieForward`) turns from the one to the
 * other along that share, in `phasesToward` (`render/air.ts`) and in
 * `zenithSkyRadiance` alike, so the turn is the lobe's own shape and costs
 * no second phase function: a dust's blue gathers around a low sun and the
 * sky away from it stays the dust's own color.
 */
export const AEROSOL_FORWARD_PEAK =
  (1 + AEROSOL_ASYMMETRY) / (4 * Math.PI * (1 - AEROSOL_ASYMMETRY) ** 2)

/**
 * Ozone's Chappuis-band cross-sections for the three channels, m² a
 * molecule, and a Dobson unit in molecules per m².
 *
 * Ozone scatters nothing and absorbs orange and green, and it is why a
 * twilight zenith is blue. Once the sun is down, the light overhead has
 * crossed the stratosphere edgeways to reach the shadowed column, through
 * thirty or forty times the vertical ozone; without it that light arrives
 * reddened by the gas and the dusk sky is the gray of a dim sunset. Its
 * vertical depth on Earth is only 0.03, so the day sky barely moves.
 *
 * Each value is the 233 K spectrum Bruneton's reference implementation
 * (2017) tabulates in 10 nm bins, averaged over the channel's CIE 1931
 * color-matching lobe rather than read at the band's nominal wavelength. The
 * band peaks at 600 nm, between the red's 680 and the green's 550: read at
 * 680 the red channel escaped it, and a −6° zenith came out violet
 * (0.65 : 0.39 : 1) where the averaged band gives 0.32 : 0.39 : 1, the blue a
 * civil-dusk photograph records.
 */
const OZONE_CROSS_SECTION = [3.98e-25, 3.61e-25, 2.52e-26] as const
const DOBSON_UNIT = 2.687e20

/**
 * The ozone layer's shape, in scale heights of its own gas: Earth's tent
 * rises from 10 km to a 25 km peak and falls to nothing at 40 km (Bruneton
 * 2017, after the 1976 US standard atmosphere), which over 8.5 km is a peak
 * at 2.94 and a half-width of 1.76. Earth's is the only ozone column in the
 * catalog.
 */
const OZONE_PEAK_HEIGHTS = 25 / 8.5
const OZONE_HALF_WIDTH_HEIGHTS = 15 / 8.5

/**
 * Scattered radiance to scene units: π, and nothing else.
 *
 * The march produces radiance per unit of the sun's irradiance, and a scene
 * unit is an albedo-one surface under that sun, which is the irradiance over
 * π — so the sky keeps its physical ratio to the ground it stands over.
 * Nothing is fitted: at π the zenith under a 60° sun is 1.07 times the CIE
 * standard clear sky's (type 12, Darula and Kittler 2002) at the model's own
 * luminous turbidity of 2.3, and `atmosphere.test.ts` holds that anchor.
 */
export const ATMOSPHERE_GAIN = Math.PI

/*
 * Enhanced's limb from orbit.
 *
 * The physical limb is a line: Earth's gas falls off over 8.5 km, a seventh
 * of a percent of the radius, two pixels on a disk four hundred across, and
 * a camera's limb is that line and no more. The deep-space composite is
 * where the bible licenses a cheat (`art.md`), and the bright ring the home
 * page draws on the disk's edge is one. From outside the air, Enhanced's
 * shell draws the body's air a second time as if it fell off over
 * `LIMB_STRETCH` of its own scale heights — 25 km on Earth in place of 8.5
 * — with `LIMB_GAIN` of the same column of gas spread over the taller
 * profile, reads it through the body's own tables at the height the
 * stretch maps a sample to (`marchLimb` for why), with the aerosol's
 * forward lobe at its foot and not its extinction, and draws its light
 * `LIMB_BRIGHTNESS` times over. Nothing authors a color:
 * the ring's foot is orange toward the sun because the table's column
 * reddens the beam there and the lobe throws it forward, its crown stays
 * blue because the sun reaches it clear, and the ring ends where the sun
 * sets on the gas, foot first. It is drawn past the silhouette and nowhere
 * else: the disk takes the physical air's light, and under the same lift
 * none of its extinction (`clearedFromOrbit` in `render/air.ts`).
 *
 * Why a stretch of the same recipe rather than a glow: a halo painted
 * around the disk has one color, and the one thing a camera's limb has is
 * the order of its colors — orange under white under blue, and dark where
 * the sun has set on it.
 */
/**
 * The ring falls off over this many of the gas's own scale heights. As a
 * multiple of the gas and not a fraction of the radius, so it is the same
 * ring on every world: a fraction small enough for Earth's 8.5 km is under
 * Titan's own 20 km, and would draw Titan a ring thinner than its air. At
 * thirty — a twenty-fifth of Earth's radius — the ring stands off the disk
 * as a halo four to seven percent of the radius wide; at three it is a
 * line a percent of the radius wide, hugging the disk.
 */
export const LIMB_STRETCH = 3
/**
 * The lifted gas ends this many of its own fall-offs up, or at the top of
 * the air where that is higher (`limbReach`). Over two the ring is lit
 * clear of the reddened foot and scatters the gas's blue, six times over:
 * at four, on Mars, whose sunset limb from low orbit is a thin line, that
 * crown is a broad blue-white arch. Earth's 100 km top is above two of its
 * ring's 25 km fall-offs, so there the ring ends at the top and this has
 * no say.
 */
export const LIMB_CEILING_FALLOFFS = 2
export const LIMB_GAIN = 1
/**
 * The ring's light over the stretched gas's own. Along a tangent the
 * stretched foot is optically thick — Earth's sea-level Rayleigh depth of
 * 0.24 in the blue is sixteen along the chord — so more column only lifts
 * the height where the ring turns opaque and leaves it as dim: at three
 * times the column the line is still a dark blue, where a photograph's
 * limb is white-blue. What the ring lacks is radiance. At one the line on
 * a Blue Marble is dimmer than the disk beside it, and a sunrise from low
 * orbit is a blue band over a thread of orange; at six the line is the
 * brightest thing on the disk's edge and the sunrise band is orange under
 * white under blue.
 */
export const LIMB_BRIGHTNESS = 6
/**
 * The eye stands at least this many of the ring's fall-offs above the
 * ring's foot: the fall-off is the eye's height over the datum divided by
 * this, if that is under `LIMB_STRETCH` scale heights (`limbFalloff`).
 * A ring taller than the eye's height puts the eye inside its own gas, and
 * a sunrise from that height fills the whole sky with reddened haze — what
 * a gas that tall does, and not what a photograph from a station shows.
 */
export const LIMB_STANDOFF = 5
/**
 * The lift comes in over this many shell heights up from the top of the
 * air — two hundred kilometers on Earth, full by three hundred — so a ship
 * climbing out keeps the sky it had and has the ring by the altitude the
 * reference photographs were taken from: every limb photographed from a
 * station is photographed from four hundred kilometers, and over ten shell
 * heights the ring would be a tenth of itself there.
 */
export const LIMB_FADE_HEIGHTS = 2

/**
 * How far an eye stands outside a body's air, 0 to 1: nothing inside it,
 * everything `LIMB_FADE_HEIGHTS` shell heights above its top, a smoothstep
 * between. `eyeRatio` is the eye's distance from the center over the datum
 * radius; `airTop` is the air's top in the same unit, 1 for a body with
 * none, which lifts nothing.
 */
export function limbLift(eyeRatio: number, airTop: number): number {
  const shellHeight = airTop - 1
  if (!(shellHeight > 0)) return 0
  const u = Math.min(
    Math.max((eyeRatio - airTop) / (shellHeight * LIMB_FADE_HEIGHTS), 0),
    1,
  )
  return u * u * (3 - 2 * u)
}

/**
 * The lift is for air too thin to see from orbit, and a column past a few
 * of Earth's is its own ring: between `LIMB_OWN_FROM` and `LIMB_OWN_TO`
 * visible columns (`visibleThickness`) the lift's share falls from one to
 * nothing. Drawn six times over on a column opaque along its tangent, the
 * ring is a hard orange rim inside a limb the physics already draws as a
 * broad glow — Titan's, at ten of Earth's columns — and a hairline is a
 * gray band standing off it. Earth, Mars and every thin haze stand under
 * two and keep the whole lift.
 */
export const LIMB_OWN_FROM = 2
export const LIMB_OWN_TO = 5

export function limbShare(haze: HazeAuthoring): number {
  const u = Math.min(
    Math.max(
      (visibleThickness(haze) - LIMB_OWN_FROM) / (LIMB_OWN_TO - LIMB_OWN_FROM),
      0,
    ),
    1,
  )
  return 1 - u * u * (3 - 2 * u)
}

/**
 * The ring's fall-off for an eye at `eyeRatio` over the datum, in datum
 * units: `LIMB_STRETCH` of the gas's own scale height `gasHeight` (datum
 * units, `airHeights`), or a `LIMB_STANDOFF`th of the eye's height if
 * that is less.
 */
export function limbFalloff(eyeRatio: number, gasHeight: number): number {
  return Math.min(
    LIMB_STRETCH * Math.max(gasHeight, 0),
    Math.max(eyeRatio - 1, 0) / LIMB_STANDOFF,
  )
}

/**
 * Where the air ends for a lift: the air's own top at none, the ring's
 * ceiling for its fall-off at one — or the top, for an air that already
 * reaches past it — in datum units. The shell mesh is drawn to it, and the
 * march of the lifted gas stops at it, so the ring is never clipped by the
 * geometry that carries it. It takes the fall-off the shader is handed
 * (`RenderBody.limbFalloff`) rather than the eye it came from: a mesh sized
 * from a second derivation of that number is a mesh the shader's reach can
 * outgrow, and the ring ends in a hard circle where they part.
 */
export function limbReach(
  airTop: number,
  lift: number,
  falloff: number,
): number {
  const ceiling = 1 + LIMB_CEILING_FALLOFFS * falloff
  return airTop + (Math.max(ceiling, airTop) - airTop) * lift
}

/** Midpoint samples along the zenith column in `zenithSkyRadiance`. */
const ZENITH_STEPS = 32

/** March steps for the transmittance table. */
const TRANSMITTANCE_STEPS = 48

/**
 * Directions and steps for the multiple-scattering estimate.
 *
 * Sixty-four directions, because once the column is in shadow its light
 * arrives from a narrow wedge of sunlit air toward the sun's azimuth, and a
 * sparser sphere either misses that wedge or lands a direction in it by
 * chance: at 16 the zenith at −12° is eleven times the measured sky, and it
 * does not move by more than noise past 64.
 */
const MS_DIRECTIONS = 64
const MS_STEPS = 16

/**
 * Derive the physical recipe from an authored haze layer, its shell, and its
 * two measured scale heights (`airHeights`), all in radii of the drawn sphere.
 */
export function atmosphereRecipe(
  haze: HazeAuthoring,
  topRatio: number,
  heights: AirHeights,
): AtmosphereRecipe {
  const hRayleigh = Math.max(heights.rayleigh, 1e-7)
  const hMie = Math.max(heights.aerosol, 1e-7)
  const ceiling = Math.max(topRatio - 1, 1e-7)
  // τ = β·∫ρ, so β = τ over the column the density profile actually holds.
  const columnRayleigh = densityColumn(hRayleigh, ceiling)
  const columnMie = densityColumn(hMie, ceiling)

  const { color, limb, thickness } = haze
  const colorSum = Math.max(color.r + color.g + color.b, 1e-6)
  const tau = TAU_RAYLEIGH_SUM * thickness
  const betaRayleigh: [number, number, number] = [
    ((color.r / colorSum) * tau) / columnRayleigh,
    ((color.g / colorSum) * tau) / columnRayleigh,
    ((color.b / colorSum) * tau) / columnRayleigh,
  ]

  // The aerosol's depth per band: 550 nm is the measured one, and the
  // others follow its Ångström slope.
  const depth = haze.aerosolDepth ?? TAU_MIE * thickness
  const tauMie = BANDS.map(
    (wavelength) => depth * (wavelength / 550) ** -haze.aerosolAngstrom,
  )
  let mieScatter: [number, number, number]
  let mieExtinction: [number, number, number]
  let mieForward: [number, number, number]
  if (haze.aerosolDepth === undefined) {
    const tint = aerosolTint(limb, betaRayleigh, hRayleigh)
    mieScatter = [
      (tint[0] * tauMie[0]!) / columnMie,
      (tint[1] * tauMie[1]!) / columnMie,
      (tint[2] * tauMie[2]!) / columnMie,
    ]
    // Extinction follows the slope and not the tint: a tinted extinction
    // double-counts the color the scattering tint already applied, and
    // drifts white sums.
    mieExtinction = [
      (tauMie[0]! / columnMie) * MIE_EXTINCTION_RATIO,
      (tauMie[1]! / columnMie) * MIE_EXTINCTION_RATIO,
      (tauMie[2]! / columnMie) * MIE_EXTINCTION_RATIO,
    ]
    mieForward = mieScatter
  } else {
    /*
     * The aerosol is the sky. Its measured depth is an extinction, and what
     * it scatters of that is its albedo in the authored colors: the sky's
     * sideways and the limb's toward the sun, each at `aerosolAlbedo` in its
     * brightest channel and under it in the rest, so no channel scatters
     * more than it takes. Read as a gas instead, Mars's 600 Pa carries a
     * Rayleigh column twenty times its measured depth and a dust column a
     * twentieth of its own, and draws a near-black zenith over the one sky in
     * the system that is lit by its dust from horizon to horizon.
     */
    const albedo = haze.aerosolAlbedo ?? AEROSOL_ALBEDO
    const side = underPeak(color, albedo)
    const forward = underPeak(limb, albedo)
    mieExtinction = [
      tauMie[0]! / columnMie,
      tauMie[1]! / columnMie,
      tauMie[2]! / columnMie,
    ]
    mieScatter = [
      mieExtinction[0] * side[0],
      mieExtinction[1] * side[1],
      mieExtinction[2] * side[2],
    ]
    mieForward = [
      mieExtinction[0] * forward[0],
      mieExtinction[1] * forward[1],
      mieExtinction[2] * forward[2],
    ]
  }

  // A tent's area is its peak times its half-width, so the peak absorption is
  // the column's depth over the half-width.
  const ozonePeak = hRayleigh * OZONE_PEAK_HEIGHTS
  const ozoneHalfWidth = hRayleigh * OZONE_HALF_WIDTH_HEIGHTS
  const molecules = haze.ozone * DOBSON_UNIT
  const ozone: [number, number, number] = [
    (molecules * OZONE_CROSS_SECTION[0]) / ozoneHalfWidth,
    (molecules * OZONE_CROSS_SECTION[1]) / ozoneHalfWidth,
    (molecules * OZONE_CROSS_SECTION[2]) / ozoneHalfWidth,
  ]

  // The detached layer: a tent whose area is its peak times its half-width,
  // so the peak extinction is the depth over the half-width, as the ozone's.
  const detached = haze.detached
  const detachedPeak = detached === undefined ? 0 : hRayleigh * detached.center
  const detachedHalfWidth =
    detached === undefined ? 1 : Math.max(hRayleigh * detached.halfWidth, 1e-9)
  const detachedExtinction =
    detached === undefined ? 0 : detached.depth / detachedHalfWidth
  const detachedScatter: [number, number, number] =
    detached === undefined
      ? [0, 0, 0]
      : (underPeak(detached.color, detachedExtinction) as [
          number,
          number,
          number,
        ])

  return {
    topRatio,
    hRayleigh,
    hMie,
    betaRayleigh,
    mieScatter,
    mieExtinction,
    mieForward,
    aerosolSky: haze.aerosolDepth === undefined ? 0 : 1,
    ozone,
    ozonePeak,
    ozoneHalfWidth,
    detachedPeak,
    detachedHalfWidth,
    detachedExtinction,
    detachedScatter,
  }
}

/** A color scaled so its brightest channel is `peak`, the others under it. */
function underPeak(
  color: HazeAuthoring['color'],
  peak: number,
): [number, number, number] {
  const brightest = Math.max(color.r, color.g, color.b, 1e-6)
  return [
    (color.r / brightest) * peak,
    (color.g / brightest) * peak,
    (color.b / brightest) * peak,
  ]
}

/**
 * How much the air shows, with Earth at 1: the column's scattering depth
 * over Earth's, for the skylight the ground takes from its sky
 * (`terrainPalette`) and the lift's share of a limb (`limbShare`). It is
 * `thickness` where the gas is the sky, and the dust's depth where the dust
 * is, past 1 for a dust deeper than Earth's whole column: Mars's 0.3
 * scatters two decades more than its gas, and a skylight read off the gas
 * lights a Martian shadow at a twentieth of its sky — the black pools under
 * every ridge of a flat-lit orange afternoon.
 */
export function visibleThickness(haze: HazeAuthoring): number {
  const gas = TAU_RAYLEIGH_SUM * haze.thickness
  const aerosol =
    haze.aerosolDepth === undefined
      ? TAU_MIE * haze.thickness * AEROSOL_ALBEDO
      : haze.aerosolDepth * (haze.aerosolAlbedo ?? AEROSOL_ALBEDO)
  return (gas + aerosol) / (TAU_RAYLEIGH_SUM + TAU_MIE * AEROSOL_ALBEDO)
}

/**
 * The vertical column of a `densities` profile: ∫₀ᶜ e^(−h/H)·(1 − h/C) dh.
 *
 * Not H. The fade that takes the density to zero at the ceiling removes
 * H/C of the column — 8% of Earth's gas under its 110 km shell — and an
 * aerosol whose scale height approaches the shell loses most of it, so a
 * coefficient taken as τ/H draws a thinner column than the one measured.
 */
export function densityColumn(scaleHeight: number, ceiling: number): number {
  const ratio = scaleHeight / ceiling
  return scaleHeight * (1 - ratio * (1 - Math.exp(-1 / ratio)))
}

/**
 * The aerosol's own color: the part of the authored limb the Rayleigh column
 * does not already make, with a mean of one.
 *
 * `limb` is what light that has grazed the air looks like, and the
 * transmittance table reddens that light by itself. Earth's orange terminator
 * is its λ⁻⁴ column at a grazing airmass and nothing more, so tinting the
 * aerosol with the whole limb applies the orange twice — and the second
 * application is not confined to the limb. The aerosol's forward lobe sits
 * around the sun at noon, which it painted salmon, and its multiple
 * scattering laid the tint over the whole day sky: a 59° sun gave a zenith of
 * 1.00 : 0.73 : 0.91 against an authored 0.29 : 0.51 : 1. Mars is the
 * opposite case: a 600 Pa column cannot turn anything blue, so its blue limb
 * is the dust's own forward scattering and has to stay on the aerosol.
 *
 * So the split is made in log chroma, where a transmittance is a subtraction.
 * The horizontal column's reddening comes off the limb, and of what remains
 * only the part along the limb's own departure from gray is kept, capped at
 * the limb itself: Earth's remainder points away from its limb and leaves the
 * aerosol gray, Mars keeps about half its blue, and Titan and Venus, whose
 * limbs are their own sky color, keep all of it. The horizontal airmass is
 * Chapman's `√(π/2H)` for a ground observer, in the recipe's own planet
 * radii.
 */
export function aerosolTint(
  limb: HazeAuthoring['limb'],
  betaRayleigh: readonly [number, number, number],
  hRayleigh: number,
): [number, number, number] {
  const airmass = Math.sqrt(Math.PI / (2 * Math.max(hRayleigh, 1e-9)))
  const departure = (values: readonly number[]): number[] => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return values.map((value) => value - mean)
  }
  const tinted = departure(
    [limb.r, limb.g, limb.b].map((value) => Math.log(Math.max(value, 1e-6))),
  )
  // A transmittance is e^−τ, so dividing it out of the limb adds τ back.
  const remainder = departure(
    betaRayleigh.map((beta) => beta * hRayleigh * airmass),
  ).map((reddening, c) => (tinted[c] as number) + reddening)
  const along = tinted.reduce(
    (sum, value, c) => sum + value * (remainder[c] as number),
    0,
  )
  const length = tinted.reduce((sum, value) => sum + value * value, 0)
  const kept = length < 1e-12 ? 0 : Math.min(Math.max(along / length, 0), 1)
  const tint = tinted.map((value) => Math.exp(value * kept))
  const mean = (tint[0]! + tint[1]! + tint[2]!) / 3
  return [tint[0]! / mean, tint[1]! / mean, tint[2]! / mean]
}

/**
 * Densities at height h above the ground, planet radii.
 *
 * The `(1 − h01)` factor takes both profiles to exactly zero at the shell's
 * ceiling. The exponential alone leaves ~1% there, and on an HDR canvas that
 * renders the shell's outer boundary as a visible hairline — the same cut the
 * analytic shell had to patch, kept identical here and in the shader so the
 * table and the march agree about where the air ends.
 */
function densities(
  h: number,
  recipe: AtmosphereRecipe,
): { rayleigh: number; mie: number; ozone: number; detached: number } {
  const ceiling = recipe.topRatio - 1
  const fade = Math.max(0, 1 - h / ceiling)
  const ozone = ozoneDensity(h, recipe)
  const detached = detachedDensity(h, recipe)
  if (fade === 0 || h < 0) {
    // Below the ground the air is whatever it is at the ground: a march step
    // that dips fractionally under r = 1 must not read vacuum.
    if (h < 0)
      return {
        rayleigh: fade > 0 ? 1 : 0,
        mie: fade > 0 ? 1 : 0,
        ozone,
        detached,
      }
    return { rayleigh: 0, mie: 0, ozone, detached }
  }
  return {
    rayleigh: Math.exp(-h / recipe.hRayleigh) * fade,
    mie: Math.exp(-h / recipe.hMie) * fade,
    ozone,
    detached,
  }
}

/** The ozone tent at height `h`, 1 at its peak; the shader's is the same. */
function ozoneDensity(h: number, recipe: AtmosphereRecipe): number {
  return tent(h, recipe.ozonePeak, recipe.ozoneHalfWidth)
}

/** The detached layer's tent at height `h`, 1 at its peak; the shader's is the same. */
function detachedDensity(h: number, recipe: AtmosphereRecipe): number {
  return tent(h, recipe.detachedPeak, recipe.detachedHalfWidth)
}

/** A tent in height, 1 at `peak` and nothing from `halfWidth` either side. */
function tent(h: number, peak: number, halfWidth: number): number {
  return Math.max(0, 1 - Math.abs(h - peak) / Math.max(halfWidth, 1e-9))
}

/**
 * Sample `i` of `n` along a segment of `length`, crowded toward `perigee` —
 * the segment's lowest point, where its air is densest. Returns the distance
 * along the segment and the step the sample stands for.
 *
 * A uniform march does not resolve air that falls off over a kilometer or
 * two. Twelve spread evenly put the first sample 5 km up a 120 km column,
 * past e^−4 of Earth's aerosol, and draw a noon zenith at 39% of one marched
 * in 2,000 steps; an even 32 draw it at 80%. The samples sit at the squares
 * of an even spread on each side of the perigee, in proportion to each
 * side's length, so the steps are fine where the density is and coarse where
 * there is none: 32 come within 0.5% of 2,000, and twelve within 4%.
 * `materials.ts` places the shell's twelve by the same rule.
 */
export function marchSample(
  i: number,
  n: number,
  length: number,
  perigee: number,
): readonly [number, number] {
  const at = Math.min(Math.max(perigee, 0), length)
  const split = length > 0 ? at / length : 0
  const u = (i + 0.5) / n
  if (u < split) {
    const w = (split - u) / split
    return [at - at * w * w, (2 * at * w) / split / n]
  }
  const w = (u - split) / (1 - split)
  return [at + (length - at) * w * w, (2 * (length - at) * w) / (1 - split) / n]
}

/** Distance along (r, μ) to the sphere of radius `radius`, or Infinity. */
function distanceToSphere(r: number, mu: number, radius: number): number {
  const discriminant = r * r * (mu * mu - 1) + radius * radius
  if (discriminant < 0) return Infinity
  const root = Math.sqrt(discriminant)
  const near = -r * mu - root
  const far = -r * mu + root
  if (near > 0) return near
  if (far > 0) return far
  return Infinity
}

/**
 * Transmittance from radius r along zenith-cosine μ to the top of the air.
 *
 * Zero for rays that meet the ground: the light did not get through, and the
 * table stores that fact rather than leaving callers to re-derive the horizon.
 */
export function transmittanceFrom(
  r: number,
  mu: number,
  recipe: AtmosphereRecipe,
): [number, number, number] {
  // Only a downward ray can meet the ground: from r ≥ 1 the radius along a
  // μ ≥ 0 ray is non-decreasing. The explicit guard matters at exactly r = 1,
  // where rounding turns the tangent intersection at s = 0 into a tiny
  // positive distance and a grazing-up ray reads as ending in rock.
  const ground = mu < 0 ? distanceToSphere(r, mu, 1) : Infinity
  if (ground !== Infinity) return [0, 0, 0]
  const top = distanceToSphere(r, mu, recipe.topRatio)
  if (top === Infinity) return [1, 1, 1]

  let tauR = 0
  let tauG = 0
  let tauB = 0
  // A ray climbing from r is densest where it starts; one aimed below the
  // horizontal is densest where it passes closest to the ground.
  const perigee = mu < 0 ? -r * mu : 0
  for (let i = 0; i < TRANSMITTANCE_STEPS; i += 1) {
    const [s, step] = marchSample(i, TRANSMITTANCE_STEPS, top, perigee)
    const radius = Math.sqrt(r * r + s * s + 2 * r * s * mu)
    const { rayleigh, mie, ozone, detached } = densities(radius - 1, recipe)
    const gray = recipe.detachedExtinction * detached
    tauR +=
      (recipe.betaRayleigh[0] * rayleigh +
        recipe.mieExtinction[0] * mie +
        recipe.ozone[0] * ozone +
        gray) *
      step
    tauG +=
      (recipe.betaRayleigh[1] * rayleigh +
        recipe.mieExtinction[1] * mie +
        recipe.ozone[1] * ozone +
        gray) *
      step
    tauB +=
      (recipe.betaRayleigh[2] * rayleigh +
        recipe.mieExtinction[2] * mie +
        recipe.ozone[2] * ozone +
        gray) *
      step
  }
  return [Math.exp(-tauR), Math.exp(-tauG), Math.exp(-tauB)]
}

/**
 * The transmittance table.
 *
 * u spans μ ∈ [−1, 1] linearly and v spans altitude — a deliberately naive
 * parameterization against Bruneton's distance-warped one. Its weakness is
 * resolution exactly at the horizon, where T drops to zero within a texel;
 * bilinear filtering smears that edge across Δμ ≈ 0.004, about a quarter of
 * a degree — the width of a sun. A penumbra there is not a defect, it is the
 * soft horizon every orbital photograph shows.
 */
export function bakeTransmittance(recipe: AtmosphereRecipe): ScatteringLut {
  const width = TRANSMITTANCE_WIDTH
  const height = TRANSMITTANCE_HEIGHT
  const data = new Float32Array(width * height * 4)
  const ceiling = recipe.topRatio - 1
  for (let y = 0; y < height; y += 1) {
    const r = 1 + (y / (height - 1)) * ceiling
    for (let x = 0; x < width; x += 1) {
      const mu = (x / (width - 1)) * 2 - 1
      const [tr, tg, tb] = transmittanceFrom(r, mu, recipe)
      const index = (y * width + x) * 4
      data[index] = tr
      data[index + 1] = tg
      data[index + 2] = tb
      data[index + 3] = 1
    }
  }
  return { width, height, data }
}

/** Bilinear read of a baked table at (u, v) ∈ [0,1]², clamped. */
export function sampleLut(
  lut: ScatteringLut,
  u: number,
  v: number,
): [number, number, number] {
  const x = Math.min(Math.max(u, 0), 1) * (lut.width - 1)
  const y = Math.min(Math.max(v, 0), 1) * (lut.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, lut.width - 1)
  const y1 = Math.min(y0 + 1, lut.height - 1)
  const fx = x - x0
  const fy = y - y0
  const read = (px: number, py: number, c: number): number =>
    lut.data[(py * lut.width + px) * 4 + c] as number
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c += 1) {
    const top = read(x0, y0, c) * (1 - fx) + read(x1, y0, c) * fx
    const bottom = read(x0, y1, c) * (1 - fx) + read(x1, y1, c) * fx
    out[c] = top * (1 - fy) + bottom * fy
  }
  return out
}

const transmittanceAt = (
  lut: ScatteringLut,
  recipe: AtmosphereRecipe,
  radius: number,
  mu: number,
): [number, number, number] =>
  sampleLut(lut, (mu + 1) / 2, (radius - 1) / (recipe.topRatio - 1))

/** A Fibonacci sphere: N directions with no axis favored. */
function fibonacciSphere(count: number): [number, number, number][] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: [number, number, number][] = []
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * (i + 0.5)) / count
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    const angle = golden * i
    out.push([Math.cos(angle) * ring, Math.sin(angle) * ring, z])
  }
  return out
}

/**
 * Hillaire's isotropic multiple-scattering table Ψ(r, μs), as ln Ψ.
 *
 * At each grid point: march a bundle of directions, accumulating the second
 * order of scattering (single-scattered light arriving from every direction,
 * isotropic phase) and the transfer factor f — how much of what scatters here
 * scatters *again*. The geometric series over orders collapses to
 * Ψ = L₂ / (1 − f). The main march then adds Ψ·σs at every sample: all orders
 * past the first for two multiplies and a lookup, which is the entire reason
 * twilight has a sky instead of an edge.
 *
 * The table holds the logarithm, and every reader takes `Math.exp` of a
 * bilinear read (`multipleScatteringAt`). Through twilight Ψ falls tenfold
 * every two degrees and a column of this table spans 11°, so blending the
 * values themselves draws each texel as its brighter neighbor, and the
 * zenith at −12° at three times what the same table says read geometrically.
 * Interpolating the logarithm is exact for an exponential falloff.
 */
export function bakeMultipleScattering(
  recipe: AtmosphereRecipe,
  transmittance: ScatteringLut,
  /** Samples per direction; the default is converged, and a test refines it. */
  steps = MS_STEPS,
): ScatteringLut {
  const width = MULTI_SCATTER_WIDTH
  const height = MULTI_SCATTER_HEIGHT
  const data = new Float32Array(width * height * 4)
  const directions = fibonacciSphere(MS_DIRECTIONS)
  const ceiling = recipe.topRatio - 1
  const isotropic = 1 / (4 * Math.PI)

  for (let y = 0; y < height; y += 1) {
    const r = 1 + (y / (height - 1)) * ceiling
    for (let x = 0; x < width; x += 1) {
      const muSun = (x / (width - 1)) * 2 - 1
      const sun: [number, number, number] = [
        Math.sqrt(Math.max(0, 1 - muSun * muSun)),
        0,
        muSun,
      ]

      const luminance = [0, 0, 0]
      const transfer = [0, 0, 0]
      for (const direction of directions) {
        const muRay = direction[2]
        /*
         * From the ground row, a ray aimed down is already in the ground.
         * `distanceToSphere` answers its far side instead — the start is on
         * the sphere, so the near root is zero and not taken — and a march
         * past this line crosses the planet at the surface's density: a chord
         * of rock lit as if it were air, which grows Ψ at the ground sixfold
         * as the steps are refined. Same μ ≥ 0 guard as `transmittanceFrom`,
         * for its rounding.
         */
        if (muRay < 0 && r <= 1) continue
        const ground = muRay < 0 ? distanceToSphere(r, muRay, 1) : Infinity
        const top = distanceToSphere(r, muRay, recipe.topRatio)
        const end = Math.min(ground, top)
        if (!Number.isFinite(end) || end <= 0) continue
        const perigee = muRay < 0 ? -r * muRay : 0

        // The transmittance to each step's start, as the shader carries it.
        const view = [1, 1, 1]
        for (let i = 0; i < steps; i += 1) {
          const [s, step] = marchSample(i, steps, end, perigee)
          // Position in the plane spanned by zenith and the ray.
          const px = direction[0] * s
          const py = direction[1] * s
          const pz = r + direction[2] * s
          const radius = Math.sqrt(px * px + py * py + pz * pz)
          const { rayleigh, mie, ozone, detached } = densities(
            radius - 1,
            recipe,
          )
          const muSunHere =
            (px * sun[0] + py * sun[1] + pz * sun[2]) / Math.max(radius, 1e-6)
          const sunlight = transmittanceAt(
            transmittance,
            recipe,
            radius,
            muSunHere,
          )
          for (let c = 0; c < 3; c += 1) {
            const scatter =
              (recipe.betaRayleigh[c] as number) * rayleigh +
              (recipe.mieScatter[c] as number) * mie +
              (recipe.detachedScatter[c] as number) * detached
            const extinction =
              (recipe.betaRayleigh[c] as number) * rayleigh +
              (recipe.mieExtinction[c] as number) * mie +
              (recipe.ozone[c] as number) * ozone +
              recipe.detachedExtinction * detached
            const stepTau = extinction * step
            const lost = -Math.expm1(-stepTau)
            // The step's light as the integral over constant density, as
            // the shader's march takes it (`marchAir`).
            const light = stepLight(step, stepTau, lost)
            const through = view[c] as number
            luminance[c] =
              (luminance[c] as number) +
              through * scatter * isotropic * (sunlight[c] as number) * light
            transfer[c] = (transfer[c] as number) + through * scatter * light
            view[c] = through * (1 - lost)
          }
        }
      }

      const index = (y * width + x) * 4
      for (let c = 0; c < 3; c += 1) {
        const secondOrder = (luminance[c] as number) / MS_DIRECTIONS
        const f = Math.min((transfer[c] as number) / MS_DIRECTIONS, 0.95)
        data[index + c] = Math.log(
          Math.max(secondOrder / (1 - f), MULTI_SCATTER_FLOOR),
        )
      }
      data[index + 3] = 1
    }
  }
  return { width, height, data }
}

/** Ψ at (r, μs) from the logarithmic table, interpolated geometrically. */
export function multipleScatteringAt(
  table: ScatteringLut,
  recipe: AtmosphereRecipe,
  radius: number,
  muSun: number,
): [number, number, number] {
  const height01 = Math.min(
    Math.max((radius - 1) / (recipe.topRatio - 1), 0),
    1,
  )
  const [r, g, b] = sampleLut(table, (muSun + 1) / 2, height01)
  return [Math.exp(r), Math.exp(g), Math.exp(b)]
}

/**
 * The sky straight overhead, in scene units per unit of the sun's color.
 *
 * The shell's own march along one ray — the zenith from `radius` planet radii
 * — with the sun `muSun` from overhead. Along a radial line every sample sees
 * the sun at the same cosine, so the column is one-dimensional and the sun's
 * transmittance is computed exactly rather than read from the table. Zero
 * above the air, and zero once the whole column is in the planet's shadow.
 *
 * What it is for is the one number the presentation needs about the sky an
 * observer is standing under: how bright the air in front of everything else
 * is. Enhanced's lift of the faint sky is measured against it.
 */
export function zenithSkyRadiance(
  recipe: AtmosphereRecipe,
  multiScatter: ScatteringLut,
  radius: number,
  muSun: number,
): [number, number, number] {
  const r = Math.max(radius, 1)
  const column = recipe.topRatio - r
  if (column <= 0) return [0, 0, 0]
  const g = AEROSOL_ASYMMETRY
  const phaseRayleigh = (3 / (16 * Math.PI)) * (1 + muSun * muSun)
  const phaseMie =
    (1 - g * g) /
    (4 * Math.PI) /
    Math.max(1 + g * g - 2 * g * muSun, 1e-4) ** 1.5
  const forwardShare = phaseMie / AEROSOL_FORWARD_PEAK
  const radiance: [number, number, number] = [0, 0, 0]
  // The transmittance to each step's start, as the shader carries it.
  const view = [1, 1, 1]
  for (let i = 0; i < ZENITH_STEPS; i += 1) {
    const [offset, step] = marchSample(i, ZENITH_STEPS, column, 0)
    const at = r + offset
    const { rayleigh, mie, ozone, detached } = densities(at - 1, recipe)
    const sunlight = transmittanceFrom(at, muSun, recipe)
    const psi = multipleScatteringAt(multiScatter, recipe, at, muSun)
    for (let c = 0; c < 3; c += 1) {
      const scatterRayleigh = (recipe.betaRayleigh[c] as number) * rayleigh
      const scatterMie = (recipe.mieScatter[c] as number) * mie
      // The detached layer's small particles scatter with Rayleigh's phase.
      const scatterDetached = (recipe.detachedScatter[c] as number) * detached
      // The aerosol turns to its forward color by the lobe's share, as the
      // march does; the multiple scattering keeps the sideways one.
      const scatterToward =
        scatterMie +
        ((recipe.mieForward[c] as number) - (recipe.mieScatter[c] as number)) *
          mie *
          forwardShare
      const extinction =
        scatterRayleigh +
        (recipe.mieExtinction[c] as number) * mie +
        (recipe.ozone[c] as number) * ozone +
        recipe.detachedExtinction * detached
      const stepTau = extinction * step
      const lost = -Math.expm1(-stepTau)
      const through = view[c] as number
      const single =
        ((scatterRayleigh + scatterDetached) * phaseRayleigh +
          scatterToward * phaseMie) *
        (sunlight[c] as number)
      const multiple =
        (psi[c] as number) * (scatterRayleigh + scatterMie + scatterDetached)
      radiance[c] =
        (radiance[c] as number) +
        through *
          (single + multiple) *
          stepLight(step, stepTau, lost) *
          ATMOSPHERE_GAIN
      view[c] = through * (1 - lost)
    }
  }
  return radiance
}

/**
 * A step's light: the integral over a step of constant density from the
 * transmittance at its start, (1 − e^−τ)/σ, for a step `length` long holding
 * `depth` optical depths, given `lost` = 1 − e^−τ. The shader's march takes
 * the same integral (`stepShare` in `render/air.ts`).
 *
 * A step that holds nothing keeps its whole length, the integral's limit. A
 * floor under τ in the quotient takes it to nothing instead: under a floor
 * of 10⁻⁷, a step of 10⁻⁹ draws a hundredth of its light.
 */
function stepLight(length: number, depth: number, lost: number): number {
  return depth > 0 ? (length * lost) / depth : length
}

/**
 * What to draw a star's disk with, per channel, when the eye is inside the
 * air and the shell will then dim it by the path's mean transmittance.
 *
 * The shell composites gray — L + T̄·background — which is right for a sky of
 * faint things behind the air and wrong for the disk in two ways. It does not
 * redden: a sun on the horizon comes through white. And under Enhanced, where
 * the disk is drawn at a calibrated eight times the surface white rather than
 * its physical fifty thousand, the full extinction takes it below its own
 * sky: through a dusty column at a 4.6° sun a gray-dimmed disk is a brown spot
 * in a peach glow, the brightest thing in the scene drawn as the dimmest.
 *
 * So the disk arrives in the column's own color, at the column's luminance
 * raised to `compression` — the exponent that took the physical disk to the
 * drawn one, ln 8 over ln 53,000 for the Sun at 1 AU under Enhanced and 1 for
 * a photograph. The air dims the disk by the same law that put it on screen,
 * so it keeps its rank against the sky until it is physically level with it,
 * and it keeps its hue, because a physical disk through that column is that
 * color at any brightness the hue-preserving curve can show. Compressing each
 * channel instead bleaches a 2° sun to 1 : 0.89 : 0.69. Zero once the planet
 * is in the way, which for a setting disk is a question for
 * `settingDiskCosine` rather than for its center.
 *
 * What this returns is drawn *before* the shell divides it back down, so it
 * is the disk over the column's transmittance, and through the last degree or
 * two above a sea-level horizon that transmittance is 10⁻⁵ and smaller. The
 * scene's target is half-float, whose largest value is 65,504, and each
 * channel is clipped to it on the way in: uncapped, the drawn disk is clipped
 * toward white there before the shell dims it, and the shell's extinction
 * cannot give back the color the clip took. So the return's brightest
 * channel is capped at `ceiling` — a deep-red disk's red is four times its
 * luminance — and a sun that low dims faster than the law that drew it, in
 * the column's own color, until the ground takes it.
 */
export function diskThroughAir(
  recipe: AtmosphereRecipe,
  radius: number,
  mu: number,
  compression: number,
  /**
   * The cap on the brightest channel: `DISK_THROUGH_AIR_CEILING` at the
   * calibration, and that over the scene gain when Enhanced meters inside
   * the air (`meteredShare`) and the stops it opens multiply the disk on its
   * way into the target.
   */
  ceiling = DISK_THROUGH_AIR_CEILING,
): [number, number, number] {
  const passed = transmittanceFrom(Math.max(radius, 1), mu, recipe)
  const mean = (passed[0] + passed[1] + passed[2]) / 3
  const luminance = 0.2126 * passed[0] + 0.7152 * passed[1] + 0.0722 * passed[2]
  if (mean <= 1e-12 || luminance <= 1e-12) return [0, 0, 0]
  const peak = Math.max(passed[0], passed[1], passed[2])
  const gain = Math.min(luminance ** (compression - 1) / mean, ceiling / peak)
  return [passed[0] * gain, passed[1] * gain, passed[2] * gain]
}

/**
 * The most `diskThroughAir` returns at the calibration, in any channel: 2¹¹.
 * At Enhanced's calibrated eight that is 16,384 in the scene's half-float
 * target, a quarter of its range, which leaves the glare and the bloom summed
 * over the disk room to stay finite. The law holds above a column
 * transmittance of 8·10⁻⁵ — Earth's sun from sea level above about 2°.
 *
 * Every stop an exposure opens doubles what reaches the target, and Enhanced
 * opens 3.8 for the daylight left under a 1° sun from sea level, where the
 * disk's red under this cap alone reaches 110,000 — so a caller drawing under
 * an opened exposure divides the cap by the opening.
 */
export const DISK_THROUGH_AIR_CEILING = 2048

/**
 * The zenith cosine of the horizon from `radius` planet radii: the ray that
 * grazes the ground. Zero on the ground, and below zero as the eye climbs.
 */
export function horizonCosine(radius: number): number {
  return -Math.sqrt(Math.max(0, 1 - 1 / (radius * radius)))
}

/**
 * The zenith cosine at which to read a disk of `angularRadius` radians,
 * centered at `mu`, for `diskThroughAir` from `radius` planet radii.
 *
 * `diskThroughAir` colors the whole disk from one ray, and the ray through the
 * center meets the ground while the upper half of the disk is still in the
 * sky. Read there, a half-set sun is zero, and it drops out of a bright
 * horizon in one frame. Across the band where the horizon cuts the disk the
 * cosine eases from the center's to the horizon's, which it reaches as the
 * upper limb sets: `h + a·x²` over `x` from 0 to 1 meets the center's cosine,
 * and its slope, at the top of the band. What is under the drawn horizon is
 * the ground's to cover. Near the horizon a step in the cosine is a step in
 * elevation, so the angular radius serves as one.
 */
export function settingDiskCosine(
  radius: number,
  mu: number,
  angularRadius: number,
): number {
  const horizon = horizonCosine(Math.max(radius, 1))
  const band = Math.max(angularRadius, 0)
  if (!(band > 0) || mu >= horizon + band || mu < horizon - band) return mu
  const x = (mu - horizon + band) / (2 * band)
  return horizon + band * x * x
}
