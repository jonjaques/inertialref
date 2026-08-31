import type { Meters } from '@inertialref/shared'
import * as procedural from '@inertialref/procedural'
import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
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
 * **Rays are albedo, not height, and they are at the bottom of this file.** A
 * young crater's rays are thin bright ejecta lying on darker mature ground, not
 * a shape — Tycho's rays cast no shadow at any sun angle and reach twenty times
 * farther than its apron does. So they are not summed into the profile and they
 * are not walked on the lattice: sixteen radii of reach is a neighborhood
 * hundreds of cells wide, which is a whole ladder's cost per sample for a
 * handful of craters. `rayCraters` enumerates those few once per body, out of
 * the same lattice and the same hashes, and `rayBrightness` evaluates them as a
 * short list.
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

/*
 * The numbers this band is written in are exported, and `bands.ts` says why:
 * the TSL port in `apps/game/src/render/terrainKernel.ts` reads the same
 * constants, and a tolerance test holds the two evaluations together.
 */

/** How far past its own rim a crater's ejecta reaches, in crater radii. */
export const EJECTA_REACH = 2.6

/**
 * Where the rim crest sits and how far the raised rim spreads, in crater radii.
 *
 * The crest is at the rim — `t = 1` — with the raised material running from
 * 0.7 to 1.5. Measured lunar profiles put the crest within a few percent of the
 * rim radius and the flank out to about 1.5, which is where the continuous
 * ejecta deposit starts.
 */
export const RIM_INNER = 0.7
export const RIM_OUTER = 1.5

/**
 * One crater's profile, as the proportions `craterProfile` is drawn from.
 *
 * `sizeFloor` is the smallest crater a level places as a fraction of its
 * largest — diameters run over one octave inside a level. `relaxSpan` is how
 * many transition diameters the palimpsest ramp spans. Everything else is a
 * measured lunar proportion, named where `craterProfile` spends it.
 */
export const CRATER_SHAPE = {
  sizeFloor: 0.5,
  flatFloor: 0.45,
  peakChance: 0.55,
  peakHeight: 0.22,
  peakWidth: 0.2,
  rimHeight: 0.2,
  apron: 0.12,
  apronBase: 0.6,
  apronSpread: 0.8,
  apronFade: 1.8,
  relaxSpan: 8,
  rimAge: 1.5,
  floorAge: 0.55,
} as const

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
  return ladderField(
    sketch.latticeSeed,
    sketch.craterLevels,
    0,
    grammar,
    direction,
    extra,
  )
}

/**
 * The same walk over any ladder, starting at any rung number.
 *
 * `firstIndex` is the rung's position in the body's *whole* ladder, and it is
 * what the lattice hashes on — so a rung is the same rung whichever list it
 * arrives in. `micro.ts` continues the ladder below the canonical wavelength
 * floor and hands its rungs in with their real numbers; passing zero would give
 * an 8 m crater the draws of the body's largest basin.
 */
export function ladderField(
  latticeSeed: number,
  levels: readonly CraterLevel[],
  firstIndex: number,
  grammar: SurfaceGrammar,
  direction: Vec3,
  extra: number,
  chord: ChordForm = 'fast',
): Meters {
  if (levels.length === 0) return 0
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
  for (let rung = 0; rung < levels.length; rung += 1) {
    const level = levels[rung] as CraterLevel
    total += levelContribution(
      latticeSeed,
      firstIndex + rung,
      level,
      grammar,
      direction,
      radius,
      along,
      spread,
      slop,
      extra,
      chord,
    )
  }
  return total
}

/**
 * How the distance from a sample to a crater's center is computed.
 *
 * `2 − 2 cos θ` out of one dot product is the cheap form and it is what every
 * canonical rung uses. It cancels: at the ladder's finest *canonical* level θ is
 * about 2 × 10⁻⁴ and the subtraction costs seven significant figures, which
 * leaves the profile exact to nine and the height to a nanometer.
 *
 * Three decades further down it is not fine. A one-meter crater on a
 * 1,700 km body subtends 3 × 10⁻⁷, so `2 − 2 cos θ` is 4 × 10⁻¹⁴ against a
 * float64 ulp of 2 × 10⁻¹⁶ — half a percent of the value, which is a millimeter
 * on the crater's own depth and, worse, a millimeter that **differs between two
 * patches that computed the same direction by different routes**. A cube face's
 * gnomonic extension gives the neighboring face's coordinate exactly in real
 * arithmetic and to the last bit in floating point, and the ill-conditioned form
 * turns that last bit into a visible-in-principle seam.
 *
 * So the presentational tail asks for `'exact'`: the same number as the sum of
 * squared component differences, where each difference is between two nearby
 * floats and is therefore exact. It costs two divides and three subtractions a
 * crater. The canonical ladder keeps `'fast'` deliberately and not for the
 * speed: changing it would move `elevationAt` in its last bits on every body,
 * and the field the contact test integrates does not move outside a version
 * bump.
 *
 * **`'exact'` also takes the sphere test in integers**, and that is a second
 * cancellation rather than a tidiness. A cell is walked when its nearest corner
 * is inside the unit sphere and its farthest outside, and the corners are
 * `m/cells` for integer `m` — so the test is `Σ m² > cells²`, an integer against
 * a float, and `Σ (m/cells)²` in float64 lands on either side of `1` by
 * rounding whenever the two are equal. They are equal on every tail rung of
 * every Sol body: the tail's `cells` is `meanRadius / 8`, `/ 4`, `/ 2`, `/ 1`,
 * a published radius is a round number, and an integer sphere has lattice
 * points on it — hundreds of thousands at Luna's radius in cells, a crater in
 * a million, each decided by which way a product rounded. The integer form
 * decides them exactly, and it is what the GPU port evaluates, so the tail is
 * the same tail on both processors. The canonical ladder cannot land there: its
 * `cells` is `meanRadius / (largestCrater / 2ᵏ)` over a float largest crater,
 * so `cells²` is never an integer and no corner sits on the sphere.
 */
export type ChordForm = 'fast' | 'exact'

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
  chord: ChordForm,
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
  // The sphere test's unit: one over squared direction-space distances, or
  // `cells²` over squared cell indices. See `ChordForm`.
  const exact = chord === 'exact'
  const limit = exact ? cells * cells : 1

  for (let ix = fromX; ix <= toX; ix += 1) {
    const loX = ix * size
    const hiX = loX + size
    // Nearest and farthest squared distance from the origin to this slab. A
    // cell intersects the unit sphere exactly when the nearest is inside it and
    // the farthest is outside — which is a tighter test than the cell's
    // bounding sphere and rejects a third of them.
    const nearX = exact
      ? squareOfNearest(ix)
      : loX > 0
        ? loX * loX
        : hiX < 0
          ? hiX * hiX
          : 0
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
    if (nearX > limit) {
      if (ix >= 0) break
      continue
    }
    const farX = exact ? squareOfFarthest(ix) : Math.max(loX * loX, hiX * hiX)
    for (let iy = fromY; iy <= toY; iy += 1) {
      const loY = iy * size
      const hiY = loY + size
      const nearY = exact
        ? squareOfNearest(iy)
        : loY > 0
          ? loY * loY
          : hiY < 0
            ? hiY * hiY
            : 0
      if (nearX + nearY > limit) {
        if (iy >= 0) break
        continue
      }
      const farY = exact ? squareOfFarthest(iy) : Math.max(loY * loY, hiY * hiY)
      const acrossXY = nearX + nearY
      for (let iz = fromZ; iz <= toZ; iz += 1) {
        const loZ = iz * size
        const hiZ = loZ + size
        const nearZ = exact
          ? squareOfNearest(iz)
          : loZ > 0
            ? loZ * loZ
            : hiZ < 0
              ? hiZ * hiZ
              : 0
        if (acrossXY + nearZ > limit) {
          if (iz >= 0) break
          continue
        }
        const farZ = exact
          ? squareOfFarthest(iz)
          : Math.max(loZ * loZ, hiZ * hiZ)
        /*
         * A cell wholly inside the sphere. There is no early exit at this end
         * and the obvious one is wrong: `farZ` bottoms out in the middle of the
         * row rather than at an end, so a run of interior cells is a *band*
         * with shell on both sides of it. Breaking here dropped 18 km of crater
         * on Luna, all of it on the far side of the band.
         */
        if (farX + farY + farZ < limit) continue

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
        const diameter =
          level.diameter *
          (CRATER_SHAPE.sizeFloor +
            ((1 - CRATER_SHAPE.sizeFloor) * draw) / level.density)
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
        let away: number
        if (chord === 'exact') {
          // The same number, as a sum of squared component differences. Each
          // difference is between two nearby floats and is exact, so nothing
          // cancels — see `ChordForm`.
          const inverse = 1 / jitterLength
          const ex = direction.x - jx * inverse
          const ey = direction.y - jy * inverse
          const ez = direction.z - jz * inverse
          away = ex * ex + ey * ey + ez * ez
        } else {
          const along =
            (direction.x * jx + direction.y * jy + direction.z * jz) /
            jitterLength
          away = 2 - 2 * along
        }
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

/*
 * The slab test's integer corners: a cell `[m, m + 1]` along one axis has its
 * nearest corner at `m` past zero, at `m + 1` before it, and straddles zero
 * otherwise; its farthest is whichever end is larger in magnitude. Squared,
 * these are exact in float64 up to 2⁵³, which is every rung in scope.
 */
const squareOfNearest = (m: number): number => {
  const nearest = m > 0 ? m : m + 1 < 0 ? m + 1 : 0
  return nearest * nearest
}
const squareOfFarthest = (m: number): number => {
  const farthest = Math.max(Math.abs(m), Math.abs(m + 1))
  return farthest * farthest
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
            grammar.complexDiameter * CRATER_SHAPE.relaxSpan,
            diameter,
          )

  // Rims decay faster than cavities: a crater loses its raised rim to
  // micrometeorites and downslope creep long before its bowl fills in.
  const rimLife = (1 - age) ** CRATER_SHAPE.rimAge * relaxed
  const floorLife = (1 - CRATER_SHAPE.floorAge * age) * relaxed

  let height = 0

  if (t < 1) {
    /*
     * A parabolic bowl for a simple crater, with a flat floor for a complex
     * one. The flat fraction is what "the floor collapses" means as a shape:
     * past the transition the walls slump inward and the middle is a plain.
     */
    const flat = complex ? CRATER_SHAPE.flatFloor : 0
    const u = t <= flat ? 0 : (t - flat) / (1 - flat)
    height -= depth * floorLife * (1 - u * u)

    /*
     * A central peak on a complex crater, hash-gated because not every complex
     * crater has one — the transition is a range rather than a line, and about
     * half of them do. The peak is a fifth of the cavity depth and a fifth of
     * its radius, which is the measured lunar proportion.
     */
    if (complex && peakDraw < CRATER_SHAPE.peakChance) {
      height +=
        depth *
        CRATER_SHAPE.peakHeight *
        floorLife *
        falloff(Math.min(1, t / CRATER_SHAPE.peakWidth))
    }
  }

  // The raised rim, from 0.7 to 1.5 crater radii, crest at the rim itself.
  if (t > RIM_INNER && t < RIM_OUTER) {
    const rimHeight = CRATER_SHAPE.rimHeight * depth
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
      (1 - smoothstep(CRATER_SHAPE.apronFade, EJECTA_REACH, t))
    height +=
      CRATER_SHAPE.apron *
      depth *
      rimLife *
      (CRATER_SHAPE.apronBase + CRATER_SHAPE.apronSpread * typeDraw) *
      apron
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

/* ---------------------------------------------------------------------------
 * Ray craters
 * ------------------------------------------------------------------------- */

/**
 * A named young crater: the ones whose rays are visible from orbit.
 *
 * Rays are albedo rather than height, so nothing here is read by `craterField`.
 * What this type exists to guarantee is that the two agree about *where the
 * crater is* — a ray system centered on ground with no bowl under it is the one
 * way this can look obviously wrong, and it is the way it looks wrong if the
 * rays are placed by a second, independent draw.
 *
 * So these are not new craters. They are craters the lattice already places,
 * enumerated once per body and kept, and every field on them is read back from
 * the same two hashes `levelContribution` reads.
 */
export interface RayCrater {
  /** The jittered center, normalized. Body-fixed. */
  readonly axis: Vec3
  readonly diameter: Meters
  /** Half the crater's own angular width, radians. */
  readonly angularRadius: number
  /** 0 fresh, 1 ancient — the draw the height profile degrades with. */
  readonly age: number
  /**
   * Cosine of the angle the rays reach, for the rejection test.
   *
   * Stored rather than derived per sample because the test runs for every
   * crater on the body at every sample and the reach is a property of the
   * crater: sixteen `cos` calls a sample is more than the whole ray field
   * costs when nothing is in range.
   */
  readonly cosReach: number
  /** An orthonormal pair spanning the tangent plane at `axis`. */
  readonly tangent: Vec3
  readonly bitangent: Vec3
  /** One phase per entry of `RAY_HARMONICS`, radians. */
  readonly phases: Float64Array
}

/**
 * How far a ray system reaches, in crater radii.
 *
 * Tycho is 86 km across on a 1,737 km Moon and its rays run about 1,500 km,
 * which is 35 of its own radii — the extreme rather than the norm, and it is
 * the one every eye has seen. Sixteen is the working figure: Copernicus's
 * system reaches roughly that, and a reach measured in radii means the same
 * number serves a 90 km crater on Luna and a 900 km one on Iapetus.
 */
export const RAY_REACH = 16

/**
 * The finest lattice rays are drawn from, in cells per unit of direction space.
 *
 * It gates a **level**, and a level places craters over an octave — from half
 * its own diameter to all of it — so the smallest crater that can carry rays is
 * `meanRadius / 48` rather than `/ 24`. On Luna that is 49 km, which keeps
 * Tycho and Copernicus; the smallest the seed actually places is 50.
 *
 * It is a cost bound as much as a judgment. The enumeration below walks a
 * `(2⌈cells⌉ + 3)³` box per qualifying level, once per body: 71,506 cell tests
 * on Luna across four levels and 132,651 on Callisto, which has one level
 * coarse enough to qualify and therefore the widest box. Each step finer
 * multiplies that by eight.
 *
 * The judgment is defensible on its own terms too. A ray system is bright
 * because it is *thin ejecta over a darker mature surface*, and how far it
 * throws scales with the crater, so a small crater's rays are a feature you
 * have to land next to. This field is for the ones you can see from space.
 */
const RAY_LATTICE_CELLS = 24

/** Craters older than this have lost their rays to space weathering. */
export const RAY_AGE = 0.22

/**
 * Where the filaments begin, in crater radii.
 *
 * Just outside the continuous deposit, which is what a ray *is* — the part of
 * the blanket that flew far enough to land as a streak rather than a sheet. It
 * is also a cheap early-out, and the term it gates is faded in across it for
 * the reason `radial` gives: a gate a term does not reach zero at is a step.
 */
export const RAY_ONSET = 1.2

/** The most a body carries. See the loop's own note on why there is a cap. */
export const MAX_RAY_CRATERS = 16

/**
 * How a ray system is drawn from its harmonics, as `rayBrightness` spends
 * them: the halo's strength, the filaments', the threshold that carves them
 * and how it climbs with distance, the onset fade, the outer fade, and the
 * exponent the ejecta thins with.
 */
export const RAY_SHAPE = {
  halo: 0.85,
  filament: 5.2,
  cutBase: 0.1,
  cutSlope: 0.62,
  cutWidth: 0.28,
  onsetWidth: 0.4,
  fadeStart: 0.55,
  thinning: 1.6,
} as const

/**
 * Azimuthal harmonics of the ray pattern, as integer frequencies.
 *
 * Integers because the pattern has to close: the azimuth is an angle and a
 * non-integer frequency puts a seam along the crater's prime meridian, which
 * draws as one ray that is brighter on one side than the other. Coprime and
 * spread over a decade because a sum of harmonics at nearby frequencies beats
 * rather than looking irregular — these produce a pattern that does not repeat
 * anywhere on the circle.
 */
export const RAY_HARMONICS = [7, 11, 17, 23, 31, 43] as const

/**
 * Hoisted, because the loop it bounds runs per harmonic per crater per sample.
 *
 * A `.length` on a `const` array is a property read the engine cannot hoist out
 * of a loop whose body it cannot prove side-effect-free, and this one is inside
 * the cover's inner loop — the same argument the module-local binding of the
 * procedural primitives at the top of this file makes, one level down.
 */
const RAY_HARMONIC_COUNT = RAY_HARMONICS.length

/**
 * The young large craters of a body, in age order.
 *
 * Walked once per body, at sketch derivation, over the levels of the ladder
 * coarse enough to qualify. The walk is the same one `levelContribution` makes
 * — the same cell test, the same two hashes, the same diameter and jitter — so
 * every crater returned is a crater the height field actually digs.
 *
 * The cap is not an optimization: it is what makes the per-sample cost a
 * constant. A saturated world has thousands of craters above the cutoff and
 * hundreds of them young, and evaluating a ray pattern against all of them at
 * every sample would cost more than the height field it decorates. Sixteen is
 * about what a real body shows — Luna has two ray systems that dominate and a
 * handful that do not — and taking the *youngest* sixteen means the ones that
 * survive are the ones with the brightest rays.
 */
export function rayCraters(
  latticeSeed: number,
  levels: readonly CraterLevel[],
  grammar: SurfaceGrammar,
): readonly RayCrater[] {
  const found: {
    ix: number
    iy: number
    iz: number
    index: number
    diameter: Meters
    age: number
    jx: number
    jy: number
    jz: number
  }[] = []

  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index] as CraterLevel
    if (level.cells > RAY_LATTICE_CELLS) continue
    const cells = level.cells
    const size = 1 / cells
    const span = Math.ceil(cells) + 1
    for (let ix = -span; ix <= span; ix += 1) {
      const loX = ix * size
      const hiX = loX + size
      const nearX = loX > 0 ? loX * loX : hiX < 0 ? hiX * hiX : 0
      if (nearX > 1) continue
      const farX = Math.max(loX * loX, hiX * hiX)
      for (let iy = -span; iy <= span; iy += 1) {
        const loY = iy * size
        const hiY = loY + size
        const nearY = loY > 0 ? loY * loY : hiY < 0 ? hiY * hiY : 0
        if (nearX + nearY > 1) continue
        const farY = Math.max(loY * loY, hiY * hiY)
        for (let iz = -span; iz <= span; iz += 1) {
          const loZ = iz * size
          const hiZ = loZ + size
          const nearZ = loZ > 0 ? loZ * loZ : hiZ < 0 ? hiZ * hiZ : 0
          if (nearX + nearY + nearZ > 1) continue
          const farZ = Math.max(loZ * loZ, hiZ * hiZ)
          if (farX + farY + farZ < 1) continue

          const hash = pcg4d(ix ^ latticeSeed, iy, iz, index)
          const draw = toUnit(hash.x)
          if (draw >= level.density) continue
          const shape = pcg4d(iy, iz, ix ^ latticeSeed, index + 8_191)
          const age = toUnit(shape.x)
          if (age >= RAY_AGE) continue

          const jx = (ix + toUnit(hash.y)) * size
          const jy = (iy + toUnit(hash.z)) * size
          const jz = (iz + toUnit(hash.w)) * size
          /*
           * Rejected here rather than after the sort, because after it the cell
           * has already spent one of the sixteen slots and skipping it leaves
           * the body with fifteen ray systems for no reason anybody could name.
           * It is the cell whose jittered centre lands on the origin, which is
           * one cell in the whole lattice and only when the jitter cancels the
           * index — but the youngest sixteen is a *ranking*, and a ranking that
           * can carry an entry it will then drop is a ranking of the wrong set.
           */
          if (jx * jx + jy * jy + jz * jz < 1e-24) continue

          found.push({
            ix,
            iy,
            iz,
            index,
            diameter:
              level.diameter *
              (CRATER_SHAPE.sizeFloor +
                ((1 - CRATER_SHAPE.sizeFloor) * draw) / level.density),
            age,
            jx,
            jy,
            jz,
          })
        }
      }
    }
  }

  /*
   * Youngest first, ties broken by the cell so the result cannot depend on the
   * order the walk happened to visit in. `age` is a 32-bit draw and a body can
   * carry thousands of craters, so ties are rare rather than impossible — and
   * "rare" is exactly the kind of order dependence that ships and then cannot
   * be reproduced.
   */
  found.sort(
    (a, b) =>
      a.age - b.age ||
      a.index - b.index ||
      a.ix - b.ix ||
      a.iy - b.iy ||
      a.iz - b.iz,
  )

  const craters: RayCrater[] = []
  for (const it of found.slice(0, MAX_RAY_CRATERS)) {
    const length = Math.sqrt(it.jx * it.jx + it.jy * it.jy + it.jz * it.jz)
    const axis = vec3(it.jx / length, it.jy / length, it.jz / length)
    const angularRadius = it.diameter / (2 * grammar.meanRadius)
    const [tangent, bitangent] = tangentFrame(axis)
    const phases = new Float64Array(RAY_HARMONIC_COUNT)
    for (let k = 0; k < RAY_HARMONIC_COUNT; k += 1) {
      const spin = pcg4d(it.ix, it.iy, it.iz ^ latticeSeed, 4_099 + k)
      phases[k] = toUnit(spin.x) * 2 * Math.PI
    }
    craters.push({
      axis,
      diameter: it.diameter,
      angularRadius,
      age: it.age,
      cosReach: Math.cos(Math.min(Math.PI, angularRadius * RAY_REACH)),
      tangent,
      bitangent,
      phases,
    })
  }
  return craters
}

/**
 * Two unit vectors spanning the plane perpendicular to `axis`.
 *
 * The choice of *which* pair is arbitrary and has to be deterministic, which is
 * the whole content of the branch: taking the cross product against a fixed
 * axis degenerates when `axis` is that axis, and a crater at the body's pole is
 * not a rare enough case to leave to chance.
 */
function tangentFrame(axis: Vec3): readonly [Vec3, Vec3] {
  const helper = Math.abs(axis.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)
  const tangent = Vec.normalize(Vec.cross(helper, axis))
  return [tangent, Vec.cross(axis, tangent)]
}

/**
 * How bright a ray system leaves the ground at a direction, 0 to 1.
 *
 * Two terms with different reach. The **continuous ejecta** is the bright halo
 * inside about 2.6 crater radii — the same deposit the height field raises as
 * an apron, seen as fresh rock over mature regolith. The **rays** are thin
 * filaments running out to sixteen radii, and they are what makes a young
 * crater read as young from a hundred thousand kilometers away.
 *
 * Both fade with the crater's own age. Nothing about brightness survives space
 * weathering: a lunar ray system is gone in about a billion years while the
 * bowl it came from is still there, which is why age drives this far harder
 * than it drives the profile in `craterProfile`.
 */
export function rayBrightness(
  craters: readonly RayCrater[],
  grammar: SurfaceGrammar,
  direction: Vec3,
): number {
  if (craters.length === 0) return 0
  /*
   * Air erases rays, and it erases them long before it erases the crater.
   * Mars keeps a trace of the brightest; Venus, at a hundred times Earth's
   * column, has none at all and never did.
   */
  const weather = 1 - grammar.air
  if (weather <= 0) return 0

  let total = 0
  for (const crater of craters) {
    const cosine =
      direction.x * crater.axis.x +
      direction.y * crater.axis.y +
      direction.z * crater.axis.z
    if (cosine <= crater.cosReach) continue
    const theta = Math.acos(Math.min(1, cosine))
    const t = theta / crater.angularRadius
    // Freshness, not age: 1 the instant it forms, 0 at the cutoff. Squared
    // because brightness decays faster than linearly with exposure.
    const fresh = (1 - crater.age / RAY_AGE) ** 2

    // The continuous deposit. Brightest just outside the rim, where the
    // blanket is thickest, and gone by the time the apron is.
    let value =
      RAY_SHAPE.halo *
      (1 - smoothstep(RIM_INNER, EJECTA_REACH, Math.max(t, RIM_INNER)))

    if (t > RAY_ONSET) {
      const px =
        direction.x * crater.tangent.x +
        direction.y * crater.tangent.y +
        direction.z * crater.tangent.z
      const py =
        direction.x * crater.bitangent.x +
        direction.y * crater.bitangent.y +
        direction.z * crater.bitangent.z
      const azimuth = Math.atan2(py, px)
      let wave = 0
      for (let k = 0; k < RAY_HARMONIC_COUNT; k += 1) {
        wave +=
          Math.cos(
            (RAY_HARMONICS[k] as number) * azimuth +
              (crater.phases[k] as number),
          ) / RAY_HARMONIC_COUNT
      }
      /*
       * The filaments, and the threshold is what makes them filaments.
       *
       * A sum of harmonics is a lumpy field between −1 and 1; cutting it high
       * leaves only the peaks, which are narrow wedges radiating from the
       * center. Raising the cut with distance is what makes a ray *taper* —
       * near the rim most azimuths are covered and far out only the strongest
       * few survive, which is what the photographs show and what a constant
       * threshold cannot produce.
       */
      const reach = t / RAY_REACH
      const cut = RAY_SHAPE.cutBase + RAY_SHAPE.cutSlope * reach
      const filament = smoothstep(
        cut,
        Math.min(1, cut + RAY_SHAPE.cutWidth),
        wave,
      )
      /*
       * Ejecta thins as it flies: r^-1.6 over the tangent plane, faded to
       * nothing at the reach so a ray ends rather than being truncated — and
       * faded *in* at the onset, which is the half that is easy to miss.
       *
       * `RAY_ONSET` is a cheap early-out, and a term that does not reach zero
       * at its own gate is a step there rather than an optimization. The
       * filament clears its threshold on about a third of azimuths at the
       * onset, so without this it appeared at full strength the instant `t`
       * crossed: 0.30 of brightness on Luna's ray craters and 0.57 on Mars's,
       * against a p99.9 adjacent-sample step of 3e-7 just outside. It draws as
       * a scalloped bright ring at 1.2 crater radii — a thirty-kilometer circle
       * around a fifty-kilometer crater — and it is the same class as the
       * ejecta blanket's own entry step, which `craterProfile` above records.
       */
      const radial =
        (smoothstep(RAY_ONSET, RAY_ONSET + RAY_SHAPE.onsetWidth, t) *
          (1 - smoothstep(RAY_SHAPE.fadeStart, 1, reach))) /
        t ** RAY_SHAPE.thinning
      value += RAY_SHAPE.filament * filament * radial
    }

    total += value * fresh
  }
  return Math.min(1, total * weather)
}
