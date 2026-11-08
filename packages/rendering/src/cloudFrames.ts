import type { Vec3 } from '@inertialref/spatial'
import { cubeDirection, cubeFaceOf } from './cubeSphere.ts'
import type { ShellHeights } from './weatherShells.ts'

/*
 * The frames the eye-anchored caches are laid out in: the clipmap's and the
 * volume's levels, each a tangent plane at a snapped anchor addressed
 * toroidally, and the sun's cascades, orthographic boxes along the sun
 * snapped in sun space. Formed in float64 here; a shader reads only the
 * eye-relative terms (`LevelFrame.along`) and never an absolute position
 * (rule 58).
 *
 * A window follows the eye by whole texels and is stored toroidally, texel
 * (i, j) at (i mod size, j mod size), so a move redraws only the strips it
 * exposes. What a texel holds is fixed by the frame it was drawn in, so
 * everything a stored texel was measured against — a level's anchor, a
 * cascade's orientation and its near plane — holds still while the window
 * scrolls, and moves only by rebuilding the whole level or cascade.
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
  /** Bumps when the anchor moves: the level is rebuilt whole. */
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
  readonly rebuilt: readonly boolean[]
}

/**
 * A sun-space cascade: an orthographic box along the sun, its texel grid
 * snapped in sun space and addressed toroidally (plan §6.1: "scrolled as it
 * moves").
 */
export interface SunCascade {
  /** Unit, toward the sun, body-fixed: the orientation, held until it moves 0.05°. */
  readonly toward: Vec3
  readonly right: Vec3
  readonly up: Vec3
  /** Eye-relative, body-fixed meters: a texel corner, snapped. */
  readonly center: Vec3
  /** Meters across. */
  readonly extent: number
  readonly texelMeters: number
  /** Distance from `center` toward the sun to the near plane. */
  readonly near: number
  /** Near to far, meters: the union's chord along the sun, with a margin. */
  readonly depth: number
  /** The integer texel at the window's low corner; texel (i, j) is stored at (i mod size, j mod size). */
  readonly origin: readonly [number, number]
  /** Bumps when the orientation moves or the cascade is rebuilt (a jump, a cut). */
  readonly epoch: number
  /**
   * The near plane's distance from the body's center along `toward`, float64:
   * what holds the plane still in body-fixed space while the cascade scrolls.
   * A texel stores its front depth from that plane, so a plane that followed
   * the eye would move every texel drawn on an earlier frame by the eye's
   * travel along the sun. `near` is this less the eye's own distance, which
   * no eye-relative field can carry from one frame to the next. Optional
   * only so a cascade built by hand still types; one without it is rebuilt.
   * A shader reads `near`, never this.
   */
  readonly plane?: number
}

export interface CascadeUpdate {
  readonly cascades: readonly SunCascade[]
  /** Per cascade, the toroidal strips the scroll exposed: drawn the frame they appear. */
  readonly dirty: readonly (readonly DirtyRect[])[]
  /** Per cascade, whether its contents are stale whole: a new orientation, a jump or a cut. */
  readonly stale: readonly boolean[]
}

/** Degrees: the sun move that re-orients a cascade. */
export const SUN_CASCADE_TURN = 0.05

/* ------------------------------------------------------------------------- */
/* Vectors                                                                    */
/* ------------------------------------------------------------------------- */

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

const scaled = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s,
})

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

/* ------------------------------------------------------------------------- */
/* Sun cascades                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Right and up across the sun, deterministic in `toward` so a rebuild at one
 * orientation lays one grid: right × up = toward, seeded off the pole unless
 * the sun is near it.
 */
function sunBasis(toward: Vec3): { readonly right: Vec3; readonly up: Vec3 } {
  const seed =
    Math.abs(toward.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const right = unit(cross(seed, toward))
  return { right, up: cross(toward, right) }
}

/** The angle between two unit vectors, without acos's loss near zero. */
const angleBetween = (a: Vec3, b: Vec3): number =>
  2 *
  Math.atan2(
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    Math.hypot(a.x + b.x, a.y + b.y, a.z + b.z),
  )

/** z on a sphere of `radius` over the sun axis at a distance `rho` from it, sun side. */
const sunSide = (radius: number, rho: number): number =>
  Math.sqrt(Math.max(0, (radius - rho) * (radius + rho)))

/**
 * How far along the sun, from the body's center, the union reaches over the
 * columns of a window centered at (x, y) in sun space, `half` meters either
 * way: [lowest, highest], or null where no column meets it.
 *
 * A column at a distance ρ from the sun axis meets the top sphere at
 * z = √((R + top)² − ρ²) and the base sphere at √((R + base)² − ρ²) on the
 * sun side; a column that passes outside the base sphere grazes the union
 * the whole way through the top one, lit on both sides of the terminator.
 * Both are monotone in ρ, so the window's nearest and farthest columns bound
 * them. The night side's union is in the body's shadow and no cascade holds it.
 */
function unionReach(
  x: number,
  y: number,
  half: number,
  shells: ShellHeights,
): readonly [number, number] | null {
  const { datumRadius, boundaries } = shells
  const inner = datumRadius + (boundaries[0] ?? 0)
  const outer = datumRadius + (boundaries[boundaries.length - 1] ?? 0)
  const nearest = Math.hypot(
    Math.max(0, Math.abs(x) - half),
    Math.max(0, Math.abs(y) - half),
  )
  const farthest = Math.hypot(Math.abs(x) + half, Math.abs(y) + half)
  if (nearest >= outer) return null
  const lowest =
    farthest < inner
      ? sunSide(inner, farthest)
      : -sunSide(outer, Math.max(nearest, inner))
  return [lowest, sunSide(outer, nearest)]
}

/*
 * A rebuild sizes its box for the window grown by half its own width on
 * every side, so the cascade scrolls that far in any direction before the
 * union can leave it, and pads both planes by a texel. Depth costs a bake
 * nothing — each texel marches between its own crossings of the union — and
 * costs a stored front depth little: the half-float pair keeps 6 cm to
 * 1,000 km.
 */
const CASCADE_SLACK = 1 / 2

/** A cascade carried over from `before`: its orientation, its grid and its box. */
type HeldCascade = SunCascade & { readonly plane: number }

/** Whether `before` can be scrolled into this frame: same layout, no jump, a sun within the turn. */
function orientedLike(
  before: SunCascade | undefined,
  extent: number,
  texel: number,
  toSun: Vec3,
  jump: boolean,
): before is HeldCascade {
  return (
    before !== undefined &&
    before.plane !== undefined &&
    !jump &&
    before.extent === extent &&
    before.texelMeters === texel &&
    angleBetween(before.toward, toSun) <= (SUN_CASCADE_TURN * Math.PI) / 180
  )
}

/** One cascade this frame, and what of it is stale. */
function cascadeAt(
  eye: Vec3,
  toSun: Vec3,
  shells: ShellHeights,
  extent: number,
  size: number,
  before: SunCascade | undefined,
  jump: boolean,
): {
  readonly cascade: SunCascade
  readonly dirty: DirtyRect[]
  readonly stale: boolean
} {
  const texel = extent / size
  const oriented = orientedLike(before, extent, texel, toSun, jump)
  const toward = oriented ? before.toward : toSun
  const { right, up } = oriented ? before : sunBasis(toSun)
  // The grid is laid on the sun axis through the body's center, so a
  // texel's column is fixed in body-fixed space whatever the eye does.
  const ex = dot(eye, right)
  const ey = dot(eye, up)
  const ez = dot(eye, toward)
  const origin = [
    windowOrigin(ex / texel, size),
    windowOrigin(ey / texel, size),
  ] as const
  const cx = (origin[0] + Math.floor(size / 2)) * texel
  const cy = (origin[1] + Math.floor(size / 2)) * texel
  const reach = unionReach(cx, cy, extent / 2, shells)
  const held =
    oriented &&
    (reach === null ||
      (reach[1] <= before.plane && reach[0] >= before.plane - before.depth))
  let plane: number
  let depth: number
  if (held) {
    plane = before.plane
    depth = before.depth
  } else {
    const grown = unionReach(
      cx,
      cy,
      extent / 2 + CASCADE_SLACK * extent,
      shells,
    ) ?? [ez, ez]
    plane = grown[1] + texel
    depth = plane - (grown[0] - texel)
  }
  const cascade: SunCascade = {
    toward,
    right,
    up,
    center: {
      x: right.x * (cx - ex) + up.x * (cy - ey),
      y: right.y * (cx - ex) + up.y * (cy - ey),
      z: right.z * (cx - ex) + up.z * (cy - ey),
    },
    extent,
    texelMeters: texel,
    near: plane - ez,
    depth,
    origin,
    epoch: held ? before.epoch : before === undefined ? 0 : before.epoch + 1,
    plane,
  }
  return {
    cascade,
    dirty: held ? exposed(before.origin, origin, size) : [whole(size)],
    stale: !held,
  }
}

/**
 * `jump` marks every cascade stale; a sun that moved more than 0.05° from a
 * cascade's orientation re-orients it; `previous` null is a cut.
 *
 * A cascade also rebuilds when the window has scrolled far enough that the
 * union over it leaves the box it was built with. That rebuild keeps the
 * orientation, which is within 0.05° of the sun or it would not be held, and
 * moves the near plane: everything the cascade holds is redrawn against it.
 * `center` lies in the eye's own plane across the sun.
 */
export function sunCascades(
  eye: Vec3,
  sun: Vec3,
  shells: ShellHeights,
  extents: readonly number[],
  size: number,
  previous: readonly SunCascade[] | null,
  jump: boolean,
): CascadeUpdate {
  const toSun = unit(sun)
  const built = extents.map((extent, k) =>
    cascadeAt(eye, toSun, shells, extent, size, previous?.[k], jump),
  )
  return {
    cascades: built.map((one) => one.cascade),
    dirty: built.map((one) => one.dirty),
    stale: built.map((one) => one.stale),
  }
}
