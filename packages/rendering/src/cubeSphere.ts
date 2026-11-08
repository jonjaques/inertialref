import type { Vec3 } from '@inertialref/spatial'

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

const notYet = (): never => {
  throw new Error('not yet: WP1')
}

/**
 * The face of a direction and its tangent-warped coordinates in [−1, 1]
 * (u = tan(a·π/4) on the face plane).
 */
export function cubeFaceOf(_direction: Vec3): {
  readonly face: CubeFace
  readonly a: number
  readonly b: number
} {
  return notYet()
}

/**
 * The unit direction at warped coordinates; |a|, |b| > 1 lands in the
 * neighbor's gutter texels, which is what the bake writes there.
 */
export function cubeDirection(_face: CubeFace, _a: number, _b: number): Vec3 {
  return notYet()
}

/** The warped coordinate of texel `index` in a tile of `size` + 2·gutter texels. */
export function cubeTexelCoordinate(
  _size: number,
  _gutter: number,
  _index: number,
): number {
  return notYet()
}

export function cubeTexelMeters(
  _size: number,
  _radius: number,
): { readonly center: number; readonly corner: number } {
  return notYet()
}
