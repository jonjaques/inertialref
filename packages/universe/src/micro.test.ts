import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { vec3 } from '@inertialref/spatial'
import { regionAddress } from './address.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import {
  GRIT_RELIEF,
  MICRO_CRATER_CEILING,
  microRelief,
  microReliefBound,
} from './micro.ts'
import {
  CANONICAL_DETAIL_FLOOR,
  MICRO_DETAIL_FLOOR,
  MICRO_RUNG_BASE,
  MAX_CRATER_LEVELS,
  craterLadder,
  microLadder,
  terrainSketch,
} from './sketch.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import {
  drawnDivergence,
  drawnElevation,
  drawnSurfaceRadius,
  elevationAt,
  groundElevation,
  regionDirection,
  surfaceDetailFloor,
  surfaceRadius,
  type BodyFixedDirection,
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

/** Golden-angle spread, so nothing clusters at a pole. */
function* sphere(count: number): Generator<ReturnType<typeof vec3>> {
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * i + 1) / count
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    yield vec3(Math.cos(around) * ring, z, Math.sin(around) * ring)
  }
}

/** Bodies with terrain worth sampling, one of each shape of surface. */
const SUBJECTS = ['Luna', 'Mars', 'Iapetus', 'Miranda', 'Mercury'].flatMap(
  (name) => {
    const body = find(name)
    return body.surface.maxElevation > 0 ? [body] : []
  },
)

describe('the ladder below the canonical floor', () => {
  it('starts at the canonical wavelength floor and runs to the micro one', () => {
    for (const body of SUBJECTS) {
      const { levels, firstRung } = microLadder(body.surface.grammar)
      if (levels.length === 0) continue
      expect(firstRung).toBe(MICRO_RUNG_BASE)
      expect(levels[0]?.diameter).toBe(CANONICAL_DETAIL_FLOOR)
      expect(levels.at(-1)?.diameter).toBeGreaterThanOrEqual(MICRO_DETAIL_FLOOR)
      // Every rung is half the one above it, so the −2 cumulative slope the
      // canonical ladder gets from its geometry carries into the tail.
      for (let i = 1; i < levels.length; i += 1) {
        expect(levels[i]?.diameter).toBeCloseTo(
          (levels[i - 1] as { diameter: number }).diameter / 2,
          9,
        )
      }
    }
  })

  /*
   * The rung number is the fourth lane of the lattice hash, so a tail rung that
   * shared a number with a canonical rung would place its craters in the same
   * cells as a basin — the same crater at two sizes, three decades apart, on
   * every body. `MICRO_RUNG_BASE` is what keeps them apart, and it has to stay
   * clear of an *uncapped* canonical ladder rather than of the capped one,
   * because raising `MAX_CRATER_LEVELS` is a change this file should survive.
   */
  it('numbers its rungs clear of every canonical rung', () => {
    for (const body of SUBJECTS) {
      const uncapped = craterLadder(
        body.surface.grammar,
        CANONICAL_DETAIL_FLOOR,
        64,
      )
      expect(uncapped.length).toBeLessThan(MICRO_RUNG_BASE)
      expect(MAX_CRATER_LEVELS).toBeLessThan(MICRO_RUNG_BASE)
    }
  })

  /*
   * A resurfaced body has no kilometer craters and is still saturated at a
   * meter, because retention at a meter is geologically instantaneous. Miranda
   * is the case: `craterDensity` is zero, `largestCrater` is zero, and the
   * canonical ladder is empty — so a tail that continued the canonical one
   * would leave the youngest surfaces in the Solar System perfectly smooth at
   * every scale a person could stand next to.
   */
  it('gives a body with no canonical craters a meter scale anyway', () => {
    const miranda = find('Miranda')
    expect(craterLadder(miranda.surface.grammar)).toHaveLength(0)
    expect(microLadder(miranda.surface.grammar).levels.length).toBeGreaterThan(
      0,
    )
  })
})

describe('the presentational tail', () => {
  it('stays inside the bound it publishes', () => {
    for (const body of SUBJECTS) {
      const sketch = terrainSketch(body.surface)
      const bound = microReliefBound(sketch, body.surface.grammar)
      expect(bound).toBeLessThanOrEqual(MICRO_CRATER_CEILING + GRIT_RELIEF)
      let peak = 0
      for (const direction of sphere(400)) {
        peak = Math.max(
          peak,
          Math.abs(microRelief(sketch, body.surface.grammar, direction)),
        )
      }
      expect(peak).toBeLessThanOrEqual(bound)
      expect(drawnDivergence(body.surface)).toBe(bound)
    }
  })

  /*
   * The whole point of the split: the field a ship integrates against does not
   * move. Asserted as an identity rather than by comparing two recorded numbers,
   * because a golden vector would go stale the first time anything above the
   * floor changed and this cannot.
   */
  it('leaves the canonical field alone', () => {
    for (const body of SUBJECTS) {
      const sketch = terrainSketch(body.surface)
      for (const direction of sphere(120)) {
        const canonical = groundElevation(body.surface, direction)
        const drawn = drawnElevation(body.surface, direction)
        const tail = microRelief(sketch, body.surface.grammar, direction)
        const sea = body.surface.seaLevel
        if (sea === null) {
          expect(drawn - canonical).toBeCloseTo(tail, 6)
        } else {
          // Under the sea clamp the difference is at most the tail, never more.
          expect(Math.abs(drawn - canonical)).toBeLessThanOrEqual(
            Math.abs(tail) + 1e-6,
          )
        }
        expect(Math.abs(drawn - canonical)).toBeLessThanOrEqual(
          drawnDivergence(body.surface),
        )
      }
    }
  })

  it('puts the drawn radius and the contact test inside the same bound', () => {
    for (const body of SUBJECTS) {
      const bound = drawnDivergence(body.surface)
      for (const direction of sphere(120)) {
        const up = direction as BodyFixedDirection
        expect(
          Math.abs(drawnSurfaceRadius(body, up) - surfaceRadius(body, up)),
        ).toBeLessThanOrEqual(bound)
      }
    }
  })

  it('is a pure function of the direction', () => {
    for (const body of SUBJECTS) {
      const sketch = terrainSketch(body.surface)
      const directions = [...sphere(64)]
      const forward = directions.map((d) =>
        microRelief(sketch, body.surface.grammar, d),
      )
      const backward = [...directions]
        .reverse()
        .map((d) => microRelief(sketch, body.surface.grammar, d))
        .reverse()
      expect(backward).toEqual(forward)
    }
  })

  /*
   * C1 at every scale, checked the way the ray filament's onset step was found:
   * walk a great circle at the tail's own finest wavelength and compare the
   * largest adjacent jump against the typical one. A term that appears at a
   * boundary rather than beginning there shows up as a ratio in the tens; a
   * continuous field gives single digits.
   */
  it('has no step in it at the scale it works at', () => {
    for (const body of SUBJECTS) {
      const sketch = terrainSketch(body.surface)
      const radius = body.surface.grammar.meanRadius
      // Two samples per meter of ground, over four kilometers of arc.
      const step = 0.5 / radius
      const steps: number[] = []
      let previous = microRelief(
        sketch,
        body.surface.grammar,
        vec3(Math.cos(0), 0.31, Math.sin(0)),
      )
      for (let i = 1; i < 8_000; i += 1) {
        const angle = i * step
        const value = microRelief(
          sketch,
          body.surface.grammar,
          vec3(Math.cos(angle) * 0.95, 0.31, Math.sin(angle) * 0.95),
        )
        steps.push(Math.abs(value - previous))
        previous = value
      }
      steps.sort((a, b) => a - b)
      const largest = steps.at(-1) as number
      const typical = steps[Math.floor(steps.length * 0.999)] as number
      // Half a meter of ground may not move the field by more than the deepest
      // thing in it, and the largest jump may not stand out from the p99.9.
      expect(largest).toBeLessThan(MICRO_CRATER_CEILING)
      expect(largest / Math.max(typical, 1e-9)).toBeLessThan(4)
    }
  })
})

describe('the floor the mesh is refined to', () => {
  /*
   * The phase's own claim, as a test. `surfaceDetailFloor` measures the drawn
   * field; measured against the canonical one it reports a shallower level, and
   * the difference is what the tail bought. Without it the search cannot go
   * deeper however fine a term is added, because its tolerance *is* the
   * canonical amplitude floor.
   */
  it('is deeper than the canonical field alone would ask for', () => {
    const compared = SUBJECTS.map((body) => {
      const drawn = surfaceDetailFloor(body.surface)
      const canonical = canonicalDetailFloor(body)
      return { name: body.name, drawn, canonical }
    })
    for (const row of compared) {
      expect(row.drawn).toBeGreaterThanOrEqual(row.canonical)
    }
    expect(compared.some((row) => row.drawn > row.canonical)).toBe(true)
  })
})

/**
 * The same search `surfaceDetailFloor` runs, against the canonical field.
 *
 * Written out here rather than exported, because nothing in the application
 * wants it: the mesh is made of the drawn field and the contact test does not
 * subdivide. It exists so the test above can state the difference as a number
 * instead of asserting the implementation back at itself.
 */
function canonicalDetailFloor(body: Body): number {
  const half = 0.5 / 64
  for (let level = 0; level <= 24; level += 1) {
    let peak = 0
    for (let probe = 0; probe < 24; probe += 1) {
      const z = 1 - (2 * probe + 1) / 24
      const around = probe * Math.PI * (3 - Math.sqrt(5))
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      const { face, i, j } = regionForProbe(
        vec3(Math.cos(around) * ring, z, Math.sin(around) * ring),
        level,
      )
      const region = regionAddress(face, level, i, j)
      const at = (s: number, t: number): number =>
        groundElevation(body.surface, regionDirection(region, s, t))
      const corners =
        at(0.5 - half, 0.5 - half) +
        at(0.5 + half, 0.5 - half) +
        at(0.5 - half, 0.5 + half) +
        at(0.5 + half, 0.5 + half)
      peak = Math.max(peak, Math.abs(at(0.5, 0.5) - corners / 4))
    }
    if (peak <= 0.5) return level + 1
  }
  return 24
}

function regionForProbe(
  direction: ReturnType<typeof vec3>,
  level: number,
): { face: number; i: number; j: number } {
  const { x, y, z } = direction
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  const span = 2 ** level
  const cell = (t: number): number =>
    Math.min(span - 1, Math.max(0, Math.floor(((t + 1) / 2) * span)))
  if (ax >= ay && ax >= az) {
    return x > 0
      ? { face: 0, i: cell(-z / ax), j: cell(y / ax) }
      : { face: 1, i: cell(z / ax), j: cell(y / ax) }
  }
  if (ay >= az) {
    return y > 0
      ? { face: 2, i: cell(x / ay), j: cell(-z / ay) }
      : { face: 3, i: cell(x / ay), j: cell(z / ay) }
  }
  return z > 0
    ? { face: 4, i: cell(x / az), j: cell(y / az) }
    : { face: 5, i: cell(-x / az), j: cell(y / az) }
}

describe('what nothing else may read', () => {
  /*
   * `elevationAt` is the landform and it is canonical, so it must not have
   * grown a tail by accident — which is what a call added in the wrong function
   * would look like. Checked against the difference the drawn field carries: if
   * `elevationAt` had the tail in it, the two would be equal.
   */
  it('keeps the tail out of elevationAt', () => {
    const luna = find('Luna')
    let differed = 0
    for (const direction of sphere(200)) {
      const bare = elevationAt(luna.surface, direction)
      const drawn = drawnElevation(luna.surface, direction)
      if (Math.abs(drawn - bare) > 1e-6) differed += 1
    }
    expect(differed).toBeGreaterThan(150)
  })
})
