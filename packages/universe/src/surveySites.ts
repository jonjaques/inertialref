import { formatDistance, type Meters, type Radians } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import { type RegionAddress, regionAddress } from './address.ts'
import { directionToGeodetic } from './frames.ts'
import type { Body } from './system.ts'
import {
  type BodyFixedDirection,
  elevationAt,
  faceToDirection,
  FACE_COUNT,
  groundElevation,
  regionDirection,
  regionForDirection,
} from './terrain.ts'

/*
 * Where on a world is worth going.
 *
 * A planetarium that can descend to two meters is useless without an answer to
 * "two meters above *what*". Latitude and longitude are the wrong question to
 * ask a person: a seeded world has no place names, and typing numbers into a
 * sphere lands you on the same undifferentiated mid-slope every time. So each
 * body derives a handful of named sites from its own terrain, by searching the
 * field it already has.
 *
 * **Derived, not authored, and that is what makes them test fixtures.** A
 * hand-written list of coordinates is stale the moment the generator changes;
 * "the highest ground on this body" survives regeneration by construction and
 * is *still the interesting place* afterwards. The same call therefore serves
 * the site picker and the regression suite — a plate of `summit` before and
 * after a change is a comparison of the same question, not of the same numbers.
 *
 * Two of the six are not searched at all, and they are the two that exist for
 * the renderer rather than for the geology. `corner` stands where three cube
 * faces meet, which is where the adjacency arithmetic is hardest and where
 * today's streamer drops five of its nine patches; `pole` stands where the
 * east/north basis is singular and where a latitude/longitude control is most
 * likely to be quietly wrong. Both are bugs that a survey of *interesting*
 * ground would never wander into.
 *
 * Everything here is a pure function of (surface seed, radius, figure). Nothing
 * is stored — see the memo at the bottom, which is a cache and says so.
 */

export type SurveySiteId =
  'summit' | 'basin' | 'shore' | 'rough' | 'corner' | 'pole'

export interface SurveySite {
  readonly id: SurveySiteId
  readonly name: string
  /** One line about the place, for a picker and for a plate caption. */
  readonly detail: string
  readonly latitude: Radians
  readonly longitude: Radians
  /** The patch of ground it names, at `SURVEY_LEVEL`. */
  readonly region: RegionAddress
  /** Ground elevation relative to the datum, meters — sea clamp included. */
  readonly elevation: Meters
}

/**
 * The level a site's region is addressed at.
 *
 * 14 is a 611 m patch on an Earth-sized body and 83 m on Luna — a place you can
 * stand in and see the whole of, which is what a site has to be. Addressing at
 * the level the streamer happens to want would make a site's identity depend on
 * how high the camera was when it was asked for.
 */
export const SURVEY_LEVEL = 14

/**
 * Where the search starts: every cell of a level-3 grid, all six faces.
 *
 * 384 samples. Coarser than that and a continent-scale feature can sit entirely
 * between two seeds; finer and the sweep costs more than the eleven refinements
 * under it put together.
 */
const SEED_LEVEL = 3

/** How many cells survive each refinement. */
const BEAM = 8

/** A cell of the search, with the field evaluated at its center. */
interface Cell {
  readonly region: RegionAddress
  readonly direction: BodyFixedDirection
  /** `groundElevation` — what the mesh and the contact test agree on. */
  readonly ground: Meters
  /** `elevationAt` — the landform before the sea clamp. See `shore`. */
  readonly land: Meters
}

const centreOf = (body: Body, region: RegionAddress): Cell => {
  const direction = regionDirection(region, 0.5, 0.5)
  return {
    region,
    direction,
    ground: groundElevation(body.surface, direction),
    land: elevationAt(body.surface, direction),
  }
}

/**
 * Refine a beam of cells down to `SURVEY_LEVEL`, keeping the best `BEAM`.
 *
 * A beam rather than an exhaustive scan, and the docstrings say what that buys
 * and what it costs: an exhaustive level-14 sweep of one body is 1.6 billion
 * samples. What comes back is the best cell the search *found*, which on a
 * multi-octave field is reliably a real peak and is not provably the global
 * one. A survey site does not need to be — it needs to be somewhere worth
 * standing, and to be the same somewhere every time.
 */
function refine(
  body: Body,
  seeds: readonly Cell[],
  seedScore: (cell: Cell) => number,
  score: (cell: Cell, parent: Cell) => number,
): Cell {
  /*
   * The seed pass scores differently from the refinements, and it has to.
   *
   * A refinement score compares a cell to its parent, which is what makes the
   * beam follow a gradient — and a level-3 cell has no parent. Scoring one
   * against itself is not a degenerate case but a silently wrong one: for the
   * escarpment search it returns zero for all 384 seeds, so the beam meant to
   * find the steepest ground on the planet starts from whichever eight cells
   * the sort happened to leave in front.
   */
  let beam = [...seeds]
    .sort((a, b) => seedScore(b) - seedScore(a))
    .slice(0, BEAM)
  for (let level = SEED_LEVEL; level < SURVEY_LEVEL; level += 1) {
    const children: { cell: Cell; value: number }[] = []
    for (const parent of beam) {
      for (let di = 0; di < 2; di += 1) {
        for (let dj = 0; dj < 2; dj += 1) {
          const cell = centreOf(
            body,
            regionAddress(
              parent.region.face,
              level + 1,
              parent.region.i * 2 + di,
              parent.region.j * 2 + dj,
            ),
          )
          children.push({ cell, value: score(cell, parent) })
        }
      }
    }
    children.sort((a, b) => b.value - a.value)
    beam = children.slice(0, BEAM).map((one) => one.cell)
  }
  // The beam is already ordered by the last refinement's score.
  return beam[0] as Cell
}

/** Every cell of the seed grid, evaluated once and shared by all four searches. */
function seedGrid(body: Body): readonly Cell[] {
  const span = 2 ** SEED_LEVEL
  const cells: Cell[] = []
  for (let face = 0; face < FACE_COUNT; face += 1) {
    for (let i = 0; i < span; i += 1) {
      for (let j = 0; j < span; j += 1) {
        cells.push(centreOf(body, regionAddress(face, SEED_LEVEL, i, j)))
      }
    }
  }
  return cells
}

/**
 * The elevation the ocean sits at, in the same units `elevationAt` returns.
 *
 * Taken from `groundElevation`'s clamp rather than re-derived, because the two
 * disagreeing is precisely the bug that put landing pads on the ocean datum
 * while the mesh drew the seabed underneath them.
 */
const seaDatum = (body: Body): Meters | null => {
  const sea = body.surface.seaLevel
  if (sea === null) return null
  return (sea * 2 - 1) * body.surface.maxElevation * 0.55
}

function siteAt(
  id: SurveySiteId,
  name: string,
  detail: string,
  cell: Cell,
): SurveySite {
  const { latitude, longitude } = directionToGeodetic(cell.direction)
  return {
    id,
    name,
    detail,
    latitude,
    longitude,
    region: cell.region,
    elevation: cell.ground,
  }
}

/** A site at a direction chosen outright, with no search. */
function siteInDirection(
  body: Body,
  id: SurveySiteId,
  name: string,
  detail: string,
  direction: BodyFixedDirection,
): SurveySite {
  const region = regionForDirection(direction, SURVEY_LEVEL)
  return siteAt(id, name, detail, centreOf(body, region))
}

const relative = (elevation: Meters): string =>
  `${formatDistance(Math.abs(elevation))} ${elevation < 0 ? 'below' : 'above'} the datum`

/**
 * Relief around each seed cell, from the samples the grid already has.
 *
 * The largest step to an in-face neighbor — the escarpment search's seed score.
 * Face edges are left out rather than wrapped: a level-3 cell has 32 of its 384
 * peers on a face boundary, and the four faces the wrap would have to reach are
 * exactly the arithmetic Phase 1 is going to property-test. Treating them as
 * interior would seed the search from a made-up gradient.
 */
function neighbourRelief(seeds: readonly Cell[]): Map<string, number> {
  const span = 2 ** SEED_LEVEL
  const at = new Map<string, Cell>()
  for (const cell of seeds) {
    at.set(`${cell.region.face}.${cell.region.i}.${cell.region.j}`, cell)
  }
  const relief = new Map<string, number>()
  for (const cell of seeds) {
    const { face, i, j } = cell.region
    let worst = 0
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (i + di < 0 || j + dj < 0 || i + di >= span || j + dj >= span) continue
      const other = at.get(`${face}.${i + di}.${j + dj}`)
      if (other === undefined) continue
      worst = Math.max(worst, Math.abs(cell.ground - other.ground))
    }
    relief.set(`${face}.${i}.${j}`, worst)
  }
  return relief
}

function derive(body: Body): readonly SurveySite[] {
  const seeds = seedGrid(body)
  const sea = seaDatum(body)

  const summit = refine(
    body,
    seeds,
    (cell) => cell.ground,
    (cell) => cell.ground,
  )
  const basin = refine(
    body,
    seeds,
    (cell) => -cell.ground,
    (cell) => -cell.ground,
  )
  /*
   * The coastline, scored on the *unclamped* landform.
   *
   * `groundElevation` clamps the whole ocean up to one value, so "closest to
   * the sea datum" scores every square meter of open water as a perfect hit and
   * the search converges on the middle of an ocean. The land surface is what
   * actually crosses the datum, and where it crosses is the shore.
   */
  const nearDatum = (cell: Cell): number => -Math.abs(cell.land - (sea ?? 0))
  const shore = refine(body, seeds, nearDatum, nearDatum)
  /*
   * The steepest step the search found.
   *
   * Scored against the *parent* rather than absolutely, so the beam follows
   * gradient rather than altitude — a summit search finds the tallest thing and
   * this finds the thing whose sides fall away fastest, which is where LOD,
   * normals and the contact test are all worked hardest.
   */
  const relief = neighbourRelief(seeds)
  const rough = refine(
    body,
    seeds,
    (cell) =>
      relief.get(`${cell.region.face}.${cell.region.i}.${cell.region.j}`) ?? 0,
    (cell, parent) => Math.abs(cell.ground - parent.ground),
  )

  return [
    siteAt(
      'summit',
      'Summit',
      `the highest ground the survey found, ${relative(summit.ground)}`,
      summit,
    ),
    siteAt(
      'basin',
      sea === null ? 'Basin' : 'Abyss',
      `the lowest ground the survey found, ${relative(basin.ground)}`,
      basin,
    ),
    siteAt(
      'shore',
      sea === null ? 'Datum Plain' : 'Shore',
      sea === null
        ? `flat country at the datum, ${relative(shore.ground)}`
        : `where the land crosses the sea, ${relative(shore.ground)}`,
      shore,
    ),
    siteAt(
      'rough',
      'Escarpment',
      `the steepest ground the survey found, ${relative(rough.ground)}`,
      rough,
    ),
    siteInDirection(
      body,
      'corner',
      'Face Corner',
      'where three faces of the addressing cube meet — the hardest ground to stitch',
      faceToDirection(0, 1, 1),
    ),
    siteInDirection(
      body,
      'pole',
      'North Pole',
      'the spin axis, where east and north stop being directions',
      faceToDirection(2, 0, 0),
    ),
  ]
}

/*
 * Memoized per body, and this is a cache rather than state.
 *
 * The site picker asks on every render, the descent probe asks once per run and
 * the observatory asks on every re-target; a derivation is ~2,100 samples of
 * fourteen-octave noise, which is a few milliseconds and is far too much to
 * spend at panel rate. The key is everything the answer depends on, so a body
 * whose seed or figure changes gets a fresh entry rather than a stale one, and
 * nothing here is ever written to a save — it is regenerable content, which the
 * rules say is a cache by definition.
 */
const CACHE = new Map<string, readonly SurveySite[]>()
const CACHE_LIMIT = 64

const cacheKey = (body: Body): string =>
  [
    formatSeed(body.surface.seed),
    body.surface.maxElevation,
    body.surface.roughness,
    body.surface.seaLevel ?? 'dry',
    body.radius,
    body.polarRadius,
    body.figure?.intermediateRadius ?? body.radius,
  ].join('|')

/**
 * The named places on a body, in a stable order.
 *
 * The order is the declaration order above rather than anything derived, so a
 * picker's list does not reshuffle when a seed changes and a plate set keeps
 * its rows.
 */
export function surveySites(body: Body): readonly SurveySite[] {
  const key = cacheKey(body)
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  const sites = derive(body)
  // A plain size cap, not an LRU: the working set is one body's worth and the
  // cost of a miss is milliseconds. An eviction policy here would be machinery
  // in front of a rounding error.
  if (CACHE.size >= CACHE_LIMIT) CACHE.clear()
  CACHE.set(key, sites)
  return sites
}

export const findSurveySite = (
  body: Body,
  id: string,
): SurveySite | undefined => surveySites(body).find((site) => site.id === id)
