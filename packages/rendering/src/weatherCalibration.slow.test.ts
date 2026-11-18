import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@inertialref/spatial'
import { isccpZonal } from './isccpZonal.ts'
import { SLAB_REFERENCE } from './slabReference.generated.ts'
import {
  type BodyWeather,
  EARTH_ZONAL_LAW,
  zonalClimate,
} from './weatherClimate.ts'
import { cloudFieldAt, columnDepth, fieldClock } from './weatherField.ts'
import { GENUS_TABLE, levelProfile } from './weatherGenus.ts'
import {
  type CloudGenus,
  type CloudLayerSpec,
  type ScenarioId,
  WEATHER_SCENARIOS,
} from './weatherScenario.ts'

/*
 * The calibration: the weather field's constants held to observations
 * (phase 1 design §5.2, §5.3 and §5.11; the rubric's rows 9, 10 and 16).
 *
 * **Like with like.** ISCCP-H averages a type's optical depth in
 * reflectance, not linearly: for stratus the two means are 43.66 and 50.66.
 * So a pixel here is what a retrieval makes of it: the mean over its columns
 * of the black-surface reflectance `R(τ)`, which the slab oracle tabulates
 * on the true medium (`SLAB_REFERENCE.flux`), inverted through the same
 * `R`. A genus's mean is its detected pixels' reflectance averaged and
 * inverted again.
 *
 * **The field is the resolved one.** Every column is `columnDepth`, at no
 * footprint, so what is held is the cloud the march resolves. Its in-cloud
 * extinction is each genus's σ to 1% (the level's gain by cover and row,
 * `weatherField.ts`), so what yields to ISCCP-H is a regime's thickness and
 * cover, inside its genus's range (§5.2).
 *
 * Figures quoted here were measured on this Mac mini (Mac18,5, Apple M6,
 * 32 GB, Node 26) with this file, and every one of them is deterministic:
 * the field is a pure function of its place and instant.
 */

/* ------------------------------------------------------------------------- */
/* The reflectance a retrieval reads                                          */
/* ------------------------------------------------------------------------- */

/** The oracle's suns: `μ₀` 0.7, the rows' own, and 0.4, their check. */
type Sun = 0 | 1
const { depths: DEPTHS, flux: FLUX } = SLAB_REFERENCE
const LOG_DEPTHS = DEPTHS.map(Math.log)
const NODES = DEPTHS.length

/** The table's reflectances under one sun. */
const row = (sun: Sun): readonly number[] =>
  FLUX.slice(sun * NODES, (sun + 1) * NODES)

/**
 * `R(τ, μ₀)` over a black surface: the oracle's table read linearly in
 * `ln τ`. Under its first depth, 0.1, a slab reflects in proportion to its
 * depth, single scattering's law, so the read falls on a line to zero.
 * Past its last, 100, `1 − R` falls as `a/(τ + b)` through the last two
 * nodes, the two-stream form of a thick slab, so a column of a
 * cumulonimbus is not clamped to the table's 0.908.
 */
function blackReflectance(depth: number, sun: Sun): number {
  if (!(depth > 0)) return 0
  const r = row(sun)
  if (depth <= DEPTHS[0]!) return (r[0]! * depth) / DEPTHS[0]!
  const last = NODES - 1
  if (depth >= DEPTHS[last]!) {
    const [t1, t2] = [DEPTHS[last - 1]!, DEPTHS[last]!]
    const [q1, q2] = [1 - r[last - 1]!, 1 - r[last]!]
    const b = (q2 * t2 - q1 * t1) / (q1 - q2)
    return 1 - (q2 * (t2 + b)) / (depth + b)
  }
  const x = Math.log(depth)
  let k = 0
  while (LOG_DEPTHS[k + 1]! < x) k += 1
  const w = (x - LOG_DEPTHS[k]!) / (LOG_DEPTHS[k + 1]! - LOG_DEPTHS[k]!)
  return r[k]! + (r[k + 1]! - r[k]!) * w
}

/** The depth whose reflectance is `reflectance`: `blackReflectance`'s inverse, by bisection to 10⁻¹² of the bracket. */
function invertReflectance(reflectance: number, sun: Sun): number {
  if (!(reflectance > 0)) return 0
  let low = 0
  let high = 1e6
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2
    if (blackReflectance(mid, sun) < reflectance) low = mid
    else high = mid
  }
  return (low + high) / 2
}

/**
 * A number in [min, max]: three draws in four uniform in value, one from
 * `fc.double`, whose draws crowd near zero, kept for the edges it finds.
 */
const between = (min: number, max: number) =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .noBias(fc.integer({ min: 0, max: 2 ** 30 }))
        .map((i) => min + ((max - min) * i) / 2 ** 30),
    },
    { weight: 1, arbitrary: fc.double({ min, max, noNaN: true }) },
  )

describe('the reflectance a retrieval reads', () => {
  it('is the oracle’s table at its nodes, under both suns', () => {
    for (const sun of [0, 1] as const)
      DEPTHS.forEach((depth, i) =>
        expect(blackReflectance(depth, sun)).toBeCloseTo(row(sun)[i]!, 12),
      )
  })

  it('rises with depth from nothing toward one, and is continuous at both ends of the table', () => {
    const examples = [0, 1e-6, 0.1, 0.38, 3.55, 22.63, 100, 380, 1e4]
    for (const sun of [0, 1] as const) {
      for (const depth of examples) {
        const r = blackReflectance(depth, sun)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThan(1)
      }
      for (const edge of [DEPTHS[0]!, DEPTHS[NODES - 1]!])
        expect(
          Math.abs(
            blackReflectance(edge * (1 + 1e-9), sun) -
              blackReflectance(edge * (1 - 1e-9), sun),
          ),
        ).toBeLessThan(1e-8)
      fc.assert(
        fc.property(between(0, 2000), between(0, 2000), (a, b) => {
          const [low, high] = a < b ? [a, b] : [b, a]
          expect(blackReflectance(high, sun)).toBeGreaterThanOrEqual(
            blackReflectance(low, sun),
          )
        }),
        { numRuns: 500 },
      )
    }
  })

  it('inverts to the depth it was given, over every depth a column holds', () => {
    for (const sun of [0, 1] as const) {
      for (const depth of [0, 0.05, 0.1, 3.55, 22.63, 100, 1500])
        expect(
          Math.abs(
            invertReflectance(blackReflectance(depth, sun), sun) - depth,
          ),
        ).toBeLessThanOrEqual(1e-6 * Math.max(1, depth))
      fc.assert(
        fc.property(between(0, 1500), (depth) => {
          const back = invertReflectance(blackReflectance(depth, sun), sun)
          expect(Math.abs(back - depth)).toBeLessThanOrEqual(
            1e-6 * Math.max(1, depth),
          )
        }),
        { numRuns: 500 },
      )
    }
  })

  it('detects a pixel at ISCCP’s visible threshold, 0.03, near a depth of 0.38', () => {
    // C-ATBD's threshold is 0.03 to 0.06 by surface; 0.03 is the ocean's.
    expect(invertReflectance(DETECTED, 0)).toBeGreaterThan(0.35)
    expect(invertReflectance(DETECTED, 0)).toBeLessThan(0.4)
  })
})

/* ------------------------------------------------------------------------- */
/* Row 9: each genus in ISCCP's classes                                       */
/* ------------------------------------------------------------------------- */

const RADIUS = 6_371_000
/** ISCCP-H's type boundaries in optical depth. */
const THIN = 3.55
const THICK = 22.63
/** A pixel's reflectance at which it is cloudy (C-ATBD, the ocean's). */
const DETECTED = 0.03
/** 200 columns a side at 500 m, 10 to a pixel side: 400 pixels of 100. */
const COLUMNS = 200
const SPACING = 500
const PIXEL = 10

/** A weather of one level of `genus`, at a uniform cover: a regime's layer laid at the row's cover. */
function oneLevel(
  genus: CloudGenus,
  base: number,
  top: number,
  cover: number,
): BodyWeather {
  const convective = GENUS_TABLE[genus].cumuliform ? 1 : 0
  const empty = { base: top, top, stratiform: genus, cumuliform: genus }
  return {
    seed: { hi: 1, lo: 2 } as unknown as BodyWeather['seed'],
    datumRadius: RADIUS,
    levels: [{ base, top, stratiform: genus, cumuliform: genus }, empty, empty],
    climate: {
      kind: 'regime',
      sample: () => ({
        cover: [cover, 0, 0],
        convective: [convective, 0, 0],
        ice: 0,
        deep: 0,
      }),
      coefficients: () => {
        throw new Error('the calibration reads samples, not uniforms')
      },
    },
    turn: [0, 0, 0],
    drift: 0,
  }
}

/** The tangent frame at a place: 0.3 rad north, 0.6 rad east. */
const PLACE = (() => {
  const [lat, lon] = [0.3, 0.6]
  return {
    up: {
      x: Math.cos(lat) * Math.cos(lon),
      y: Math.sin(lat),
      z: -Math.cos(lat) * Math.sin(lon),
    },
    east: { x: -Math.sin(lon), y: 0, z: -Math.cos(lon) },
    north: {
      x: -Math.sin(lat) * Math.cos(lon),
      y: Math.cos(lat),
      z: Math.sin(lat) * Math.sin(lon),
    },
  }
})()

/** The direction of the column `i` east and `j` north of a square's corner, `side` columns `spacing` apart. */
function columnAt(i: number, j: number, side: number, spacing: number): Vec3 {
  const half = (side - 1) / 2
  const e = ((i - half) * spacing) / RADIUS
  const n = ((j - half) * spacing) / RADIUS
  const { up, east, north } = PLACE
  return {
    x: up.x + east.x * e + north.x * n,
    y: up.y + east.y * e + north.y * n,
    z: up.z + east.z * e + north.z * n,
  }
}

/** The square's unscaled column depths, row by row. */
function depths(weather: BodyWeather): Float64Array {
  const clock = fieldClock(weather, 0)
  const out = new Float64Array(COLUMNS * COLUMNS)
  for (let j = 0; j < COLUMNS; j += 1)
    for (let i = 0; i < COLUMNS; i += 1)
      out[j * COLUMNS + i] = columnDepth(
        weather,
        clock,
        PLACE.up,
        columnAt(i, j, COLUMNS, SPACING),
        0,
      )
  return out
}

/** What a retrieval makes of a square under one sun. */
interface Retrieval {
  /** Pixels holding any cloud, and of those the share detected. */
  readonly cloudy: number
  readonly detected: number
  /** Of the detected pixels, the shares under 3.55, in 3.55–22.63 and over 22.63. */
  readonly under: number
  readonly within: number
  readonly over: number
  /** The detected pixels' reflectance averaged and inverted: ISCCP's mean. */
  readonly mean: number
}

function retrieve(columns: Float64Array, sun: Sun): Retrieval {
  const pixels = COLUMNS / PIXEL
  const found: number[] = []
  let cloudy = 0
  let total = 0
  for (let pj = 0; pj < pixels; pj += 1)
    for (let pi = 0; pi < pixels; pi += 1) {
      let sum = 0
      let any = false
      for (let j = 0; j < PIXEL; j += 1)
        for (let i = 0; i < PIXEL; i += 1) {
          const depth = columns[(pj * PIXEL + j) * COLUMNS + pi * PIXEL + i]!
          any ||= depth > 0
          sum += blackReflectance(depth, sun)
        }
      const reflectance = sum / (PIXEL * PIXEL)
      if (any) cloudy += 1
      if (reflectance < DETECTED) continue
      total += reflectance
      found.push(invertReflectance(reflectance, sun))
    }
  const share = (test: (depth: number) => boolean) =>
    found.length === 0 ? 0 : found.filter(test).length / found.length
  return {
    cloudy,
    detected: cloudy === 0 ? 0 : found.length / cloudy,
    under: share((depth) => depth < THIN),
    within: share((depth) => depth >= THIN && depth <= THICK),
    over: share((depth) => depth > THICK),
    mean: found.length === 0 ? 0 : invertReflectance(total / found.length, sun),
  }
}

type Share = 'under' | 'within' | 'over' | 'notUnder' | 'notOver'
const shareOf = (r: Retrieval, share: Share): number =>
  share === 'notUnder'
    ? r.within + r.over
    : share === 'notOver'
      ? r.under + r.within
      : r[share]

/** A regime's layer, by its id and index. */
const layerOf = (regime: ScenarioId, index: number): CloudLayerSpec =>
  WEATHER_SCENARIOS[regime].layers[index]!

/**
 * One row of §6.2: a genus laid at its cover over the thickness its regime
 * gives it, the shares its detected pixels must hold, and ISCCP-H's type it
 * is held to in mean. Altostratus has no regime: it is laid at 500 m, the
 * thickness inside its range whose mean meets ISCCP-H's (8.99 against 8.54;
 * 7.46 at 400 m, 10.45 at 600), and that is what a regime of it should take.
 */
interface GenusRow {
  readonly genus: CloudGenus
  readonly base: number
  readonly top: number
  readonly cover: number
  readonly type: string
  readonly shares: readonly (readonly [Share, number])[]
}

const fromRegime = (
  regime: ScenarioId,
  index: number,
  cover: number,
  type: string,
  shares: GenusRow['shares'],
): GenusRow => {
  const layer = layerOf(regime, index)
  return {
    genus: layer.genus,
    base: layer.base,
    top: layer.top,
    cover,
    type,
    shares,
  }
}

const ROWS: readonly GenusRow[] = [
  fromRegime('fair-cumulus', 0, 0.35, 'cumulus', [
    ['notOver', 0.9],
    ['under', 0.3],
  ]),
  fromRegime('stratocumulus', 0, 0.9, 'stratocumulus', [['within', 0.6]]),
  fromRegime('overcast', 0, 1, 'stratus', [
    ['notUnder', 0.9],
    ['over', 0.3],
  ]),
  fromRegime('altocumulus', 0, 0.7, 'altocumulus', [['under', 0.6]]),
  {
    genus: 'altostratus',
    base: 4000,
    top: 4500,
    cover: 1,
    type: 'altostratus',
    shares: [['within', 0.6]],
  },
  fromRegime('cirrus-over-cumulus', 1, 0.5, 'cirrus', [['under', 0.8]]),
  fromRegime('anvil', 0, 0.9, 'deep-convection', [['over', 0.6]]),
]

const rowOf = (genus: CloudGenus): GenusRow =>
  ROWS.find((r) => r.genus === genus)!

/**
 * The bounds a declared miss is held to: its measured figure, so a later
 * change that makes it worse fails. A share's bound is the least it may be,
 * a mean's the largest relative error, the sun's the most a share may move.
 * Each miss is also an `it.fails` below, against the rubric's own bound, so
 * a change that cures it fails there and the declaration goes.
 *
 * - Stratocumulus is at its range's top, 500 m. Its class shifts 27 points
 *   between the suns at every thickness that keeps its share in class (26
 *   at 350 m, 20 even at 800 m; only 200 m, 9 points, loses the class), and
 *   its mean, 5.01 against 7.35, meets ISCCP-H near 800 m (7.02).
 * - Stratus is at its range's top, 700 m: 0.280 of its pixels over 22.63
 *   against 0.30, which 800 m passes (0.345). Its mean, 14.5 against 43.7,
 *   would need several kilometers.
 * - Cirrus at the plan's 0.2 km⁻¹ has no column deeper than 0.23 and no
 *   pixel the visible threshold sees; at its range's 2 km, 1.1%.
 * - Cumulonimbus is "to the level's top", 14 km, and its mean is 159.9
 *   against ISCCP-H's deep convection, 48.9, whose retrievals saturate.
 */
const DECLARED: {
  readonly shares: Readonly<Record<string, number>>
  readonly mean: Readonly<Record<string, number>>
  readonly sun: Readonly<Record<string, number>>
  /** The least mean column depth a genus whose pixels no threshold sees holds. */
  readonly depth: Readonly<Record<string, number>>
} = {
  shares: { 'stratus over': 0.28 },
  mean: { stratocumulus: 0.32, stratus: 0.67, 'deep-convection': 2.28 },
  sun: { stratocumulus: 0.28 },
  depth: { cirrus: 0.03 },
}

/** ISCCP-H's tolerance on a type's mean depth (rubric row 9). */
const MEAN_TOLERANCE = 0.15
/** The most a share may move between the two suns (rubric row 9). */
const SUN_TOLERANCE = 0.1
/** A row reads at all only when half its cloudy pixels are seen (§5.2). */
const LEAST_DETECTED = 0.5

/** Each row's columns, taken once: 40,000 at 220 to 280 µs. */
const COLUMNS_OF = new Map<CloudGenus, Float64Array>()
const columnsOf = (r: GenusRow): Float64Array => {
  let held = COLUMNS_OF.get(r.genus)
  if (held === undefined) {
    held = depths(oneLevel(r.genus, r.base, r.top, r.cover))
    COLUMNS_OF.set(r.genus, held)
  }
  return held
}

/** The most any of a row's three shares moves from a sun at μ₀ 0.7 to one at 0.4. */
function sunMove(r: GenusRow): number {
  const columns = columnsOf(r)
  const [high, low] = [retrieve(columns, 0), retrieve(columns, 1)]
  return Math.max(
    Math.abs(high.under - low.under),
    Math.abs(high.within - low.within),
    Math.abs(high.over - low.over),
  )
}

/** A row's mean depth's relative error against its ISCCP-H type, or null where either is absent. */
function meanError(r: GenusRow): number | null {
  const seen = retrieve(columnsOf(r), 0)
  const want = isccpZonal().type(r.type)
  // The table carries all nine types; a table without one skips it.
  if (want === null || seen.detected < LEAST_DETECTED) return null
  return Math.abs(seen.mean / want.depth - 1)
}

/** A row's column work is seconds; this is the bound on one row, shared machine and all. */
const ROW_TIMEOUT = 120_000

describe('row 9: each genus in ISCCP-H’s optical-depth classes', () => {
  it.each(ROWS.map((r) => [r.genus, r] as const))(
    '%s: its detected pixels fall in its class, or no worse than declared',
    (_, r) => {
      const columns = columnsOf(r)
      const seen = retrieve(columns, 0)
      if (r.genus in DECLARED.depth) {
        // No pixel is seen, so no share exists: hold the depth that is there.
        let sum = 0
        for (const depth of columns) sum += depth
        expect(sum / columns.length).toBeGreaterThanOrEqual(
          DECLARED.depth[r.genus]!,
        )
        return
      }
      expect(seen.detected).toBeGreaterThanOrEqual(LEAST_DETECTED)
      for (const [share, least] of r.shares)
        expect(
          shareOf(seen, share),
          `${r.genus} ${share}`,
        ).toBeGreaterThanOrEqual(
          DECLARED.shares[`${r.genus} ${share}`] ?? least,
        )
    },
    ROW_TIMEOUT,
  )

  it.each(ROWS.map((r) => [r.genus, r] as const))(
    '%s: no share moves ten points from a sun at μ₀ 0.7 to one at 0.4, or no more than declared',
    (_, r) => {
      if (retrieve(columnsOf(r), 0).detected < LEAST_DETECTED) return
      expect(sunMove(r)).toBeLessThanOrEqual(
        DECLARED.sun[r.genus] ?? SUN_TOLERANCE,
      )
    },
    ROW_TIMEOUT,
  )

  it.each(ROWS.map((r) => [r.genus, r] as const))(
    '%s: its mean depth, averaged as ISCCP-H averages, is its type’s within 15%, or no further than declared',
    (_, r) => {
      const error = meanError(r)
      if (error === null) return
      expect(error, r.type).toBeLessThanOrEqual(
        DECLARED.mean[r.type] ?? MEAN_TOLERANCE,
      )
    },
    ROW_TIMEOUT,
  )

  it('lays every regime the calibration names inside its genus’s range of thickness', () => {
    for (const r of ROWS) {
      const [least, greatest] = GENUS_TABLE[r.genus].thickness
      expect(r.top - r.base, r.genus).toBeGreaterThanOrEqual(least)
      expect(r.top - r.base, r.genus).toBeLessThanOrEqual(greatest)
    }
  })
})

/*
 * Row 9's declared misses, each against the rubric's own bound and failing
 * there at the figure its name gives. When one passes, `it.fails` fails,
 * and the declaration and its bound above go with it.
 */
describe('row 9’s declared misses, at their figures', () => {
  it.fails(
    'stratocumulus: its class shifts 0.2725 between the suns, against 0.10',
    () => {
      expect(sunMove(rowOf('stratocumulus'))).toBeLessThanOrEqual(SUN_TOLERANCE)
    },
    ROW_TIMEOUT,
  )
  it.fails(
    'stratocumulus: its mean depth is 5.01 against ISCCP-H’s 7.35, 31.9% off',
    () => {
      expect(meanError(rowOf('stratocumulus'))).toBeLessThanOrEqual(
        MEAN_TOLERANCE,
      )
    },
    ROW_TIMEOUT,
  )
  it.fails(
    'stratus: 0.280 of its pixels are over 22.63, against 0.30',
    () => {
      const seen = retrieve(columnsOf(rowOf('stratus')), 0)
      expect(seen.over).toBeGreaterThanOrEqual(0.3)
    },
    ROW_TIMEOUT,
  )
  it.fails(
    'stratus: its mean depth is 14.5 against ISCCP-H’s 43.7, 66.8% off',
    () => {
      expect(meanError(rowOf('stratus'))).toBeLessThanOrEqual(MEAN_TOLERANCE)
    },
    ROW_TIMEOUT,
  )
  it.fails(
    'cirrus: none of its 362 cloudy pixels is seen (its deepest column 0.23), against half',
    () => {
      const seen = retrieve(columnsOf(rowOf('cirrus')), 0)
      expect(seen.detected).toBeGreaterThanOrEqual(LEAST_DETECTED)
    },
    ROW_TIMEOUT,
  )
  it.fails(
    'cumulonimbus: its mean depth is 159.9 against deep convection’s 48.9, 227% off',
    () => {
      expect(meanError(rowOf('cumulonimbus'))).toBeLessThanOrEqual(
        MEAN_TOLERANCE,
      )
    },
    ROW_TIMEOUT,
  )
})

/* ------------------------------------------------------------------------- */
/* Row 10: a fair-weather field's cell sizes                                  */
/* ------------------------------------------------------------------------- */

/** 600 columns a side at 100 m: a 60 km square. */
const CELL_SIDE = 600
const CELL_SPACING = 100
/**
 * Heights a cell's column is read at, where `columnDepth` reads 256: the
 * square is 360,000 columns. The exponent is 1.218 at 32 heights and 1.256
 * at 16, and the cloudy mask agrees with `columnDepth`'s on 255 columns of
 * 255 sampled at 32 and 254 at 16.
 */
const CELL_STEPS = 16
/** A column is cloudy at ISCCP's clear-or-cloudy depth (Rossow and Schiffer 1999). */
const CLOUDY_DEPTH = 0.3
const [LEAST_D, GREATEST_D] = [200, 2000]

/** `fair-cumulus`'s cloud mask over the square, 1 where a column holds 0.3 or more. */
function cumulusMask(): Uint8Array {
  const layer = layerOf('fair-cumulus', 0)
  const weather = oneLevel('cumulus', layer.base, layer.top, layer.coverage)
  const clock = fieldClock(weather, 0)
  const profile = levelProfile(weather.levels[0])
  const unscale = profile.sigma / profile.scaled
  const thickness = layer.top - layer.base
  const mask = new Uint8Array(CELL_SIDE * CELL_SIDE)
  for (let j = 0; j < CELL_SIDE; j += 1)
    for (let i = 0; i < CELL_SIDE; i += 1) {
      const d = columnAt(i, j, CELL_SIDE, CELL_SPACING)
      const length = Math.hypot(d.x, d.y, d.z)
      let sum = 0
      for (let k = 0; k < CELL_STEPS; k += 1) {
        const r =
          (RADIUS + layer.base + ((k + 0.5) / CELL_STEPS) * thickness) / length
        const at = cloudFieldAt(
          weather,
          clock,
          PLACE.up,
          { x: d.x * r, y: d.y * r, z: d.z * r },
          0,
        )
        sum += at.fraction * at.sigma
      }
      const depth = (sum * unscale * thickness) / CELL_STEPS
      mask[j * CELL_SIDE + i] = depth >= CLOUDY_DEPTH ? 1 : 0
    }
  return mask
}

/** The areas, in columns, of the mask's 4-connected cloudy cells. */
function cellAreas(mask: Uint8Array, side: number): number[] {
  const seen = new Uint8Array(mask.length)
  const areas: number[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue
    let area = 0
    seen[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const at = stack.pop()!
      area += 1
      const x = at % side
      const y = (at - x) / side
      const next = [
        x > 0 ? at - 1 : -1,
        x < side - 1 ? at + 1 : -1,
        y > 0 ? at - side : -1,
        y < side - 1 ? at + side : -1,
      ]
      for (const n of next)
        if (n >= 0 && mask[n] === 1 && seen[n] === 0) {
          seen[n] = 1
          stack.push(n)
        }
    }
    areas.push(area)
  }
  return areas
}

/** The exponent α of `n(D) ∝ D^−α` on [least, greatest] by maximum likelihood, by golden section over 1 to 6. */
function powerLawExponent(
  diameters: readonly number[],
  least: number,
  greatest: number,
): number {
  const logSum = diameters.reduce((sum, d) => sum + Math.log(d), 0)
  const likelihood = (alpha: number): number => {
    const norm =
      Math.abs(alpha - 1) < 1e-9
        ? Math.log(greatest / least)
        : (greatest ** (1 - alpha) - least ** (1 - alpha)) / (1 - alpha)
    return -alpha * logSum - diameters.length * Math.log(norm)
  }
  let [low, high] = [1.0001, 6]
  for (let i = 0; i < 100; i += 1) {
    const a = high - 0.618 * (high - low)
    const b = low + 0.618 * (high - low)
    if (likelihood(a) > likelihood(b)) high = b
    else low = a
  }
  return (low + high) / 2
}

/** The exponent of fair-cumulus's cells inside 200 m to 2 km, fitted once. */
let exponent: number | null = null
function cumulusExponent(): number {
  if (exponent !== null) return exponent
  const diameters = cellAreas(cumulusMask(), CELL_SIDE)
    .map((area) => 2 * Math.sqrt((area * CELL_SPACING ** 2) / Math.PI))
    .filter((d) => d >= LEAST_D && d <= GREATEST_D)
  expect(diameters.length).toBeGreaterThan(100)
  exponent = powerLawExponent(diameters, LEAST_D, GREATEST_D)
  return exponent
}

/** Row 10's measured exponent, less its rounding: the bound a later change must not fall under. */
const DECLARED_EXPONENT = 1.25

describe('row 10: a fair-weather field’s cell sizes', () => {
  it('finds the exponent of a power law it drew, so the fit can fail', () => {
    // Inverse-CDF draws from D^−2.19 on [200, 2000], on a fixed lattice.
    const alpha = 2.19
    const [a, b] = [LEAST_D ** (1 - alpha), GREATEST_D ** (1 - alpha)]
    const drawn = Array.from({ length: 2000 }, (_, i) => {
      const u = (i + 0.5) / 2000
      return (a + u * (b - a)) ** (1 / (1 - alpha))
    })
    expect(powerLawExponent(drawn, LEAST_D, GREATEST_D)).toBeCloseTo(alpha, 2)
  })

  /*
   * Mieslinger et al. 2019 fit 2.19 to cumulus fields' area-equivalent
   * diameters; the rubric's bound is 2.19 ± 0.4, advisory. The field's
   * cells are too evenly sized: of 789 cells, the 445 inside 200 m to 2 km
   * give 1.256, and the largest is 6.7 km across, several base cells
   * joined. A thresholded noise is a power law in island size only as a fractal
   * (Korčák's law, `n(D) ∝ D^−(3 − H)`), and the base noise has no octave
   * finer than its 1,200 m cell; the design's remedy is octaves down to
   * 150 m in the bake, a mechanism, and this row is declared at its figure.
   */
  it(
    'fits the exponent of fair-cumulus’s cells no lower than declared',
    () => {
      expect(cumulusExponent()).toBeGreaterThanOrEqual(DECLARED_EXPONENT)
    },
    ROW_TIMEOUT,
  )

  it.fails(
    'fits fair-cumulus’s cells at 1.256, against Mieslinger’s 2.19 ± 0.4',
    () => {
      expect(Math.abs(cumulusExponent() - 2.19)).toBeLessThanOrEqual(0.4)
    },
    ROW_TIMEOUT,
  )
})

/* ------------------------------------------------------------------------- */
/* Row 16, as far as the climate carries it: Earth's cover by band            */
/* ------------------------------------------------------------------------- */

const DEG = Math.PI / 180
/** The sub-solar latitude on each month's 15th (Cooper 1969). */
const MONTH_DAYS = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349]
const subsolar = (month: number): number =>
  23.44 * DEG * Math.sin((2 * Math.PI * (284 + MONTH_DAYS[month]!)) / 365)

/** Five-point Gauss–Legendre over the synoptic factor's spread, 0.75 to 1.25. */
const SYNOPTIC: readonly (readonly [number, number])[] = [
  [-0.9061798459, 0.2369268851],
  [-0.5384693101, 0.4786286705],
  [0, 0.5688888889],
  [0.5384693101, 0.4786286705],
  [0.9061798459, 0.2369268851],
]

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/**
 * The law's total cover at a latitude and a sun as the field draws it: the
 * synoptic factor taken over its spread, the three levels overlapped at
 * random. Which level is on top does not change the total.
 */
function drawnTotal(latitude: number, sun: number): number {
  const cover = zonalClimate(EARTH_ZONAL_LAW, latitude, sun).cover
  let total = 0
  for (const [x, weight] of SYNOPTIC) {
    const f = 1 + 0.25 * x
    const clear = cover.reduce((c, k) => c * (1 - clamp01(k * f)), 1)
    total += (weight / 2) * (1 - clear)
  }
  return total
}

/** A 10° band's annual mean of the drawn total, area-weighted over 20 latitudes and the twelve months. */
function bandTotal(band: number): number {
  let sum = 0
  let weight = 0
  for (let s = 0; s < 20; s += 1) {
    const latitude = (-90 + band * 10 + (s + 0.5) / 2) * DEG
    let year = 0
    for (let m = 0; m < 12; m += 1) year += drawnTotal(latitude, subsolar(m))
    sum += (year / 12) * Math.cos(latitude)
    weight += Math.cos(latitude)
  }
  return sum / weight
}

/** A band's share of the sphere's area. */
const bandArea = (band: number): number =>
  (Math.sin((-80 + band * 10) * DEG) - Math.sin((-90 + band * 10) * DEG)) / 2

/**
 * The bands the law misses by more than the rubric's 0.05, each with the
 * largest error it may have: 30°S to 40°S (0.051), 50°S to 60°S (0.070),
 * and 40°N to 60°N (0.068 and 0.062), where a law symmetric about the
 * equator splits the southern ocean from the northern continents; and the
 * polar bands 60°S to 70°S, 70°N to 80°N and 80°N to 90°N (0.108, 0.116 and
 * 0.155), which the rubric declares. The other three polar bands pass.
 */
const DECLARED_BANDS: Readonly<Record<number, number>> = {
  2: 0.109,
  3: 0.071,
  5: 0.052,
  13: 0.069,
  14: 0.062,
  16: 0.117,
  17: 0.155,
}
/** The rubric's tolerance on a band. */
const BAND_TOLERANCE = 0.05

describe('row 16, as the climate carries it: Earth’s cover against ISCCP-H', () => {
  /*
   * The rubric's row counts detected pixels of the field (§6.3) and is
   * phase 3's gate, with a land mask the climate does not have yet. What is
   * held here is the cover the law draws, before any pixel: the climate's
   * half of that count, which the law was fitted to. Land and ocean are not
   * held: no land enters the climate until phase 3.
   */
  const table = isccpZonal()

  it('holds the global mean within 0.03 of ISCCP-H’s 0.6475', () => {
    let sum = 0
    for (let band = 0; band < 18; band += 1)
      sum += bandTotal(band) * bandArea(band)
    // Measured: 0.6403, 0.0072 under.
    expect(Math.abs(sum - table.global('total')!)).toBeLessThanOrEqual(0.03)
  })

  it('holds each 10° band within 0.05, and each band the law cannot split within its own figure', () => {
    for (let band = 0; band < 18; band += 1) {
      const error = Math.abs(bandTotal(band) - table.zonal('total', band)!)
      const declared = DECLARED_BANDS[band]
      expect(error, `band ${band}`).toBeLessThanOrEqual(
        declared ?? BAND_TOLERANCE,
      )
    }
  })

  /*
   * Each declared band against the rubric's 0.05, failing there at the
   * figure its name gives. When one passes, `it.fails` fails, and its
   * declaration goes.
   */
  for (const [name, band, figure] of [
    ['70°S to 60°S', 2, '0.693 against 0.801'],
    ['60°S to 50°S', 3, '0.801 against 0.871'],
    ['40°S to 30°S', 5, '0.657 against 0.708'],
    ['40°N to 50°N', 13, '0.787 against 0.719'],
    ['50°N to 60°N', 14, '0.801 against 0.739'],
    ['70°N to 80°N', 16, '0.551 against 0.668'],
    ['80°N to 90°N', 17, '0.474 against 0.629'],
  ] as const)
    it.fails(`${name}: the law draws ${figure}, against 0.05`, () => {
      expect(
        Math.abs(bandTotal(band) - table.zonal('total', band)!),
      ).toBeLessThanOrEqual(BAND_TOLERANCE)
    })
})
