import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { vec3 } from '@inertialref/spatial'
import {
  bodyAddress,
  type RegionAddress,
  formatAddress,
  objectOf,
  parseAddress,
  regionOf,
  systemId,
} from './address.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import {
  regionScatter,
  type ScatterRock,
  SCATTER_REGION,
  SCATTER_SLOTS,
  scatterLevel,
} from './scatter.ts'
import { SKETCH_CACHE_LIMIT, terrainSketch } from './sketch.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import {
  drawnElevation,
  regionForDirection,
  regionSize,
  seaDatumElevation,
} from './terrain.ts'

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

/** A handful of regions spread over a body, at its own scatter level. */
function* regions(body: Body, count = 12) {
  const level = scatterLevel(body.radius)
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * i + 1) / count
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    yield regionForDirection(
      vec3(Math.cos(around) * ring, z, Math.sin(around) * ring),
      level,
    )
  }
}

const LUNA = find('Luna')
const MARS = find('Mars')
const IAPETUS = find('Iapetus')

describe('where the rocks are addressed', () => {
  it('picks a level whose regions are about the size it asks for', () => {
    for (const body of [LUNA, MARS, IAPETUS, find('Mercury')]) {
      const size = regionSize(body.radius, scatterLevel(body.radius))
      // `levelForSize` rounds to a level, so the real figure straddles the
      // target by up to √2 either way. Anything outside that is the conversion
      // going through the wrong radius.
      expect(size).toBeGreaterThan(SCATTER_REGION / 1.5)
      expect(size).toBeLessThan(SCATTER_REGION * 1.5)
    }
  })

  it('gives every rock an address that round-trips', () => {
    const body = bodyAddress(MILKY_WAY, systemId('SOL'), [2, 0])
    for (const region of regions(LUNA, 3)) {
      for (const rock of regionScatter(LUNA.surface, region)) {
        const address = objectOf(regionOf(body, region), rock.index)
        const back = parseAddress(formatAddress(address))
        expect(back.kind).toBe('object')
        if (back.kind !== 'object') continue
        expect(back.index).toBe(rock.index)
        expect(back.region).toEqual(region)
      }
    }
  })

  it('keeps every rock inside the region that names it', () => {
    for (const region of regions(LUNA)) {
      for (const rock of regionScatter(LUNA.surface, region)) {
        expect(regionForDirection(rock.direction, region.level)).toEqual(region)
      }
    }
  })

  it('never issues a slot twice and never issues one out of range', () => {
    for (const region of regions(LUNA)) {
      const rocks = regionScatter(LUNA.surface, region)
      const seen = new Set(rocks.map((rock) => rock.index))
      expect(seen.size).toBe(rocks.length)
      for (const rock of rocks) {
        expect(rock.index).toBeGreaterThanOrEqual(0)
        expect(rock.index).toBeLessThan(SCATTER_SLOTS)
      }
    }
  })
})

describe('what a rock is', () => {
  it('stands on the ground the mesh draws', () => {
    for (const region of regions(LUNA, 6)) {
      for (const rock of regionScatter(LUNA.surface, region)) {
        expect(rock.elevation).toBe(
          drawnElevation(LUNA.surface, rock.direction),
        )
      }
    }
  })

  it('keeps every field inside the range the renderer assumes', () => {
    for (const body of [LUNA, MARS, IAPETUS]) {
      for (const region of regions(body, 6)) {
        for (const rock of regionScatter(body.surface, region)) {
          expect(rock.radius).toBeGreaterThan(0)
          expect(rock.radius).toBeLessThanOrEqual(4)
          expect(rock.sink).toBeGreaterThanOrEqual(0)
          expect(rock.sink).toBeLessThanOrEqual(1)
          expect(rock.angularity).toBeGreaterThanOrEqual(0)
          expect(rock.angularity).toBeLessThanOrEqual(1)
          expect(rock.spin).toBeGreaterThanOrEqual(0)
          expect(rock.spin).toBeLessThan(2 * Math.PI + 1e-9)
          expect(rock.tilt).toBeGreaterThanOrEqual(0)
          expect(rock.tilt).toBeLessThan(Math.PI / 4)
          expect(rock.tone).toBeGreaterThanOrEqual(-1)
          expect(rock.tone).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  /*
   * A sea surface is flat by definition and nothing coarse is lying on it.
   * `groundCoverAt` has already clamped a submarine sample *up* to the datum, so
   * "is this under water" is only answerable by comparing against the datum
   * itself — which is why the generator holds `seaDatumElevation` rather than
   * asking the cover.
   */
  it('puts nothing on the water', () => {
    const wet = [...walkBodies(SOL)].find(
      (body) => body.surface.seaLevel !== null && body.surface.maxElevation > 0,
    )
    if (wet === undefined) return
    const sea = seaDatumElevation(wet.surface) as number
    for (const region of regions(wet, 24)) {
      for (const rock of regionScatter(wet.surface, region)) {
        expect(rock.elevation).toBeGreaterThan(sea)
      }
    }
  })
})

describe('the geology decides how many', () => {
  /*
   * The claim the abundance terms make, as an ordering rather than as a count:
   * an airless body keeps what impacts excavate and an atmosphered one buries
   * it. Stated over the whole body rather than per region, because a single
   * region is a sample of a thousand draws and says nothing.
   */
  it('strews an airless body more heavily than one with air', () => {
    const airless = count(LUNA)
    const airy = count(MARS)
    expect(LUNA.surface.grammar.air).toBe(0)
    expect(MARS.surface.grammar.air).toBeGreaterThan(0)
    expect(airless).toBeGreaterThan(airy)
  })

  it('concentrates them where a young crater has thrown material', () => {
    // Split the same body's regions by how bright their rocks' ground is: the
    // ejecta term is a multiplier, so the fresh half has to carry more of them.
    let freshRocks = 0
    let freshRegions = 0
    let matureRocks = 0
    let matureRegions = 0
    for (const region of regions(LUNA, 96)) {
      const rocks = regionScatter(LUNA.surface, region)
      const bright =
        rocks.reduce((sum, rock) => sum + rock.tone, 0) /
        Math.max(1, rocks.length)
      if (bright > 0.2) {
        freshRocks += rocks.length
        freshRegions += 1
      } else {
        matureRocks += rocks.length
        matureRegions += 1
      }
    }
    if (freshRegions === 0 || matureRegions === 0) return
    expect(freshRocks / freshRegions).toBeGreaterThan(
      matureRocks / matureRegions,
    )
  })

  const count = (body: Body): number => {
    let total = 0
    for (const region of regions(body, 48)) {
      total += regionScatter(body.surface, region).length
    }
    return total
  }
})

describe('a region can be assembled a slice at a time', () => {
  /*
   * The property the per-frame budget rests on. A whole region is eight and a
   * half milliseconds of field samples, so the streamer takes it in slices —
   * and a slice boundary that moved a rock would make the ground depend on the
   * frame rate.
   */
  it('gives the same rocks whether it is asked in one call or eight', () => {
    for (const region of regions(LUNA, 4)) {
      const whole = regionScatter(LUNA.surface, region)
      const sliced: ScatterRock[] = []
      const step = SCATTER_SLOTS / 8
      for (let from = 0; from < SCATTER_SLOTS; from += step) {
        sliced.push(
          ...regionScatter(LUNA.surface, region, { from, to: from + step }),
        )
      }
      expect(sliced).toEqual(whole)
    }
  })

  it('clamps a slice that runs past either end', () => {
    const region = [...regions(LUNA, 1)][0] as ReturnType<
      typeof regionForDirection
    >
    expect(
      regionScatter(LUNA.surface, region, { from: -50, to: SCATTER_SLOTS * 3 }),
    ).toEqual(regionScatter(LUNA.surface, region))
  })
})

describe('generation never depends on order', () => {
  /*
   * The rule this file could break most quietly. A rock is a hash of its own
   * address, so asking for the regions backwards — and churning another body's
   * sketch between them, which is what makes a memo the wrong kind of shared
   * state — has to return the same list.
   */
  it('answers the same whichever order the regions are asked for', () => {
    const list = [...regions(LUNA, 16)]
    const slots = (
      surface: typeof LUNA.surface,
      region: RegionAddress,
    ): string =>
      regionScatter(surface, region)
        .map((rock) => rock.index)
        .join(',')
    const forward = list.map((region) => slots(LUNA.surface, region))
    /*
     * Churned past `SKETCH_CACHE_LIMIT`, and the backward pass asks through a
     * **fresh surface object**. Both halves are what make this test able to
     * fail: `terrainSketch` puts a `WeakMap` on the surface identity in front of
     * its string cache, so the same object short-circuits the key entirely, and
     * the string cache is 96 entries deep, so a handful of other bodies evicts
     * nothing. Written the easy way, this asserted a property of `regionScatter`
     * and could not see the memo it names — which is exactly how a missing field
     * in `cacheKey` stayed invisible.
     */
    for (let i = 0; i < SKETCH_CACHE_LIMIT + 8; i += 1) {
      regionScatter(
        { ...LUNA.surface, seed: rootSeed(`churn ${i}`) },
        list[0] as RegionAddress,
      )
    }
    const fresh = { ...LUNA.surface }
    const backward = [...list]
      .reverse()
      .map((region) => slots(fresh, region))
      .reverse()
    expect(backward).toEqual(forward)
  })

  /*
   * The cache key is "what the derivation reads", and the sub-floor ladder added
   * a reader — `grammar.air`, through `microCraterDensity`. Two grammars alike
   * in everything else and different in that one have to derive two sketches;
   * sharing one is order-dependence in the generator's own memo, and the seed
   * being in the key is protection by coincidence rather than by design.
   */
  it('does not share a sketch between two bodies whose air differs', () => {
    const seed = rootSeed('one seed, two atmospheres')
    const airless = terrainSketch({
      ...LUNA.surface,
      seed,
      grammar: { ...LUNA.surface.grammar, air: 0 },
    })
    const smothered = terrainSketch({
      ...LUNA.surface,
      seed,
      grammar: { ...LUNA.surface.grammar, air: 1 },
    })
    expect(airless.microLevels.length).toBeGreaterThan(0)
    expect(smothered.microLevels).toHaveLength(0)
  })

  it('gives two bodies with different seeds different rocks', () => {
    const level = scatterLevel(LUNA.radius)
    const region = regionForDirection(vec3(0.4, 0.5, 0.76), level)
    const here = regionScatter(LUNA.surface, region).map((r) => r.index)
    const there = regionScatter(
      { ...LUNA.surface, seed: rootSeed('somewhere else') },
      region,
    ).map((r) => r.index)
    expect(here).not.toEqual(there)
  })
})
