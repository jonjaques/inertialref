import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { rootSeed, type Seed } from '@inertialref/procedural'
import { Vec, vec3 } from '@inertialref/spatial'
import { regionAddress } from './address.ts'
import {
  ARC_MARGIN,
  BELT_MARGIN,
  HYPSOMETRY_MARGIN,
  hypsometryBand,
  plateContext,
} from './bands.ts'
import {
  craterCountAbove,
  craterField,
  craterFieldWithin,
  softLimit,
} from './craters.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import {
  craterDepth,
  CRUST_STRENGTH,
  type GrammarFacts,
  MAX_RELIEF,
  reliefLimit,
  surfaceGrammar,
  surfaceTemperature,
} from './grammar.ts'
import { craterLadder, PLATE_MARGIN, plateAt, terrainSketch } from './sketch.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import { elevationAt, regionDirection } from './terrain.ts'

const ROOT = rootSeed('inertialref')

// Through `generateSystem`, which dispatches Sol to the measured table — the
// same route every other test and the game itself take.
const SOL = generateSystem(
  ROOT,
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
)

const find = (name: string): Body => {
  for (const body of walkBodies(SOL)) if (body.name === name) return body
  throw new Error(`no ${name} in Sol`)
}

/** A spread of directions, golden-angle so nothing clusters at a pole. */
function* sphere(count: number): Generator<ReturnType<typeof vec3>> {
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * i + 1) / count
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    yield vec3(Math.cos(around) * ring, z, Math.sin(around) * ring)
  }
}

describe('the surface grammar', () => {
  /*
   * `surfaceTemperature`'s docstring says it is *fitted* to three bodies where
   * both the equilibrium and the ground temperature are published. Nothing
   * asserted that, and the gain drifted far enough to put Venus at 913 K —
   * twenty-four percent above the 737 the sentence claims — without a single
   * test noticing, because every consumer only asks whether the ground is above
   * a frost point or below a boiling one.
   *
   * The tolerances are the fit's own error against the measurements, not a
   * margin: Mars is claimed at 210 and lands at 213, Earth 288 and 286, Venus
   * 737 and 739.
   */
  it('lands its fitted anchors where the docstring says it does', () => {
    const rows = [
      ['Mars', 213, 220, 210, 4],
      ['Earth', 263, 10_200, 288, 3],
      ['Venus', 310, 1.0e6, 737, 5],
    ] as const
    for (const [name, equilibrium, airMass, published, tolerance] of rows) {
      const fitted = surfaceTemperature(equilibrium, airMass)
      expect(`${name}: ${Math.abs(fitted - published) < tolerance}`).toBe(
        `${name}: true`,
      )
    }
    // And no air is no greenhouse, exactly, rather than nearly.
    expect(surfaceTemperature(263, 0)).toBe(263)
  })

  /*
   * The anchors § 6 of the plan names, checked against the bodies they were
   * written from. Not exact figures — the grammar is a model and these are
   * measurements — but the *ordering* is the whole claim it makes, and an
   * ordering is something a test can hold.
   */
  it('reads the four archetypes off the bodies they were named for', () => {
    const rows = [
      ['Mercury', 'rocky-airless'],
      ['Earth', 'rocky-atmosphered'],
      ['Callisto', 'icy-dead'],
      ['Enceladus', 'icy-active'],
    ] as const
    for (const [name, archetype] of rows) {
      expect(`${name}: ${find(name).surface.grammar.archetype}`).toBe(
        `${name}: ${archetype}`,
      )
    }
  })

  it('erases craters in proportion to how much air there is', () => {
    // Mercury and Luna are saturated; Mars keeps most of its craters; Earth has
    // a handful; Venus and Titan have effectively none. That is the published
    // order and it comes out of one expression on the atmospheric column mass.
    const density = (name: string): number =>
      find(name).surface.grammar.craterDensity
    expect(density('Mercury')).toBeGreaterThan(0.9)
    expect(density('Luna')).toBeGreaterThan(0.8)
    expect(density('Mars')).toBeGreaterThan(0.3)
    expect(density('Mars')).toBeLessThan(density('Luna'))
    expect(density('Earth')).toBeLessThan(density('Mars'))
    expect(density('Venus')).toBeLessThan(0.05)
    expect(density('Titan')).toBeLessThan(0.1)
  })

  it('puts the simple-to-complex transition where gravity says', () => {
    /*
     * The transition scales as 1/g, and the product is the constant: ~18 km on
     * the Moon at 1.62 m/s² and ~3 km on Earth at 9.81 both give about 29,000.
     * Ice transitions at roughly an eighth of the diameter rock does, which is
     * why Ganymede's is 2 km rather than 20.
     */
    for (const name of ['Mercury', 'Luna', 'Earth', 'Mars']) {
      const grammar = find(name).surface.grammar
      const product = grammar.complexDiameter * grammar.gravity
      expect(`${name}: ${Math.round(product / 1000)}`).toBe(`${name}: 29`)
    }
    const callisto = find('Callisto').surface.grammar
    expect(callisto.complexDiameter * callisto.gravity).toBeLessThan(15_000)
  })

  it('gives a wet world plates and a dry one a stagnant lid', () => {
    /*
     * Earth and Venus are the same size and the same age, and one has plate
     * tectonics. Water is the leading explanation — a wet lithosphere is weak
     * enough to subduct — and that is the only input that separates them here.
     */
    expect(find('Earth').surface.grammar.plateCount).toBeGreaterThan(8)
    expect(find('Venus').surface.grammar.plateCount).toBe(1)
    expect(find('Mars').surface.grammar.plateCount).toBe(1)
    expect(find('Luna').surface.grammar.plateCount).toBe(1)
  })

  it('relaxes old ice, and only where it is warm enough to flow', () => {
    // Callisto at 134 K is smooth at large scales because its big craters have
    // sagged; Pluto at 40 K stands three-kilometer water-ice mountains with no
    // sign of flow at all.
    expect(find('Callisto').surface.grammar.relaxation).toBeGreaterThan(0.2)
    expect(find('Pluto').surface.grammar.relaxation).toBe(0)
    expect(find('Luna').surface.grammar.relaxation).toBe(0)
  })

  it('limits relief by strength, by size, and by the largest ever measured', () => {
    // Mars: the calibration. 3.2e8 Pa over ρg of 14,600 is 21.9 km, which is
    // Olympus Mons.
    expect(reliefLimit(3_933, 3.71, 3.39e6) / 1000).toBeCloseTo(21.9, 0)
    // Earth: strength binds, and it understates Everest because a static limit
    // describes what a crust holds rather than what a collision is still doing.
    expect(reliefLimit(5_514, 9.81, 6.371e6) / 1000).toBeCloseTo(5.9, 0)
    // A 50 km moon: the strength limit alone would allow five thousand
    // kilometers, so the size bound is the one that means anything.
    expect(reliefLimit(2_000, 0.028, 49_000)).toBeCloseTo(49_000 * 0.09, 6)
    // Luna: neither of those binds and the absolute ceiling does.
    expect(reliefLimit(3_344, 1.62, 1.737e6)).toBe(MAX_RELIEF)
    // And the formula is the formula.
    expect(reliefLimit(3_933, 3.71, 1e12)).toBeCloseTo(
      CRUST_STRENGTH / (3_933 * 3.71),
      6,
    )
  })

  it('divides the whole budget and no more', () => {
    for (const body of walkBodies(SOL)) {
      const bands = body.surface.grammar.bands
      const total =
        bands.hypsometry +
        bands.belts +
        bands.volcanism +
        bands.craters +
        bands.ice +
        bands.relief
      expect(`${body.name}: ${total.toFixed(9)}`).toBe(
        `${body.name}: 1.000000000`,
      )
    }
  })

  it('is a pure function of the seed and the facts', () => {
    const facts: GrammarFacts = {
      mass: 7.35e22,
      meanRadius: 1.737e6,
      atmosphere: null,
      temperature: 270,
      tidalProxy: 0,
      hasOcean: false,
      reliefSpent: 0.8,
      publishedRelief: null,
    }
    const seed: Seed = ROOT
    expect(surfaceGrammar(seed, facts)).toEqual(surfaceGrammar(seed, facts))
    // And every fact moves it, which is what stops one of them being dead.
    expect(surfaceGrammar(seed, { ...facts, hasOcean: true })).not.toEqual(
      surfaceGrammar(seed, facts),
    )
    expect(surfaceGrammar(seed, { ...facts, temperature: 90 })).not.toEqual(
      surfaceGrammar(seed, facts),
    )
  })
})

describe('the crater field', () => {
  it('follows a cumulative size–frequency slope near −2', () => {
    /*
     * The lunar highlands at saturation, and the ladder gets it for free: each
     * level halves the diameter and quadruples the cells, which is `N(>D) ∝
     * D^-2` by construction. Measured over the ladder rather than asserted, so
     * a change to how a level is built shows up here.
     *
     * The fit is over the saturated levels only. `density` climbs toward 1 at
     * the fine end on an unsaturated surface — that is the production slope
     * being steeper than the saturation slope — and Luna is saturated enough
     * for the first few levels to be clean.
     */
    const grammar = find('Luna').surface.grammar
    const ladder = craterLadder(grammar)
    expect(ladder.length).toBeGreaterThan(6)
    const at = (index: number): { x: number; y: number } => {
      const level = ladder[index] as (typeof ladder)[number]
      return {
        x: Math.log(level.diameter),
        y: Math.log(craterCountAbove(ladder, level.diameter)),
      }
    }
    const a = at(0)
    const b = at(4)
    const slope = (b.y - a.y) / (b.x - a.x)
    // −2 within a tenth. It is not exactly −2 because the count is a sum over
    // levels rather than an integral, and the coarsest level contributes a
    // constant the fit cannot see past.
    expect(slope).toBeGreaterThan(-2.2)
    expect(slope).toBeLessThan(-1.8)
  })

  it('digs a floor, raises a rim, and throws an apron', () => {
    /*
     * The published profile, as a shape rather than as numbers: somewhere
     * inside a crater the ground is below the datum, the rim is above it, and
     * the rim is lower than the floor is deep. Searched rather than asserted at
     * a point, because where the craters are is the hash's business.
     */
    const body = find('Luna')
    const sketch = terrainSketch(body.surface)
    let deepest = 0
    let highest = 0
    for (const direction of sphere(20_000)) {
      const value = craterField(sketch, body.surface.grammar, direction)
      if (value < deepest) deepest = value
      if (value > highest) highest = value
    }
    expect(deepest).toBeLessThan(-1_000)
    expect(highest).toBeGreaterThan(100)
    // Rims are a fifth of the cavity depth, so the field is asymmetric and the
    // sign of that asymmetry is the whole reason craters read as craters.
    expect(highest).toBeLessThan(-deepest)
  })

  it('walks far enough out to find every crater that reaches it', () => {
    /*
     * The containment claim, held by running the walk the claim is about
     * against a wider one and finding nothing in the difference.
     *
     * A crater the walk does not visit is not a small error, it is a *step*:
     * the crater appears the moment the sample crosses into a cell the walk can
     * see, at whatever height its apron has there. The ±1 neighborhood this
     * replaced could not contain the ejecta reach — 1.3 cells, because a
     * level's largest crater has an angular radius of half a cell — and lost up
     * to 158 m of ejecta on about 30% of directions.
     *
     * Reach is only half of how wide the walk has to be. The other half is that
     * the lattice is cubes in ℝ³ while the field is a shell cutting through
     * them, so a crater's center sits off the sphere by up to the cell's own
     * width along the radius, and is indexed there while its profile is
     * measured from its projection. Walking `reach` alone still lost 34 m on
     * Luna, which is what makes this a test rather than an argument.
     *
     * Two cells wider is the reference because the bound it is checking against
     * peaks at 2.2, so a walk two cells past it cannot be short. Twelve
     * thousand directions on two bodies is enough to find it: dropping the
     * radial half of the bound fails this by 506 m on Luna.
     */
    for (const name of ['Luna', 'Iapetus']) {
      const body = find(name)
      const sketch = terrainSketch(body.surface)
      const grammar = body.surface.grammar
      let worst = 0
      for (const direction of sphere(12_000)) {
        const gap = Math.abs(
          craterField(sketch, grammar, direction) -
            craterFieldWithin(sketch, grammar, direction, 2),
        )
        if (gap > worst) worst = gap
      }
      // Not "small": equal. Both walks evaluate the same craters in the same
      // order, so anything but zero is a crater one of them did not see.
      expect(`${name}: ${worst}`).toBe(`${name}: 0`)
    }
  })

  it('crosses a cube-face corner without a step in it', () => {
    /*
     * The bug the 3D lattice exists to make impossible, stated as continuity.
     *
     * A crater field laid out on the cube-sphere's own (face, i, j) grid has to
     * agree with itself across a face edge, and at the eight points where three
     * faces meet a cell has *seven* neighbors rather than eight — so a ring walk
     * counts one of them twice and that crater comes out at double depth, on
     * every world, at eight places. A lattice of cubes in ℝ³ has no seams and no
     * corners, and the way that shows from outside is that nothing happens when
     * a walk crosses one.
     *
     * Measured against the same walk through the middle of a face rather than
     * against a constant, because "how big a step is too big" is a property of
     * how rough this particular world is. A doubled crater is a step of order
     * its own depth — kilometers — between neighbors a few meters apart.
     */
    const body = find('Luna')
    const walk = (
      from: ReturnType<typeof vec3>,
      to: ReturnType<typeof vec3>,
    ): number => {
      let worst = 0
      let previous = elevationAt(body.surface, from)
      for (let i = 1; i <= 600; i += 1) {
        const here = elevationAt(
          body.surface,
          Vec.normalize(Vec.lerp(from, to, i / 600)),
        )
        worst = Math.max(worst, Math.abs(here - previous))
        previous = here
      }
      return worst
    }
    // Through the corner where three faces meet — `(1, 1, 1)` normalized, which
    // is `regionDirection(face 0, 1, 1)`.
    const corner = Vec.normalize(
      regionDirection(regionAddress(0, 0, 0, 0), 1, 1),
    )
    const heading = Vec.normalize(vec3(1, 0.2, -0.3))
    const acrossCorner = walk(
      Vec.normalize(Vec.lerp(corner, heading, -0.04)),
      Vec.normalize(Vec.lerp(corner, heading, 0.04)),
    )
    // The same arc length in the middle of a face, where nothing is stitched.
    const interior = Vec.normalize(vec3(1, 0.1, 0.15))
    const elsewhere = Vec.normalize(vec3(1, 0.18, 0.23))
    const inFace = walk(
      Vec.normalize(Vec.lerp(interior, elsewhere, -0.5)),
      Vec.normalize(Vec.lerp(interior, elsewhere, 0.5)),
    )
    expect(inFace).toBeGreaterThan(0)
    expect(acrossCorner).toBeLessThan(inFace * 3)
  })

  it('has no step in it, anywhere a crater rim falls', () => {
    /*
     * `elevationAt` is C0, and this is the assertion that says so.
     *
     * The ejecta blanket entered at its full `r⁻³` value on the first sample
     * past one crater radius, which is a vertical wall of 7–17% of every
     * crater's depth at exactly the radius the rim crest sits on: 590 m on
     * Iapetus, 432 m on a rocky airless world, across 1.7e-10 m of ground.
     * `craters.ts` fades it in over the rim now.
     *
     * **The measurement is continuity itself, not a proxy for it.** A large
     * adjacent-sample jump is not a defect — a crater rim is genuinely steep,
     * and a scan fine enough to resolve one will report meters between
     * neighbors. What separates steep from discontinuous is what happens when
     * the two samples are brought together: on a continuous field the gap
     * closes with the separation, and across a step it does not. So this finds
     * the worst jump on a great circle, bisects it sixty times — down to a
     * separation of ~1e-16 of the arc, sub-nanometer on every body here — and
     * asserts the gap has gone with it.
     *
     * A meter is four hundred times the largest survivor measured (2.4 mm, on
     * Miranda) and six hundred times smaller than the defect, so the bound is
     * nowhere near either edge. Reintroducing the step fails it by three orders
     * of magnitude on four of the five bodies.
     */
    const walk = (
      body: Body,
      from: ReturnType<typeof vec3>,
      to: ReturnType<typeof vec3>,
      samples: number,
    ): number => {
      const at = (t: number): ReturnType<typeof vec3> =>
        Vec.normalize(Vec.lerp(from, to, t))
      /*
       * The four largest jumps on the arc, not the largest.
       *
       * A step is not usually the biggest thing on a walk — a crater rim is
       * genuinely steeper than a kilometer of plate seam spread over a
       * five-thousandth of an arc — so bisecting onto the single largest jump
       * examines a rim, finds it continuous, and reports that the arc is clean.
       * Four candidates is what it takes to see past the rims, and each costs
       * sixty samples against the four thousand the scan already spent.
       */
      const candidates: { at: number; jump: number }[] = []
      let previous = elevationAt(body.surface, at(0))
      for (let i = 1; i <= samples; i += 1) {
        const here = elevationAt(body.surface, at(i / samples))
        const jump = Math.abs(here - previous)
        previous = here
        if (candidates.length === 4 && jump <= (candidates[3]?.jump ?? 0))
          continue
        candidates.push({ at: i / samples, jump })
        candidates.sort((a, b) => b.jump - a.jump)
        candidates.length = Math.min(4, candidates.length)
      }

      let survivor = 0
      for (const candidate of candidates) {
        // Bisect onto the jump, keeping `lo` on the side the walk started from.
        let lo = candidate.at - 1 / samples
        let hi = candidate.at
        const atLo = elevationAt(body.surface, at(lo))
        for (let i = 0; i < 60; i += 1) {
          const mid = (lo + hi) / 2
          if (mid === lo || mid === hi) break
          if (
            Math.abs(elevationAt(body.surface, at(mid)) - atLo) <
            candidate.jump / 2
          )
            lo = mid
          else hi = mid
        }
        const gap = Math.abs(
          elevationAt(body.surface, at(hi)) - elevationAt(body.surface, at(lo)),
        )
        if (gap > survivor) survivor = gap
      }
      return survivor
    }

    const step = (body: Body): number =>
      walk(
        body,
        Vec.normalize(vec3(0.3, 0.7, 0.64)),
        Vec.normalize(vec3(0.9, -0.2, 0.31)),
        20_000,
      )

    /*
     * The same walk over a spread of great circles, for the worlds with plates.
     *
     * One arc is enough to find a crater seam, because craters are everywhere.
     * It is not enough to find a plate seam: the interior seams run along the
     * curves where the second and third nearest plates are equidistant, and
     * there are only a few dozen of them on a world. Earth's single arc above
     * reported 5.0e-5 m while a sweep of twenty-four circles found **3,081 m**
     * on the same body and the same day — the arc simply missed. So a plated
     * world is swept, and that is what makes this test able to fail for the
     * defect it was written for.
     */
    const sweep = (body: Body, arcs: number): number => {
      let worst = 0
      for (let a = 0; a < arcs; a += 1) {
        const z = 1 - (2 * a + 1) / arcs
        const around = a * Math.PI * (3 - Math.sqrt(5))
        const ring = Math.sqrt(Math.max(0, 1 - z * z))
        const gap = walk(
          body,
          Vec.normalize(
            vec3(Math.cos(around) * ring, z, Math.sin(around) * ring),
          ),
          Vec.normalize(
            vec3(-Math.sin(around) * ring, -z, Math.cos(around) * ring),
          ),
          4_000,
        )
        if (gap > worst) worst = gap
      }
      return worst
    }

    /*
     * Five stagnant lids and two worlds with plates, and the second group is
     * the one that has to be here.
     *
     * A body with `plateCount === 1` never enters the branches that read
     * `sample.plate.*`, so a list of Luna, Mercury, Mars, Callisto and Miranda
     * exercises the crater ladder and nothing else — it cannot fail for
     * anything the tectonic bands do, however large. Earth carries 22 plates
     * and Proxima Centauri II 20, which is why they are named individually
     * rather than left to whichever bodies a zoo sweep happens to pick.
     *
     * Proxima Centauri II is the worst case in `TEST_CATALOG` and it is worth a
     * generated system for: a plate boundary stepped 9,433.9 m there, 46% of
     * everything that world has, against 891.2 m on Earth. Both are closed; the
     * seam that survives on it is pinned below rather than asserted away.
     */
    const plated = generateSystem(
      ROOT,
      MILKY_WAY,
      catalogStub(
        TEST_CATALOG.stars.find(
          (star) => star.name === 'Proxima Centauri',
        ) as (typeof TEST_CATALOG.stars)[number],
      ),
    )
    const proxima = [...walkBodies(plated)].find(
      (body) => body.name === 'Proxima Centauri II',
    )
    expect(proxima?.surface.grammar.plateCount).toBeGreaterThan(1)
    expect(find('Earth').surface.grammar.plateCount).toBeGreaterThan(1)

    const subjects: readonly Body[] = [
      ...['Luna', 'Mercury', 'Mars', 'Callisto', 'Miranda'].map(find),
      find('Earth'),
    ]
    for (const body of subjects) {
      if (body.surface.maxElevation <= 0) continue
      expect(`${body.name}: ${step(body) < 1}`).toBe(`${body.name}: true`)
    }

    /*
     * Proxima Centauri II is held to the same meter as everything else, and it
     * is the body that had to earn it.
     *
     * The seam here was never a plate boundary. `plateAt` used to return the
     * second-nearest plate, and which plate that *is* changes discontinuously
     * along the locus where the second and third nearest are equidistant — a
     * network of curves through every plate's interior, nowhere near an edge.
     * Measured either side of one: the same nearest plate, base 0.432, with the
     * second jumping from base 0.224 to −0.894 at a `boundary` of 5.72e-2, for
     * 1,532.3 m of step out of a 20,434 m budget. Anything reading that second
     * plate inherited the jump, which is why fixing the boundary blend left the
     * interior alone.
     *
     * `plateProperty` weights every plate within `PLATE_MARGIN` instead, so no
     * rank identity enters and there is nothing left to change discontinuously.
     * It reads 7.5e-6 m now, and Earth — whose own seam this walk's single arc
     * happened to miss, while a sweep of twenty-four great circles found
     * 3,081 m of it — reads 1.2e-4.
     */
    for (const body of [find('Earth'), proxima as Body]) {
      expect(`${body.name}: ${sweep(body, 16) < 1}`).toBe(`${body.name}: true`)
    }
  })

  it('folds an overlapping stack through a soft ceiling', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 1e5, noNaN: true }),
        (value, limit) => {
          const folded = softLimit(value, limit)
          expect(Math.abs(folded)).toBeLessThanOrEqual(limit)
          expect(Math.sign(folded)).toBe(Math.sign(Math.tanh(value / limit)))
          // Identity to within a few percent well below the ceiling, which is
          // where every ordinary crater sits — the fold is for the stack, not
          // for the individual.
          if (Math.abs(value) < 0.1 * limit) {
            expect(Math.abs(folded - value)).toBeLessThan(0.005 * limit)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('deepens with diameter and saturates past the transition', () => {
    const transition = 18_000
    // A simple crater is a bowl: a fifth as deep as it is wide.
    expect(craterDepth(1_000, transition)).toBeCloseTo(200, 6)
    expect(craterDepth(transition, transition)).toBeCloseTo(3_600, 6)
    // Past it the floor collapses and depth grows as D^0.3, which is why South
    // Pole–Aitken is 2,500 km across and eight kilometers deep rather than five
    // hundred.
    expect(craterDepth(2_500_000, transition) / 1000).toBeLessThan(20)
    expect(craterDepth(2_500_000, transition)).toBeGreaterThan(
      craterDepth(250_000, transition),
    )
  })
})

describe('the band stack', () => {
  it('stays inside the relief the strength limit allows', () => {
    /*
     * The shares sum to one and each band is bounded by its share, so the whole
     * stack is bounded by `maxElevation`. The craters are the one band in
     * meters, and `softLimit` is what keeps them inside theirs.
     *
     * Measured over the sphere rather than argued, because the argument has a
     * hole in it the moment a band forgets to clamp.
     */
    for (const name of ['Mercury', 'Earth', 'Luna', 'Mars', 'Iapetus']) {
      const body = find(name)
      let extreme = 0
      for (const direction of sphere(3_000)) {
        extreme = Math.max(
          extreme,
          Math.abs(elevationAt(body.surface, direction)),
        )
      }
      expect(`${name}: ${extreme <= body.surface.maxElevation}`).toBe(
        `${name}: true`,
      )
      // And it uses the budget rather than sitting at a tenth of it, which is
      // the failure that reads as a flat world with a large number on it.
      expect(`${name}: ${extreme > body.surface.maxElevation * 0.2}`).toBe(
        `${name}: true`,
      )
    }
  })

  it('gives a plate world a bimodal elevation histogram', () => {
    /*
     * Earth's is the signature: means near +0.8 km and −3.7 km with very little
     * ground between them, because continental and oceanic crust are different
     * materials at different heights rather than one surface with a sea on it.
     * Mercury, Luna, Mars and Venus have one plate each and come out unimodal,
     * and that difference is the whole point of the hypsometry band.
     *
     * Sarle's bimodality coefficient, `(skew² + 1) / kurtosis`, which sits above
     * 5/9 for a distribution with two modes and below it for a normal one.
     * Earth reads 0.583 against 0.36–0.40 for the four stagnant lids.
     *
     * Earth's figure is the one that moves when the blend does, and the margin
     * over 5/9 is thin on purpose rather than by luck: reading a plate property
     * as a partition of unity means a sample near a triple junction averages
     * three plates rather than two, which fills in the middle of the histogram.
     * `plateWeight` is shaped so that the two-plate case is unchanged — with
     * the plain complement instead, this reads 0.553 and fails.
     *
     * The obvious cheaper statistic — the share of samples in the middle third
     * of the range — reads *Mercury* as the more bimodal of the two, because
     * two deep basins stretch its range and pile everything else into the top
     * third. That measures outliers rather than modality, and it is why this
     * one is worth four moments.
     */
    const coefficient = (name: string): number => {
      const body = find(name)
      const sketch = terrainSketch(body.surface)
      const peak =
        body.surface.grammar.bands.hypsometry * body.surface.maxElevation
      const values = [...sphere(6_000)].map((d) =>
        hypsometryBand(
          sketch,
          body.surface.grammar,
          plateContext(sketch, d),
          d,
          peak,
        ),
      )
      const n = values.length
      const mean = values.reduce((sum, v) => sum + v, 0) / n
      const moment = (power: number): number =>
        values.reduce((sum, v) => sum + (v - mean) ** power, 0) / n
      const variance = moment(2)
      const skew = moment(3) / variance ** 1.5
      return (skew * skew + 1) / (moment(4) / (variance * variance))
    }
    expect(coefficient('Earth')).toBeGreaterThan(5 / 9)
    for (const lid of ['Mercury', 'Luna', 'Mars', 'Venus']) {
      expect(`${lid}: ${coefficient(lid) < 5 / 9}`).toBe(`${lid}: true`)
    }
  })

  it('finds a plate, a distance to its boundary, and everyone nearby', () => {
    const sketch = terrainSketch(find('Earth').surface)
    expect(sketch.plates.length).toBeGreaterThan(8)
    let onBoundary = 0
    let crowded = 0
    for (const direction of sphere(2_000)) {
      const sample = plateAt(sketch, direction)
      if (sample === null) throw new Error('a plate world has plates')
      // `F2 − F1` is a distance and cannot be negative; it is zero exactly on a
      // boundary, which is what makes it the field a belt is drawn along.
      expect(sample.boundary).toBeGreaterThanOrEqual(0)
      if (sample.boundary < 0.02) onBoundary += 1
      /*
       * The neighborhood, and the two things every reader of it assumes: the
       * nearest plate is in it at zero excess — which is what makes the weights
       * sum to something positive everywhere — and nothing in it is farther out
       * than the search looked, which is what makes a plate's weight zero
       * before it can leave.
       */
      expect(sample.nearby).toContain(sample.plate)
      expect(sample.excess).toHaveLength(sample.nearby.length)
      expect(Math.min(...sample.excess)).toBe(0)
      expect(Math.max(...sample.excess)).toBeLessThanOrEqual(PLATE_MARGIN)
      if (sample.nearby.length > 2) crowded += 1
    }
    // Some samples land near a boundary, or the belt band never fires.
    expect(onBoundary).toBeGreaterThan(0)
    // And some land where three plates have a say, which is the ground the
    // rank-based version had a seam through.
    expect(crowded).toBeGreaterThan(0)
  })

  it('keeps every band margin inside the one the search looked over', () => {
    /*
     * A band blending over a wider margin than `plateAt` collected would divide
     * by a sum it had already truncated, and a plate would fall out of the set
     * while it still had weight — which is the seam, put back by arithmetic.
     */
    for (const margin of [HYPSOMETRY_MARGIN, BELT_MARGIN, ARC_MARGIN]) {
      expect(margin).toBeLessThanOrEqual(PLATE_MARGIN)
    }
  })

  it('derives the same sketch whatever order it is asked in', () => {
    /*
     * The rule that generation may never depend on order, at the two places
     * this phase adds state: the sketch cache and the `WeakMap` in front of it.
     * Two bodies, interleaved, and the answers have to be the ones each would
     * get alone.
     *
     * **The copy is the half that reaches the string cache.** `terrainSketch`
     * answers a repeat of the same object from the `WeakMap` and returns before
     * the key is built, so asserting only on `luna.surface` tests an identity
     * lookup and nothing else — an eviction policy that dropped a live entry
     * would pass it. A structural copy has a different identity and the same
     * key, so it is the assertion the FIFO cap and the key itself are visible
     * through.
     */
    const luna = find('Luna')
    const earth = find('Earth')
    const first = terrainSketch(luna.surface)
    terrainSketch(earth.surface)
    expect(terrainSketch(luna.surface)).toBe(first)
    expect(terrainSketch({ ...luna.surface })).toBe(first)
    const direction = vec3(0.3, 0.5, 0.8)
    const a = elevationAt(luna.surface, direction)
    elevationAt(earth.surface, direction)
    expect(elevationAt(luna.surface, direction)).toBe(a)
  })

  it('is a pure function of the direction, at any magnitude', () => {
    /*
     * `elevationAt` normalizes, so a caller that hands it an unnormalized
     * direction gets the ground under that direction rather than a scaled
     * version of it — which is what `regionDirection` relies on when it steps
     * past a face edge.
     *
     * Three decimal places, on a field whose values are kilometers: half a
     * millimeter. `normalize` of `6·d` and of `d` differ in the last bits of a
     * double, and the crater band reads that difference through
     * `2 − 2 cos θ` at the ladder's finest level, where the cancellation costs
     * seven significant figures. What is being asserted is that the two answers
     * are the same *place*, not that two different float paths agree to the
     * last bit.
     */
    const body = find('Mars')
    fc.assert(
      fc.property(
        fc.double({ min: 0.2, max: 5, noNaN: true }),
        fc.integer({ min: 0, max: 999 }),
        (scale, index) => {
          const direction = [...sphere(1_000)][index] as ReturnType<typeof vec3>
          expect(
            elevationAt(body.surface, Vec.scale(direction, scale)),
          ).toBeCloseTo(elevationAt(body.surface, direction), 3)
        },
      ),
      { numRuns: 60 },
    )
  })
})
