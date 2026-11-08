import type { Vec3 } from '@inertialref/spatial'
import type { ShellHeights } from './weatherShells.ts'

/*
 * The frames the eye-anchored caches are laid out in: the clipmap's and the
 * volume's levels, each a tangent plane at a snapped anchor addressed
 * toroidally, and the sun's cascades, orthographic boxes along the sun
 * snapped in sun space. Formed in float64 here; a shader reads only the
 * eye-relative terms (`LevelFrame.along`) and never an absolute position
 * (rule 58).
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

const notYet = (): never => {
  throw new Error('not yet: WP1')
}

/**
 * Snap: the anchor moves when the eye leaves the inner half of the window; the
 * window's origin moves by whole texels. `previous` null rebuilds every level
 * (a first frame, or force 'cut').
 */
export function levelFrames(
  _eye: Vec3,
  _datumRadius: number,
  _texelMeters: readonly number[],
  _size: number,
  _previous: readonly LevelFrame[] | null,
): LevelUpdate {
  return notYet()
}

export function planeOf(
  _frame: LevelFrame,
  _direction: Vec3,
  _datumRadius: number,
): readonly [number, number] {
  return notYet()
}

export function directionOf(
  _frame: LevelFrame,
  _plane: readonly [number, number],
  _datumRadius: number,
): Vec3 {
  return notYet()
}

/**
 * `jump` marks every cascade stale; a sun that moved more than 0.05° from a
 * cascade's orientation re-orients it; `previous` null is a cut.
 */
export function sunCascades(
  _eye: Vec3,
  _sun: Vec3,
  _shells: ShellHeights,
  _extents: readonly number[],
  _size: number,
  _previous: readonly SunCascade[] | null,
  _jump: boolean,
): CascadeUpdate {
  return notYet()
}
