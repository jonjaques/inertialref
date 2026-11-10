import { pcg4d, smoothstep } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import { aerosolDepthOf } from './atmosphere.ts'
import { type CubeFace, cubeFaceOf } from './cubeSphere.ts'
import { periodIndex } from './weatherClock.ts'

/*
 * The placeholder weather: analytic scenarios the cloud passes draw through
 * the real recipe — the maps' coverage, a genus's height profile, eroded
 * noise — before any climatology exists. Presentation only: nothing here is
 * stored, hashed or saved, and a scenario is chosen by a lever, never by a
 * body's record (rule 17).
 *
 * The σ values are the plan's §5.1 table divided down to 1/m, with round
 * placements. They are uncalibrated on purpose — phase 0 measures what the
 * passes cost, not how a cloud looks — and the measurement batches name
 * these scenarios, so a value here changes only with them.
 */

/** What a placeholder layer can be: each a height profile and an extinction. */
export const CLOUD_GENERA = [
  'stratus',
  'stratocumulus',
  'cumulus',
  'altocumulus',
  'cirrus',
  'cumulonimbus',
  'fog',
  // Last, so every genus before it keeps its row of the profile table.
  'altostratus',
] as const
export type CloudGenus = (typeof CLOUD_GENERA)[number]

/** One shell over the datum, and what fills it. Meters, per meter, micrometers. */
export interface CloudLayerSpec {
  readonly genus: CloudGenus
  /** Over the datum, meters; base < top. */
  readonly base: number
  readonly top: number
  /** Mean column cloud fraction the maps carry, 0..1. */
  readonly coverage: number
  /** In-cloud extinction at full density, 1/m (plan §5.1's km⁻¹ ÷ 1000). */
  readonly sigma: number
  /** One Worley cell of the base noise, meters. */
  readonly cellMeters: number
  /** How far the detail noise eats the edge, 0..1. */
  readonly erosion: number
  /** Effective droplet radius, µm: the phase table's row. */
  readonly radius: number
}

export const SCENARIO_IDS = [
  'fair-cumulus',
  'broken-horizon',
  'inside',
  'two-decks',
  'near-gap-far',
  'cirrus-over-cumulus',
  'anvil',
  'overcast',
  'fog',
  'altocumulus',
  'dusk-altocumulus',
  'stratocumulus',
] as const
export type ScenarioId = (typeof SCENARIO_IDS)[number]

export interface WeatherScenario {
  readonly id: ScenarioId
  /** At most `MAX_CLOUD_LAYERS`, sorted by base, disjoint. */
  readonly layers: readonly CloudLayerSpec[]
  /** A uniform placeholder wind at the eye, m/s. */
  readonly wind: { readonly east: number; readonly north: number }
  /** How coverage varies over the body. */
  readonly pattern: 'uniform' | 'bands' | 'blobs'
  /** Angular size of a band or a blob, radians; 0 for a uniform pattern. */
  readonly patternScale: number
  /** Seconds a blob's cell holds one draw before it draws again; 0 for never. */
  readonly patternPeriod: number
  /**
   * Where the layers end against the sun, or nowhere when absent: full cover
   * where the local sun stands under `full` degrees over the horizon, none
   * over `clear`, and a smoothstep between, in the sine of the elevation.
   *
   * A deck held over the whole body cannot be lit from below. A base's ray
   * to a sun under its horizon dips under the layer and climbs back into it
   * where the local sun stands as far over the horizon as it is under here,
   * hundreds of kilometers sunward, and a regime that holds cover there
   * stands the whole deck in its own shadow. Real underlit decks end
   * sunward, with clear sky under the edge, and this is that edge.
   */
  readonly terminator?: { readonly full: number; readonly clear: number }
}

/** The layers a frame carries: three shells' boundaries, six uniforms a body. */
export const MAX_CLOUD_LAYERS = 3

/*
 * The two decks the cornerstones stand under or over (phase 1 design §3.3).
 *
 * Each regime's thickness is held to ISCCP-H by `weatherCalibration.slow.test.ts`.
 * The altocumulus deck is 400 m, the top of its genus's range: its detected
 * pixels' radiative mean depth is then 1.33 against ISCCP-H's altocumulus
 * 1.37, where at 800 m it was 2.28. The stratocumulus deck is already its
 * range's top, 500 m, and is too thin for ISCCP-H's class: the miss is
 * declared there with its figure.
 */
const ALTOCUMULUS: CloudLayerSpec = {
  genus: 'altocumulus',
  base: 4000,
  top: 4400,
  coverage: 0.7,
  sigma: 0.04,
  cellMeters: 1000,
  erosion: 0.5,
  radius: 7,
}
const STRATOCUMULUS: CloudLayerSpec = {
  genus: 'stratocumulus',
  base: 800,
  top: 1300,
  coverage: 0.9,
  sigma: 0.035,
  cellMeters: 1800,
  erosion: 0.4,
  radius: 10,
}

const cumulus = (
  base: number,
  top: number,
  coverage: number,
  sigma: number,
  cellMeters: number,
  erosion: number,
  radius: number,
): CloudLayerSpec => ({
  genus: 'cumulus',
  base,
  top,
  coverage,
  sigma,
  cellMeters,
  erosion,
  radius,
})

export const WEATHER_SCENARIOS: Readonly<Record<ScenarioId, WeatherScenario>> =
  {
    'fair-cumulus': {
      id: 'fair-cumulus',
      layers: [cumulus(1000, 2400, 0.35, 0.068, 1200, 0.6, 8)],
      wind: { east: 8, north: 2 },
      pattern: 'blobs',
      patternScale: 0.02,
      patternPeriod: 3600,
    },
    'broken-horizon': {
      id: 'broken-horizon',
      layers: [cumulus(900, 2200, 0.5, 0.052, 1500, 0.5, 10)],
      wind: { east: 10, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    inside: {
      id: 'inside',
      layers: [
        {
          genus: 'stratocumulus',
          base: 800,
          top: 1800,
          coverage: 1,
          sigma: 0.035,
          cellMeters: 2000,
          erosion: 0.3,
          radius: 10,
        },
      ],
      wind: { east: 5, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'two-decks': {
      id: 'two-decks',
      layers: [
        {
          genus: 'stratocumulus',
          base: 1000,
          top: 1500,
          coverage: 0.6,
          sigma: 0.035,
          cellMeters: 1800,
          erosion: 0.4,
          radius: 10,
        },
        {
          genus: 'altocumulus',
          base: 4000,
          top: 4800,
          coverage: 0.6,
          sigma: 0.04,
          cellMeters: 1000,
          erosion: 0.5,
          radius: 7,
        },
      ],
      wind: { east: 8, north: 4 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'near-gap-far': {
      id: 'near-gap-far',
      layers: [cumulus(1000, 2400, 0.5, 0.068, 1200, 0.6, 8)],
      wind: { east: 8, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'cirrus-over-cumulus': {
      id: 'cirrus-over-cumulus',
      layers: [
        cumulus(1000, 2400, 0.35, 0.068, 1200, 0.6, 8),
        {
          genus: 'cirrus',
          base: 9000,
          top: 10000,
          coverage: 0.5,
          sigma: 0.0002,
          cellMeters: 5000,
          erosion: 0.3,
          radius: 32,
        },
      ],
      wind: { east: 12, north: 0 },
      pattern: 'bands',
      patternScale: 0.05,
      patternPeriod: 0,
    },
    anvil: {
      id: 'anvil',
      layers: [
        {
          genus: 'cumulonimbus',
          base: 1000,
          top: 15000,
          coverage: 0.25,
          sigma: 0.093,
          cellMeters: 8000,
          erosion: 0.4,
          radius: 12,
        },
      ],
      wind: { east: 6, north: 0 },
      pattern: 'blobs',
      patternScale: 0.05,
      patternPeriod: 7200,
    },
    overcast: {
      id: 'overcast',
      layers: [
        {
          genus: 'stratus',
          base: 300,
          top: 1000,
          coverage: 1,
          sigma: 0.057,
          cellMeters: 3000,
          erosion: 0.2,
          radius: 8,
        },
      ],
      wind: { east: 4, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    /*
     * The cornerstones' three. A regime's id is part of a committed format
     * from here on — `cornerstones.json` names them — so an id is never
     * renamed; a picture naming one a build does not know reports its
     * weather unavailable.
     *
     * `altocumulus` is a mid-level deck with nothing under it to block a sun
     * under the horizon; `dusk-altocumulus` is the same deck ending where the
     * local sun clears the horizon, which is what lets G3's bases be lit
     * from below; `stratocumulus` is the marine deck G4 looks down on and
     * G6 descends through.
     */
    altocumulus: {
      id: 'altocumulus',
      layers: [ALTOCUMULUS],
      wind: { east: 8, north: 4 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'dusk-altocumulus': {
      id: 'dusk-altocumulus',
      layers: [ALTOCUMULUS],
      wind: { east: 8, north: 4 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
      terminator: { full: -0.1, clear: 0.1 },
    },
    stratocumulus: {
      id: 'stratocumulus',
      layers: [STRATOCUMULUS],
      wind: { east: 6, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    fog: {
      id: 'fog',
      layers: [
        {
          genus: 'fog',
          base: 0,
          top: 150,
          coverage: 1,
          sigma: 0.0081,
          cellMeters: 500,
          erosion: 0.2,
          radius: 6,
        },
      ],
      wind: { east: 1, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
  }

/*
 * The patterns. Each keeps the layer's `coverage` as its mean over the body
 * and stays inside [0, 1], so a measurement that names a coverage gets it.
 *
 * Bands follow latitude about the pole, +Y in body-fixed axes: a cosine whose
 * cloudy and clear halves are each `patternScale` wide, its swing as large as
 * the mean allows without leaving [0, 1].
 *
 * Blobs sit one to a cell of the weather cube's face grid. A cell exists when
 * the first lane of pcg4d(cell, period) falls under a u32 threshold, so the
 * GPU's bake decides exactly what this does (rule 58): the comparison is
 * between integers, and the cell index itself is never in doubt at a texel
 * center, because a face edge holds a power of two of cells no finer than
 * its 512 texels and a texel center is then never on a cell's edge — it sits
 * at an odd multiple of half a texel. A blob is 1 over the inner half of its
 * cell and falls smoothly to 0 by the cell's inscribed circle, so a cell
 * index read the other way near an edge reads 0 on both sides and the field
 * stays continuous across cells and faces. Its mean over the cell is
 * 23π/160 = 0.4516; a coverage past that fills every cell and raises the
 * floor between them instead.
 */

/** A blob's full core and its edge, in half-widths of its cell. */
const BLOB_CORE = 0.5
/** The blob's mean over its cell: π/4 for the core's disk plus 0.65·π/2 for its rim, over the cell's area of 4. */
export const BLOB_MEAN = (23 * Math.PI) / 160
/** The finest blob grid: one cell a texel of a 512-texel face. */
const BLOB_CELLS_MAX = 512
const U32_MAX = 0xffff_ffff

/**
 * Cells a face edge for blobs of angular size `patternScale`: the power of
 * two nearest a face's quarter turn over that size. 32 for the anvil's 0.05
 * rad, 16 texels a cell; 64 for fair-cumulus's 0.02, 8 a cell.
 */
export function blobCells(patternScale: number): number {
  if (!(patternScale > 0)) return 1
  const exponent = Math.round(Math.log2(Math.PI / 2 / patternScale))
  return Math.min(BLOB_CELLS_MAX, Math.max(1, 2 ** exponent))
}

/**
 * The u32 a blob cell's hash must fall under, for a layer's mean coverage:
 * computed here, uploaded as an integer, never compared as a float.
 */
export function blobThreshold(coverage: number): number {
  const share = Math.min(1, Math.max(0, coverage) / BLOB_MEAN)
  return Math.min(U32_MAX, Math.floor(share * 0x1_0000_0000))
}

/** The coverage between blobs: none until every cell holds one. */
function blobFloor(coverage: number): number {
  return Math.max(0, (Math.min(1, coverage) - BLOB_MEAN) / (1 - BLOB_MEAN))
}

/**
 * Whether the blob cell (i, j) of `face` holds a blob for `layer` in the
 * pattern's period `period` (`periodIndex`'s halves). The face, the layer and
 * the period's high half share pcg4d's third lane: a face is three bits, a
 * layer two, and the high half is under 2¹⁰ for any instant within
 * 3.2 × 10¹² s of a one-second period.
 */
export function blobExists(
  face: CubeFace,
  i: number,
  j: number,
  layer: number,
  period: readonly [number, number],
  threshold: number,
): boolean {
  const lane = (face | (layer << 3) | (period[1] << 5)) >>> 0
  return pcg4d(i, j, lane, period[0]).x < threshold
}

function blobCoverage(
  s: WeatherScenario,
  layer: number,
  coverage: number,
  direction: Vec3,
  t: number,
): number {
  const cells = blobCells(s.patternScale)
  const { face, a, b } = cubeFaceOf(direction)
  const x = ((a + 1) / 2) * cells
  const y = ((b + 1) / 2) * cells
  const i = Math.min(cells - 1, Math.max(0, Math.floor(x)))
  const j = Math.min(cells - 1, Math.max(0, Math.floor(y)))
  const floor = blobFloor(coverage)
  const period = periodIndex(t, s.patternPeriod)
  if (!blobExists(face, i, j, layer, period, blobThreshold(coverage)))
    return floor
  const radius = Math.hypot(2 * (x - i) - 1, 2 * (y - j) - 1)
  return floor + (1 - floor) * (1 - smoothstep(BLOB_CORE, 1, radius))
}

function bandCoverage(
  s: WeatherScenario,
  coverage: number,
  direction: Vec3,
): number {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  const latitude = Math.asin(
    Math.min(1, Math.max(-1, length > 0 ? direction.y / length : 0)),
  )
  const swing = coverage <= 0.5 ? 1 : (1 - coverage) / coverage
  return (
    coverage * (1 + swing * Math.cos((Math.PI * latitude) / s.patternScale))
  )
}

/**
 * A terminator's two elevations as the sines the bake compares, `[full,
 * clear]`; `[2, 3]` with no terminator, which no sine reaches, so the
 * factor is 1 everywhere and one program serves both kinds of scenario.
 */
export function terminatorSines(s: WeatherScenario): readonly [number, number] {
  if (s.terminator === undefined) return [2, 3]
  const sine = (degrees: number): number => Math.sin((degrees * Math.PI) / 180)
  return [sine(s.terminator.full), sine(s.terminator.clear)]
}

/** The share of the pattern's cover a terminator leaves at a direction. */
function terminatorShare(
  s: WeatherScenario,
  direction: Vec3,
  sun: Vec3 | null,
): number {
  if (s.terminator === undefined) return 1
  if (sun === null)
    throw new Error(`${s.id} ends at the terminator, so its cover needs a sun`)
  const length = Math.hypot(direction.x, direction.y, direction.z)
  const up =
    length > 0
      ? (direction.x * sun.x + direction.y * sun.y + direction.z * sun.z) /
        length
      : 0
  const [full, clear] = terminatorSines(s)
  return 1 - smoothstep(full, clear, up)
}

/**
 * The coverage the maps hold for `layer` at a body-fixed unit direction, at
 * presentation time `t`, under a body-fixed unit `sun`: the CPU reference of
 * the maps' bake. Blob cells hash (cell, periodIndex) with pcg4d against a
 * u32 threshold (rule 58). The sun is read only by a scenario with a
 * terminator, and such a scenario refuses a null one rather than answer for
 * a sun nobody named.
 */
export function scenarioCoverage(
  s: WeatherScenario,
  layer: number,
  direction: Vec3,
  t: number,
  sun: Vec3 | null = null,
): number {
  const spec = s.layers[layer]
  if (spec === undefined) return 0
  const coverage = Math.min(1, Math.max(0, spec.coverage))
  const share = terminatorShare(s, direction, sun)
  if (s.pattern === 'blobs')
    return share * blobCoverage(s, layer, coverage, direction, t)
  if (s.pattern === 'bands' && s.patternScale > 0)
    return share * bandCoverage(s, coverage, direction)
  return share * coverage
}

/*
 * Each genus as a rise from its base and a fall to its top: smoothstep up
 * over [0, rise], full density, smoothstep down over [fall, 1]. A stratus
 * sheet holds its density through most of its depth; a cumulus rises sharply
 * off a flat base and thins toward a rounded top; cirrus is a thin peak; a
 * cumulonimbus fills its column to the anvil; fog is densest at the ground.
 * Placeholders, like the scenarios: the measurement prices the march, and a
 * profile's shape moves the cost only through where it puts the density.
 */
const PROFILES: Readonly<
  Record<CloudGenus, { readonly rise: number; readonly fall: number }>
> = {
  stratus: { rise: 0.1, fall: 0.7 },
  stratocumulus: { rise: 0.15, fall: 0.5 },
  cumulus: { rise: 0.08, fall: 0.55 },
  altocumulus: { rise: 0.2, fall: 0.6 },
  cirrus: { rise: 0.3, fall: 0.5 },
  cumulonimbus: { rise: 0.03, fall: 0.85 },
  fog: { rise: 0.02, fall: 0.25 },
  // A sheet like stratus, with a softer base: its water is flat (§5.2).
  altostratus: { rise: 0.15, fall: 0.75 },
}

/**
 * The genus's density profile over a layer, `h01` = 0 at its base and 1 at
 * its top: continuous, 0 outside (0, 1), peak 1. The CPU reference of the
 * profile table.
 */
export function genusProfile(genus: CloudGenus, h01: number): number {
  if (!(h01 > 0 && h01 < 1)) return 0
  const { rise, fall } = PROFILES[genus]
  return smoothstep(0, rise, h01) * (1 - smoothstep(fall, 1, h01))
}

/**
 * The profile's mean over its layer, (1 + fall − rise)/2: each smoothstep
 * integrates to half its width. §5.6's p̄, the density an unresolved cell
 * stands for.
 */
export function genusProfileMean(genus: CloudGenus): number {
  const { rise, fall } = PROFILES[genus]
  return (1 + fall - rise) / 2
}

/** The lowest base and highest top, meters over the datum. */
export function shellUnion(s: WeatherScenario): {
  readonly base: number
  readonly top: number
} {
  if (s.layers.length === 0) return { base: 0, top: 0 }
  let base = Infinity
  let top = -Infinity
  for (const layer of s.layers) {
    base = Math.min(base, layer.base)
    top = Math.max(top, layer.top)
  }
  return { base, top }
}

/**
 * Drawn with weather by default: a standing sea of water under an air whose
 * aerosol is a haze, not a deck. Derived; stored nowhere (rule 17).
 *
 * The aerosol bound is the line between a haze and a deck. A sulfuric
 * family's air (τ 8) and Titan's (τ 4.3) already are a cloud the air's tables
 * draw, and a volume over them counts the cloud twice; dust (0.4) and violet
 * (0.25) are hazes. The depth is the one the air's recipe draws
 * (`aerosolDepthOf`), so an unauthored haze thicker than 1/0.12 is a deck
 * here as it is in the sky.
 */
export function wetWorld(body: Body): boolean {
  const haze = body.appearance.haze
  return (
    body.surface.seaLevel !== null &&
    body.surface.grammar.liquidKind === 'water' &&
    (haze === null || aerosolDepthOf(haze) < 1)
  )
}

/**
 * Drawn by the volume unasked: wet, and no authored deck to lose. Derived;
 * stored nowhere (rule 17).
 *
 * Earth is wet and keeps its textured deck until the volume draws Earth with
 * its shadow and its light, so it is outside this set: a picture or a lever
 * that wants the volume there names it by address, which wins over the set.
 * A body leaves its deck behind and joins the set with no change here.
 */
export function cloudsServed(body: Body): boolean {
  return wetWorld(body) && body.appearance.clouds === null
}
