import { fbm3, seedFromNumber } from '@inertialref/procedural'

/*
 * The four shapes every rock on every world is drawn from.
 *
 * There are no authored assets ([art](../../../docs/design/art.md) says when
 * there will be), so these are generated: a subdivided icosahedron with its
 * vertices pushed in and out by the same fBm the terrain uses, at a frequency
 * low enough that a rock reads as a rock rather than as a lump of noise.
 *
 * **Shape is per variant and attitude is per instance**, which is what keeps the
 * whole scatter to a handful of draw calls. A field of two thousand boulders is
 * four `InstancedMesh`es; what makes them look like two thousand different rocks
 * is the spin, the tilt, the non-uniform scale and how far each is buried, all
 * of which are per-instance and free.
 *
 * **Angularity is topology, not shading.** A weathered boulder is smooth-normal
 * over many faces; a freshly broken block is flat-normal over few. Faking the
 * second by hardening the normals of the first gives a faceted sphere, which
 * reads as a low-poly asset rather than as broken rock — the silhouette is what
 * says which it is, and the silhouette is the vertex count. So the angular
 * variants are one subdivision with flat normals and a stronger displacement,
 * and the rounded ones are two with smooth normals and a gentler one.
 *
 * Plain arrays, no Three.js, generated once per variant and shared by every
 * instance on every body — `packages/rendering` is the layer that may not import
 * a renderer, and a rock is the same rock whoever draws it.
 */

/** One variant's buffers, ready to be handed to a renderer verbatim. */
export interface RockMesh {
  /** xyz triples, in the rock's own axes, longest half-extent 1. */
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint16Array
  /** How faceted this variant is, 0 rounded to 1 angular. */
  readonly angularity: number
}

/**
 * A variant's own angularity, ordered rounded to angular.
 *
 * `scatterVariant` picks by nearest, so a rock whose geology says 0.7 lands on
 * the third and one that says 0.1 lands on the first.
 */
const ANGULARITY: readonly number[] = [0.1, 0.4, 0.7, 0.95]

/**
 * How many shapes there are.
 *
 * Four, and it is a taste judgment with a cost behind it: each is a draw call
 * and a geometry, and a scatter field near the camera is a few thousand
 * instances spread over them. Two is visibly two, and eight is four more
 * pipelines to compile at boot for a difference nobody looking at a rock field
 * can name.
 *
 * Counted off `ANGULARITY` rather than written down beside it, because the
 * three tables below are indexed by variant and a count that outran them built
 * a mesh out of `undefined` — every vertex `NaN`, cached under that key, and
 * nothing anywhere throwing.
 */
export const ROCK_VARIANTS = ANGULARITY.length

const cache = new Map<number, RockMesh>()

/** The variant whose angularity is closest to what a rock asks for. */
export function scatterVariant(angularity: number): number {
  let best = 0
  let gap = Infinity
  for (let i = 0; i < ROCK_VARIANTS; i += 1) {
    const distance = Math.abs((ANGULARITY[i] as number) - angularity)
    if (distance < gap) {
      gap = distance
      best = i
    }
  }
  return best
}

/**
 * One rock shape.
 *
 * Memoized because it is a pure function of the variant and the renderer wants
 * the same buffer object every time — a fresh array per call would be a fresh
 * GPU upload per call, which is the whole reason the shapes are shared.
 */
export function rockMesh(variant: number): RockMesh {
  const held = cache.get(variant)
  if (held !== undefined) return held
  const built = build(variant)
  cache.set(variant, built)
  return built
}

/**
 * How far a vertex is pushed off the unit sphere, as a fraction of the radius.
 *
 * Half, at the angular end. A rock is not a perturbed sphere — its aspect ratio
 * is nearer 1.5:1 than 1.05:1 — and the non-uniform per-instance scale supplies
 * the elongation, so what this has to supply is the *facets*: lobes and hollows
 * a few across the body, which at this amplitude read as fracture rather than as
 * dimples.
 */
const RELIEF = [0.22, 0.3, 0.42, 0.5]

/** Lobes across the rock. Low: a rock has three or four, not thirty. */
const LOBES = [2.1, 2.6, 1.9, 2.3]

function build(variant: number): RockMesh {
  const angularity = ANGULARITY[variant] as number
  const smooth = angularity < 0.55
  const { positions, indices } = icosphere(smooth ? 2 : 1)
  const seed = seedFromNumber(0x52_4f_43_00 + variant)
  const relief = RELIEF[variant] as number
  const lobes = LOBES[variant] as number

  // Push each vertex along its own radius. The domain is the unit direction, so
  // two vertices at the same place get the same displacement however the mesh
  // was subdivided — which is what keeps the shape watertight.
  let peak = 0
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number
    const y = positions[i + 1] as number
    const z = positions[i + 2] as number
    const noise = fbm3(seed, x * lobes, y * lobes, z * lobes, { octaves: 3 })
    const scale = 1 + relief * noise
    positions[i] = x * scale
    positions[i + 1] = y * scale
    positions[i + 2] = z * scale
    // `scale` *is* the length: the icosphere's vertices are on the unit sphere,
    // so measuring the displaced one back out is a hypot that cancels.
    peak = Math.max(peak, scale)
  }
  /*
   * Normalized so the longest half-extent is exactly one.
   *
   * The instance scale is the rock's radius in meters, so a variant that came
   * out 1.4 across would be 40% larger than the size the geology asked for —
   * and by a different amount per variant, which reads as four rock species of
   * four different sizes rather than one population.
   */
  for (let i = 0; i < positions.length; i += 1) {
    positions[i] = (positions[i] as number) / peak
  }

  return smooth
    ? {
        positions,
        normals: smoothNormals(positions, indices),
        indices,
        angularity,
      }
    : { ...flatten(positions, indices), angularity }
}

/**
 * A subdivided icosahedron, vertices on the unit sphere.
 *
 * Icosahedral rather than a UV sphere for the ordinary reason — no pole, no
 * seam, near-uniform triangle area — and because the subdivision count is the
 * one dial that decides both the silhouette and the facet size, which is what
 * `angularity` is choosing between.
 */
function icosphere(subdivisions: number): {
  positions: Float32Array
  indices: Uint16Array
} {
  const t = (1 + Math.sqrt(5)) / 2
  const points: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(([x, y, z]) => {
    const length = Math.hypot(x as number, y as number, z as number)
    return [
      (x as number) / length,
      (y as number) / length,
      (z as number) / length,
    ]
  })
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ]

  for (let pass = 0; pass < subdivisions; pass += 1) {
    // Edge midpoints, shared between the two faces that meet on them — a fresh
    // vertex per face would leave the mesh split along every edge, which is a
    // seam in the normals and four times the vertices.
    const midpoints = new Map<string, number>()
    const middle = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const held = midpoints.get(key)
      if (held !== undefined) return held
      const pa = points[a] as number[]
      const pb = points[b] as number[]
      const x = ((pa[0] as number) + (pb[0] as number)) / 2
      const y = ((pa[1] as number) + (pb[1] as number)) / 2
      const z = ((pa[2] as number) + (pb[2] as number)) / 2
      const length = Math.hypot(x, y, z)
      points.push([x / length, y / length, z / length])
      const index = points.length - 1
      midpoints.set(key, index)
      return index
    }
    const next: number[][] = []
    for (const [a, b, c] of faces) {
      const ab = middle(a as number, b as number)
      const bc = middle(b as number, c as number)
      const ca = middle(c as number, a as number)
      next.push(
        [a as number, ab, ca],
        [b as number, bc, ab],
        [c as number, ca, bc],
        [ab, bc, ca],
      )
    }
    faces = next
  }

  const positions = new Float32Array(points.length * 3)
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] as number[]
    positions[i * 3] = point[0] as number
    positions[i * 3 + 1] = point[1] as number
    positions[i * 3 + 2] = point[2] as number
  }
  const indices = new Uint16Array(faces.length * 3)
  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i] as number[]
    indices[i * 3] = face[0] as number
    indices[i * 3 + 1] = face[1] as number
    indices[i * 3 + 2] = face[2] as number
  }
  return { positions, indices }
}

/** Area-weighted vertex normals: the sum of the faces that meet at a vertex. */
function smoothNormals(
  positions: Float32Array,
  indices: Uint16Array,
): Float32Array {
  const normals = new Float32Array(positions.length)
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
    // Not normalized: the cross product's length is twice the triangle's area,
    // which is exactly the weight a vertex normal wants.
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const at of [a, b, c]) {
      normals[at] = (normals[at] as number) + nx
      normals[at + 1] = (normals[at + 1] as number) + ny
      normals[at + 2] = (normals[at + 2] as number) + nz
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length =
      Math.hypot(
        normals[i] as number,
        normals[i + 1] as number,
        normals[i + 2] as number,
      ) || 1
    normals[i] = (normals[i] as number) / length
    normals[i + 1] = (normals[i + 1] as number) / length
    normals[i + 2] = (normals[i + 2] as number) / length
  }
  return normals
}

/**
 * De-index, so every triangle owns its three vertices and its own face normal.
 *
 * Three times the vertices for a shape with eighty triangles, which is 240
 * against 42 — and it is what a fractured block is: the facet is the feature,
 * and a shared vertex averages the two faces that meet on it into a bevel.
 */
function flatten(
  positions: Float32Array,
  indices: Uint16Array,
): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  const out = new Float32Array(indices.length * 3)
  const normals = new Float32Array(indices.length * 3)
  const flatIndices = new Uint16Array(indices.length)
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
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz) || 1
    nx /= length
    ny /= length
    nz /= length
    for (let corner = 0; corner < 3; corner += 1) {
      const from = [a, b, c][corner] as number
      const at = (i + corner) * 3
      out[at] = positions[from] as number
      out[at + 1] = positions[from + 1] as number
      out[at + 2] = positions[from + 2] as number
      normals[at] = nx
      normals[at + 1] = ny
      normals[at + 2] = nz
      flatIndices[i + corner] = i + corner
    }
  }
  return { positions: out, normals, indices: flatIndices }
}
