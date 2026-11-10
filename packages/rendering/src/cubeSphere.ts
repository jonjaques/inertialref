import { Vec, type Vec3 } from '@inertialref/spatial'

/*
 * The weather cube: six tangent-warped faces over a body, each a tile of
 * texels with a gutter of its neighbors' directions around it, so a bilinear
 * read near an edge never mixes two faces. The atlas the maps bake into and
 * the far fields read is laid out from this, and `cloudGeometry.ts`'s
 * `cubeAtlasUv` addresses it by the same faces and the same warp.
 */

export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5

/**
 * Each face's outward normal and its two in-plane axes, body-fixed, with
 * a × b = normal on every face, so every tile is drawn the same way round.
 *
 * A direction belongs to the face of its largest-magnitude component, and a
 * tie goes to the earlier axis — X before Y before Z — with a zero component
 * counting as positive. The GPU's lookup takes the same rule, so a direction
 * on an edge lands on one face on both sides.
 */
export const CUBE_FACES: readonly {
  readonly normal: Vec3
  readonly a: Vec3
  readonly b: Vec3
}[] = [
  {
    normal: { x: 1, y: 0, z: 0 },
    a: { x: 0, y: 1, z: 0 },
    b: { x: 0, y: 0, z: 1 },
  },
  {
    normal: { x: -1, y: 0, z: 0 },
    a: { x: 0, y: 0, z: 1 },
    b: { x: 0, y: 1, z: 0 },
  },
  {
    normal: { x: 0, y: 1, z: 0 },
    a: { x: 0, y: 0, z: 1 },
    b: { x: 1, y: 0, z: 0 },
  },
  {
    normal: { x: 0, y: -1, z: 0 },
    a: { x: 1, y: 0, z: 0 },
    b: { x: 0, y: 0, z: 1 },
  },
  {
    normal: { x: 0, y: 0, z: 1 },
    a: { x: 1, y: 0, z: 0 },
    b: { x: 0, y: 1, z: 0 },
  },
  {
    normal: { x: 0, y: 0, z: -1 },
    a: { x: 0, y: 1, z: 0 },
    b: { x: 1, y: 0, z: 0 },
  },
]

/*
 * The warp is u = tan(a·π/4): a is proportional to the angle from the face's
 * center along each axis, so a texel's solid angle varies across a face by
 * √2 — the least at an edge's midpoint, where one side is foreshortened — and
 * not by the 5.2 of the plain gnomonic cube, whose corner texels are the
 * smallest.
 */
const WARP = Math.PI / 4

/** The face a direction belongs to, by `CUBE_FACES`' rule. */
function faceOf(direction: Vec3): CubeFace {
  const ax = Math.abs(direction.x)
  const ay = Math.abs(direction.y)
  const az = Math.abs(direction.z)
  if (ax >= ay && ax >= az) return direction.x >= 0 ? 0 : 1
  if (ay >= az) return direction.y >= 0 ? 2 : 3
  return direction.z >= 0 ? 4 : 5
}

/**
 * The face of a direction and its tangent-warped coordinates in [−1, 1]
 * (u = tan(a·π/4) on the face plane).
 */
export function cubeFaceOf(direction: Vec3): {
  readonly face: CubeFace
  readonly a: number
  readonly b: number
} {
  const face = faceOf(direction)
  const { normal, a, b } = CUBE_FACES[face]!
  const depth = Vec.dot(direction, normal)
  // A zero vector has no face; the first face's center keeps it finite.
  if (!(depth > 0)) return { face, a: 0, b: 0 }
  return {
    face,
    a: Math.atan(Vec.dot(direction, a) / depth) / WARP,
    b: Math.atan(Vec.dot(direction, b) / depth) / WARP,
  }
}

/**
 * The unit direction at warped coordinates; |a|, |b| > 1 lands in the
 * neighbor's gutter texels, which is what the bake writes there.
 */
export function cubeDirection(face: CubeFace, a: number, b: number): Vec3 {
  const axes = CUBE_FACES[face]!
  const u = Math.tan(a * WARP)
  const v = Math.tan(b * WARP)
  const x = axes.normal.x + axes.a.x * u + axes.b.x * v
  const y = axes.normal.y + axes.a.y * u + axes.b.y * v
  const z = axes.normal.z + axes.a.z * u + axes.b.z * v
  const length = Math.hypot(x, y, z)
  return { x: x / length, y: y / length, z: z / length }
}

/**
 * The warped coordinate of texel `index` in a tile of `size` + 2·gutter
 * texels: −1 + (2(index − gutter) + 1)/size, the center of the texel, so the
 * gutter's first texel sits half a texel past the face's edge.
 */
export function cubeTexelCoordinate(
  size: number,
  gutter: number,
  index: number,
): number {
  return -1 + (2 * (index - gutter) + 1) / size
}

/**
 * The side of a texel at a face's center and at its corner, meters on a
 * sphere of `radius`: the two texels of a face that are square, by symmetry.
 * Δa = 2/size spans an angle of (π/4)·Δa at the center and (π/4)·Δa·(2√2/3)
 * at the corner, where the warp's stretch (1 + u²) meets the plane's
 * foreshortening √(1 + v²)/(1 + u² + v²). 19.6 km at the center for Earth's
 * radius and a 512-texel face. The center's is the largest side on the face;
 * the smallest is along an edge at its midpoint, 1/√2 of it, in a texel that
 * is not square.
 */
export function cubeTexelMeters(
  size: number,
  radius: number,
): { readonly center: number; readonly corner: number } {
  const center = (radius * WARP * 2) / size
  return { center, corner: (center * 2 * Math.SQRT2) / 3 }
}
