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
 * at eight metres of wavelength and half a metre of amplitude
 * ([ADR-0019](../../../docs/adr/0019-the-geology.md)). That floor is a cost
 * decision and a save-compatibility one, and it is the right one: a landing
 * ship spans tens of metres, so ground that is right to within half a metre is
 * ground, and every band below it would move every existing save's landed hull.
 *
 * It is also, standing at two metres, the whole picture. One mesh cell at the
 * detail floor is one to seven metres of ground and four hundred display pixels
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
 * The deepest a sub-floor crater may cut, meters.
 *
 * A fifth of `CANONICAL_DETAIL_FLOOR`, because depth over diameter is 0.2 for a
 * fresh simple crater and eight metres is the largest crater in this list. Every
 * crater below that is shallower, and the sum of the overlapping ones is folded
 * through `softLimit` rather than clamped — so this is a strict bound on the
 * tail and not a target it approaches from below.
 *
 * It is deliberately **above** `CANONICAL_AMPLITUDE_FLOOR`, and that is the
 * whole reason the mesh gets any deeper. `TERRAIN_DETAIL_TOLERANCE` is half a
 * metre, so a term that never exceeds half a metre cannot move
 * `surfaceDetailFloor` by a single level however fine its wavelength is — the
 * search would call every level of it quiet and stop where it stops today. An
 * eight-metre crater is 1.6 m deep because that is what an eight-metre crater
 * is, and that is what buys the two to three levels this phase is named for.
 */
export const MICRO_CRATER_CEILING: Meters = 0.8

/**
 * Peak-to-datum relief of the regolith grit, meters, on an airless world.
 *
 * Under `CANONICAL_AMPLITUDE_FLOOR`, and that is a consequence rather than a
 * rule. A landscape is close to self-affine with a Hurst exponent near 0.8, so
 * continuing the relief band's cascade from its own finest octave — 41 m at
 * about a metre across the zoo — down to eight gives `1 · (8/41)^0.8 ≈ 0.27 m`.
 * Half a metre is that with room for the roughest body in scope, and 2πA/λ makes
 * it a 20° slope at the coarsest octave, which is the top of the 5°–20° RMS band
 * measured at metre baselines on Luna and at the Mars landing sites.
 *
 * It therefore **cannot move the mesh's floor by itself**, because the floor's
 * tolerance is the half-metre this sits under. What moves the floor is the
 * crater tail, and on a body whose air has taken the small craters away the two
 * facts agree: there is nothing at a metre for the mesh to go and get.
 */
export const GRIT_RELIEF: Meters = 0.45

/**
 * How much of the grit an atmosphere takes away.
 *
 * A third at most, which is deliberately mild and is the opposite of what the
 * crater tail does. Wind, frost and running water round the metre scale first,
 * so there is an effect — but a landscape's roughness is close to self-affine,
 * and continuing the relief band's own cascade from its finest octave down to
 * eight metres gives about this amplitude whether or not the body has air. An
 * atmosphered world's metre scale is not smooth, it is made of different things:
 * soil, ripples and loose rock, which is `scatter.ts` rather than a band.
 */
const GRIT_AIR_LOSS = 0.35

/**
 * The shortest wavelength the grit is meshed down to, meters.
 *
 * Two rather than `MICRO_DETAIL_FLOOR`'s one, and the reason is amplitude rather
 * than taste. Octaves halve, so the one-metre octave carries 5.6 cm of a 45 cm
 * band — a twelfth of the half-metre tolerance a mesh cell is refined against,
 * and a twentieth of what a sub-floor crater rim does at the same wavelength.
 * It is two more `noise3` per sample on every patch on the body for relief the
 * finest cell cannot express, and the material draws that band per pixel anyway.
 *
 * The crater tail does run to `MICRO_DETAIL_FLOOR`, because a one-metre crater
 * is 20 cm deep against a wavelength of one — a slope the mesh resolves and the
 * grit at that wavelength does not have.
 */
const GRIT_FLOOR: Meters = 2

/**
 * Octaves of grit: from `CANONICAL_DETAIL_FLOOR` down to `GRIT_FLOOR`.
 *
 * Arithmetic rather than a constant, so the two floors stay the only dials —
 * and 2.03 rather than 2 because that is `DEFAULT_FBM`'s lacunarity and an
 * octave count derived against the wrong one lands short.
 */
const GRIT_OCTAVES = Math.max(
  1,
  Math.ceil(Math.log(CANONICAL_DETAIL_FLOOR / GRIT_FLOOR) / Math.log(2.03)),
)

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
     * moon and a 6,371 km planet: eight metres of ground is eight metres of
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
 * Zero where a body has neither tail nor grit, which is what makes "this body's
 * mesh *is* its contact test" a statement the tests can make about the bodies it
 * is true of rather than a claim about the average.
 */
export function microReliefBound(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
): Meters {
  const tail = sketch.microLevels.length > 0 ? MICRO_CRATER_CEILING : 0
  return tail + gritRelief(grammar)
}
