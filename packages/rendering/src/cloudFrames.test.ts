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
  SUN_CASCADE_TURN,
  type SunCascade,
  sunCascades,
} from './cloudFrames.ts'
import { cubeDirection, cubeFaceOf } from './cubeSphere.ts'
import { WEATHER_SCENARIOS } from './weatherScenario.ts'
import { shellBoundaries, shellHeights } from './weatherShells.ts'

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

/* ------------------------------------------------------------------------- */
/* Sun cascades                                                               */
/* ------------------------------------------------------------------------- */

const EXTENTS = [12_800, 51_200, 204_800]
const CASCADE = 512
const boundaries = shellBoundaries(WEATHER_SCENARIOS['fair-cumulus'])

function unit(a: Vec3): Vec3 {
  return scale(a, 1 / length(a))
}

/** The sun at `elevation` over the eye's horizon, toward its east. */
function sunOver(eye: Vec3, elevation: number): Vec3 {
  const { up, east } = horizonBasis(eye)
  return add(scale(up, Math.sin(elevation)), scale(east, Math.cos(elevation)))
}

function turned(sun: Vec3, about: Vec3, degrees: number): Vec3 {
  const angle = (degrees * Math.PI) / 180
  const axis = unit(about)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const along = scale(axis, dot(axis, sun) * (1 - c))
  const cross = {
    x: axis.y * sun.z - axis.z * sun.y,
    y: axis.z * sun.x - axis.x * sun.z,
    z: axis.x * sun.y - axis.y * sun.x,
  }
  return add(add(scale(sun, c), scale(cross, s)), along)
}

/** A texel's column, body-fixed: where its center sits across the sun. */
function column(
  cascade: SunCascade,
  eye: Vec3,
  i: number,
  j: number,
): readonly [number, number] {
  const middle = CASCADE / 2
  const corner = add(eye, cascade.center)
  return [
    dot(corner, cascade.right) +
      (i - cascade.origin[0] - middle + 0.5) * cascade.texelMeters,
    dot(corner, cascade.up) +
      (j - cascade.origin[1] - middle + 0.5) * cascade.texelMeters,
  ]
}

const nearPlane = (cascade: SunCascade, eye: Vec3): number =>
  dot(add(eye, cascade.center), cascade.toward) + cascade.near

describe('the sun’s cascades', () => {
  const eye = scale(unit({ x: 0.2, y: 0.9, z: 0.4 }), EARTH + 2)
  const sun = sunOver(eye, (37.5 * Math.PI) / 180)
  const shells = () => shellHeights(eye, EARTH, boundaries)

  it('are stale and new from no previous frame', () => {
    const update = sunCascades(
      eye,
      sun,
      shells(),
      EXTENTS,
      CASCADE,
      null,
      false,
    )
    expect(update.stale).toEqual([true, true, true])
    for (const cascade of update.cascades) {
      expect(cascade.epoch).toBe(0)
      expect(dot(cascade.toward, unit(sun))).toBeCloseTo(1, 14)
      expect(dot(cascade.right, cascade.up)).toBeCloseTo(0, 14)
      expect(dot(cascade.right, cascade.toward)).toBeCloseTo(0, 14)
      expect(cascade.texelMeters * CASCADE).toBe(cascade.extent)
      // The center is the window's middle corner, in the eye's own plane across the sun.
      expect(dot(cascade.center, cascade.toward)).toBeCloseTo(0, 6)
    }
  })

  it('hold the union the window covers between their near and far planes', () => {
    const { cascades } = sunCascades(
      eye,
      sun,
      shells(),
      EXTENTS,
      CASCADE,
      null,
      false,
    )
    for (const cascade of cascades) {
      const plane = nearPlane(cascade, eye)
      for (const [i, j] of [
        [0, 0],
        [CASCADE - 1, 0],
        [0, CASCADE - 1],
        [CASCADE - 1, CASCADE - 1],
        [CASCADE / 2, CASCADE / 2],
      ] as const) {
        const [x, y] = column(
          cascade,
          eye,
          cascade.origin[0] + i,
          cascade.origin[1] + j,
        )
        const rho = Math.hypot(x, y)
        for (const h of [boundaries[0]!, boundaries[5]!]) {
          const z = Math.sqrt((EARTH + h) ** 2 - rho * rho)
          expect(z).toBeLessThanOrEqual(plane)
          expect(z).toBeGreaterThanOrEqual(plane - cascade.depth)
        }
      }
    }
  })

  it('scroll toroidally as the eye moves, every kept texel’s column and the near plane fixed in body-fixed space', () => {
    const first = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, null, false)
    const { east, north } = horizonBasis(eye)
    const step = add(scale(east, 130), scale(north, -70))
    const moved = add(eye, step)
    const after = sunCascades(
      moved,
      sun,
      shellHeights(moved, EARTH, boundaries),
      EXTENTS,
      CASCADE,
      first.cascades,
      false,
    )
    expect(after.stale).toEqual([false, false, false])
    after.cascades.forEach((cascade, k) => {
      const before = first.cascades[k]!
      expect(cascade.toward).toEqual(before.toward)
      expect(cascade.epoch).toBe(before.epoch)
      expect(nearPlane(cascade, moved)).toBeCloseTo(nearPlane(before, eye), 6)
      const i = cascade.origin[0] + 300
      const j = cascade.origin[1] + 200
      const now = column(cascade, moved, i, j)
      const then = column(before, eye, i, j)
      expect(Math.abs(now[0] - then[0])).toBeLessThan(1e-6)
      expect(Math.abs(now[1] - then[1])).toBeLessThan(1e-6)
      const torus = new Torus(CASCADE)
      torus.fill(before.origin)
      torus.redraw(cascade.origin, after.dirty[k]!)
      const fresh = new Torus(CASCADE)
      fresh.fill(cascade.origin)
      expect(torus.differences(fresh)).toBe(0)
    })
    // The inner cascade's 25 m texels: 130 m east is five columns.
    expect(after.cascades[0]!.origin).not.toEqual(first.cascades[0]!.origin)
  })

  it('hold their orientation through a 0.04° turn of the sun and re-orient past 0.05°', () => {
    const first = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, null, false)
    const axis = horizonBasis(eye).north
    const held = sunCascades(
      eye,
      turned(sun, axis, 0.8 * SUN_CASCADE_TURN),
      shells(),
      EXTENTS,
      CASCADE,
      first.cascades,
      false,
    )
    expect(held.stale).toEqual([false, false, false])
    held.cascades.forEach((cascade, k) =>
      expect(cascade.toward).toEqual(first.cascades[k]!.toward),
    )
    const newSun = turned(sun, axis, 1.2 * SUN_CASCADE_TURN)
    const turnedOver = sunCascades(
      eye,
      newSun,
      shells(),
      EXTENTS,
      CASCADE,
      held.cascades,
      false,
    )
    expect(turnedOver.stale).toEqual([true, true, true])
    turnedOver.cascades.forEach((cascade) => {
      expect(dot(cascade.toward, unit(newSun))).toBeCloseTo(1, 14)
      expect(cascade.epoch).toBe(1)
    })
    for (const rects of turnedOver.dirty)
      expect(rects).toEqual([{ x: 0, y: 0, width: CASCADE, height: CASCADE }])
  })

  it('go stale whole on a jump of the field’s time, the sun unmoved', () => {
    const first = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, null, false)
    const jumped = sunCascades(
      eye,
      sun,
      shells(),
      EXTENTS,
      CASCADE,
      first.cascades,
      true,
    )
    expect(jumped.stale).toEqual([true, true, true])
    jumped.cascades.forEach((cascade) => expect(cascade.epoch).toBe(1))
  })

  it('start their epochs over on a cut, which stale reports and the epoch cannot', () => {
    const first = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, null, false)
    const jumped = sunCascades(
      eye,
      sun,
      shells(),
      EXTENTS,
      CASCADE,
      first.cascades,
      true,
    )
    jumped.cascades.forEach((cascade) => expect(cascade.epoch).toBe(1))
    // A cut passes no previous cascade: there is no epoch to count from.
    const cut = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, null, false)
    expect(cut.stale).toEqual([true, true, true])
    cut.cascades.forEach((cascade) => expect(cascade.epoch).toBe(0))
    // Before anything has rebuilt, a cut's cascades are a held frame's in
    // every field, the epoch among them, and `stale` is all that tells them
    // apart.
    const held = sunCascades(
      eye,
      sun,
      shells(),
      EXTENTS,
      CASCADE,
      first.cascades,
      false,
    )
    expect(cut.cascades).toEqual(held.cascades)
    expect(held.stale).toEqual([false, false, false])
  })

  it('rebuild a cascade the eye has carried past its box, and only that one', () => {
    /*
     * A rebuild sizes the box for the window grown by half its width, so the
     * inner cascade, 12.8 km across, re-centers once the window has crossed
     * 6.4 to 9 km of sun space toward the sun axis, depending on how the
     * square sits to it. Travel east, toward the sun's azimuth, crosses sun
     * space at sin 37.5° = 0.61 of its own rate, so that is 10 to 15 km of
     * it; the outer cascade's slack is sixteen times as far.
     */
    let previous = sunCascades(
      eye,
      sun,
      shells(),
      EXTENTS,
      CASCADE,
      null,
      false,
    )
    const { east } = horizonBasis(eye)
    let rebuiltAt = -1
    for (let km = 1; km <= 30; km += 1) {
      const moved = add(eye, scale(east, 1000 * km))
      const now = sunCascades(
        moved,
        sun,
        shellHeights(moved, EARTH, boundaries),
        EXTENTS,
        CASCADE,
        previous.cascades,
        false,
      )
      expect(now.stale[2]).toBe(false)
      if (now.stale[0] && rebuiltAt < 0) rebuiltAt = km
      previous = now
    }
    expect(rebuiltAt).toBeGreaterThanOrEqual(10)
    expect(rebuiltAt).toBeLessThanOrEqual(15)
  })

  it('rebuild a cascade that carries no near plane of its own', () => {
    const first = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, null, false)
    const bare = first.cascades.map(({ plane: _plane, ...rest }) => rest)
    const after = sunCascades(eye, sun, shells(), EXTENTS, CASCADE, bare, false)
    expect(after.stale).toEqual([true, true, true])
  })
})
