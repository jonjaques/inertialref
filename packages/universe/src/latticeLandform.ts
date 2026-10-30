import type { Meters } from '@inertialref/shared'
import type { Vec3 } from '@inertialref/spatial'
import {
  beltBand,
  hypsometryBand,
  iceBand,
  plateContext,
  reliefBand,
  volcanicBand,
} from './bands.ts'
import { type StageContext, stageOn } from './bandStack.ts'
import { ladderField, softLimit } from './craters.ts'
import type { TerrainSketch } from './sketch.ts'
import type { SurfaceParameters } from './system.ts'

/*
 * The landform the drainage is built and refined against: the stack read
 * down to a wavelength floor, the crater rungs a cell can resolve, and the
 * mean of the rest. The lattice reads it at its own cell and the refinement
 * at each refined level's.
 */

/**
 * The macro landform at a lattice node: every stage of the stack before the
 * drainage, read at the lattice's own wavelength floor, plus the crater
 * rungs coarse enough to hold a lake, plus the mean of the rest.
 *
 * The same expression `evaluate` sums and in the same order, with three
 * differences a lattice node earns. An octave finer than a cell is relief
 * the flow routing cannot see and would pay for at every node, so each band
 * stops at the cell size — which costs nothing in the mean, because a
 * normalized noise has none. The crater ladder is walked only over the
 * rungs whose craters span two cells or more: those are the basins that
 * flood — a below-datum floor a thousand kilometers inland is a lake at its
 * own spill and not at the sea's — and the finer rungs are a hundred cell
 * tests a node for craters no node can resolve. And the finer rungs are
 * not nothing: a crater is one-signed, so a ladder saturated at its fine
 * end depresses the whole surface by a near constant — on Earth the coarse
 * rung alone folds to −76 m through the soft limit and the whole ladder to
 * −610 — and a lattice that left it out held every floor half a kilometer
 * over the ground the field actually has. `fineMean` is that constant: the
 * mean, once per body, of what the whole ladder folds to less what the
 * coarse rungs fold to, added after the limit — the limit is a `tanh`, and
 * the fold of a mean is not the mean of the folds.
 */
export function latticeLandform(
  surface: SurfaceParameters,
  sketch: TerrainSketch,
  stack: StageContext,
  direction: Vec3,
  floor: Meters,
  coarseRungs: number,
  fineMean: Meters,
): Meters {
  const grammar = surface.grammar
  const budget = surface.maxElevation
  const bands = grammar.bands
  const plates = plateContext(sketch, direction)
  let height =
    bands.hypsometry *
      hypsometryBand(
        sketch,
        grammar,
        plates,
        direction,
        bands.hypsometry * budget,
        floor,
      ) +
    bands.belts *
      beltBand(
        sketch,
        grammar,
        plates,
        direction,
        bands.belts * budget,
        floor,
      ) +
    bands.volcanism *
      volcanicBand(
        sketch,
        grammar,
        plates,
        direction,
        bands.volcanism * budget,
        floor,
      ) +
    bands.relief *
      reliefBand(
        sketch,
        grammar,
        surface.roughness,
        direction,
        bands.relief * budget,
        floor,
      )
  if (stageOn('ice', stack)) {
    height +=
      bands.ice * iceBand(sketch, grammar, direction, bands.ice * budget, floor)
  }
  let elevation = height * budget
  if (stageOn('craters', stack)) {
    const coarse =
      coarseRungs > 0
        ? ladderField(
            sketch.latticeSeed,
            sketch.craterLevels.slice(0, coarseRungs),
            0,
            grammar,
            direction,
            0,
          )
        : 0
    elevation += softLimit(coarse, bands.craters * budget) + fineMean
  }
  return elevation
}

/** Directions the fine rungs' mean is taken over: golden-angle, so nothing clusters. */
const FINE_MEAN_SAMPLES = 256

/**
 * What the crater ladder below the lattice's coarse rungs adds to the
 * ground in the mean, meters: the whole ladder through the soft limit less
 * the coarse rungs through it, averaged over a spread of directions. A few
 * hundred walks of the ladder once per body, against the tens of thousands
 * of nodes the mean is then applied to.
 */
export function fineRungMean(
  sketch: TerrainSketch,
  surface: SurfaceParameters,
  coarseRungs: number,
): Meters {
  if (sketch.craterLevels.length <= coarseRungs) return 0
  const limit = surface.grammar.bands.craters * surface.maxElevation
  const coarse = sketch.craterLevels.slice(0, coarseRungs)
  let total = 0
  for (let i = 0; i < FINE_MEAN_SAMPLES; i += 1) {
    const z = 1 - (2 * i + 1) / FINE_MEAN_SAMPLES
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    const direction = {
      x: Math.cos(around) * ring,
      y: z,
      z: Math.sin(around) * ring,
    }
    const whole = ladderField(
      sketch.latticeSeed,
      sketch.craterLevels,
      0,
      surface.grammar,
      direction,
      0,
    )
    const part =
      coarseRungs > 0
        ? ladderField(
            sketch.latticeSeed,
            coarse,
            0,
            surface.grammar,
            direction,
            0,
          )
        : 0
    total += softLimit(whole, limit) - softLimit(part, limit)
  }
  return total / FINE_MEAN_SAMPLES
}
