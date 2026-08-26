import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { deriveSeed, rootSeed } from '@inertialref/procedural'
import {
  buildShapeMesh,
  decodeShapeField,
  encodeShapeField,
  generateShapeField,
  sampleShapeField,
  type ShapeField,
  shapeExtent,
  shapePhi,
  shapeTheta,
} from './shape.ts'

/*
 * The geometry of bodies that are not spheres.
 *
 * Three things have to hold, and each of them failed at least once on the way
 * here.
 *
 *   **The file is lossless enough to be a measurement.** A shape model is
 *   quantized to 16 bits between its own extremes; the round trip has to
 *   preserve the volume and the half-extents to far better than the model's own
 *   uncertainty, or the thing shipped is not the thing measured.
 *
 *   **The mesh is closed, correctly wound and correctly parameterized.** A
 *   sphere's UV layout is what makes an equirectangular map fit it, and a
 *   shape mesh has to reproduce it exactly — every surface map in the project
 *   was written for the sphere this replaces.
 *
 *   **The generated figure looks like the measured ones.** `irregularFigure`
 *   claims its distribution comes from the twenty-five vendored models. That is
 *   a claim about the population it produces, so it is checked as one.
 */

const SEED = rootSeed('shape-test')

const ellipsoid = (a: number, b: number, c: number, width = 64): ShapeField => {
  const height = width / 2 + 1
  const radii = new Float32Array(width * height)
  const field: ShapeField = { width, height, radii }
  for (let row = 0; row < height; row += 1) {
    const theta = shapeTheta(field, row)
    for (let column = 0; column < width; column += 1) {
      const phi = shapePhi(field, column)
      const x = -Math.cos(phi) * Math.sin(theta)
      const y = Math.cos(theta)
      const z = Math.sin(phi) * Math.sin(theta)
      radii[row * width + column] =
        1 / Math.sqrt((x / a) ** 2 + (y / c) ** 2 + (z / b) ** 2)
    }
  }
  return field
}

describe('the shape field', () => {
  it('measures an ellipsoid it was given', () => {
    /*
     * The calibration of everything else here. An ellipsoid has a known volume
     * — `4/3 π a b c` — and known half-extents, so if `shapeExtent` can recover
     * those from a grid of radii then the integral and the axis convention are
     * both right. The 0.3% is the grid: 64 columns is a 5.6° cell, and the
     * wedge sum converges from below at second order.
     */
    for (const [a, b, c] of [
      [1, 1, 1],
      [13_258, 11_865, 9_827], // Phobos, in meters.
      [17_556, 8_586, 6_073], // Eros, which is nearly three times as long as wide.
    ] as const) {
      const extent = shapeExtent(ellipsoid(a, b, c, 256))
      const volume = (4 / 3) * Math.PI * a * b * c
      expect(Math.abs(extent.volume / volume - 1)).toBeLessThan(0.003)
      expect(Math.abs(extent.semiAxes[0] / a - 1)).toBeLessThan(0.003)
      expect(Math.abs(extent.semiAxes[1] / b - 1)).toBeLessThan(0.01)
      expect(Math.abs(extent.semiAxes[2] / c - 1)).toBeLessThan(0.003)
      expect(
        Math.abs(extent.meanRadius / (a * b * c) ** (1 / 3) - 1),
      ).toBeLessThan(0.002)
    }
  })

  it('survives the round trip through the shipped file (property)', () => {
    /*
     * 16-bit quantization between the field's own extremes, so the error is
     * bounded by the *relief* over 65,535 rather than by the radius — which for
     * Phobos is 5 cm on a body 27 km across. The bound below is a hundred times
     * that and still four orders of magnitude inside the model's own
     * uncertainty, which for Thomas's Phobos is 100 m.
     */
    fc.assert(
      fc.property(
        fc.double({ min: 0.3, max: 1, noNaN: true }),
        fc.double({ min: 0.3, max: 1, noNaN: true }),
        fc.double({ min: 100, max: 1e6, noNaN: true }),
        (bOverA, cOverA, a) => {
          const field = ellipsoid(a, a * bOverA, a * cOverA)
          const back = decodeShapeField(encodeShapeField(field))
          expect(back.width).toBe(field.width)
          expect(back.height).toBe(field.height)
          for (let i = 0; i < field.radii.length; i += 1) {
            const error = Math.abs(
              (back.radii[i] as number) - (field.radii[i] as number),
            )
            expect(error / a).toBeLessThan(1e-4)
          }
        },
      ),
      { numRuns: 40 },
    )
  })

  it('rejects a file that is not one', () => {
    expect(() => decodeShapeField(new Uint8Array(32))).toThrow(/magic/)
    const bytes = encodeShapeField(ellipsoid(1, 1, 1))
    new DataView(bytes.buffer).setUint16(4, 99, true)
    expect(() => decodeShapeField(bytes)).toThrow(/version/)
  })

  it('samples between its own grid points', () => {
    // A sphere is the case where interpolation has a known answer everywhere.
    const field = ellipsoid(1_000, 1_000, 1_000)
    for (let i = 0; i < 200; i += 1) {
      const theta = (Math.PI * (i + 0.37)) / 200
      const phi = (2 * Math.PI * (i * 7 + 0.19)) / 200
      expect(
        Math.abs(sampleShapeField(field, theta, phi) / 1_000 - 1),
      ).toBeLessThan(1e-3)
    }
  })
})

describe('the mesh', () => {
  const field = ellipsoid(13_258, 11_865, 9_827, 128)

  it('reproduces the sphere UV layout a surface map was written for', () => {
    /*
     * The assertion that lets Phobos take an equirectangular albedo map through
     * the same material as Mars.
     *
     * Three.js `SphereGeometry` puts `u = 0` at `+x`-ish and runs it eastward,
     * `v = 1` at the north pole, and duplicates the seam column so the last
     * quad of every ring does not sample the whole map backwards. All three are
     * checked here, because all three are invisible until a texture arrives and
     * then all three are catastrophic.
     */
    const mesh = buildShapeMesh(field, 13_258)
    let north = 0
    let south = 0
    let seam = 0
    for (let i = 0; i < mesh.uvs.length; i += 2) {
      const u = mesh.uvs[i] as number
      const v = mesh.uvs[i + 1] as number
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      if (v === 1) north += 1
      if (v === 0) south += 1
      if (u === 1) seam += 1
      // v runs with +y: the north pole is v = 1.
      const y = mesh.positions[(i / 2) * 3 + 1] as number
      if (v > 0.999) expect(y).toBeGreaterThan(0)
      if (v < 0.001) expect(y).toBeLessThan(0)
    }
    // One full ring of duplicated vertices at each pole and down the seam.
    expect(north).toBeGreaterThan(1)
    expect(south).toBeGreaterThan(1)
    expect(seam).toBe(mesh.vertexCount / (mesh.vertexCount / seam))
    expect(seam).toBeGreaterThan(1)
  })

  it('has no degenerate faces and no NaN normals', () => {
    /*
     * The pole is one point sampled `width` times, so the quads that touch it
     * are triangles with a zero-length edge. Emitting them as triangles anyway
     * gives every pole vertex a NaN normal — and a NaN normal is not a dark
     * spot, it is a hole, because the shading of every fragment that
     * interpolates it is NaN.
     */
    for (const stride of [1, 2, 4, 8]) {
      const mesh = buildShapeMesh(field, 13_258, stride)
      for (let i = 0; i < mesh.normals.length; i += 1)
        expect(Number.isFinite(mesh.normals[i])).toBe(true)
      for (let i = 0; i < mesh.normals.length; i += 3) {
        const length = Math.hypot(
          mesh.normals[i] as number,
          mesh.normals[i + 1] as number,
          mesh.normals[i + 2] as number,
        )
        expect(Math.abs(length - 1)).toBeLessThan(1e-5)
      }
      for (let i = 0; i < mesh.indices.length; i += 3) {
        expect(mesh.indices[i]).not.toBe(mesh.indices[i + 1])
        expect(mesh.indices[i + 1]).not.toBe(mesh.indices[i + 2])
        expect(mesh.indices[i]).not.toBe(mesh.indices[i + 2])
      }
    }
  })

  it('points its normals outward', () => {
    // A mesh wound the wrong way is invisible from outside and lit from
    // inside, which reads as "the body did not load" rather than as a bug.
    const mesh = buildShapeMesh(field, 13_258)
    let inward = 0
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const px = mesh.positions[i] as number
      const py = mesh.positions[i + 1] as number
      const pz = mesh.positions[i + 2] as number
      const dot =
        px * (mesh.normals[i] as number) +
        py * (mesh.normals[i + 1] as number) +
        pz * (mesh.normals[i + 2] as number)
      if (dot < 0) inward += 1
    }
    expect(inward).toBe(0)
  })

  it('is the same body at every level of detail', () => {
    /*
     * A stride is a subsample, not a decimation — the coarse mesh is the fine
     * one's own samples. So the volume it encloses may only lose the detail it
     * skipped, and must not *move*: a body that got 8% smaller when it dropped
     * a tier would pulse as it approached.
     */
    const reference = shapeExtent(field)
    for (const stride of [1, 2, 4]) {
      const mesh = buildShapeMesh(field, 13_258, stride)
      let volume = 0
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = (mesh.indices[i] as number) * 3
        const b = (mesh.indices[i + 1] as number) * 3
        const c = (mesh.indices[i + 2] as number) * 3
        const ax = mesh.positions[a] as number
        const ay = mesh.positions[a + 1] as number
        const az = mesh.positions[a + 2] as number
        const bx = mesh.positions[b] as number
        const by = mesh.positions[b + 1] as number
        const bz = mesh.positions[b + 2] as number
        const cx = mesh.positions[c] as number
        const cy = mesh.positions[c + 1] as number
        const cz = mesh.positions[c + 2] as number
        volume +=
          (ax * (by * cz - bz * cy) +
            ay * (bz * cx - bx * cz) +
            az * (bx * cy - by * cx)) /
          6
      }
      // In units of the reference radius, cubed.
      const scaled = Math.abs(volume) * 13_258 ** 3
      expect(
        `stride ${stride}: ${Math.abs(scaled / reference.volume - 1) < 0.03}`,
      ).toBe(`stride ${stride}: true`)
    }
  })

  it('normalizes to the radius the renderer scales by', () => {
    // The mesh is drawn at `placement.scale`, which is the body's own radius,
    // so the mesh's longest half-extent has to come out at 1. Anything else is
    // an asteroid the wrong size, which is invisible in isolation.
    const mesh = buildShapeMesh(field, 13_258)
    let longest = 0
    for (let i = 0; i < mesh.positions.length; i += 3)
      longest = Math.max(longest, Math.abs(mesh.positions[i] as number))
    expect(Math.abs(longest - 1)).toBeLessThan(0.01)
  })
})

describe('the generated figure', () => {
  it('is a pure function of its seed', () => {
    // The same body has to be the same shape in two sessions, on two machines,
    // and in the two React mounts StrictMode makes.
    const shape = {
      semiAxes: [1_000, 700, 550] as [number, number, number],
      irregularity: 0.2,
      width: 64,
      height: 33,
    }
    const a = generateShapeField(deriveSeed(SEED, 'b:4'), shape)
    const b = generateShapeField(deriveSeed(SEED, 'b:4'), shape)
    expect([...a.radii]).toEqual([...b.radii])
    const other = generateShapeField(deriveSeed(SEED, 'b:5'), shape)
    expect([...a.radii]).not.toEqual([...other.radii])
  })

  it('encloses exactly the volume its half-extents describe (property)', () => {
    /*
     * The split this whole system rests on: the axes are a measurement and the
     * lumps are not.
     *
     * `irregularFigure` solves `a·b·c = r̄³` so that a generated body's class
     * density comes back out of its mass, and `docs/design/art.md` licenses the
     * shape below the published axes and not the size. So the field's enclosed
     * volume has to be the ellipsoid's, at every roughness — which it is now by
     * construction rather than by an analytic correction that did not survive
     * the clamp. Measured before the rescale: 1.004 at the median roughness and
     * **1.37** at the top of the range.
     */
    fc.assert(
      fc.property(
        fc.double({ min: 0.45, max: 1, noNaN: true }),
        fc.double({ min: 0.45, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 0.45, noNaN: true }),
        fc.integer({ min: 0, max: 500 }),
        (bOverA, cOverB, irregularity, index) => {
          const a = 5_000
          const b = a * bOverA
          const c = b * cOverB
          const field = generateShapeField(deriveSeed(SEED, `b:${index}`), {
            semiAxes: [a, b, c],
            irregularity,
            width: 64,
            height: 33,
          })
          const extent = shapeExtent(field)
          const ellipsoid = (4 / 3) * Math.PI * a * b * c
          // 1% rather than exact: `shapeExtent`'s wedge sum is second-order in
          // the grid spacing and 64 columns is a 5.6° cell, so the same
          // integral is used on both sides and the residual is the rescale's
          // own convergence.
          expect(Math.abs(extent.volume / ellipsoid - 1)).toBeLessThan(0.01)
          expect(extent.minRadius).toBeGreaterThan(0)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('keeps its lumps to the size a lump is', () => {
    /*
     * The other half, and the number the loose version of this test failed to
     * pin down. It asserted `exp(0.6)` — 1.82 — while its comment claimed 30%,
     * so it could not fail for any input in its own range.
     *
     * What is actually true is subtler and worth writing down, because the two
     * classes of body normalize differently and `radius` means slightly
     * different things in each. For a body with a *shipped model*, `radius` is
     * the measured bounding box, so nothing ever exceeds it. For a *generated*
     * body it is the reference ellipsoid's semi-axis, and lumps stand above it
     * — which is what a lump is. Measured across the range at 128 × 65:
     *
     * ```
     *   irregularity   mean max/a   worst max/a
     *   0.02           1.03         1.04
     *   0.09           1.17         1.28
     *   0.18           1.42         1.63
     *   0.45           1.50         1.57
     * ```
     *
     * 1.75 is the bound that holds across all of it with headroom and would
     * still catch the exponential running away, which is what it is for.
     */
    for (const irregularity of [0.02, 0.09, 0.18, 0.3, 0.45]) {
      for (let seed = 0; seed < 12; seed += 1) {
        const a = 5_000
        const field = generateShapeField(deriveSeed(SEED, `lump:${seed}`), {
          semiAxes: [a, a * 0.7, a * 0.5],
          irregularity,
          width: 64,
          height: 33,
        })
        const extent = shapeExtent(field)
        const label = `${irregularity} #${seed}`
        expect(`${label}: ${extent.maxRadius / a < 1.75}`).toBe(
          `${label}: true`,
        )
        expect(`${label}: ${extent.minRadius > 0}`).toBe(`${label}: true`)
      }
    }
  })

  it('closes its poles', () => {
    /*
     * A latitude/longitude grid samples the pole `width` times at the same
     * point. Sampling the noise independently at each of them makes a fan of
     * spikes where they meet — which looks exactly like a corrupted mesh, and
     * was.
     */
    const field = generateShapeField(SEED, {
      semiAxes: [1_000, 800, 600],
      irregularity: 0.4,
      width: 64,
      height: 33,
    })
    for (const row of [0, field.height - 1]) {
      const first = field.radii[row * field.width] as number
      for (let column = 1; column < field.width; column += 1)
        expect(field.radii[row * field.width + column]).toBe(first)
    }
  })

  it('produces the population the measured bodies do', () => {
    /*
     * The claim `irregularFigure` makes, checked as a claim about a
     * distribution rather than about one draw.
     *
     * Across the twenty-five published shape models in `data/shapes/`, the
     * radial standard deviation about each body's own best-fit ellipsoid runs
     * from 0.023 (Janus) to 0.61 (Ida) with a median of 0.090, and
     * `irregularity` is defined to be that number. So a generator asked for
     * 0.09 has to *produce* 0.09 — which is what makes this a calibration
     * rather than a smoke test, and it is how the first version was caught:
     * asked for 0.18 it delivered 0.03, because the fBm's own standard
     * deviation is a sixth of its range and nothing divided it out. Every
     * generated body in the galaxy was a very slightly dented ball.
     */
    const roughness: number[] = []
    // 80 bodies rather than 200: each is 2,112 samples of nine octaves of 3D
    // noise, and 200 of them took long enough to trip vitest's own timeout.
    for (let i = 0; i < 80; i += 1) {
      const irregularity = 0.05 + (0.45 * i) / 80
      const field = generateShapeField(deriveSeed(SEED, `body:${i}`), {
        semiAxes: [1_000, 1_000, 1_000],
        irregularity,
        width: 64,
        height: 33,
      })
      const mean = shapeExtent(field).meanRadius
      let sum = 0
      for (const radius of field.radii) sum += (radius - mean) ** 2
      roughness.push(Math.sqrt(sum / field.radii.length) / mean)
    }
    // Asked for `0.05 + 0.45·i/200`, so the median ask is 0.275 and the
    // extremes are 0.05 and 0.50. The delivered value has to track it within
    // 20% — the clamp on the log-normal tail bites at the top of the range,
    // deliberately, so the agreement is closest where real bodies live.
    roughness.sort((a, b) => a - b)
    const median = roughness[Math.floor(roughness.length / 2)] as number
    expect(roughness[0]).toBeGreaterThan(0.04)
    expect(roughness[0]).toBeLessThan(0.07)
    expect(median).toBeGreaterThan(0.22)
    expect(median).toBeLessThan(0.32)
  })

  it('is not a sphere, at any irregularity worth the name', () => {
    // The regression for the whole change. A generated small body that came
    // back spherical would be indistinguishable from the bug this replaced.
    for (const irregularity of [0.1, 0.2, 0.4]) {
      const field = generateShapeField(SEED, {
        semiAxes: [1_000, 1_000, 1_000],
        irregularity,
        width: 64,
        height: 33,
      })
      const extent = shapeExtent(field)
      // 1.30 is Larissa, the roundest body in `data/shapes/`. Anything the
      // generator calls irregular has to be at least as lumpy as the least
      // lumpy thing anyone has measured.
      expect(
        `${irregularity}: ${extent.maxRadius / extent.minRadius > 1.3}`,
      ).toBe(`${irregularity}: true`)
    }
  })
})
