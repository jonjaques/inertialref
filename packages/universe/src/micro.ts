import type { Meters } from '@inertialref/shared'
import { fbm3 } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { ladderField, softLimit } from './craters.ts'
import type { SurfaceGrammar } from './grammar.ts'
import { CANONICAL_DETAIL_FLOOR, type TerrainSketch } from './sketch.ts'

/*
 * The ground below the canonical floor.
 *
 * `elevationAt` is the field the contact test integrates against, and it stops
 * at eight meters of wavelength and half a meter of amplitude
 * ([ADR-0019](../../../docs/adr/0019-the-geology.md)). That floor is a cost
 * decision and a save-compatibility one, and it is the right one: a landing
 * ship spans tens of meters, so ground that is right to within half a meter is
 * ground, and every band below it would move every existing save's landed hull.
 *
 * It is also, standing at two meters, the whole picture. One mesh cell at the
 * detail floor is one to seven meters of ground and four hundred display pixels
 * across; below it the canonical field has nothing and the plain draws as a
 * plane. So this is the **presentational** tail — the same construction, the
 * same hashes, the same published statistics, evaluated by the heightfield
 * generator and the material and *not* by the contact test.
 *
 * **What that costs is a number rather than an adjective.** The mesh and the
 * ground a ship lands on differ by at most `microReliefBound`, which is
 * `MICRO_CRATER_CEILING + GRIT_RELIEF` by construction rather than by
 * measurement — the crater tail is folded through a `tanh` and the grit is a
 * normalized fBm. It is the same shape of honesty as the figured-body datum:
 * the divergence is bounded, named and measured, not denied. `micro.test.ts`
 * holds the bound against the field, and `terrain.test.ts` holds the drawn
 * radius against the canonical one.
 *
 * **One field at every level, exactly as the canonical stack is.** Nothing here
 * knows which patch is asking or how closely it is sampling, so the CDLOD morph
 * endpoint is untouched: a fully morphed child is still the child's own field
 * at the parent's spacing, and that still equals the parent's mesh. The obvious
 * saving — evaluate the tail only on patches fine enough to resolve it — is the
 * one thing that would break it, and `sketch.ts`'s `craterLadder` carries the
 * argument at length.
 */

/**
 * The deepest the sub-floor crater band may cut, meters.
 *
 * **A tenth of `CANONICAL_DETAIL_FLOOR`, and the depth law says a fifth.** A
 * fresh eight-meter crater is 1.6 m deep — `craterDepth` at 0.2·D — and that is
 * the depth of *one* of them. This band is saturated: every cell at every rung
 * holds a crater, which is what a surface in production equilibrium at a meter
 * is, and a saturated population's members destroy each other rather than
 * stacking. Half is the measurement of that. At 1.6 the ground drew as broken
 * glass, at **21° of RMS slope over a one-meter baseline** against a published
 * 5–20° for lunar regolith and the MER landing sites; at 0.8 it is 12.3° on
 * Luna, 8.4° on Mars and 15.6° on Mercury.
 *
 * It is still deliberately **above** `CANONICAL_AMPLITUDE_FLOOR`, and that is
 * the whole reason the mesh gets any deeper. `TERRAIN_DETAIL_TOLERANCE` is half
 * a meter, so a term that never exceeds half a meter cannot move
 * `surfaceDetailFloor` by a single level however fine its wavelength is — the
 * search would call every level of it quiet and stop where it stops today.
 *
 * `softLimit` is a `tanh`, so this is a strict bound the sum approaches and
 * never reaches: measured across the zoo the deepest cut is 0.799 m and the
 * most the tail ever *lifts* the ground is 0.66 m.
 */
export const MICRO_CRATER_CEILING: Meters = 0.8

/**
 * Peak-to-datum relief of the regolith grit, meters, on an airless world.
 *
 * Under `CANONICAL_AMPLITUDE_FLOOR`, and that is a consequence rather than a
 * rule. A landscape is close to self-affine with a Hurst exponent near 0.8, so
 * continuing the relief band's cascade from its own finest octave — 41 m at
 * about a meter across the zoo — down to eight gives `1 · (8/41)^0.8 ≈ 0.27 m`.
 * Half a meter is that with room for the roughest body in scope, and 2πA/λ makes
 * it a 20° slope at the coarsest octave, which is the top of the 5°–20° RMS band
 * measured at meter baselines on Luna and at the Mars landing sites.
 *
 * It therefore **cannot move the mesh's floor by itself**, because the floor's
 * tolerance is the half-meter this sits under. What moves the floor is the
 * crater tail, and on a body whose air has taken the small craters away the two
 * facts agree: there is nothing at a meter for the mesh to go and get.
 */
export const GRIT_RELIEF: Meters = 0.45

/**
 * How much of the grit an atmosphere takes away.
 *
 * A third at most, which is deliberately mild and is the opposite of what the
 * crater tail does. Wind, frost and running water round the meter scale first,
 * so there is an effect — but a landscape's roughness is close to self-affine,
 * and continuing the relief band's own cascade from its finest octave down to
 * eight meters gives about this amplitude whether or not the body has air. An
 * atmosphered world's meter scale is not smooth, it is made of different things:
 * soil, ripples and loose rock, which is `scatter.ts` rather than a band.
 */
const GRIT_AIR_LOSS = 0.35

/**
 * The shortest wavelength the grit is meshed down to, meters.
 *
 * Four rather than `MICRO_DETAIL_FLOOR`'s one, and the reason is amplitude
 * rather than taste. A normalized two-octave fBm puts 0.30 m at eight meters and
 * 0.15 at four; the next octave down would carry 7.5 cm, which is a sixth of the
 * half-meter tolerance a mesh cell is refined against and a fraction of what a
 * sub-floor crater rim does at the same wavelength. It is one more `noise3` per
 * sample on every patch on the body for relief the finest cell cannot express,
 * and the material draws that band per pixel anyway.
 *
 * The crater tail does run to `MICRO_DETAIL_FLOOR`, because a one-meter crater
 * is 20 cm deep against a wavelength of one — a slope the mesh resolves and the
 * grit at that wavelength does not have.
 */
const GRIT_FLOOR: Meters = 4

/**
 * Octaves of grit: from `CANONICAL_DETAIL_FLOOR` down to `GRIT_FLOOR`.
 *
 * Arithmetic rather than a constant, so the two floors stay the only dials. Two
 * corrections are folded in and each has cost a wrong number once. 2.03 rather
 * than 2, because that is `DEFAULT_FBM`'s lacunarity and a count derived against
 * the wrong one lands short. And **`+ 1`, because `fbm3`'s first octave is at
 * the base frequency**: `N` octaves reach `CANONICAL_DETAIL_FLOOR / 2.03^(N−1)`,
 * so the ratio alone counts the gaps between octaves rather than the octaves.
 * Without it this returned two for a floor of two meters and stopped at 3.9.
 */
const GRIT_OCTAVES =
  Math.max(
    0,
    Math.ceil(Math.log(CANONICAL_DETAIL_FLOOR / GRIT_FLOOR) / Math.log(2.03)),
  ) + 1

/**
 * The presentational tail at a direction, meters.
 *
 * Pure, deterministic, and a function of the same sketch the landforms come
 * from. Added to the canonical elevation by `drawnElevation` and by nothing
 * else — `elevationAt`, `groundElevation` and `surfaceRadius` do not know this
 * file exists, which is what makes the split testable rather than a convention.
 */
export function microRelief(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
): Meters {
  let height = 0
  if (sketch.microLevels.length > 0) {
    height += softLimit(
      ladderField(
        sketch.latticeSeed,
        sketch.microLevels,
        sketch.microFirstRung,
        grammar,
        direction,
        0,
        'exact',
      ),
      MICRO_CRATER_CEILING,
    )
  }
  const grit = gritRelief(grammar)
  if (grit > 0) {
    /*
     * Cycles per unit of *direction* space, so one constant serves a 236 km
     * moon and a 6,371 km planet: eight meters of ground is eight meters of
     * ground on both. It is the same conversion `craterLadder` makes for a
     * cell, through the same `meanRadius`.
     */
    const cycles = grammar.meanRadius / CANONICAL_DETAIL_FLOOR
    height +=
      grit *
      fbm3(
        sketch.seeds.grit,
        direction.x * cycles,
        direction.y * cycles,
        direction.z * cycles,
        { octaves: GRIT_OCTAVES },
      )
  }
  return height
}

/** How loud the grit is on this body: full on an airless one, worn under air. */
export const gritRelief = (grammar: SurfaceGrammar): Meters =>
  GRIT_RELIEF * (1 - GRIT_AIR_LOSS * grammar.air)

/**
 * How far the drawn ground may sit from the ground the contact test integrates,
 * meters.
 *
 * A bound rather than a measurement, and both terms are bounds by construction:
 * `softLimit` is asymptotic to its ceiling and never reaches it, and `fbm3`
 * normalizes to [-1, 1]. `micro.test.ts` samples the field across the zoo and
 * asserts it stays under this, which is the check that the two halves have not
 * drifted apart.
 *
 * **It never reaches zero**, and that is worth stating rather than implying:
 * `gritRelief` bottoms out at 0.2925 under the thickest air, so no body's mesh
 * is exactly its contact test. Venus's bound is 0.29 m and Luna's is 1.25.
 */
export function microReliefBound(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
): Meters {
  const tail = sketch.microLevels.length > 0 ? MICRO_CRATER_CEILING : 0
  return tail + gritRelief(grammar)
}
