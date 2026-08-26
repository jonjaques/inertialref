import type { Meters } from '@inertialref/shared'
import { deriveSeed, fbm3, type Seed } from '@inertialref/procedural'

/*
 * Bodies that are not spheres.
 *
 * Everything the renderer drew before this file existed was a scaled unit
 * sphere, optionally squashed along its spin axis. That is right for anything
 * gravity has rounded off — which is every planet, every large moon, and
 * Pluto — and it is *wrong* for the rest of the Solar System. Phobos is
 * 27 × 22 × 18 km with a nine-kilometer crater taken out of one end. Bennu is a
 * spinning top with an equatorial ridge. Kleopatra is a dog bone. Drawing any
 * of them as a ball is not a simplification, it is a different object.
 *
 * ## Why a radius grid and not a mesh
 *
 * A shape model is published as a triangle mesh or as a latitude/longitude grid
 * of radii, depending on who made it. This carries the grid, and converts the
 * meshes into one at ingest.
 *
 * The grid buys four things a mesh does not:
 *
 *   - **The texture already fits.** Every surface map in this project is
 *     equirectangular and the sphere it was written for has a known UV layout.
 *     A grid mesh *is* that sphere with the radii moved, so Phobos takes the
 *     same albedo map through the same material as Mars, seam and poles
 *     included. An arbitrary mesh needs a parameterization invented for it.
 *   - **Level of detail is subsampling.** Take every second row and column.
 *   - **The file is the data.** No indices, no vertex list, no normals: 16
 *     bytes of header and one `uint16` per sample. Phobos at 256 × 128 is 64 KB.
 *   - **The generated case and the measured case are the same case.** A small
 *     body with no published model gets a field out of its own seed, in the
 *     same format, through the same mesh builder.
 *
 * What it cannot represent is an overhang: one radius per direction means the
 * surface has to be star-shaped about the body's center. Every published model
 * that has been run through this is — including the bilobate ones, because a
 * neck is a saddle rather than a roof — and the ingest *measures* it, comparing
 * the reconstructed volume against the source mesh's and refusing a model that
 * loses more than a few percent. A body that genuinely overhangs itself would
 * fail that check loudly rather than ship quietly rounded off.
 *
 * ## Coordinates
 *
 * Rows run from the north pole (`theta = 0`) to the south, columns eastward
 * from the prime meridian, and the vertex layout below reproduces Three.js's
 * `SphereGeometry` exactly. That is not an implementation detail to be tidied
 * later: it is what makes a shape model a drop-in for the sphere it replaces,
 * and a body whose UVs disagree with the sphere's would have its map rotated by
 * some amount nobody could name.
 */

export interface ShapeField {
  /** Longitude samples. Column `width` is column 0 again — the grid wraps. */
  readonly width: number
  /** Latitude samples from north pole to south, both poles included. */
  readonly height: number
  /** Radii in meters, row-major, north pole row first. */
  readonly radii: Float32Array
}

const MAGIC = 0x4952534d /* 'IRSM' */
const VERSION = 1
const HEADER_BYTES = 20

/** Colatitude of row `row`, radians: 0 at the north pole, π at the south. */
export const shapeTheta = (field: ShapeField, row: number): number =>
  (Math.PI * row) / (field.height - 1)

/** East longitude of column `column`, radians. */
export const shapePhi = (field: ShapeField, column: number): number =>
  (2 * Math.PI * column) / field.width

const at = (field: ShapeField, row: number, column: number): number => {
  const r = Math.min(field.height - 1, Math.max(0, row))
  const c = ((column % field.width) + field.width) % field.width
  return field.radii[r * field.width + c] as number
}

/**
 * The radius in a direction, bilinearly.
 *
 * Used by the ingest's fidelity check and by anything that wants a surface
 * height without building a mesh. The mesh builder does not go through this —
 * it walks the grid it already has.
 */
export function sampleShapeField(
  field: ShapeField,
  theta: number,
  phi: number,
): Meters {
  const y =
    (Math.min(Math.PI, Math.max(0, theta)) / Math.PI) * (field.height - 1)
  const x = (phi / (2 * Math.PI)) * field.width
  const y0 = Math.floor(y)
  const x0 = Math.floor(x)
  const fy = y - y0
  const fx = x - x0
  const a = at(field, y0, x0)
  const b = at(field, y0, x0 + 1)
  const c = at(field, y0 + 1, x0)
  const d = at(field, y0 + 1, x0 + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

export interface ShapeExtent {
  readonly minRadius: Meters
  readonly maxRadius: Meters
  /** Volume-equivalent radius: the sphere of the same volume. */
  readonly meanRadius: Meters
  /** Enclosed volume, cubic meters. */
  readonly volume: number
  /**
   * Half-extents along the grid's three axes, largest first.
   *
   * This is the *bounding box* of the figure, not the semi-axes of a best-fit
   * ellipsoid, and the two differ by a percent or so on a lumpy body. It is
   * the bounding box that a published `extent` is: JPL's `0.5047 x 0.4918 x
   * 0.4567` for Bennu is the overall size of the thing. Comparing a
   * reconstruction against a published extent therefore has to compare like
   * with like, which is the entire reason this is computed rather than assumed.
   */
  readonly semiAxes: readonly [Meters, Meters, Meters]
}

/**
 * What the field measures, so that a claim about it can be checked.
 *
 * The volume is the sum of the spherical wedges under each cell, which for a
 * star-shaped surface is exact in the limit and converges from below. It is the
 * number the ingest compares against the source mesh's own volume: a radius
 * grid that lost a concavity has too *much* volume, and one sampled too coarsely
 * has too little, so a two-sided tolerance catches both.
 */
export function shapeExtent(field: ShapeField): ShapeExtent {
  let minRadius = Infinity
  let maxRadius = 0
  let volume = 0
  let extentX = 0
  let extentY = 0
  let extentZ = 0
  for (let row = 0; row < field.height; row += 1) {
    const theta = shapeTheta(field, row)
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)
    // Trapezoidal in latitude: the pole rows are half-cells.
    const dTheta =
      Math.PI /
      (field.height - 1) /
      (row === 0 || row === field.height - 1 ? 2 : 1)
    const band = sinTheta * dTheta * ((2 * Math.PI) / field.width)
    for (let column = 0; column < field.width; column += 1) {
      const radius = at(field, row, column)
      const phi = shapePhi(field, column)
      minRadius = Math.min(minRadius, radius)
      maxRadius = Math.max(maxRadius, radius)
      volume += (radius * radius * radius * band) / 3
      extentX = Math.max(extentX, Math.abs(radius * Math.cos(phi) * sinTheta))
      extentY = Math.max(extentY, Math.abs(radius * cosTheta))
      extentZ = Math.max(extentZ, Math.abs(radius * Math.sin(phi) * sinTheta))
    }
  }
  const axes: [number, number, number] = [extentX, extentY, extentZ]
  axes.sort((a, b) => b - a)
  return {
    minRadius,
    maxRadius,
    meanRadius: ((3 * volume) / (4 * Math.PI)) ** (1 / 3),
    volume,
    semiAxes: axes,
  }
}

/* ------------------------------------------------------------------------- */
/* The file                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Pack a field into the shipped form.
 *
 * `uint16` between the field's own extremes rather than a fixed scale, so the
 * quantization step is the body's relief over 65,535 — a centimeter on Phobos.
 * Storing absolute meters in a float would be four times the size to record
 * digits that are below the model's own uncertainty by three orders of
 * magnitude.
 */
export function encodeShapeField(field: ShapeField): Uint8Array {
  const { minRadius, maxRadius } = shapeExtent(field)
  const span = maxRadius - minRadius
  const bytes = new Uint8Array(HEADER_BYTES + 2 * field.width * field.height)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, MAGIC, false)
  view.setUint16(4, VERSION, true)
  view.setUint16(6, field.width, true)
  view.setUint16(8, field.height, true)
  view.setUint16(10, 0, true)
  view.setFloat32(12, minRadius, true)
  view.setFloat32(16, maxRadius, true)
  for (let i = 0; i < field.radii.length; i += 1) {
    const normalized =
      span === 0 ? 0 : ((field.radii[i] as number) - minRadius) / span
    view.setUint16(
      HEADER_BYTES + 2 * i,
      Math.round(Math.min(1, Math.max(0, normalized)) * 65535),
      true,
    )
  }
  return bytes
}

export function decodeShapeField(bytes: Uint8Array): ShapeField {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, false) !== MAGIC)
    throw new Error('not a shape model: bad magic')
  const version = view.getUint16(4, true)
  if (version !== VERSION)
    throw new Error(`shape model version ${version}, expected ${VERSION}`)
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  const minRadius = view.getFloat32(12, true)
  const maxRadius = view.getFloat32(16, true)
  const span = maxRadius - minRadius
  const radii = new Float32Array(width * height)
  for (let i = 0; i < radii.length; i += 1) {
    radii[i] =
      minRadius + (span * view.getUint16(HEADER_BYTES + 2 * i, true)) / 65535
  }
  return { width, height, radii }
}

/* ------------------------------------------------------------------------- */
/* The generated case                                                         */
/* ------------------------------------------------------------------------- */

export interface GeneratedShape {
  /** Measured semi-axes, meters, largest first. The ellipsoid underneath. */
  readonly semiAxes: readonly [Meters, Meters, Meters]
  /**
   * Radial roughness as a fraction of the mean radius, *after* the ellipsoid.
   *
   * Not a style knob, and not a free parameter: it is the residual standard
   * deviation of the radius about the body's own best-fit ellipsoid, which is
   * a thing that can be measured and has been. Across the twenty-five shape
   * models in `data/shapes/` it runs from 0.023 (Janus, a smooth potato) to
   * 0.61 (Ida, which is bent enough that an ellipsoid barely describes it),
   * with a median of 0.090.
   *
   * `docs/design/art.md` licenses the shape below the published axes as
   * generated. It does not license the axes.
   */
  readonly irregularity: number
  readonly width: number
  readonly height: number
}

/**
 * A lumpy body from its own seed, on the measured ellipsoid.
 *
 * The ellipsoid is a fact and the lumps are not, which is the same split the
 * terrain generator makes: `SurfaceParameters` takes a published `maxElevation`
 * and generates the shape below it. Here the published thing is the tri-axial
 * extent and the generated thing is everything between the samples.
 *
 * Two fields, because one does not read as a rock. The fBm gives the broad
 * asymmetry — a body that is heavier on one end — and the second, sharper
 * term is folded to be *negative only*: craters and spall scars go in, they do
 * not come out. A symmetric noise field makes a potato; an asymmetric one makes
 * something that has been hit.
 */
export function generateShapeField(
  seed: Seed,
  shape: GeneratedShape,
): ShapeField {
  const { semiAxes, irregularity, width, height } = shape
  const [a, b, c] = semiAxes
  const lumps = deriveSeed(seed, 'shape:lumps')
  const scars = deriveSeed(seed, 'shape:scars')
  /*
   * The displacement is log-normal about a measured sigma.
   *
   * `NOISE_SIGMA` is the standard deviation of `broad + 1.6·cut` over the
   * sphere at the frequencies below — 0.161, measured over twenty thousand
   * samples. Dividing by it is what makes `irregularity` mean the number it
   * says it means rather than "some amplitude"; without it, asking for 0.18
   * produced 0.03 and every generated body in the galaxy was a very slightly
   * dented ball.
   *
   * `exp` rather than `1 +` because a multiplier has to stay positive. At the
   * median roughness the two agree to a percent; at the roughness of a
   * Kleopatra, `1 + k·n` goes negative and turns the body inside out.
   */
  const NOISE_SIGMA = 0.161
  const k = irregularity / NOISE_SIGMA
  const radii = new Float32Array(width * height)
  const field: ShapeField = { width, height, radii }

  for (let row = 0; row < height; row += 1) {
    const theta = shapeTheta(field, row)
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)
    for (let column = 0; column < width; column += 1) {
      const phi = shapePhi(field, column)
      // The same axes the mesh builder uses, so the ellipsoid it lays down and
      // the ellipsoid measured back out of the grid are the same one.
      const x = -Math.cos(phi) * sinTheta
      const y = cosTheta
      const z = Math.sin(phi) * sinTheta
      // Radius of the ellipsoid in this direction: a-b in the equator, c polar.
      const ellipsoid =
        1 / Math.sqrt((x / a) * (x / a) + (y / c) * (y / c) + (z / b) * (z / b))
      const broad = fbm3(lumps, x * 2.6, y * 2.6, z * 2.6, { octaves: 4 })
      // Folded to be negative only: craters and spall scars go *in*. A
      // symmetric field makes a potato; an asymmetric one makes something that
      // has been hit, which is what all of these are.
      const cut = Math.min(
        0,
        fbm3(scars, x * 7.5, y * 7.5, z * 7.5, { octaves: 5 }) + 0.25,
      )
      /*
       * Clamped, and the clamp is measured too.
       *
       * A log-normal has a tail, and at the top of the roughness range it runs
       * away: asking for 0.5 produced bodies whose farthest point was
       * twenty-seven times their nearest, which is not an asteroid, it is a
       * sea urchin. Across the twenty-five shipped models the ratio runs from
       * 1.30 (Larissa) to 9.39 (Ida, which is a bent shard), so the exponent is
       * held inside `[-0.9, +0.6]` — a ratio of `e^1.5 = 4.5` at the extreme,
       * with the last stretch to Ida's 9.4 available only through the
       * *half-extents*, which is where a body that shape gets it from anyway.
       */
      const displacement = Math.min(
        0.6,
        Math.max(-0.9, k * (broad + cut * 1.6)),
      )
      radii[row * width + column] = ellipsoid * Math.exp(displacement)
    }
  }
  // The poles are one point, not a row of them: a grid that samples the noise
  // independently across the top row makes a fan of spikes where they meet.
  collapsePole(field, 0)
  collapsePole(field, height - 1)
  /*
   * And then the volume is put back, exactly.
   *
   * The correction used to be the analytic log-normal mean, `exp(-k²σ²/2)`, and
   * it does not survive contact with this field: the displacement is clamped,
   * the `cut` term is folded to be negative-only, and neither of those is the
   * Gaussian that identity assumes. Measured before this: the enclosed volume
   * came out 1.004 times the ellipsoid's at the median roughness and **1.37
   * times** at the top of the range, so a rough body was quietly a third
   * larger than the half-extents it was handed.
   *
   * That matters because the half-extents are where the *mass* came from —
   * `irregularFigure` solves `a·b·c = r̄³` precisely so the class density comes
   * back out — and because `docs/design/art.md` licenses the shape below the
   * published axes and not the size. A uniform rescale to the ellipsoid's own
   * volume makes the guarantee exact rather than approximate, costs one pass,
   * and changes no shape at all: every radius moves by the same factor.
   */
  const target = ((4 / 3) * Math.PI * a * b * c) / shapeExtent(field).volume
  const scale = target ** (1 / 3)
  for (let i = 0; i < radii.length; i += 1)
    radii[i] = (radii[i] as number) * scale
  return field
}

function collapsePole(field: ShapeField, row: number): void {
  let sum = 0
  for (let column = 0; column < field.width; column += 1)
    sum += field.radii[row * field.width + column] as number
  const mean = sum / field.width
  for (let column = 0; column < field.width; column += 1)
    field.radii[row * field.width + column] = mean
}

/* ------------------------------------------------------------------------- */
/* The mesh                                                                   */
/* ------------------------------------------------------------------------- */

export interface ShapeMesh {
  /** Positions in units of `referenceRadius`, so the renderer scales by one number. */
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array
  readonly indices: Uint32Array
  readonly vertexCount: number
  readonly triangleCount: number
}

/**
 * The grid as a drawable mesh, in Three.js `SphereGeometry`'s own layout.
 *
 * `stride` subsamples: 1 takes every row and column, 2 takes every second. It
 * is how a body a dozen pixels across avoids paying for a 65,000-triangle
 * Phobos, and it is exact — the coarse mesh is the fine one's own samples, not
 * a decimation with its own error.
 *
 * Normals are computed from the finished positions rather than from the
 * ellipsoid, which is the entire point: a radial normal would shade a crater
 * exactly as if it were not there.
 */
export function buildShapeMesh(
  field: ShapeField,
  referenceRadius: Meters,
  stride = 1,
): ShapeMesh {
  const step = Math.max(1, Math.floor(stride))
  // Columns wrap, so the count is a division; rows do not, so the last row is
  // forced in even when the stride does not land on it — dropping it would
  // leave the south pole open.
  const columns = Math.max(8, Math.floor(field.width / step))
  const rowIndices: number[] = []
  for (let row = 0; row < field.height - 1; row += step) rowIndices.push(row)
  rowIndices.push(field.height - 1)

  const rows = rowIndices.length
  // One extra column: the seam vertex is duplicated with u = 1 rather than 0,
  // or the last quad of every ring samples the whole map backwards.
  const across = columns + 1
  const vertexCount = across * rows
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const scale = 1 / referenceRadius

  for (let j = 0; j < rows; j += 1) {
    const row = rowIndices[j] as number
    const v = row / (field.height - 1)
    const theta = Math.PI * v
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)
    for (let i = 0; i < across; i += 1) {
      const u = i / columns
      const phi = 2 * Math.PI * u
      const radius = sampleShapeField(field, theta, phi) * scale
      const index = j * across + i
      positions[index * 3] = -Math.cos(phi) * sinTheta * radius
      positions[index * 3 + 1] = cosTheta * radius
      positions[index * 3 + 2] = Math.sin(phi) * sinTheta * radius
      uvs[index * 2] = u
      uvs[index * 2 + 1] = 1 - v
    }
  }

  const indices = new Uint32Array((across - 1) * (rows - 1) * 6)
  let out = 0
  for (let j = 0; j < rows - 1; j += 1) {
    for (let i = 0; i < across - 1; i += 1) {
      const a = j * across + i
      const b = a + 1
      const c = a + across
      const d = c + 1
      // Degenerate triangles at the poles are skipped rather than emitted with
      // zero area: a zero-area face contributes a NaN normal to its vertices.
      if (j !== 0) {
        indices[out] = a
        indices[out + 1] = c
        indices[out + 2] = b
        out += 3
      }
      if (j !== rows - 2) {
        indices[out] = b
        indices[out + 1] = c
        indices[out + 2] = d
        out += 3
      }
    }
  }
  const used = indices.subarray(0, out)
  accumulateNormals(positions, normals, used)
  // The seam's two copies are the same point and must not shade differently:
  // averaging only the faces on one side leaves a visible crease down the
  // anti-meridian, which is exactly where a texture seam already is.
  weldSeamNormals(normals, across, rows)
  /*
   * The pole is `across` copies of one point, and each of them collects only
   * the two triangles beside it — so the ring of vertices at the top of the
   * body ends up with `across` different normals fanned around the axis, and
   * the shading pinwheels. `SphereGeometry` gets away with the same layout
   * because its pole normal is exactly the axis whichever face you ask; a
   * lumpy body's is not, and the artifact is visible on anything whose pole
   * faces the camera.
   */
  weldRowNormals(normals, across, 0)
  weldRowNormals(normals, across, rows - 1)
  normalize(normals)

  return {
    positions,
    normals,
    uvs,
    indices: used.slice(),
    vertexCount,
    triangleCount: out / 3,
  }
}

function accumulateNormals(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
): void {
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] as number) * 3
    const b = (indices[i + 1] as number) * 3
    const c = (indices[i + 2] as number) * 3
    const ax = (positions[b] as number) - (positions[a] as number)
    const ay = (positions[b + 1] as number) - (positions[a + 1] as number)
    const az = (positions[b + 2] as number) - (positions[a + 2] as number)
    const bx = (positions[c] as number) - (positions[a] as number)
    const by = (positions[c + 1] as number) - (positions[a + 1] as number)
    const bz = (positions[c + 2] as number) - (positions[a + 2] as number)
    // Unnormalized, so a large face weighs more than a small one — which is
    // the standard area-weighted average and the right one for a grid whose
    // cells shrink toward the poles.
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    for (const vertex of [a, b, c]) {
      normals[vertex] = (normals[vertex] as number) + nx
      normals[vertex + 1] = (normals[vertex + 1] as number) + ny
      normals[vertex + 2] = (normals[vertex + 2] as number) + nz
    }
  }
}

function weldSeamNormals(
  normals: Float32Array,
  across: number,
  rows: number,
): void {
  for (let j = 0; j < rows; j += 1) {
    const first = j * across * 3
    const last = (j * across + across - 1) * 3
    for (let k = 0; k < 3; k += 1) {
      const sum = (normals[first + k] as number) + (normals[last + k] as number)
      normals[first + k] = sum
      normals[last + k] = sum
    }
  }
}

/** Every vertex in a row shares one normal. Used for the two pole rows. */
function weldRowNormals(
  normals: Float32Array,
  across: number,
  row: number,
): void {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < across; i += 1) {
    const base = (row * across + i) * 3
    x += normals[base] as number
    y += normals[base + 1] as number
    z += normals[base + 2] as number
  }
  for (let i = 0; i < across; i += 1) {
    const base = (row * across + i) * 3
    normals[base] = x
    normals[base + 1] = y
    normals[base + 2] = z
  }
}

function normalize(normals: Float32Array): void {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i] as number
    const y = normals[i + 1] as number
    const z = normals[i + 2] as number
    const length = Math.hypot(x, y, z)
    if (length === 0) {
      normals[i + 1] = 1
      continue
    }
    normals[i] = x / length
    normals[i + 1] = y / length
    normals[i + 2] = z / length
  }
}
