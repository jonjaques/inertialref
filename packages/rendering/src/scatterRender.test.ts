import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import {
  type BodyFixedDirection,
  regionCentreDirection,
  regionForDirection,
  regionSize,
} from '@inertialref/universe'
import {
  BASELINE_VIEWPORT,
  FOV_MAX,
  FOV_MIN,
  LENS_PRESETS,
  lensForFov,
} from './lens.ts'
import { ROCK_VARIANTS, rockMesh, scatterVariant } from './rockMesh.ts'
import { scatterRange, selectScatterRegions } from './scatterSelect.ts'

const LUNA_RADIUS = 1_737_400
const LEVEL = 14

// Unit, and deliberately so: `BodyFixedDirection`'s three producers all
// normalize, and `selectScatterRegions` measures a chord against a radius — a
// direction 0.16% short puts the eye 2.8 km below the ground it is standing on.
const EYE = Vec.normalize(vec3(0.4, 0.5, 0.766)) as BodyFixedDirection

// The ground under the eye and the datum are deliberately different numbers:
// a stance is a height above the *ground*, and reading it off the datum was
// what switched the whole field off on a body whose sites sit 687 m up.
const GROUND_ELEVATION = 687

const eyeAt = (height: number) => ({
  direction: EYE,
  distance: LUNA_RADIUS + GROUND_ELEVATION + height,
  radius: LUNA_RADIUS,
  ground: LUNA_RADIUS + GROUND_ELEVATION,
  level: LEVEL,
})

const OPTICS = {
  lens: LENS_PRESETS.flight,
  viewport: BASELINE_VIEWPORT,
} as const

describe('the rock shapes', () => {
  it('faces every triangle outward', () => {
    for (let variant = 0; variant < ROCK_VARIANTS; variant += 1) {
      const { positions, normals, indices } = rockMesh(variant)
      let inverted = 0
      for (let i = 0; i < indices.length; i += 3) {
        const a = (indices[i] as number) * 3
        const b = (indices[i + 1] as number) * 3
        const c = (indices[i + 2] as number) * 3
        const ux = (positions[b] as number) - (positions[a] as number)
        const uy = (positions[b + 1] as number) - (positions[a + 1] as number)
        const uz = (positions[b + 2] as number) - (positions[a + 2] as number)
        const vx = (positions[c] as number) - (positions[a] as number)
        const vy = (positions[c + 1] as number) - (positions[a + 1] as number)
        const vz = (positions[c + 2] as number) - (positions[a + 2] as number)
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        // Against the centroid, not against a vertex: on a displaced shape a
        // vertex can sit inside its own triangle's plane and the dot goes to
        // zero, which is a tie rather than an inversion.
        const cx =
          ((positions[a] as number) +
            (positions[b] as number) +
            (positions[c] as number)) /
          3
        const cy =
          ((positions[a + 1] as number) +
            (positions[b + 1] as number) +
            (positions[c + 1] as number)) /
          3
        const cz =
          ((positions[a + 2] as number) +
            (positions[b + 2] as number) +
            (positions[c + 2] as number)) /
          3
        if (nx * cx + ny * cy + nz * cz <= 0) inverted += 1
      }
      /*
       * The material is single-sided and the GPU culls by winding, so an
       * inverted triangle is a hole in a rock rather than a shading error —
       * which is exactly the defect `patchIndices` remembers, one object down.
       */
      expect(inverted).toBe(0)
      expect(normals.length).toBe(positions.length)
    }
  })

  it('fits every shape inside the radius the geology asked for', () => {
    for (let variant = 0; variant < ROCK_VARIANTS; variant += 1) {
      const { positions } = rockMesh(variant)
      let peak = 0
      for (let i = 0; i < positions.length; i += 3) {
        peak = Math.max(
          peak,
          Math.hypot(
            positions[i] as number,
            positions[i + 1] as number,
            positions[i + 2] as number,
          ),
        )
      }
      // Exactly one, not merely under it: the instance scale is the rock's
      // radius in meters, so a variant 40% larger than the unit sphere would be
      // a different species at a different size rather than one population.
      expect(peak).toBeCloseTo(1, 5)
    }
  })

  it('hands back the same buffers every time', () => {
    expect(rockMesh(0).positions).toBe(rockMesh(0).positions)
  })

  it('picks the variant nearest the angularity it is given', () => {
    expect(scatterVariant(0)).toBe(0)
    expect(scatterVariant(1)).toBe(ROCK_VARIANTS - 1)
    let previous = -1
    for (let a = 0; a <= 1.0001; a += 0.05) {
      const variant = scatterVariant(a)
      expect(variant).toBeGreaterThanOrEqual(previous)
      previous = variant
    }
  })
})

describe('which rock regions the camera asks for', () => {
  it('asks for nothing from orbit', () => {
    expect(selectScatterRegions(eyeAt(50_000), OPTICS)).toHaveLength(0)
  })

  /*
   * The gate is against the ground, not the datum. Written as a pair because
   * only the pair can fail: a body whose sites sit hundreds of meters up reads
   * as "in orbit" from a two-meter stance if the height is taken off the datum,
   * and every assertion above still passes because they all use `eyeAt`.
   */
  it('measures the stance against the ground it is standing on', () => {
    const standing = {
      direction: EYE,
      distance: LUNA_RADIUS + 687 + 2,
      radius: LUNA_RADIUS,
      ground: LUNA_RADIUS + 687,
      level: LEVEL,
    }
    expect(selectScatterRegions(standing, OPTICS).length).toBeGreaterThan(0)
    expect(
      selectScatterRegions({ ...standing, ground: LUNA_RADIUS }, OPTICS),
    ).toHaveLength(0)
  })

  it('asks for a disk of them from the ground', () => {
    const regions = selectScatterRegions(eyeAt(2), OPTICS)
    expect(regions.length).toBeGreaterThan(4)
    const range = scatterRange(LENS_PRESETS.flight, BASELINE_VIEWPORT)
    const size = regionSize(LUNA_RADIUS, LEVEL)
    for (const region of regions) {
      expect(region.level).toBe(LEVEL)
      const centre = regionCentreDirection(region)
      const angle = Math.acos(
        Math.min(1, Math.max(-1, dot(centre, eyeAt(2).direction))),
      )
      expect(angle * LUNA_RADIUS).toBeLessThanOrEqual(range + size)
      expect(regions.length).toBeGreaterThan(0)
    }
  })

  it('puts the region under the camera first', () => {
    const eye = eyeAt(2)
    const regions = selectScatterRegions(eye, OPTICS)
    expect(regions[0]).toEqual(regionForDirection(eye.direction, LEVEL))
  })

  it('never names the same region twice, even across a cube corner', () => {
    // The direction of a cube corner, where three faces meet and an eight-way
    // step names one of them twice.
    const corner = 1 / Math.sqrt(3)
    const regions = selectScatterRegions(
      {
        direction: Vec.normalize(
          vec3(corner, corner, corner),
        ) as BodyFixedDirection,
        distance: LUNA_RADIUS + 2,
        radius: LUNA_RADIUS,
        ground: LUNA_RADIUS,
        level: LEVEL,
      },
      OPTICS,
    )
    const keys = regions.map((r) => `${r.face}.${r.i}.${r.j}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('reaches further through a longer lens', () => {
    const wide = scatterRange(lensForFov(FOV_MAX), BASELINE_VIEWPORT)
    const flight = scatterRange(LENS_PRESETS.flight, BASELINE_VIEWPORT)
    const long = scatterRange(lensForFov(FOV_MIN), BASELINE_VIEWPORT)
    expect(wide).toBeLessThan(flight)
    expect(flight).toBeLessThan(long)
    expect(
      selectScatterRegions(eyeAt(2), {
        ...OPTICS,
        lens: lensForFov(FOV_MIN),
      }).length,
    ).toBeGreaterThan(selectScatterRegions(eyeAt(2), OPTICS).length)
  })

  it('holds to the ceiling it publishes', () => {
    const regions = selectScatterRegions(eyeAt(2), {
      ...OPTICS,
      lens: lensForFov(FOV_MIN),
      maxRegions: 7,
    })
    expect(regions).toHaveLength(7)
  })
})

const dot = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number => a.x * b.x + a.y * b.y + a.z * b.z
