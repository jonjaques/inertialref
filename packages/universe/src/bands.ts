import type { Meters } from '@inertialref/shared'
import {
  clamp,
  falloff,
  fbm3,
  fbmField,
  mix,
  pcg4d,
  ridged3,
  ridgedField,
  type Seed,
  smoothstep,
  toUnit,
} from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { SurfaceGrammar } from './grammar.ts'
import {
  CANONICAL_AMPLITUDE_FLOOR,
  CANONICAL_DETAIL_FLOOR,
  convergence,
  type Hotspot,
  plateAt,
  type StripeAxis,
  type TerrainSketch,
} from './sketch.ts'

/*
 * The band stack.
 *
 * Six fields, evaluated coarse to fine, each returning a number in roughly
 * [-1, 1] that `elevationAt` scales by that band's share of the body's relief
 * budget. Shares rather than meters, because a band that carried its own scale
 * could quietly grow past the peak the strength limit allows — and because the
 * budget is where the grammar says how much of this world is craters and how
 * much is mountain belts.
 *
 * The crater band is the exception and lives in `craters.ts`: it works in
 * meters, because its shape is published in meters — depth over diameter, rim
 * height over diameter, a transition diameter that scales as 1/g — and
 * converting all of that into a fraction of a budget would be inventing a
 * second set of numbers that had to agree with the first.
 *
 * **Octave counts are derived, not written down.** A band evaluated at `d · k`
 * has its coarsest features about `R/k` meters across, and each octave is
 * `lacunarity` times finer and half as tall; `octavesFor` counts how many it
 * takes to reach the canonical floor — in wavelength or in amplitude, whichever
 * comes first — and stops there. That is the "coarse-to-fine with early-out"
 * the plan asks for, stated as arithmetic: a 50 km moon does not evaluate the
 * twelve octaves an Earth-sized world needs, because it runs out of world
 * first, and a band with a tenth of the relief budget stops three octaves
 * earlier than one with all of it.
 *
 * **Only the bands that read a gradient pay for one.** `gradientNoise3` is four
 * times the cost of `noise3` — the value is one trilinear interpolation and the
 * gradient is three more — and it is worth it exactly where the derivative is
 * consumed: the relief band's slope damping, and the belts' when the grammar
 * says the world erodes. Everywhere else — the hypsometric swell,
 * the domain warp, the arc cones, the sulci — the value is all anyone wants and
 * the v1 primitives are what get called. On an airless world that is the whole
 * stack except the craters.
 */

/**
 * How many octaves it takes a band to reach the canonical detail floor.
 *
 * Two floors, and the tighter one wins. Wavelength: the coarsest feature is
 * about `R/cycles` meters across and each octave is `lacunarity` times finer,
 * so `log(coarsest/floor)` octaves reach 8 m. Amplitude: octaves halve, and a
 * normalized fBm's `i`-th one carries `peak · 2^-i / 2`, so it drops under half
 * a meter after `log2(peak)` of them.
 *
 * `peak` is the band's whole contribution in meters — its share of the budget —
 * and passing it is what makes a band that owns a tenth of a small moon's
 * relief stop at four octaves where the arithmetic on wavelength alone would
 * ask for eleven. The gain is assumed to be the default 0.5; a band that sets
 * its own would need this to read it, and none does.
 */
export function octavesFor(
  radius: Meters,
  cycles: number,
  max: number,
  peak: Meters = Number.POSITIVE_INFINITY,
): number {
  const coarsest = radius / Math.max(cycles, 1e-6)
  if (!(coarsest > CANONICAL_DETAIL_FLOOR)) return 1
  const byLength = Math.ceil(
    Math.log(coarsest / CANONICAL_DETAIL_FLOOR) / Math.log(2.03),
  )
  const byAmplitude = Number.isFinite(peak)
    ? Math.ceil(Math.log2(Math.max(1, peak / CANONICAL_AMPLITUDE_FLOOR)))
    : Number.POSITIVE_INFINITY
  return Math.max(1, Math.min(max, byLength, byAmplitude))
}

/**
 * Hypsometry: continents against ocean floor.
 *
 * A plate is continental or oceanic, and that one bit is what gives Earth its
 * bimodal elevation histogram — means near +0.8 km and −3.7 km with very little
 * ground in between. The blend across a boundary is what stops it being a step:
 * `F2 − F1` is zero exactly on the boundary and grows inward, so the two
 * plates' bases mix over a margin instead of meeting at a cliff.
 *
 * A stagnant-lid world has one plate and takes the `null` branch, which is the
 * swell alone — unimodal, which is Mercury.
 */
export function hypsometryBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  peak: Meters,
): number {
  const swellCycles = 1.6
  const swell = fbm3(
    sketch.seeds.hypsometry,
    direction.x * swellCycles,
    direction.y * swellCycles,
    direction.z * swellCycles,
    { octaves: octavesFor(grammar.meanRadius, swellCycles, 5, peak * 0.35) },
  )

  const sample = plateAt(sketch, direction)
  if (sample === null) return clamp(swell, -1, 1)

  // A quarter of a radian of margin, which is ~1,600 km on Earth: the width of
  // a continental shelf and slope together, and the scale over which the crust
  // actually changes type.
  const blend = 0.5 + 0.5 * smoothstep(0, 0.25, sample.boundary)
  const base = mix(
    (sample.plate.base + sample.neighbor.base) / 2,
    sample.plate.base,
    blend,
  )
  return clamp(base + swell * 0.35, -1, 1)
}

/**
 * Tectonic belts: what happens along a plate boundary.
 *
 * Three cases, from the component of relative motion across the boundary.
 * Convergent builds a ridged range on the overriding side and a trench on the
 * other. Divergent opens a rift on continental crust and a mid-ocean ridge on
 * oceanic. Transform neither builds nor opens and leaves a scarp — a step whose
 * sign is the plate's, so the two sides of the fault sit at different heights.
 *
 * A one-plate world still cracks. Mercury's lobate scarps are a whole planet
 * that shrank as its core froze, and they are hundreds of kilometers long and a
 * kilometer high on a body with no plates at all, so the `null` branch is a
 * global scarp field rather than nothing.
 */
export function beltBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  peak: Meters,
): number {
  const cycles = 9
  const options = {
    octaves: octavesFor(grammar.meanRadius, cycles, 7, peak),
    damping: grammar.erosion,
  }
  // The analytic-derivative form only where the damping consumes the gradient.
  // On an airless world `erosion` is zero, and there it would be twice the cost
  // of `ridged3` for the same number.
  const raw =
    grammar.erosion > 0
      ? ridgedField(
          sketch.seeds.belts,
          direction.x * cycles,
          direction.y * cycles,
          direction.z * cycles,
          options,
        ).value
      : ridged3(
          sketch.seeds.belts,
          direction.x * cycles,
          direction.y * cycles,
          direction.z * cycles,
          options,
        )
  const ranges = raw * 0.5 + 0.5

  const sample = plateAt(sketch, direction)
  if (sample === null) {
    // Lobate scarps: long, low, one-sided. The `1 -` turns the ridge crest into
    // a scarp face, and the cube keeps it to a few percent of the surface.
    return (1 - ranges) ** 3 * 2 - 0.1
  }

  // A tenth of a radian is ~640 km on Earth, which is the width of an orogen —
  // the Andes are 700 km across including the foreland.
  const edge = 1 - smoothstep(0, 0.1, sample.boundary)
  if (edge <= 0) return 0
  const across = convergence(sample, direction)
  const converging = Math.max(0, across)
  const diverging = Math.max(0, -across)
  const sliding = 1 - Math.abs(across)
  const continental = sample.plate.continental

  const uplift = converging * (continental ? ranges : -0.9 * ranges)
  const opening = diverging * (continental ? -0.7 * ranges : 0.55 * ranges)
  const scarp = sliding * 0.35 * sample.plate.step * ranges
  return clamp(edge * (uplift + opening + scarp), -1, 1)
}

/**
 * Volcanic edifices: hotspot shields, their calderas, and arc cones.
 *
 * A shield is a broad dome with a notch in the top, and the notch is not
 * decoration: a caldera is where the summit collapsed into the emptied chamber,
 * and a shield drawn without one reads as a hill. The `0.7` exponent on the
 * falloff is what makes the flank concave — Mauna Loa averages four degrees and
 * steepens toward the rift zones rather than toward the summit.
 *
 * Arc cones are gated on a convergent boundary, because that is where they are:
 * a volcanic arc is the subducting slab dehydrating under the overriding plate,
 * so the field only has cones where the belt band has a trench.
 */
export function volcanicBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  peak: Meters,
): number {
  let height = 0
  for (const hotspot of sketch.hotspots) {
    height += shieldProfile(hotspot, direction)
  }

  const sample = plateAt(sketch, direction)
  if (sample !== null && sample.plate.continental) {
    const edge = 1 - smoothstep(0, 0.06, sample.boundary)
    if (edge > 0) {
      const across = Math.max(0, convergence(sample, direction))
      const cycles = 60
      const cones =
        ridged3(
          sketch.seeds.belts,
          direction.x * cycles + 11.3,
          direction.y * cycles,
          direction.z * cycles,
          { octaves: octavesFor(grammar.meanRadius, cycles, 4, peak) },
        ) *
          0.5 +
        0.5
      height += edge * across * cones ** 3 * 1.6
    }
  }
  return clamp(height, -1, 1)
}

function shieldProfile(hotspot: Hotspot, direction: Vec3): number {
  // Chord rather than arc, as in the crater band: 0.35 radians is the widest
  // shield the sketch draws and the two differ by half a percent there.
  const ex = direction.x - hotspot.axis.x
  const ey = direction.y - hotspot.axis.y
  const ez = direction.z - hotspot.axis.z
  const distance = Math.sqrt(ex * ex + ey * ey + ez * ez)
  const t = distance / hotspot.radius
  if (t >= 1) return 0
  const flank = hotspot.strength * falloff(t) ** 0.7
  const caldera =
    t < hotspot.caldera
      ? hotspot.strength * 0.4 * falloff(t / hotspot.caldera)
      : 0
  return flank - caldera
}

/**
 * The icy-active set: chaos terrain, sulci, and tiger-stripe troughs.
 *
 * All three are the same cause — a shell being worked by a tide it cannot
 * relax — and they are separated because they look nothing alike. Chaos is
 * Europa's block rafts: crust broken into pieces, rotated, and refrozen at
 * different heights, which is a Voronoi field with plateau interiors and sharp
 * walls. Sulci are Ganymede's grooved bands, parallel ridges over tens of
 * kilometers, which is ridged noise with one axis compressed fivefold. Tiger
 * stripes are Enceladus's four parallel fractures — a great-circle trough with
 * a raised ridge on each shoulder, which is what a double ridge is.
 */
export function iceBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  peak: Meters,
): number {
  let height = 0

  if (grammar.chaos > 0.05) {
    // ~10 km blocks, which is the scale Europa's chaos regions break into.
    const cells = grammar.meanRadius / 10_000
    height += grammar.chaos * blockField(sketch.seeds.chaos, direction, cells)
  }

  if (grammar.sulci > 0.05) {
    const cycles = 24
    const sulci = ridged3(
      sketch.seeds.sulci,
      direction.x * cycles * 5,
      direction.y * cycles,
      direction.z * cycles,
      { octaves: octavesFor(grammar.meanRadius, cycles * 5, 5, peak) },
    )
    height += grammar.sulci * 0.5 * sulci
  }

  for (const stripe of sketch.stripes) {
    height += grammar.stripes * stripeProfile(stripe, direction)
  }

  return clamp(height, -1, 1)
}

/**
 * A double ridge over a great-circle fracture.
 *
 * The trough is the fracture itself and the two ridges are the material pushed
 * up on either side of it as the walls grind. Cassini measured Enceladus's at
 * ~500 m deep and ~2 km wide with flanking ridges roughly as high, so the
 * shoulders are a real feature rather than a way of hiding the cut.
 */
function stripeProfile(stripe: StripeAxis, direction: Vec3): number {
  const away = Math.abs(
    direction.x * stripe.pole.x +
      direction.y * stripe.pole.y +
      direction.z * stripe.pole.z,
  )
  const reach = stripe.halfWidth + stripe.offset * 3
  if (away > reach) return 0
  const trough = -falloff(Math.min(1, away / stripe.halfWidth))
  const shoulderCenter = stripe.halfWidth + stripe.offset
  const shoulder =
    0.7 *
    falloff(Math.min(1, Math.abs(away - shoulderCenter) / (stripe.offset * 2)))
  return trough + shoulder
}

/**
 * Voronoi block rafts: plateau interiors, sharp walls, each block at its own
 * height.
 *
 * The same 3×3×3 lattice the crater field walks, for the same reason — a cube
 * lattice in ℝ³ intersected with the sphere has no face seams and no corners.
 * `F2 − F1` is the distance to the nearest wall, and running it through a
 * smoothstep is what makes the interior flat instead of conical.
 */
function blockField(seed: Seed, direction: Vec3, cells: number): number {
  const size = 1 / cells
  const baseX = Math.floor(direction.x * cells)
  const baseY = Math.floor(direction.y * cells)
  const baseZ = Math.floor(direction.z * cells)
  let nearest = Infinity
  let second = Infinity
  let winner = 0
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const ix = baseX + dx
        const iy = baseY + dy
        const iz = baseZ + dz
        const hash = pcg4d(ix ^ seed.a, iy, iz, seed.b)
        const px = (ix + toUnit(hash.x)) * size - direction.x
        const py = (iy + toUnit(hash.y)) * size - direction.y
        const pz = (iz + toUnit(hash.z)) * size - direction.z
        const distance = px * px + py * py + pz * pz
        if (distance < nearest) {
          second = nearest
          nearest = distance
          winner = hash.w
        } else if (distance < second) {
          second = distance
        }
      }
    }
  }
  if (!Number.isFinite(second)) return 0
  const wall = (Math.sqrt(second) - Math.sqrt(nearest)) / size
  return (toUnit(winner) * 2 - 1) * smoothstep(0, 0.35, wall)
}

/**
 * The tail: domain-warped, derivative-damped fBm, plus dunes where there is
 * wind.
 *
 * Everything the named features do not explain. The domain warp is what stops
 * it reading as noise — a warped field bends its own ridges around, which is
 * what a landscape that has been drained and re-drained looks like — and the
 * damping is the erosion stand-in: on an airless world it is zero and rims stay
 * razor-edged, under a thick atmosphere it is 24 and everything reads as worn.
 */
export function reliefBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  roughness: number,
  direction: Vec3,
  peak: Meters,
): number {
  const cycles = Math.max(0.5, roughness) * 2.2
  const octaves = octavesFor(grammar.meanRadius, cycles, 12, peak)

  /*
   * The warp is two octaves and a tenth of a cell, which is enough to bend a
   * ridge and not enough to fold the field over itself. A warp that large stops
   * being a landscape and starts being marble.
   */
  const warpCycles = cycles * 0.5
  const warpOptions = { octaves: 2 } as const
  const wx = fbm3(
    sketch.seeds.warpX,
    direction.x * warpCycles,
    direction.y * warpCycles,
    direction.z * warpCycles,
    warpOptions,
  )
  const wy = fbm3(
    sketch.seeds.warpY,
    direction.x * warpCycles,
    direction.y * warpCycles,
    direction.z * warpCycles,
    warpOptions,
  )
  const wz = fbm3(
    sketch.seeds.warpZ,
    direction.x * warpCycles,
    direction.y * warpCycles,
    direction.z * warpCycles,
    warpOptions,
  )
  const amount = 0.1 / cycles

  const options = { octaves, damping: grammar.erosion }
  const relief =
    grammar.erosion > 0
      ? fbmField(
          sketch.seeds.relief,
          (direction.x + wx * amount) * cycles,
          (direction.y + wy * amount) * cycles,
          (direction.z + wz * amount) * cycles,
          options,
        ).value
      : fbm3(
          sketch.seeds.relief,
          (direction.x + wx * amount) * cycles,
          (direction.y + wy * amount) * cycles,
          (direction.z + wz * amount) * cycles,
          options,
        )

  if (grammar.dunes <= 0.02) return clamp(relief, -1, 1)

  /*
   * A dune sea is anisotropic by definition — the wind has a direction — and
   * one compressed axis is how that reads without the field carrying a wind
   * map. It is stretched along x in body-fixed axes rather than along a local
   * prevailing wind, which is the thing this owes the phase that gives the
   * grammar a circulation.
   */
  const duneCycles = cycles * 40
  const dunes = ridged3(
    sketch.seeds.dunes,
    direction.x * duneCycles * 0.15,
    direction.y * duneCycles,
    direction.z * duneCycles,
    { octaves: octavesFor(grammar.meanRadius, duneCycles, 3, peak) },
  )
  return clamp(relief + grammar.dunes * 0.18 * dunes, -1, 1)
}
