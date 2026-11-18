import { Vec, type Vec3 } from '@inertialref/spatial'
import { cubeDirection, cubeFaceOf } from './cubeSphere.ts'

/*
 * The frames the eye-anchored caches are laid out in: the clipmap's and the
 * volume's levels, each a tangent plane at a snapped anchor addressed
 * toroidally. Formed in float64 here; a shader reads only the eye-relative
 * terms (`LevelFrame.along`) and never an absolute position (rule 58).
 *
 * A window follows the eye by whole texels and is stored toroidally, texel
 * (i, j) at (i mod size, j mod size), so a move redraws only the strips it
 * exposes. What a texel holds is fixed by the frame it was drawn in, so
 * everything a stored texel was measured against — a level's anchor — holds
 * still while the window scrolls, and moves only by rebuilding the whole
 * level.
 */

/** One clipmap or volume level: a tangent plane at a snapped anchor, addressed toroidally. */
export interface LevelFrame {
  readonly level: number
  /** Unit, body-fixed; snapped so two eyes in one snap cell give one anchor. */
  readonly anchor: Vec3
  readonly east: Vec3
  readonly north: Vec3
  readonly texelMeters: number
  readonly size: number
  /** The eye's gnomonic plane coordinates about the anchor, meters, float64. */
  readonly eye: readonly [number, number]
  /**
   * (e·A, e·E, e·N): the eye's position from the center against the frame's
   * axes, meters, float64. What a shader forms a sample's plane coordinate
   * from, with the offset, eye-relatively (§3.9, rule 58).
   */
  readonly along: readonly [number, number, number]
  /** The integer texel at the window's low corner; texel (i, j) is stored at (i mod size, j mod size). */
  readonly origin: readonly [number, number]
  /**
   * The anchor's moves since the level was built from no previous frame,
   * where it starts over at 0. A first frame and a cut both pass none, so
   * neither has an epoch to count from, and a cut taken before any anchor
   * moved leaves every epoch at the 0 it had: `LevelUpdate.rebuilt` reports
   * a cut, and an unchanged epoch does not rule one out.
   */
  readonly epoch: number
}

/** A rectangle of storage texels, inside [0, size)²: a window's move is split where it wraps. */
export interface DirtyRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LevelUpdate {
  readonly frames: readonly LevelFrame[]
  /** Per level, the toroidal rectangles the window's move exposed. */
  readonly dirty: readonly (readonly DirtyRect[])[]
  /** Per level, whether the window is exposed whole: a moved anchor, a first frame or a cut. */
  readonly rebuilt: readonly boolean[]
}

/* ------------------------------------------------------------------------- */
/* Vectors                                                                    */
/* ------------------------------------------------------------------------- */

const { dot, cross, scale: scaled } = Vec

/** +Y for a zero vector: `Vec.normalize` answers zero, and a basis crossed from zero is zero too. */
function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z)
  return length > 0 ? scaled(a, 1 / length) : { x: 0, y: 1, z: 0 }
}

/**
 * East, north and up at a body-fixed direction, as `buildScene`'s horizon
 * forms them: the pole is +Y, north is the pole laid flat on the horizon and
 * east is north × up, the way the ground turns on a prograde body. Over a
 * pole there is no north, and a fixed seed axis stands in for it.
 */
export function horizonBasis(direction: Vec3): {
  readonly up: Vec3
  readonly east: Vec3
  readonly north: Vec3
} {
  const up = unit(direction)
  let north: Vec3 = { x: -up.x * up.y, y: 1 - up.y * up.y, z: -up.z * up.y }
  if (Math.hypot(north.x, north.y, north.z) < 1e-6) {
    const seed =
      Math.abs(up.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }
    north = {
      x: seed.x - up.x * dot(seed, up),
      y: seed.y - up.y * dot(seed, up),
      z: seed.z - up.z * dot(seed, up),
    }
  }
  north = unit(north)
  return { up, east: cross(north, up), north }
}

/* ------------------------------------------------------------------------- */
/* Toroidal windows                                                           */
/* ------------------------------------------------------------------------- */

const modulo = (value: number, size: number): number =>
  ((value % size) + size) % size

const whole = (size: number): DirtyRect => ({
  x: 0,
  y: 0,
  width: size,
  height: size,
})

/** A run of lattice texels as runs of storage texels, split where i mod size wraps. */
function storageRuns(
  start: number,
  length: number,
  size: number,
): { readonly start: number; readonly length: number }[] {
  if (length <= 0) return []
  const first = modulo(start, size)
  const before = Math.min(length, size - first)
  return before < length
    ? [
        { start: first, length: before },
        { start: 0, length: length - before },
      ]
    : [{ start: first, length }]
}

function storageRects(
  x: number,
  width: number,
  y: number,
  height: number,
  size: number,
): DirtyRect[] {
  const columns = storageRuns(x, width, size)
  const rows = storageRuns(y, height, size)
  return columns.flatMap((column) =>
    rows.map((row) => ({
      x: column.start,
      y: row.start,
      width: column.length,
      height: row.length,
    })),
  )
}

/**
 * The texels a window of `size` holds at `after` and did not at `before`, as
 * storage rectangles: the columns that entered, every row of them, then the
 * rows that entered across the columns both windows hold, so no texel is
 * drawn twice. A move of a whole window or more exposes everything.
 */
function exposed(
  before: readonly [number, number],
  after: readonly [number, number],
  size: number,
): DirtyRect[] {
  const dx = after[0] - before[0]
  const dy = after[1] - before[1]
  if (Math.abs(dx) >= size || Math.abs(dy) >= size) return [whole(size)]
  const rects: DirtyRect[] = []
  if (dx !== 0)
    rects.push(
      ...storageRects(
        dx > 0 ? before[0] + size : after[0],
        Math.abs(dx),
        after[1],
        size,
        size,
      ),
    )
  if (dy !== 0)
    rects.push(
      ...storageRects(
        Math.max(after[0], before[0]),
        size - Math.abs(dx),
        dy > 0 ? before[1] + size : after[1],
        Math.abs(dy),
        size,
      ),
    )
  return rects
}

/** The window's low corner for an eye at lattice coordinate `at`: the eye within half a texel of its middle corner. */
const windowOrigin = (at: number, size: number): number =>
  Math.floor(at + 0.5) - Math.floor(size / 2)

/* ------------------------------------------------------------------------- */
/* Levels                                                                     */
/* ------------------------------------------------------------------------- */

/*
 * A level re-anchors when the eye's plane coordinates leave a quarter of its
 * window either side of the anchor — the inner half of a window centered on
 * it. The gnomonic plane stretches as sec² of the angle from the tangent
 * point, so the bound holds the eye where the stretch is 1.7% at the
 * coarsest level (512 km on a 3,980 km world), and the far corner of the
 * window it carries, three quarters of a window out, at 15%. The new anchor
 * is the center of the eye's cell on a grid an eighth of a window fine, laid
 * on the weather cube's faces, so two eyes in one cell take one anchor and
 * the eye starts within 0.09 of a window of it on each axis, a sixth of a
 * window short of the next re-anchor.
 */
const ANCHOR_REACH = 1 / 4
const ANCHOR_CELL = 1 / 8

function snappedAnchor(
  eye: Vec3,
  datumRadius: number,
  cellMeters: number,
): Vec3 {
  const cells = Math.max(
    1,
    Math.ceil(((Math.PI / 2) * datumRadius) / cellMeters),
  )
  const { face, a, b } = cubeFaceOf(eye)
  const center = (warped: number): number => {
    const k = Math.min(
      cells - 1,
      Math.max(0, Math.floor(((warped + 1) / 2) * cells)),
    )
    return -1 + (2 * k + 1) / cells
  }
  return cubeDirection(face, center(a), center(b))
}

export function planeOf(
  frame: LevelFrame,
  direction: Vec3,
  datumRadius: number,
): readonly [number, number] {
  const depth = dot(direction, frame.anchor)
  return [
    (datumRadius * dot(direction, frame.east)) / depth,
    (datumRadius * dot(direction, frame.north)) / depth,
  ]
}

export function directionOf(
  frame: LevelFrame,
  plane: readonly [number, number],
  datumRadius: number,
): Vec3 {
  const { anchor, east, north } = frame
  return unit({
    x: anchor.x * datumRadius + east.x * plane[0] + north.x * plane[1],
    y: anchor.y * datumRadius + east.y * plane[0] + north.y * plane[1],
    z: anchor.z * datumRadius + east.z * plane[0] + north.z * plane[1],
  })
}

/** Whether `previous` still describes level `level` of this layout, and the eye is still near its anchor. */
function holds(
  previous: LevelFrame,
  level: number,
  texelMeters: number,
  size: number,
  eye: Vec3,
  datumRadius: number,
): boolean {
  if (
    previous.level !== level ||
    previous.texelMeters !== texelMeters ||
    previous.size !== size ||
    !(dot(eye, previous.anchor) > 0)
  )
    return false
  const reach = ANCHOR_REACH * size * texelMeters
  const [u, v] = planeOf(previous, eye, datumRadius)
  return Math.abs(u) <= reach && Math.abs(v) <= reach
}

/**
 * Snap: the anchor moves when the eye leaves the inner half of the window; the
 * window's origin moves by whole texels. `previous` null rebuilds every level
 * (a first frame, or force 'cut').
 */
export function levelFrames(
  eye: Vec3,
  datumRadius: number,
  texelMeters: readonly number[],
  size: number,
  previous: readonly LevelFrame[] | null,
): LevelUpdate {
  const frames: LevelFrame[] = []
  const dirty: DirtyRect[][] = []
  const rebuilt: boolean[] = []
  texelMeters.forEach((texel, level) => {
    const before = previous?.[level]
    const kept =
      before !== undefined &&
      holds(before, level, texel, size, eye, datumRadius)
    const anchor = kept
      ? before.anchor
      : snappedAnchor(eye, datumRadius, ANCHOR_CELL * size * texel)
    const { east, north } = kept ? before : horizonBasis(anchor)
    const along = [dot(eye, anchor), dot(eye, east), dot(eye, north)] as const
    const plane = [
      (datumRadius * along[1]) / along[0],
      (datumRadius * along[2]) / along[0],
    ] as const
    const origin = [
      windowOrigin(plane[0] / texel, size),
      windowOrigin(plane[1] / texel, size),
    ] as const
    const rects = kept ? exposed(before.origin, origin, size) : [whole(size)]
    frames.push({
      level,
      anchor,
      east,
      north,
      texelMeters: texel,
      size,
      eye: plane,
      along,
      origin,
      epoch: before === undefined ? 0 : before.epoch + (kept ? 0 : 1),
    })
    dirty.push(rects)
    rebuilt.push(
      rects.length === 1 &&
        rects[0]!.width === size &&
        rects[0]!.height === size,
    )
  })
  return { frames, dirty, rebuilt }
}
