import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { COVER_CHANNELS } from './cover.ts'
import { craterField, rayBrightness } from './craters.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import { terrainSketch } from './sketch.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import {
  generateHeightfield,
  HEIGHTFIELD_RESOLUTION,
  regionDirection,
  surfaceCoverAt,
} from './terrain.ts'
import { regionAddress } from './address.ts'

const ROOT = rootSeed('inertialref')

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
function* sphere(count: number): Generator<Vec3> {
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * i + 1) / count
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    yield vec3(Math.cos(around) * ring, z, Math.sin(around) * ring)
  }
}

describe('ray craters', () => {
  /*
   * The claim the whole construction rests on. Rays are placed from a separate
   * enumeration of the same lattice, so the one way this goes visibly wrong is
   * a ray system centered on flat ground — which is what happens the moment the
   * enumerator's hash convention drifts from the walk's.
   *
   * A crater is a hole, so the field at its center is well below the field a
   * radius away from it. Both are measured on the same body, so nothing here
   * depends on how deep the grammar decided craters should be.
   */
  it('sit on craters the height field actually digs', () => {
    for (const name of ['Luna', 'Mercury', 'Mars', 'Callisto']) {
      const body = find(name)
      const surface = body.surface
      const sketch = terrainSketch(surface)
      const grammar = surface.grammar
      expect(`${name}: ${sketch.rayCraters.length > 0}`).toBe(`${name}: true`)

      for (const crater of sketch.rayCraters) {
        /*
         * The crater's own rung of the ladder, and the rest silenced.
         *
         * Comparing the whole field against itself cannot hold the claim: a
         * saturated world has craters at every scale, so a fresh 60 km bowl can
         * sit on the inward slope of a 700 km basin and read *higher* than the
         * ground a crater radius away from it. Four of Luna's sixteen do.
         * Silencing every other rung leaves only same-sized craters at least a
         * cell apart, and the bowl under a ray system is then unambiguous.
         *
         * The rung follows from the diameter alone, because the bands are
         * disjoint: rung k places craters in `(largest/2^(k+1), largest/2^k]`.
         */
        const rung = Math.floor(
          Math.log2(grammar.largestCrater / crater.diameter),
        )
        const alone = {
          ...sketch,
          craterLevels: sketch.craterLevels.map((level, index) =>
            index === rung ? level : { ...level, density: 0 },
          ),
        }
        const centre = craterField(alone, grammar, crater.axis)
        // The median of a ring three radii out — past the ejecta blanket, and
        // a median so that one neighbour cannot decide the comparison.
        const ring: number[] = []
        for (let k = 0; k < 24; k += 1) {
          const azimuth = (k / 24) * 2 * Math.PI
          const span = crater.angularRadius * 3
          const offset = Vec.add(
            Vec.scale(crater.tangent, Math.cos(azimuth) * span),
            Vec.scale(crater.bitangent, Math.sin(azimuth) * span),
          )
          ring.push(
            craterField(
              alone,
              grammar,
              Vec.normalize(Vec.add(crater.axis, offset)),
            ),
          )
        }
        ring.sort((a, b) => a - b)
        const drop = (ring[12] as number) - centre
        const label = `${name} ${(crater.diameter / 1000).toFixed(0)}km`
        expect(`${label}: ${drop > 0.002 * crater.diameter}`).toBe(
          `${label}: true`,
        )
      }
    }
  })

  it('are the youngest craters on the body, in age order', () => {
    const sketch = terrainSketch(find('Luna').surface)
    const ages = sketch.rayCraters.map((crater) => crater.age)
    expect([...ages].sort((a, b) => a - b)).toEqual(ages)
    // The gate, restated as a test rather than trusted: an old crater has no
    // rays left, so one in this list would be a ray system with no brightness.
    expect(Math.max(...ages)).toBeLessThan(0.22)
  })

  /*
   * The azimuthal pattern is a sum of harmonics of the azimuth, and an azimuth
   * is an angle. A non-integer frequency in that sum puts a seam along the
   * crater's own prime meridian — one ray brighter on one side than the other,
   * on every ray crater on every body. The harmonics are integers for exactly
   * this reason and this is the test that says so.
   */
  it('close around the crater, with no seam at the azimuth wrap', () => {
    const body = find('Luna')
    const sketch = terrainSketch(body.surface)
    const grammar = body.surface.grammar
    const crater = sketch.rayCraters[0]
    if (crater === undefined) throw new Error('Luna has no ray craters')

    // Either side of azimuth zero, at a radius well inside the ray field.
    const at = (azimuth: number): number => {
      const reach = crater.angularRadius * 6
      const offset = Vec.add(
        Vec.scale(crater.tangent, Math.cos(azimuth) * reach),
        Vec.scale(crater.bitangent, Math.sin(azimuth) * reach),
      )
      return rayBrightness(
        sketch.rayCraters,
        grammar,
        Vec.normalize(Vec.add(crater.axis, offset)),
      )
    }
    const epsilon = 1e-5
    expect(Math.abs(at(epsilon) - at(2 * Math.PI - epsilon))).toBeLessThan(1e-6)
  })

  it('reach further than the ejecta blanket and stop', () => {
    const body = find('Luna')
    const sketch = terrainSketch(body.surface)
    const grammar = body.surface.grammar
    const crater = sketch.rayCraters[0]
    if (crater === undefined) throw new Error('Luna has no ray craters')

    // Brightest at the rim; still lit at eight radii, where the height field's
    // apron ended five radii ago; dark past the reach.
    // This crater alone: at twenty-four of its own radii the sample is a
    // quarter-radian away, which on a body with sixteen ray systems is
    // comfortably inside somebody else's.
    const at = (radii: number): number => {
      let peak = 0
      for (let k = 0; k < 64; k += 1) {
        const azimuth = (k / 64) * 2 * Math.PI
        const span = crater.angularRadius * radii
        const offset = Vec.add(
          Vec.scale(crater.tangent, Math.cos(azimuth) * span),
          Vec.scale(crater.bitangent, Math.sin(azimuth) * span),
        )
        peak = Math.max(
          peak,
          rayBrightness(
            [crater],
            grammar,
            Vec.normalize(Vec.add(crater.axis, offset)),
          ),
        )
      }
      return peak
    }
    expect(at(1)).toBeGreaterThan(0.3)
    expect(at(8)).toBeGreaterThan(0.02)
    expect(at(24)).toBeLessThan(1e-6)
  })
})

describe('the cover field', () => {
  it('is a pure function of the direction, on every body', () => {
    const body = find('Luna')
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (z, around) => {
          const ring = Math.sqrt(Math.max(0, 1 - z * z))
          const d = vec3(Math.cos(around) * ring, z, Math.sin(around) * ring)
          expect(surfaceCoverAt(body.surface, d)).toEqual(
            surfaceCoverAt(body.surface, d),
          )
        },
      ),
      { numRuns: 120 },
    )
  })

  it('stays inside the unit interval everywhere', () => {
    for (const name of [
      'Mercury',
      'Luna',
      'Mars',
      'Earth',
      'Europa',
      'Venus',
    ]) {
      const body = find(name)
      for (const d of sphere(400)) {
        const cover = surfaceCoverAt(body.surface, d)
        for (const [channel, value] of Object.entries(cover)) {
          expect(`${name} ${channel}: ${value >= 0 && value <= 1}`).toBe(
            `${name} ${channel}: true`,
          )
        }
      }
    }
  })

  /*
   * The mare are the point of the `dark` channel and Luna is the body it was
   * written from: a third of the near side and 2% of the far side, which is a
   * hemispheric asymmetry rather than a uniform sprinkling. What the test can
   * hold is that some ground floods and most does not, and that the flooded
   * ground is not spread evenly over the sphere.
   */
  it('floods some of Luna and not most of it, on one side more than the other', () => {
    const body = find('Luna')
    const samples = [...sphere(2000)].map((d) => ({
      d,
      dark: surfaceCoverAt(body.surface, d).dark,
    }))
    const flooded = samples.filter((s) => s.dark > 0.4)
    // Lunar mare is 16% of the whole surface. Between a twentieth and a third
    // is the band this has to land in to be maria rather than a grey planet.
    expect(flooded.length / samples.length).toBeGreaterThan(0.05)
    expect(flooded.length / samples.length).toBeLessThan(0.33)

    /*
     * The mean of the flooded directions, as a unit vector. Isotropic flooding
     * leaves this near zero and a perfect hemisphere gives 0.5, so anything
     * above that is ground confined to a cap — which is what the near side is.
     */
    let bias = vec3(0, 0, 0)
    for (const s of flooded) bias = Vec.add(bias, s.d)
    expect(Vec.length(bias) / flooded.length).toBeGreaterThan(0.4)
  })

  it('gives an airless world rays and a thick-aired one none', () => {
    const brightest = (name: string): number => {
      const body = find(name)
      let peak = 0
      for (const d of sphere(3000)) {
        peak = Math.max(peak, surfaceCoverAt(body.surface, d).bright)
      }
      return peak
    }
    expect(brightest('Luna')).toBeGreaterThan(0.5)
    expect(brightest('Venus')).toBeLessThan(0.02)
  })

  it('caps a cold world with air, covers an ice shell, and leaves the rest bare', () => {
    const capped = (name: string): { pole: number; equator: number } => {
      const body = find(name)
      return {
        pole: surfaceCoverAt(body.surface, vec3(0, 1, 0)).ice,
        equator: surfaceCoverAt(body.surface, vec3(1, 0, 0)).ice,
      }
    }
    // A cap needs cold *and* a supply. Mars and Earth have both and get one.
    expect(capped('Mars').pole).toBeGreaterThan(0.9)
    expect(capped('Mars').equator).toBeLessThan(0.05)
    expect(capped('Earth').pole).toBeGreaterThan(0.9)
    expect(capped('Earth').equator).toBeLessThan(0.05)
    // Callisto is made of the stuff, so it is ice at the equator at noon.
    expect(capped('Callisto').equator).toBeGreaterThan(0.7)
    /*
     * Mercury's poles are cold by the same arithmetic and they are bare, and
     * that is the supply term rather than a fudge: the planet has no volatile
     * inventory at the surface. What ice it holds is cometary and sits in
     * craters the sun has never reached, which is a shadowing model this field
     * does not have and does not claim to.
     */
    expect(capped('Mercury').pole).toBeLessThan(0.05)
    /*
     * And Venus is cold at the pole by the *equilibrium* temperature, which is
     * why the cover reads `groundTemperature` instead. 310 K of equilibrium
     * against 920 K of ground.
     */
    expect(capped('Venus').pole).toBeLessThan(0.05)
  })
})

describe('the heightfield carries its cover', () => {
  it('emits one sample per vertex, and no border', () => {
    const body = find('Luna')
    const field = generateHeightfield(body.surface, {
      region: regionAddress(2, 6, 19, 41),
      resolution: HEIGHTFIELD_RESOLUTION,
    })
    expect(field.cover.length).toBe(
      HEIGHTFIELD_RESOLUTION * HEIGHTFIELD_RESOLUTION * COVER_CHANNELS,
    )
  })

  /*
   * The patch and the field have to agree about the ground, and a patch is the
   * only place the two are computed by different code paths — the cover comes
   * out of the heightfield's own loop and `surfaceCoverAt` is the readable
   * form. They are the same evaluation and this is what keeps them so.
   */
  it('matches the direct sample at every vertex it carries', () => {
    const body = find('Mars')
    const region = regionAddress(0, 5, 11, 7)
    const field = generateHeightfield(body.surface, {
      region,
      resolution: HEIGHTFIELD_RESOLUTION,
    })
    const step = HEIGHTFIELD_RESOLUTION - 1
    for (const [row, col] of [
      [0, 0],
      [0, step],
      [step, 0],
      [step, step],
      [17, 41],
      [32, 32],
    ] as const) {
      const direct = surfaceCoverAt(
        body.surface,
        regionDirection(region, col / step, row / step),
      )
      const at = (row * HEIGHTFIELD_RESOLUTION + col) * COVER_CHANNELS
      expect([
        field.cover[at],
        field.cover[at + 1],
        field.cover[at + 2],
        field.cover[at + 3],
      ]).toEqual([
        Math.round(direct.bright * 255),
        Math.round(direct.dark * 255),
        Math.round(direct.mineral * 255),
        Math.round(direct.ice * 255),
      ])
    }
  })
})
