import type { Meters } from '@inertialref/shared'
import * as procedural from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { craterDepth, type SurfaceGrammar } from './grammar.ts'
import type { CraterLevel, TerrainSketch } from './sketch.ts'

/*
 * The crater band.
 *
 * It carries most of the character of the bodies this milestone is about, and
 * it is the one band whose numbers are published rather than invented. Size and
 * frequency follow a power law; fresh simple craters carry depth/diameter ≈ 0.2
 * and a rim ~4% of the diameter high; the simple-to-complex transition scales
 * inversely with surface gravity — ~18 km on the Moon, ~3 km on Earth — and
 * above it floors flatten and central peaks appear. Age degrades: the rim
 * rounds off first, then the floor fills in.
 *
 * **Placement is a 3D lattice in direction space, not the cube-sphere's own
 * grid.** The cube grid was the obvious choice and is wrong for a reason worth
 * writing down: a crater straddling a face edge would have to hash the same
 * from both faces, and at the eight points where three faces meet a cell has
 * seven neighbors rather than eight — so a ring walk visits one of them twice
 * and that crater comes out at double depth, at eight places on every world. A
 * lattice of cubes in ℝ³ intersected with the unit sphere has no seams and no
 * corners: a cell is `floor(d · s)` whoever is asking, so the same crater is
 * the same crater from every patch, at every level, on both sides of every face
 * edge, by construction rather than by arithmetic.
 *
 * The cost of that is a 3×3×3 neighborhood instead of 3×3. Most of those
 * twenty-seven cells do not touch the unit sphere at all, and the box-sphere
 * test that rejects them is squared distances and two compares — an order of
 * magnitude cheaper than the hash it avoids.
 *
 * Rays are not here. A young crater's rays are an *albedo* field, not a height
 * one, which is how Tycho actually reads from orbit; they belong to the
 * material in the phase after this.
 */

/*
 * The imported primitives, bound to module-local names once.
 *
 * A `import { toUnit }` and a `toUnit(…)` are the same thing everywhere this
 * code actually runs. Under **vitest** they are not: Vite's SSR transform
 * rewrites every reference to an imported binding into a property read on a
 * module-namespace object, and this loop reads four of them per crater cell
 * over a million cells a patch. Measured, that is 98 ms a patch under the test
 * runner against 20 under Node's own loader — and it is what made the four
 * tests that stream a whole landing take two minutes each.
 *
 * Binding them here pays the property read once per module rather than once per
 * call, and it is a rename rather than a copy: the functions, the formulas and
 * the docstrings all still live in `packages/procedural`. It is worth the two
 * lines *only here*. The same change to `bands.ts`, which calls the same
 * primitives ten times per sample rather than a million times per patch, moved
 * the measurement by 0.7 ms and was reverted.
 */
const { falloff, pcg4d, ring, smoothstep, toUnit } = procedural

/** How far past its own rim a crater's ejecta reaches, in crater radii. */
const EJECTA_REACH = 2.6

/**
 * Where the rim crest sits and how far the raised rim spreads, in crater radii.
 *
 * The crest is at the rim — `t = 1` — with the raised material running from
 * 0.7 to 1.5. Measured lunar profiles put the crest within a few percent of the
 * rim radius and the flank out to about 1.5, which is where the continuous
 * ejecta deposit starts.
 */
const RIM_INNER = 0.7
const RIM_OUTER = 1.5

/**
 * The crater field's contribution at a direction, meters.
 *
 * Summed over every lattice level in the sketch and soft-limited by the caller,
 * because craters overlap and a basin inside a basin would otherwise punch
 * through the mantle.
 */
export function craterField(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
): Meters {
  const radius = grammar.meanRadius
  let total = 0
  for (let index = 0; index < sketch.craterLevels.length; index += 1) {
    const level = sketch.craterLevels[index] as CraterLevel
    total += levelContribution(
      sketch.latticeSeed,
      index,
      level,
      grammar,
      direction,
      radius,
    )
  }
  return total
}

function levelContribution(
  seed: number,
  index: number,
  level: CraterLevel,
  grammar: SurfaceGrammar,
  direction: Vec3,
  radius: Meters,
): number {
  const cells = level.cells
  const size = 1 / cells
  const baseX = Math.floor(direction.x * cells)
  const baseY = Math.floor(direction.y * cells)
  const baseZ = Math.floor(direction.z * cells)
  let total = 0

  for (let dx = -1; dx <= 1; dx += 1) {
    const ix = baseX + dx
    const loX = ix * size
    const hiX = loX + size
    // Nearest and farthest squared distance from the origin to this slab. A
    // cell intersects the unit sphere exactly when the nearest is inside it and
    // the farthest is outside — which is a tighter test than the cell's
    // bounding sphere and rejects a third more of the twenty-seven.
    const nearX = loX > 0 ? loX * loX : hiX < 0 ? hiX * hiX : 0
    const farX = Math.max(loX * loX, hiX * hiX)
    for (let dy = -1; dy <= 1; dy += 1) {
      const iy = baseY + dy
      const loY = iy * size
      const hiY = loY + size
      const nearY = loY > 0 ? loY * loY : hiY < 0 ? hiY * hiY : 0
      const farY = Math.max(loY * loY, hiY * hiY)
      for (let dz = -1; dz <= 1; dz += 1) {
        const iz = baseZ + dz
        const loZ = iz * size
        const hiZ = loZ + size
        const nearZ = loZ > 0 ? loZ * loZ : hiZ < 0 ? hiZ * hiZ : 0
        if (nearX + nearY + nearZ > 1) continue
        const farZ = Math.max(loZ * loZ, hiZ * hiZ)
        if (farX + farY + farZ < 1) continue

        const hash = pcg4d(ix ^ seed, iy, iz, index)
        const draw = toUnit(hash.x)
        if (draw >= level.density) continue
        /*
         * The existence draw, reused as the size draw.
         *
         * Conditional on the cell holding a crater, `draw / density` is uniform
         * on [0, 1) — so it is a size draw with no hash behind it, and having
         * the diameter *here* rather than after a second hash is what lets the
         * exact reach test below reject three cells in four before that hash is
         * paid for. Diameters run over one octave inside a level, so the
         * ladder's halving covers every size continuously rather than in bands.
         */
        const diameter = level.diameter * (0.5 + (0.5 * draw) / level.density)
        const angularRadius = diameter / (2 * radius)

        // Jitter the center inside its own cell. It is *not* normalized: the
        // only thing anyone wants from it is how far the sample is from it.
        const jx = (ix + toUnit(hash.y)) * size
        const jy = (iy + toUnit(hash.z)) * size
        const jz = (iz + toUnit(hash.w)) * size
        const jitterLength = Math.sqrt(jx * jx + jy * jy + jz * jz)
        if (jitterLength < 1e-12) continue

        /*
         * The squared chord from the sample to the crater, `2 − 2 cos θ`,
         * straight out of the dot product.
         *
         * Projecting the jittered center onto the sphere and subtracting is
         * three divides, three subtractions and three multiplies; this is one
         * divide, and it is the same number. Over two hundred cells a sample
         * and fourteen levels, that division is the crater band's inner loop.
         *
         * Chord rather than arc, and the approximation is stated because it is
         * load-bearing rather than lazy: `2 sin(θ/2)` differs from θ by 0.26% at
         * 0.25 radians, which is the angular radius of the largest crater the
         * grammar will place. An `acos` here would cost more than the hash that
         * found the crater. The cancellation in `2 − 2 cos θ` at small θ costs
         * about seven significant figures at the ladder's finest level, against
         * a profile that is read to three.
         */
        const along =
          (direction.x * jx + direction.y * jy + direction.z * jz) /
          jitterLength
        const away = 2 - 2 * along
        const reach = angularRadius * EJECTA_REACH
        if (away > reach * reach) continue
        const distance = Math.sqrt(Math.max(0, away))

        // A second hash for age, central peak and type, paid only by the cells
        // whose crater actually reaches this sample.
        const shape = pcg4d(iy, iz, ix ^ seed, index + 8_191)
        total += craterProfile(
          distance / angularRadius,
          diameter,
          grammar,
          toUnit(shape.x),
          toUnit(shape.y),
          toUnit(shape.z),
        )
      }
    }
  }
  return total
}

/**
 * One crater's radial profile, meters.
 *
 * `t` is the distance from the center in crater radii: the floor is inside
 * `t < 1`, the rim crest is at 1, and the ejecta apron runs out to 2.6.
 */
function craterProfile(
  t: number,
  diameter: Meters,
  grammar: SurfaceGrammar,
  age: number,
  peakDraw: number,
  typeDraw: number,
): number {
  const complex = diameter > grammar.complexDiameter
  const depth = craterDepth(diameter, grammar.complexDiameter)

  /*
   * Viscous relaxation: on ice, a large old crater sags into a palimpsest.
   *
   * It is why Callisto is smooth at large scales and rough at small — the small
   * craters are younger than the relaxation time and the large ones are not —
   * and it is a stronger effect the larger the crater, because the driving
   * stress goes as the depth.
   */
  const relaxed =
    grammar.relaxation === 0
      ? 1
      : 1 -
        grammar.relaxation *
          age *
          smoothstep(
            grammar.complexDiameter,
            grammar.complexDiameter * 8,
            diameter,
          )

  // Rims decay faster than cavities: a crater loses its raised rim to
  // micrometeorites and downslope creep long before its bowl fills in.
  const rimLife = (1 - age) ** 1.5 * relaxed
  const floorLife = (1 - 0.55 * age) * relaxed

  let height = 0

  if (t < 1) {
    /*
     * A parabolic bowl for a simple crater, with a flat floor for a complex
     * one. The flat fraction is what "the floor collapses" means as a shape:
     * past the transition the walls slump inward and the middle is a plain.
     */
    const flat = complex ? 0.45 : 0
    const u = t <= flat ? 0 : (t - flat) / (1 - flat)
    height -= depth * floorLife * (1 - u * u)

    /*
     * A central peak on a complex crater, hash-gated because not every complex
     * crater has one — the transition is a range rather than a line, and about
     * half of them do. The peak is a fifth of the cavity depth and a fifth of
     * its radius, which is the measured lunar proportion.
     */
    if (complex && peakDraw < 0.55) {
      height += depth * 0.22 * floorLife * falloff(Math.min(1, t / 0.2))
    }
  }

  // The raised rim, from 0.7 to 1.5 crater radii, crest at the rim itself.
  if (t > RIM_INNER && t < RIM_OUTER) {
    const rimHeight = 0.2 * depth
    height +=
      rimHeight *
      rimLife *
      ring(
        (t - RIM_INNER) / (RIM_OUTER - RIM_INNER),
        (1 - RIM_INNER) / (RIM_OUTER - RIM_INNER),
      )
  }

  /*
   * The ejecta blanket, falling off as ~r⁻³ from the rim.
   *
   * Faded to zero at the outer reach rather than truncated: an apron that stops
   * with a step draws a circle at its own edge, and the circle survives into
   * the normals. The `typeDraw` is the one place a crater's *kind* shows in the
   * height field — a low-angle impact throws a lopsided blanket, and here that
   * is a scale on the apron rather than a direction, because a direction would
   * need a second axis this profile does not carry.
   */
  if (t > 1) {
    const r = t
    const apron = (1 / (r * r * r)) * (1 - smoothstep(1.8, EJECTA_REACH, t))
    height += 0.12 * depth * rimLife * (0.6 + 0.8 * typeDraw) * apron
  }

  return height
}

/**
 * The soft ceiling the crater sum is folded through.
 *
 * Craters overlap, and a saturated surface has three or four of them on top of
 * each other everywhere. Summed unbounded, a basin inside a basin inside a
 * basin goes through the mantle. A hard clamp would flatten exactly the deepest
 * and most interesting ground into a plateau, so this is `tanh`: identity to
 * within a few percent below half the budget, asymptotic to it above, smooth
 * everywhere.
 */
export function softLimit(value: number, limit: number): number {
  if (limit <= 0) return 0
  return limit * Math.tanh(value / limit)
}

/** Cumulative crater count above a diameter, for a ladder — the SFD, for tests. */
export const craterCountAbove = (
  levels: readonly CraterLevel[],
  diameter: Meters,
): number => {
  let total = 0
  for (const level of levels) {
    if (level.diameter < diameter) continue
    // Cells on the shell of a sphere of unit radius, one crater at most each.
    total += 4 * Math.PI * level.cells * level.cells * level.density
  }
  return total
}
