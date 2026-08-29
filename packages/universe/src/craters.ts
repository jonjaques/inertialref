import type { Meters } from '@inertialref/shared'
import * as procedural from '@inertialref/procedural'
import { type Vec3, vec3 } from '@inertialref/spatial'
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
 * The cost of that is a three-dimensional neighborhood instead of a flat one.
 * Most of its cells do not touch the unit sphere at all, and the box-sphere
 * test that rejects them is squared distances and two compares — an order of
 * magnitude cheaper than the hash it avoids.
 *
 * **How wide that neighborhood is comes from the ejecta reach, and does not fit
 * in a ±1 walk.** A level's cell is one largest-crater diameter across, so that
 * crater's radius is half a cell and its apron runs `EJECTA_REACH` of those —
 * 1.3 cells, against the one cell a ±1 walk contains. The apron of a crater in
 * the next cell out was therefore never summed, and it did not fade out at the
 * boundary: it *appeared* there, as a step in the field, on about 30% of
 * directions and up to 158 m of it. `levelContribution` derives its own bounds
 * from the reach instead, which is three or four cells an axis rather than
 * three, and `craterFieldWithin` lets the test walk wider still and find
 * nothing more.
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
  return craterFieldWithin(sketch, grammar, direction, 0)
}

/**
 * The same field, with every level's neighborhood widened by `extra` cells.
 *
 * Exported for the one test that can hold the containment claim, because the
 * claim is about what the walk does *not* visit and the only way to see that is
 * to visit it. `extra` of zero is what ships; a test compares it against two and
 * asserts the difference is nothing, over enough directions that a crater
 * straddling a cell boundary has to turn up in some of them.
 */
export function craterFieldWithin(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  extra: number,
): Meters {
  const radius = grammar.meanRadius
  /*
   * How radial each axis is here, how tangent, and how thick a cell is along
   * the radius. Every level's neighborhood is sized from these three, and they
   * are a property of the direction rather than of the level, so they are
   * computed once for the whole ladder. `levelContribution` says what each one
   * is doing.
   *
   * `slop` is a cube's own width along `direction` — the support function of a
   * unit cube, which is the sum of the absolute components — and it runs from
   * one cell face-on to √3 corner-on.
   */
  const along = vec3(
    Math.abs(direction.x),
    Math.abs(direction.y),
    Math.abs(direction.z),
  )
  const spread = vec3(
    Math.sqrt(Math.max(0, 1 - direction.x * direction.x)),
    Math.sqrt(Math.max(0, 1 - direction.y * direction.y)),
    Math.sqrt(Math.max(0, 1 - direction.z * direction.z)),
  )
  const slop = along.x + along.y + along.z
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
      along,
      spread,
      slop,
      extra,
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
  along: Vec3,
  spread: Vec3,
  slop: number,
  extra: number,
): number {
  const cells = level.cells
  const size = 1 / cells
  /*
   * How far this level can throw, in cells.
   *
   * The largest crater the level places is `level.diameter`, its ejecta reach
   * `EJECTA_REACH` of that crater's *radius*, and a cell is `size` of direction
   * space — so this is that reach measured in cells. Derived from the level
   * rather than written down as 1.3, so that changing `EJECTA_REACH` or how
   * `craterLadder` sizes a cell moves the walk with it instead of silently
   * truncating the apron.
   */
  const reach = ((EJECTA_REACH * level.diameter) / (2 * radius)) * cells
  /*
   * How wide the neighborhood has to be, per axis — and it is not the same on
   * all three, which is the whole reason this is arithmetic rather than a
   * literal ±1.
   *
   * **Two displacements separate a crater's cell from the sample's, and they
   * are perpendicular.** The ejecta reach lies in the tangent plane. The other
   * is radial and is the one the old walk had no idea about: the lattice is
   * cubes in ℝ³ and the field is a shell cutting through them, so a cell's
   * jittered center is a point *near* the sphere rather than on it, while the
   * profile measures from that point's projection. A crater directly under the
   * sample can therefore be indexed a whole cell away, purely because its
   * center sits above or below the shell — and the bound on that is the cell's
   * own width along the radius, which is `slop`.
   *
   * So an axis takes `reach` times how tangent it is here plus `slop` times how
   * radial, which never exceeds √(reach² + slop²). Splitting them is worth the
   * arithmetic: spending the sum on all three axes is 3.0 cells everywhere
   * where the split peaks at 2.2 and sits near 2.1, which on a lunar patch is
   * 5.1 cells an axis rather than 7.
   *
   * The last two terms are the curvature the small-cell picture drops, and they
   * matter only at the top of the ladder, where a cell is a tenth of the sphere
   * across: `reach²·size/2` is how far a chord of that length falls away from
   * the tangent plane, and `slop·reach·size` is the radial offset applied to a
   * direction that has already moved by the reach.
   */
  const bend = (reach * reach * size) / 2
  const curve = slop * reach * size
  const spanX = reach * spread.x + (slop + bend) * along.x + curve + extra
  const spanY = reach * spread.y + (slop + bend) * along.y + curve + extra
  const spanZ = reach * spread.z + (slop + bend) * along.z + curve + extra
  const fromX = Math.floor(direction.x * cells - spanX)
  const toX = Math.floor(direction.x * cells + spanX)
  const fromY = Math.floor(direction.y * cells - spanY)
  const toY = Math.floor(direction.y * cells + spanY)
  const fromZ = Math.floor(direction.z * cells - spanZ)
  const toZ = Math.floor(direction.z * cells + spanZ)
  let total = 0

  for (let ix = fromX; ix <= toX; ix += 1) {
    const loX = ix * size
    const hiX = loX + size
    // Nearest and farthest squared distance from the origin to this slab. A
    // cell intersects the unit sphere exactly when the nearest is inside it and
    // the farthest is outside — which is a tighter test than the cell's
    // bounding sphere and rejects a third of them.
    const nearX = loX > 0 ? loX * loX : hiX < 0 ? hiX * hiX : 0
    /*
     * The same rejection, partially summed, and left early where it can be.
     *
     * A neighborhood wide enough to contain the ejecta reach spends most of its
     * cells off the shell, and reaching the full three-axis test once per cell
     * to find that out is the walk's largest cost. `nearX` alone throws away a
     * whole plane and `nearX + nearY` a whole row — and both are *monotone*
     * once the index is past zero, where the slab is moving away from the
     * origin rather than toward it, so the tail of a row can be abandoned
     * rather than scanned.
     */
    if (nearX > 1) {
      if (ix >= 0) break
      continue
    }
    const farX = Math.max(loX * loX, hiX * hiX)
    for (let iy = fromY; iy <= toY; iy += 1) {
      const loY = iy * size
      const hiY = loY + size
      const nearY = loY > 0 ? loY * loY : hiY < 0 ? hiY * hiY : 0
      if (nearX + nearY > 1) {
        if (iy >= 0) break
        continue
      }
      const farY = Math.max(loY * loY, hiY * hiY)
      const acrossXY = nearX + nearY
      for (let iz = fromZ; iz <= toZ; iz += 1) {
        const loZ = iz * size
        const hiZ = loZ + size
        const nearZ = loZ > 0 ? loZ * loZ : hiZ < 0 ? hiZ * hiZ : 0
        if (acrossXY + nearZ > 1) {
          if (iz >= 0) break
          continue
        }
        const farZ = Math.max(loZ * loZ, hiZ * hiZ)
        /*
         * A cell wholly inside the sphere. There is no early exit at this end
         * and the obvious one is wrong: `farZ` bottoms out in the middle of the
         * row rather than at an end, so a run of interior cells is a *band*
         * with shell on both sides of it. Breaking here dropped 18 km of crater
         * on Luna, all of it on the far side of the band.
         */
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
   * Faded to zero at **both** ends rather than truncated at either: an apron
   * that stops with a step draws a circle at its own edge, and the circle
   * survives into the normals.
   *
   * The outer fade is the obvious one and the inner fade is the one that
   * matters more, because `r⁻³` is at its largest exactly where the blanket
   * begins. Entering at full value on the first sample past `t = 1` is a
   * vertical wall of `0.12·depth·rimLife·(0.6 + 0.8·typeDraw)` — seven to
   * seventeen percent of every crater's depth, on every crater on every body,
   * at precisely the radius the rim crest sits on. Measured before the
   * `smoothstep(1, RIM_OUTER, t)` below: a 590 m step across 1.7e-10 m of
   * ground on Iapetus, 432 m on a rocky airless world, and a largest-sample-jump
   * to p99.9 ratio of 14.4 where a C1 field gives ~1.
   *
   * That is not only a visible cliff. `elevationAt` is the one function the mesh
   * and the contact test share, and the CDLOD morph is exact only because a
   * parent and its child evaluate the same function — which two patches
   * straddling a step at different levels do not
   * ([ADR-0019](../../../docs/adr/0019-the-geology.md) § "One field, at every
   * level"). `RIM_OUTER` is where the rim ring has already returned to zero, so
   * the blanket is at full strength by the time it is the only term left.
   *
   * The `typeDraw` is the one place a crater's *kind* shows in the height field
   * — a low-angle impact throws a lopsided blanket, and here that is a scale on
   * the apron rather than a direction, because a direction would need a second
   * axis this profile does not carry.
   */
  if (t > 1) {
    const r = t
    const apron =
      (1 / (r * r * r)) *
      smoothstep(1, RIM_OUTER, t) *
      (1 - smoothstep(1.8, EJECTA_REACH, t))
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
