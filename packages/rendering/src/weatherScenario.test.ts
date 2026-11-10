import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pcg4d, rootSeed } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { aerosolDepthOf } from './atmosphere.ts'
import { type CubeFace, cubeDirection } from './cubeSphere.ts'
import { mieDroplets } from './mieTable.ts'
import { periodIndex } from './weatherClock.ts'
import {
  BLOB_MEAN,
  blobCells,
  blobExists,
  blobThreshold,
  CLOUD_GENERA,
  genusProfile,
  genusProfileMean,
  MAX_CLOUD_LAYERS,
  SCENARIO_IDS,
  scenarioCoverage,
  shellUnion,
  WEATHER_SCENARIOS,
  wetWorld,
} from './weatherScenario.ts'

/*
 * The placeholder weather. The scenario table is what the measurement batches
 * name, so it is held to its own rules; the patterns are held to the mean
 * coverage they promise and to a lattice decision taken on integers; and the
 * wet predicate is held on real records — Sol from its own system, far-shore
 * from the universe seed and its id, as `World.loadSystem` builds them —
 * rather than through `openSession`, which lives in devtools, a layer above.
 */

const ROOT = rootSeed('inertialref')
const GALAXY = galaxySeedOf(ROOT, MILKY_WAY)

function system(id: string): readonly Body[] {
  const stub = resolveSystem(GALAXY, SOL_ONLY_CATALOG, systemId(id))
  if (stub === undefined) throw new Error(`no system ${id}`)
  return [...walkBodies(generateSystem(ROOT, MILKY_WAY, stub))]
}

function body(bodies: readonly Body[], address: string): Body {
  const found = bodies.find((one) => formatAddress(one.address) === address)
  if (found === undefined) throw new Error(`no body ${address}`)
  return found
}

/** Directions spread evenly over the sphere: a Fibonacci lattice, so a mean over them is an area mean. */
function sphere(count: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: count }, (_, k) => {
    const y = 1 - (2 * (k + 0.5)) / count
    const across = Math.sqrt(1 - y * y)
    return {
      x: across * Math.cos(golden * k),
      y,
      z: across * Math.sin(golden * k),
    }
  })
}

describe('the scenarios', () => {
  it('each holds its own rules: at most three layers, sorted, disjoint, in range', () => {
    const table = mieDroplets()
    for (const id of SCENARIO_IDS) {
      const scenario = WEATHER_SCENARIOS[id]
      expect(scenario.id).toBe(id)
      expect(scenario.layers.length).toBeGreaterThan(0)
      expect(scenario.layers.length).toBeLessThanOrEqual(MAX_CLOUD_LAYERS)
      scenario.layers.forEach((layer, k) => {
        expect(layer.base).toBeLessThan(layer.top)
        expect(layer.coverage).toBeGreaterThanOrEqual(0)
        expect(layer.coverage).toBeLessThanOrEqual(1)
        expect(layer.sigma).toBeGreaterThan(0)
        expect(layer.cellMeters).toBeGreaterThan(0)
        expect(layer.erosion).toBeGreaterThanOrEqual(0)
        expect(layer.erosion).toBeLessThanOrEqual(1)
        // The phase table's rows are what the radius reads.
        expect(layer.radius).toBeGreaterThanOrEqual(table.radiusMin)
        expect(layer.radius).toBeLessThanOrEqual(table.radiusMax)
        const next = scenario.layers[k + 1]
        if (next !== undefined) expect(layer.top).toBeLessThanOrEqual(next.base)
      })
      if (scenario.pattern !== 'uniform')
        expect(scenario.patternScale).toBeGreaterThan(0)
      expect(scenario.patternPeriod).toBeGreaterThanOrEqual(0)
    }
  })

  it('spans the lowest base to the highest top', () => {
    expect(shellUnion(WEATHER_SCENARIOS['two-decks'])).toEqual({
      base: 1000,
      top: 4800,
    })
    expect(shellUnion(WEATHER_SCENARIOS.anvil)).toEqual({
      base: 1000,
      top: 15_000,
    })
  })
})

describe('a genus’s profile', () => {
  const h01 = fc.double({ min: -0.5, max: 1.5, noNaN: true })

  it('is 0 outside its layer and at its ends, and never leaves [0, 1]', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CLOUD_GENERA), h01, (genus, h) => {
        const p = genusProfile(genus, h)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(1)
        if (h <= 0 || h >= 1) expect(p).toBe(0)
      }),
    )
  })

  it('peaks at 1 inside its layer', () => {
    for (const genus of CLOUD_GENERA) {
      let peak = 0
      for (let k = 1; k < 10_000; k += 1)
        peak = Math.max(peak, genusProfile(genus, k / 10_000))
      expect(peak).toBe(1)
    }
  })

  it('is continuous: no step anywhere, the ends included', () => {
    /*
     * A smoothstep's steepest slope is 1.5 over its width, and the narrowest
     * ramp of any genus is fog's 0.02 off the ground, so 75 per unit of h
     * bounds every profile; a step anywhere would be a jump no ε shrinks.
     */
    const epsilon = 1e-7
    fc.assert(
      fc.property(fc.constantFrom(...CLOUD_GENERA), h01, (genus, h) => {
        const jump = Math.abs(
          genusProfile(genus, h + epsilon) - genusProfile(genus, h),
        )
        expect(jump).toBeLessThanOrEqual(75 * epsilon + 1e-12)
      }),
      { numRuns: 5000 },
    )
  })

  it('averages (1 + fall − rise)/2 over its layer, the density an unresolved cell stands for', () => {
    for (const genus of CLOUD_GENERA) {
      const n = 100_000
      let sum = 0
      for (let k = 0; k < n; k += 1) sum += genusProfile(genus, (k + 0.5) / n)
      expect(sum / n).toBeCloseTo(genusProfileMean(genus), 6)
    }
  })
})

describe('the wet predicate', () => {
  const sol = system('SOL')
  const farShore = system('P222_1_0_9')
  const shore = body(farShore, 'g:milky-way/s:P222_1_0_9/b:4')

  it('draws weather on far-shore V and on Earth', () => {
    // The probe's record: a sea of water under the dust family's τ 0.4.
    expect(shore.surface.seaLevel).not.toBeNull()
    expect(shore.surface.grammar.liquidKind).toBe('water')
    expect(aerosolDepthOf(shore.appearance.haze!)).toBe(0.4)
    expect(wetWorld(shore)).toBe(true)
    expect(wetWorld(body(sol, 'g:milky-way/s:SOL/b:2'))).toBe(true)
  })

  it('draws none on Mars or Venus, or on far-shore’s dry neighbor and moon', () => {
    expect(wetWorld(body(sol, 'g:milky-way/s:SOL/b:3'))).toBe(false)
    expect(wetWorld(body(sol, 'g:milky-way/s:SOL/b:1'))).toBe(false)
    expect(wetWorld(body(farShore, 'g:milky-way/s:P222_1_0_9/b:3'))).toBe(false)
    expect(wetWorld(body(farShore, 'g:milky-way/s:P222_1_0_9/b:4.0'))).toBe(
      false,
    )
  })

  it('draws none on a generated sulfuric world, and none on a sea under its deck', () => {
    /*
     * The generator's sulfuric worlds are all hotter than 450 K and none
     * keeps a sea, so the one taken here fails on its sea as well; the
     * aerosol clause is held on its own by putting that same deck over
     * far-shore's ocean.
     */
    const sulfuric = body(system('P5q_1_0_4'), 'g:milky-way/s:P5q_1_0_4/b:0')
    expect(aerosolDepthOf(sulfuric.appearance.haze!)).toBe(8)
    expect(wetWorld(sulfuric)).toBe(false)
    const decked: Body = {
      ...shore,
      appearance: { ...shore.appearance, haze: sulfuric.appearance.haze },
    }
    expect(wetWorld(decked)).toBe(false)
  })

  it('reads an unauthored haze by the air’s own recipe: thickness 10 is τ 1.2, a deck', () => {
    const {
      aerosolDepth: _depth,
      aerosolAlbedo: _albedo,
      ...unauthored
    } = shore.appearance.haze!
    const under = (thickness: number): Body => ({
      ...shore,
      appearance: {
        ...shore.appearance,
        haze: { ...unauthored, thickness },
      },
    })
    expect(aerosolDepthOf(under(10).appearance.haze!)).toBeCloseTo(1.2, 12)
    expect(wetWorld(under(10))).toBe(false)
    expect(wetWorld(under(8))).toBe(true)
  })
})

describe('the blobs', () => {
  const cellIndex = fc.integer({ min: 0, max: 511 })
  const half = fc.integer({ min: 0, max: 0xffff_ffff })

  it('exist exactly where a cell’s hash is under the u32 threshold, compared as integers', () => {
    /*
     * The threshold the hash meets is the hash itself and one past it: no
     * float compare could sit between the two, so a decision that is right
     * at both is an integer one (rule 58). `toUnit(hash) < share` is the
     * float version, and at the hash floor(share·2³²) it says yes where this
     * says no.
     */
    fc.assert(
      fc.property(
        fc.constantFrom<CubeFace>(0, 1, 2, 3, 4, 5),
        cellIndex,
        cellIndex,
        fc.integer({ min: 0, max: 2 }),
        half,
        fc.integer({ min: 0, max: 1023 }),
        (face, i, j, layer, low, high) => {
          const period = [low, high] as const
          const hash = pcg4d(
            i,
            j,
            (face | (layer << 3) | (high << 5)) >>> 0,
            low,
          ).x
          expect(blobExists(face, i, j, layer, period, hash)).toBe(false)
          if (hash < 0xffff_ffff)
            expect(blobExists(face, i, j, layer, period, hash + 1)).toBe(true)
        },
      ),
      { numRuns: 5000 },
    )
  })

  it('take their threshold as an integer of the u32 range, rising with coverage', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a]
          for (const threshold of [blobThreshold(low), blobThreshold(high)]) {
            expect(Number.isInteger(threshold)).toBe(true)
            expect(threshold).toBeGreaterThanOrEqual(0)
            expect(threshold).toBeLessThanOrEqual(0xffff_ffff)
          }
          expect(blobThreshold(low)).toBeLessThanOrEqual(blobThreshold(high))
        },
      ),
    )
    expect(blobThreshold(0)).toBe(0)
    expect(blobThreshold(1)).toBe(0xffff_ffff)
  })

  it('fill the share of cells their coverage asks for', () => {
    const coverage = 0.35
    const cells = 64
    let held = 0
    const threshold = blobThreshold(coverage)
    for (const face of [0, 1, 2, 3, 4, 5] as const)
      for (let i = 0; i < cells; i += 1)
        for (let j = 0; j < cells; j += 1)
          if (blobExists(face, i, j, 0, [7, 0], threshold)) held += 1
    const share = coverage / BLOB_MEAN
    const total = 6 * cells * cells
    // Four binomial deviations: 0.011 of 24,576 cells.
    const deviation = Math.sqrt((share * (1 - share)) / total)
    expect(Math.abs(held / total - share)).toBeLessThan(4 * deviation)
  })

  it('size their cells by the power of two nearest the pattern’s scale', () => {
    expect(blobCells(0.05)).toBe(32)
    expect(blobCells(0.02)).toBe(64)
    expect(blobCells(0)).toBe(1)
    expect(blobCells(1e-9)).toBe(512)
  })
})

describe('the coverage the maps hold', () => {
  const at = sphere(60_000)

  it('keeps every layer’s mean coverage over the body, whatever its pattern', () => {
    for (const id of SCENARIO_IDS) {
      const scenario = WEATHER_SCENARIOS[id]
      scenario.layers.forEach((layer, k) => {
        let sum = 0
        for (const direction of at)
          sum += scenarioCoverage(scenario, k, direction, 10_000)
        // Blob cells are drawn, so a blob layer's mean is a sample's: the
        // anvil's 6,144 cells have a binomial deviation of 0.0029 in it and
        // measure 0.0015 under 0.25, fair-cumulus's 24,576 0.0002 over 0.35.
        // Bands and uniform layers measure under 10⁻⁴.
        expect(Math.abs(sum / at.length - layer.coverage)).toBeLessThan(0.006)
      })
    }
  })

  it('stays inside [0, 1] everywhere, at every instant', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIO_IDS),
        fc.integer({ min: 0, max: 60_000 - 1 }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        (id, k, t) => {
          const scenario = WEATHER_SCENARIOS[id]
          for (let layer = 0; layer < MAX_CLOUD_LAYERS; layer += 1) {
            const c = scenarioCoverage(scenario, layer, at[k]!, t)
            expect(c).toBeGreaterThanOrEqual(0)
            expect(c).toBeLessThanOrEqual(1)
            if (layer >= scenario.layers.length) expect(c).toBe(0)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('is the layer’s own coverage everywhere under a uniform pattern', () => {
    const scenario = WEATHER_SCENARIOS['broken-horizon']
    for (const direction of at.slice(0, 500))
      expect(scenarioCoverage(scenario, 0, direction, 0)).toBe(0.5)
  })

  it('holds a blob’s draw for its period and draws again at the next', () => {
    const scenario = WEATHER_SCENARIOS['fair-cumulus']
    const period = scenario.patternPeriod
    const start = 40 * period
    let changed = 0
    for (const direction of at.slice(0, 5000)) {
      const now = scenarioCoverage(scenario, 0, direction, start + 1)
      expect(scenarioCoverage(scenario, 0, direction, start + period - 1)).toBe(
        now,
      )
      if (scenarioCoverage(scenario, 0, direction, start + period + 1) !== now)
        changed += 1
    }
    expect(periodIndex(start + 1, period)).not.toEqual(
      periodIndex(start + period + 1, period),
    )
    expect(changed).toBeGreaterThan(500)
  })

  it('reads the floor on both sides of every cell edge, so a cell read the other way changes nothing', () => {
    /*
     * A blob is 0 by its cell's inscribed circle, so on an edge between two
     * cells — or two faces — the coverage is the floor whichever cell holds
     * the point. That is what lets the GPU's float32 cell index disagree with
     * this one at an edge without a seam.
     */
    const scenario = WEATHER_SCENARIOS.anvil
    const cells = blobCells(scenario.patternScale)
    for (const face of [0, 1, 2, 3, 4, 5] as const)
      for (let edge = 0; edge <= cells; edge += 4)
        for (let k = 0; k < cells; k += 3) {
          const across = -1 + (2 * edge) / cells
          const along = -1 + (2 * (k + 0.37)) / cells
          for (const direction of [
            cubeDirection(face, across, along),
            cubeDirection(face, along, across),
          ])
            expect(scenarioCoverage(scenario, 0, direction, 0)).toBe(0)
        }
  })

  it('lays bands in latitude, cloudy and clear each the pattern’s scale wide', () => {
    const scenario = WEATHER_SCENARIOS['cirrus-over-cumulus']
    const scale = scenario.patternScale
    const north = (latitude: number): Vec3 => ({
      x: Math.cos(latitude),
      y: Math.sin(latitude),
      z: 0,
    })
    // The cumulus layer's 0.35 swings fully: 0.7 on a band's middle, 0 between.
    expect(scenarioCoverage(scenario, 0, north(0), 0)).toBeCloseTo(0.7, 12)
    expect(scenarioCoverage(scenario, 0, north(scale), 0)).toBeCloseTo(0, 12)
    expect(scenarioCoverage(scenario, 0, north(scale / 2), 0)).toBeCloseTo(
      0.35,
      12,
    )
  })
})
