import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  decodeShapeField,
  encodeShapeField,
  sampleShapeField,
  shapeExtent,
  shapePhi,
  shapeTheta,
} from '@inertialref/rendering'
import { shapeFieldFrom } from './shapeResample.ts'
import type { ShapeFormat, ShapeSource } from './shapeSources.ts'

/*
 * The resample, held to meshes whose answer is known.
 *
 * Every mesh here is generated, in the PDS body frame the archives publish
 * (+Z the pole, +X the prime meridian), and written out in the archives' own
 * text formats in kilometers, so `shapeFieldFrom` reads it exactly as it reads
 * a download. A generated sphere has a radius anyone can check; a downloaded
 * asteroid does not.
 */

const source = (format: ShapeFormat, width = 64): ShapeSource => ({
  key: 'test',
  name: 'Test body',
  url: 'https://example.invalid/test',
  file: 'test.txt',
  format,
  scale: 1_000,
  credit: '',
  reference: '',
  width,
  minimumBytes: 0,
})

interface Mesh {
  readonly vertices: readonly (readonly [number, number, number])[]
  readonly faces: readonly (readonly [number, number, number])[]
}

/** `(θ, φ)` — colatitude from +Z, east longitude from +X — to the PDS frame. */
const direction = (theta: number, phi: number): [number, number, number] => [
  Math.cos(phi) * Math.sin(theta),
  Math.sin(phi) * Math.sin(theta),
  Math.cos(theta),
]

/**
 * A closed, consistently wound UV mesh of a radial function: one vertex per
 * pole and `rings - 1` rings of `segments` vertices between them.
 */
function radialMesh(
  radius: (theta: number, phi: number) => number,
  rings = 48,
  segments = 96,
): Mesh {
  const vertices: [number, number, number][] = []
  const at = (theta: number, phi: number) => {
    const [x, y, z] = direction(theta, phi)
    const r = radius(theta, phi)
    vertices.push([x * r, y * r, z * r])
  }
  at(0, 0)
  for (let i = 1; i < rings; i += 1)
    for (let j = 0; j < segments; j += 1)
      at((Math.PI * i) / rings, (2 * Math.PI * j) / segments)
  at(Math.PI, 0)
  const south = vertices.length - 1
  const ring = (i: number, j: number) =>
    1 + (i - 1) * segments + (((j % segments) + segments) % segments)
  const faces: [number, number, number][] = []
  for (let j = 0; j < segments; j += 1) {
    faces.push([0, ring(1, j), ring(1, j + 1)])
    for (let i = 1; i < rings - 1; i += 1) {
      faces.push([ring(i, j), ring(i + 1, j), ring(i + 1, j + 1)])
      faces.push([ring(i, j), ring(i + 1, j + 1), ring(i, j + 1)])
    }
    faces.push([ring(rings - 1, j), south, ring(rings - 1, j + 1)])
  }
  return { vertices, faces }
}

/** A ring torus about +Z: `major` to the tube's center, `minor` its radius. */
function torusMesh(major: number, minor: number, around = 96, tube = 32): Mesh {
  const vertices: [number, number, number][] = []
  for (let i = 0; i < around; i += 1)
    for (let j = 0; j < tube; j += 1) {
      const u = (2 * Math.PI * i) / around
      const v = (2 * Math.PI * j) / tube
      const r = major + minor * Math.cos(v)
      vertices.push([r * Math.cos(u), r * Math.sin(u), minor * Math.sin(v)])
    }
  const index = (i: number, j: number) =>
    (((i % around) + around) % around) * tube + (((j % tube) + tube) % tube)
  const faces: [number, number, number][] = []
  for (let i = 0; i < around; i += 1)
    for (let j = 0; j < tube; j += 1) {
      faces.push([index(i, j), index(i + 1, j), index(i + 1, j + 1)])
      faces.push([index(i, j), index(i + 1, j + 1), index(i, j + 1)])
    }
  return { vertices, faces }
}

const km = (meters: number) => String(meters / 1_000)

/** Gaskell's vertex table: a count line, `index x y z`, then `index a b c`. */
const vertexTable = (mesh: Mesh): string =>
  [
    `${mesh.vertices.length} ${mesh.faces.length}`,
    ...mesh.vertices.map((v, i) => `${i + 1} ${v.map(km).join(' ')}`),
    ...mesh.faces.map((f, i) => `${i + 1} ${f.map((n) => n + 1).join(' ')}`),
  ].join('\n')

/** Wavefront OBJ, with a comment, normals and `v/vt/vn` face indices. */
const obj = (mesh: Mesh): string =>
  [
    '# generated',
    ...mesh.vertices.map((v) => `v ${v.map(km).join(' ')}`),
    'vn 0 0 1',
    ...mesh.faces.map(
      (f) => `f ${f.map((n) => `${n + 1}/${n + 1}/1`).join(' ')}`,
    ),
  ].join('\n')

/**
 * The resample's own floor for a smooth body: a ray between two vertices of a
 * ring hits the flat facet, which sits inside the surface by the chord's sag,
 * `r(1 − cos(π / segments))` — 0.054% of the radius at 96 segments, and the
 * pole caps are coarser in longitude than that. Measured, the worst sample of
 * a 48 × 96 sphere is 0.11% short; this is that, doubled.
 */
const FACET_SAG = 0.002

/**
 * Grid volume over mesh volume for a smooth body, at 64 × 33: the trapezoidal
 * integral over latitude rows against the divergence-theorem volume of the
 * facets. Measured at 0.04% on the sphere and 0.06% on the ellipsoid; the
 * bound is wider for the fuzzed bodies below, which are meshed at half the
 * resolution and carry relief.
 */
const GRID_QUADRATURE = 0.01

describe('a sphere', () => {
  const r = 5_000
  const sphere = radialMesh(() => r)

  it.each([
    ['vertex', vertexTable(sphere)],
    ['obj', obj(sphere)],
  ] as const)(
    'resamples from %s text to its radius everywhere',
    (format, text) => {
      const { field, volumeRatio, sourceDetail } = shapeFieldFrom(
        text,
        source(format),
      )
      expect(field.width).toBe(64)
      expect(field.height).toBe(33)
      for (const radius of field.radii) {
        expect(radius).toBeLessThanOrEqual(r * (1 + 1e-9))
        expect(radius).toBeGreaterThan(r * (1 - FACET_SAG))
      }
      // The grid's quadrature against the mesh's exact volume: both are short
      // of the sphere by the facets, and the grid by its own coarse sampling.
      expect(Math.abs(volumeRatio - 1)).toBeLessThan(GRID_QUADRATURE)
      expect(sourceDetail).toBe('9,024 facets')
    },
  )

  it('round-trips through the file and the reader the game uses', () => {
    const { field } = shapeFieldFrom(vertexTable(sphere), source('vertex'))
    const decoded = decodeShapeField(encodeShapeField(field))
    const { minRadius, maxRadius } = shapeExtent(field)
    // uint16 between the field's own extremes: the step is the relief / 65,535.
    const step = (maxRadius - minRadius) / 65_535
    for (let row = 0; row < field.height; row += 1)
      for (let column = 0; column < field.width; column += 1) {
        const theta = shapeTheta(field, row)
        const phi = shapePhi(field, column)
        expect(
          Math.abs(
            sampleShapeField(decoded, theta, phi) -
              sampleShapeField(field, theta, phi),
          ),
        ).toBeLessThanOrEqual(step / 2 + r * 1e-7)
      }
  })
})

describe('an ellipsoid', () => {
  it('recovers its three half-extents', () => {
    const [a, b, c] = [9_000, 6_000, 4_000]
    const mesh = radialMesh((theta, phi) => {
      const [x, y, z] = direction(theta, phi)
      return 1 / Math.hypot(x / a, y / b, z / c)
    })
    const { field, volumeRatio } = shapeFieldFrom(
      vertexTable(mesh),
      source('vertex'),
    )
    const { semiAxes } = shapeExtent(field)
    expect(semiAxes).toHaveLength(3)
    ;[a, b, c].forEach((axis, i) => {
      expect(semiAxes[i]).toBeLessThanOrEqual(axis * (1 + 1e-9))
      expect(semiAxes[i]).toBeGreaterThan(axis * (1 - FACET_SAG))
    })
    expect(Math.abs(volumeRatio - 1)).toBeLessThan(GRID_QUADRATURE)
  })
})

describe('a body the grid cannot hold', () => {
  /*
   * `.claude/rules/catalog.md`'s ±6% rule, made executable. A radius grid is
   * single-valued per direction, so a body that is not star-shaped about its
   * centroid cannot be held, and the build refuses it rather than shipping
   * its star-shaped hull. A torus is refused by coverage: every ray more than
   * asin(minor / major) off its plane passes through the hole and hits
   * nothing.
   */
  it('refuses a torus, which no radius grid can hold', () => {
    const torus = torusMesh(5_000, 2_000)
    expect(() => shapeFieldFrom(vertexTable(torus), source('vertex'))).toThrow(
      /resample missed \d+ of 2112 samples — the mesh is not closed about its centroid/,
    )
  })

  /*
   * A body with a cavity is refused by volume: every ray hits the outer
   * wall, so coverage is complete and only the volume can tell. The grid
   * holds the full ball, `1 / (1 − k³)` of the shell's volume for a cavity
   * of `k` times the radius. The cases bracket the tolerance: 105.8% at
   * k = 0.38 is held, 106.3% at k = 0.39 is refused, so a tolerance widened
   * to 6.3% or past it turns this red.
   */
  it.each([
    [0.3, '102.7'],
    [0.38, '105.8'],
    [0.39, null],
    [0.5, null],
  ])(
    'holds a cavity of %s of the radius only inside ±6% of the volume',
    (k, held) => {
      const r = 5_000
      const outer = radialMesh(() => r)
      const inner = radialMesh(() => k * r)
      const offset = outer.vertices.length
      const shell: Mesh = {
        vertices: [...outer.vertices, ...inner.vertices],
        // The cavity's faces wound inward, so its volume subtracts.
        faces: [
          ...outer.faces,
          ...inner.faces.map(
            ([a, b, c]) => [a + offset, c + offset, b + offset] as const,
          ),
        ],
      }
      const convert = () => shapeFieldFrom(vertexTable(shell), source('vertex'))
      if (held !== null)
        expect((convert().volumeRatio * 100).toFixed(1)).toBe(held)
      else
        expect(convert).toThrow(
          /encloses 1(0[6-9]|1\d)\.\d% of the source's volume\. Past ±6% .* not star-shaped/,
        )
    },
  )

  it('refuses a vertex file with no count line', () => {
    expect(() => shapeFieldFrom('v 1 0 0\nv 0 1 0', source('vertex'))).toThrow(
      'test: no count line at the top of the vertex file',
    )
  })

  it('refuses a mesh with a vertex nothing can read', () => {
    // One NaN vertex moves the centroid to NaN, and with it every ray.
    const text = vertexTable(radialMesh(() => 5_000, 8, 16)).replace(
      /^2 \S+/m,
      '2 n/a',
    )
    expect(() => shapeFieldFrom(text, source('vertex'))).toThrow(
      'resample missed 2112 of 2112 samples',
    )
  })
})

describe('a latitude/longitude grid', () => {
  /** `lat lon radius` rows every `step` degrees, both 0° and 360° written. */
  const gridText = (
    radius: (lat: number, lon: number) => number,
    step: number,
    lonFirst = false,
  ) => {
    const lines = ['# lat lon radius']
    for (let lat = -90; lat <= 90; lat += step)
      for (let lon = 0; lon <= 360; lon += step) {
        const r = km(radius(lat, lon))
        lines.push(lonFirst ? `${lon} ${lat} ${r}` : `${lat} ${lon} ${r}`)
      }
    return lines.join('\n')
  }

  it.each([
    ['lat-lon-radius', false],
    ['lon-lat-radius', true],
  ] as const)('reads %s columns onto the shipped grid', (columns, lonFirst) => {
    const text = gridText(() => 3_000, 5, lonFirst)
    const { field, volumeRatio, sourceDetail } = shapeFieldFrom(text, {
      ...source('grid', 128),
      columns,
    })
    // 0° and 360° are one meridian: 72 columns, not 73.
    expect(sourceDetail).toBe('72 × 37 grid')
    for (const radius of field.radii) expect(radius).toBeCloseTo(3_000, 6)
    // The same integral at the source's spacing and at the output's: they
    // differ by 0.04% at 72 × 37 against 128 × 65.
    expect(Math.abs(volumeRatio - 1)).toBeLessThan(0.001)
  })

  it('interpolates between the source samples, across the meridian too', () => {
    // Radius rising with longitude and stepping back down at 360°: the
    // samples between 355° and 360° are the one place the axis wraps.
    const text = gridText((_lat, lon) => 3_000 + (lon % 360), 5)
    const { field } = shapeFieldFrom(text, source('grid', 144))
    const row = (field.height - 1) / 2
    const at = (column: number) => field.radii[row * field.width + column]!
    // Column 1 is 2.5°, halfway between the 0° and 5° samples.
    expect(at(1)).toBeCloseTo(3_002.5, 3)
    // Column 143 is 357.5°, halfway between 355° and 360° (= 0°).
    expect(at(143)).toBeCloseTo((3_355 + 3_000) / 2, 3)
  })

  it('refuses a table too small to be a shape model', () => {
    expect(() =>
      shapeFieldFrom('0 0 1\n0 90 1\n90 0 1\n90 90 1', source('grid')),
    ).toThrow('test: parsed a 2 × 2 grid, which is not a shape model')
  })
})

describe('any smooth star-shaped body', () => {
  it('keeps its volume inside the tolerance', () => {
    const term = fc.record({
      amplitude: fc.double({ min: -0.12, max: 0.12, noNaN: true }),
      l: fc.integer({ min: 1, max: 3 }),
      m: fc.integer({ min: 0, max: 3 }),
      phase: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
    })
    fc.assert(
      fc.property(
        fc.double({ min: 200, max: 50_000, noNaN: true }),
        fc.array(term, { minLength: 1, maxLength: 3 }),
        (scale, terms) => {
          // Three terms of at most 12% each keep the radius above 64% of
          // `scale` everywhere, so every body is star-shaped about its center.
          const radius = (theta: number, phi: number) =>
            scale *
            (1 +
              terms.reduce(
                (sum, t) =>
                  sum +
                  t.amplitude *
                    Math.cos(t.l * theta) *
                    Math.cos(t.m * phi + t.phase),
                0,
              ))
          const { volumeRatio } = shapeFieldFrom(
            vertexTable(radialMesh(radius, 32, 64)),
            source('vertex'),
          )
          expect(Math.abs(volumeRatio - 1)).toBeLessThan(GRID_QUADRATURE)
        },
      ),
      { numRuns: 40 },
    )
  })
})
