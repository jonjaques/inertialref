import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@inertialref/spatial'
import {
  type DirtyRect,
  directionOf,
  horizonBasis,
  type LevelFrame,
  levelFrames,
  planeOf,
} from './cloudFrames.ts'
import { cubeDirection, cubeFaceOf } from './cubeSphere.ts'

/*
 * The caches' frames. A toroidal window is only right if what it redraws is
 * exactly what its move exposed and what it keeps was measured in a frame
 * that did not move, so both are checked against a texture simulated here:
 * every storage texel records which lattice texel it holds, a move rewrites
 * only the dirty rectangles, and the result must equal a fresh build.
 */

const EARTH = 6_371_000
const SIZE = 256
const CLIPMAP = [250, 500, 1000, 2000, 4000, 8000]

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})
const scale = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s,
})
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
const unit = (a: Vec3): Vec3 => scale(a, 1 / length(a))

const unitDirection = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-2)
  .map(([x, y, z]) => scale({ x, y, z }, 1 / Math.hypot(x, y, z)))

/** A texture of `size`² storage texels, each recording the lattice texel it holds. */
class Torus {
  readonly size: number
  readonly i: Int32Array
  readonly j: Int32Array
  constructor(size: number) {
    this.size = size
    this.i = new Int32Array(size * size).fill(-1)
    this.j = new Int32Array(size * size).fill(-1)
  }
  /** What a fresh build at `origin` writes everywhere. */
  fill(origin: readonly [number, number]): void {
    for (let i = origin[0]; i < origin[0] + this.size; i += 1)
      for (let j = origin[1]; j < origin[1] + this.size; j += 1) {
        const slot = mod(i, this.size) + this.size * mod(j, this.size)
        this.i[slot] = i
        this.j[slot] = j
      }
  }
  /** Storage texels holding a different lattice texel than `other`'s. */
  differences(other: Torus): number {
    let count = 0
    for (let slot = 0; slot < this.i.length; slot += 1)
      if (this.i[slot] !== other.i[slot] || this.j[slot] !== other.j[slot])
        count += 1
    return count
  }
  /** Redraw `rects` for a window at `origin`; returns how many texels were drawn. */
  redraw(
    origin: readonly [number, number],
    rects: readonly DirtyRect[],
  ): number {
    let drawn = 0
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(this.size)
      expect(rect.y + rect.height).toBeLessThanOrEqual(this.size)
      for (let x = rect.x; x < rect.x + rect.width; x += 1)
        for (let y = rect.y; y < rect.y + rect.height; y += 1) {
          const slot = x + this.size * y
          this.i[slot] = origin[0] + mod(x - origin[0], this.size)
          this.j[slot] = origin[1] + mod(y - origin[1], this.size)
          drawn += 1
        }
    }
    return drawn
  }
}

const mod = (value: number, size: number): number =>
  ((value % size) + size) % size

/** The eye moved by (du, dv) meters in a level's gnomonic plane, at the same distance from the center. */
function movedInPlane(
  frame: LevelFrame,
  eye: Vec3,
  du: number,
  dv: number,
): Vec3 {
  const plane = planeOf(frame, eye, EARTH)
  return scale(
    directionOf(frame, [plane[0] + du, plane[1] + dv], EARTH),
    length(eye),
  )
}

describe('a level’s frame', () => {
  const eye = scale(unit({ x: 0.3, y: 0.8, z: -0.52 }), EARTH + 1500)

  it('forms the eye’s terms in float64 against an orthonormal frame', () => {
    const { frames } = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    for (const frame of frames) {
      const { anchor, east, north } = frame
      expect(length(anchor)).toBeCloseTo(1, 14)
      expect(length(east)).toBeCloseTo(1, 14)
      expect(length(north)).toBeCloseTo(1, 14)
      expect(dot(anchor, east)).toBeCloseTo(0, 14)
      expect(dot(anchor, north)).toBeCloseTo(0, 14)
      expect(dot(east, north)).toBeCloseTo(0, 14)
      expect(frame.along).toEqual([
        dot(eye, anchor),
        dot(eye, east),
        dot(eye, north),
      ])
      expect(frame.eye).toEqual([
        (EARTH * frame.along[1]) / frame.along[0],
        (EARTH * frame.along[2]) / frame.along[0],
      ])
      expect(frame.eye).toEqual(planeOf(frame, eye, EARTH))
    }
  })

  it('holds the window on the eye: its middle corner within half a texel', () => {
    const { frames } = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    for (const frame of frames) {
      for (const axis of [0, 1] as const) {
        const middle = frame.origin[axis] + SIZE / 2
        expect(
          Math.abs(frame.eye[axis] / frame.texelMeters - middle),
        ).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('gives two eyes in one snap cell one anchor, whatever their heights', () => {
    /*
     * The snap cells are rectangles of the cube's warped coordinates, so the
     * segment from an eye's coordinates to its anchor's stays in the eye's
     * cell: every eye along it, at any height, must take the same anchor.
     */
    fc.assert(
      fc.property(
        unitDirection,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: -1000, max: 400_000, noNaN: true }),
        fc.integer({ min: 0, max: CLIPMAP.length - 1 }),
        (direction, share, height, level) => {
          const first = levelFrames(direction, EARTH, CLIPMAP, SIZE, null)
          const anchor = first.frames[level]!.anchor
          const from = cubeFaceOf(direction)
          const to = cubeFaceOf(anchor)
          fc.pre(from.face === to.face)
          const between = cubeDirection(
            from.face,
            from.a + share * (to.a - from.a),
            from.b + share * (to.b - from.b),
          )
          // On a face's very edge the round trip, or the scaling to a
          // height, can move a direction an ulp onto the next face, which is
          // another cell and rightly another anchor; the property is about
          // eyes that stay in the cell.
          const other = scale(between, EARTH + height)
          fc.pre(cubeFaceOf(other).face === from.face)
          const second = levelFrames(other, EARTH, CLIPMAP, SIZE, null)
          expect(second.frames[level]!.anchor).toEqual(anchor)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('rebuilds every level from no previous frame', () => {
    const update = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    expect(update.rebuilt).toEqual(CLIPMAP.map(() => true))
    for (const rects of update.dirty)
      expect(rects).toEqual([{ x: 0, y: 0, width: SIZE, height: SIZE }])
    for (const frame of update.frames) expect(frame.epoch).toBe(0)
  })

  it('exposes exactly the strips a whole-texel move uncovers, and the torus then equals a fresh build', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CLIPMAP.length - 1 }),
        fc.integer({ min: -60, max: 60 }),
        fc.integer({ min: -60, max: 60 }),
        (level, dx, dy) => {
          const before = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
          const frame = before.frames[level]!
          const texel = frame.texelMeters
          /*
           * Start on the anchor, at a whole lattice coordinate, so the window
           * is centered on the eye with no rounding near a half and a move of
           * 60 texels stays inside the anchor's reach of 64.
           */
          const plane = planeOf(frame, eye, EARTH)
          const centered = movedInPlane(frame, eye, -plane[0], -plane[1])
          const start = levelFrames(
            centered,
            EARTH,
            CLIPMAP,
            SIZE,
            before.frames,
          )
          const held = start.frames[level]!
          const moved = movedInPlane(held, centered, dx * texel, dy * texel)
          const after = levelFrames(moved, EARTH, CLIPMAP, SIZE, start.frames)
          const next = after.frames[level]!
          expect(next.anchor).toEqual(held.anchor)
          expect(next.epoch).toBe(held.epoch)
          expect(next.origin).toEqual([
            held.origin[0] + dx,
            held.origin[1] + dy,
          ])
          expect(after.rebuilt[level]).toBe(false)
          const torus = new Torus(SIZE)
          torus.fill(held.origin)
          const drawn = torus.redraw(next.origin, after.dirty[level]!)
          // Exactly the texels the new window holds and the old one did not.
          expect(drawn).toBe(
            SIZE * SIZE - (SIZE - Math.abs(dx)) * (SIZE - Math.abs(dy)),
          )
          const fresh = new Torus(SIZE)
          fresh.fill(next.origin)
          expect(torus.differences(fresh)).toBe(0)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('keeps its anchor while the eye stays in the inner half, and moves it, rebuilt, once it leaves', () => {
    const first = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    const level = 0
    const frame = first.frames[level]!
    const reach = (SIZE / 4) * frame.texelMeters
    const plane = planeOf(frame, eye, EARTH)
    const inside = movedInPlane(frame, eye, reach - plane[0] - 10, 0)
    const kept = levelFrames(inside, EARTH, CLIPMAP, SIZE, first.frames)
    expect(kept.frames[level]!.anchor).toEqual(frame.anchor)
    expect(kept.frames[level]!.epoch).toBe(0)
    expect(kept.rebuilt[level]).toBe(false)
    const outside = movedInPlane(frame, eye, reach - plane[0] + 10, 0)
    const moved = levelFrames(outside, EARTH, CLIPMAP, SIZE, kept.frames)
    expect(moved.frames[level]!.anchor).not.toEqual(frame.anchor)
    expect(moved.frames[level]!.epoch).toBe(1)
    expect(moved.rebuilt[level]).toBe(true)
    // The eye restarts near its new anchor, well inside the next reach.
    const restart = planeOf(moved.frames[level]!, outside, EARTH)
    expect(Math.max(Math.abs(restart[0]), Math.abs(restart[1]))).toBeLessThan(
      0.1 * SIZE * frame.texelMeters,
    )
  })

  it('starts its epochs over on a cut, which rebuilt reports and the epoch cannot', () => {
    const first = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    const frame = first.frames[0]!
    const reach = (SIZE / 4) * frame.texelMeters
    const plane = planeOf(frame, eye, EARTH)
    const outside = movedInPlane(frame, eye, reach - plane[0] + 10, 0)
    const moved = levelFrames(outside, EARTH, CLIPMAP, SIZE, first.frames)
    expect(moved.frames[0]!.epoch).toBe(1)
    // A cut passes no previous frame: there is no epoch to count from.
    const cut = levelFrames(outside, EARTH, CLIPMAP, SIZE, null)
    expect(cut.rebuilt).toEqual(CLIPMAP.map(() => true))
    for (const level of cut.frames) expect(level.epoch).toBe(0)
    // Where no anchor has moved, a cut's frames are a held frame's in every
    // field, the epoch among them, and `rebuilt` is all that tells them apart.
    const held = levelFrames(eye, EARTH, CLIPMAP, SIZE, first.frames)
    const still = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    expect(still.frames).toEqual(held.frames)
    expect(held.rebuilt).toEqual(CLIPMAP.map(() => false))
    expect(still.rebuilt).toEqual(CLIPMAP.map(() => true))
  })

  it('projects and unprojects a direction through the anchor’s tangent plane', () => {
    const { frames } = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    fc.assert(
      fc.property(
        fc.double({ min: -2e6, max: 2e6, noNaN: true }),
        fc.double({ min: -2e6, max: 2e6, noNaN: true }),
        (u, v) => {
          const frame = frames[5]!
          const direction = directionOf(frame, [u, v], EARTH)
          const back = planeOf(frame, direction, EARTH)
          expect(Math.abs(back[0] - u)).toBeLessThan(1e-6)
          expect(Math.abs(back[1] - v)).toBeLessThan(1e-6)
        },
      ),
    )
  })

  it('carries what a shader needs to place a point 100 km out to a centimeter, eye-relatively', () => {
    /*
     * `cloudGeometry.ts`'s `levelPlane`: u(e + o) = u(e) + R·[o·E − (e·E)(o·A)/(e·A)]/(e·A + o·A),
     * formed from this frame's `eye` and `along`. In float64 here it must
     * agree with projecting the absolute point; the GPU test holds the
     * float32 port to 2 cm.
     */
    const { frames } = levelFrames(eye, EARTH, CLIPMAP, SIZE, null)
    fc.assert(
      fc.property(unitDirection, fc.integer({ min: 0, max: 5 }), (d, k) => {
        const frame = frames[k]!
        const o = scale(d, 100_000)
        const oA = dot(o, frame.anchor)
        const [eA, eE, eN] = frame.along
        const factor = EARTH / (eA + oA)
        const u = frame.eye[0] + factor * (dot(o, frame.east) - (eE * oA) / eA)
        const v = frame.eye[1] + factor * (dot(o, frame.north) - (eN * oA) / eA)
        const truth = planeOf(frame, add(eye, o), EARTH)
        expect(Math.abs(u - truth[0])).toBeLessThan(0.01)
        expect(Math.abs(v - truth[1])).toBeLessThan(0.01)
      }),
    )
  })

  it('names east and north as the horizon does, the pole being +Y', () => {
    // On the equator at +X the ground turns toward −Z: that is east.
    const { up, east, north } = horizonBasis({ x: 1, y: 0, z: 0 })
    expect(dot(up, { x: 1, y: 0, z: 0 })).toBe(1)
    expect(dot(north, { x: 0, y: 1, z: 0 })).toBe(1)
    expect(dot(east, { x: 0, y: 0, z: -1 })).toBe(1)
    const pole = horizonBasis({ x: 0, y: 1, z: 0 })
    expect(dot(pole.east, pole.north)).toBeCloseTo(0, 15)
    expect(length(pole.north)).toBeCloseTo(1, 15)
  })
})
