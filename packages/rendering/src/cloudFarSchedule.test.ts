import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, type Vec3 } from '@inertialref/spatial'
import {
  type FarAtlasFacts,
  type FarAtlasLayout,
  type FarAtlasState,
  farAtlasState,
  farBlockAngle,
  type FarBlockPlan,
  farBlockPlans,
  farOwed,
  farViewCap,
  stepFarAtlas,
} from './cloudFarSchedule.ts'
import { cachePace } from './cloudSunSchedule.ts'
import {
  CUBE_FACES,
  type CubeFace,
  cubeDirection,
  cubeTexelCoordinate,
} from './cubeSphere.ts'

/*
 * The far atlas's schedule, a frame at a time, over a cube stepped as the
 * weather cube steps: a discontinuity of the field starts a generation and
 * stales every face, and a face comes back a frame, the longest stale
 * first and the nearest the eye among those.
 */

const EARTH = 6_371_000
const TILE = 256
const GUTTER = 1
const SPAN = TILE + 2 * GUTTER
const ROWS = 3
const BLOCKS = [192, 128, 96] as const
const layoutOf = (block: number): FarAtlasLayout => ({
  tile: TILE,
  gutter: GUTTER,
  rows: ROWS,
  block,
})
const ALL_LEVELS = [true, true, true] as const
const LOW_LEVEL = [true, false, false] as const
const FACES: readonly CubeFace[] = [0, 1, 2, 3, 4, 5]

/** The weather cube's schedule, as `CloudMaps.render` keeps it. */
interface Cube {
  generation: number
  readonly faces: number[]
  readonly stale: (number | null)[]
}

const cubeOf = (): Cube => ({
  generation: 0,
  faces: [-1, -1, -1, -1, -1, -1],
  stale: [null, null, null, null, null, null],
})

function stepCube(cube: Cube, frame: number, event: boolean, eye: Vec3): void {
  if (event) {
    cube.generation += 1
    for (const f of FACES) cube.stale[f] ??= frame
  }
  const nearest = [...FACES].sort(
    (a, b) =>
      Vec.dot(CUBE_FACES[b]!.normal, eye) -
        Vec.dot(CUBE_FACES[a]!.normal, eye) || a - b,
  )
  let chosen: CubeFace | null = null
  for (const face of nearest) {
    const since = cube.stale[face]
    if (since === null || since === undefined) continue
    if (chosen === null || since < cube.stale[chosen]!) chosen = face
  }
  if (chosen === null) return
  cube.stale[chosen] = null
  cube.faces[chosen] = cube.generation
}

/** An atlas over a cube, and what each block's texels were baked from. */
interface Session {
  readonly plans: readonly FarBlockPlan[]
  readonly cube: Cube
  state: FarAtlasState
  /** The least generation of its faces at each block's last bake: what its texels hold. */
  readonly holds: number[]
  /** Bakes of each block. */
  readonly bakes: number[]
  frame: number
}

function sessionOf(block: number): Session {
  const plans = farBlockPlans(layoutOf(block))
  return {
    plans,
    cube: cubeOf(),
    state: farAtlasState(plans),
    holds: plans.map(() => -1),
    bakes: plans.map(() => 0),
    frame: 0,
  }
}

interface Frame {
  readonly event: boolean
  readonly eye: Vec3
  readonly cap: number
  readonly levels: readonly boolean[]
  readonly owed: number
  readonly blocks: number
  /** The atlas's own generation. */
  readonly generation?: number
}

function step(session: Session, frame: Frame) {
  const { cube, plans } = session
  stepCube(cube, session.frame, frame.event, frame.eye)
  const facts: FarAtlasFacts = {
    frame: session.frame,
    generation: frame.generation ?? 0,
    source: { generation: cube.generation, faces: [...cube.faces] },
    levels: frame.levels,
    eye: frame.eye,
    cap: frame.cap,
    owed: frame.owed,
    blocks: frame.blocks,
  }
  const before = session.state
  const result = stepFarAtlas(plans, before, facts)
  for (const k of result.bake) {
    session.holds[k] = Math.min(...plans[k]!.faces.map((f) => cube.faces[f]!))
    session.bakes[k]! += 1
  }
  session.state = result.state
  session.frame += 1
  return { result, before, facts }
}

const heldOf = (
  plans: readonly FarBlockPlan[],
  levels: readonly boolean[],
): number[] =>
  plans.flatMap((plan, k) =>
    plan.levels.some((level) => levels[level] === true) ? [k] : [],
  )

const unitVector = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
  )
  .map(([z, phi]): Vec3 => {
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    return { x: r * Math.cos(phi), y: r * Math.sin(phi), z }
  })

const angleBetween = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.max(-1, Math.min(1, Vec.dot(a, b))))

describe('the far atlas’s blocks', () => {
  it.each(BLOCKS)(
    'of %i texels cover every texel of the atlas once, and each names its levels',
    (block) => {
      const plans = farBlockPlans(layoutOf(block))
      const width = 6 * SPAN
      const height = ROWS * SPAN
      expect(
        plans.reduce((sum, plan) => sum + plan.width * plan.height, 0),
      ).toBe(width * height)
      for (const plan of plans) {
        expect(plan.x % block).toBe(0)
        expect(plan.y % block).toBe(0)
        expect(plan.x + plan.width).toBeLessThanOrEqual(width)
        expect(plan.y + plan.height).toBeLessThanOrEqual(height)
        const first = Math.floor(plan.y / SPAN)
        const last = Math.floor((plan.y + plan.height - 1) / SPAN)
        expect(plan.levels).toEqual(
          Array.from({ length: last - first + 1 }, (_, k) => first + k),
        )
      }
    },
  )

  it('name every face a column of theirs stands on: a tile’s own, and the neighbor’s where they hold its gutter', () => {
    for (const block of BLOCKS)
      for (const plan of farBlockPlans(layoutOf(block))) {
        const faces = new Set<number>()
        let gutters = 0
        for (let y = plan.y; y < plan.y + plan.height; y += 1)
          for (let x = plan.x; x < plan.x + plan.width; x += 1) {
            const tile = Math.floor(x / SPAN)
            const i = x - tile * SPAN
            const j = y - Math.floor(y / SPAN) * SPAN
            const inside = i >= 1 && i <= TILE && j >= 1 && j <= TILE
            if (inside) faces.add(tile)
            else gutters += 1
          }
        // Every interior texel's tile, and with a gutter at least one more.
        for (const face of faces) expect(plan.faces).toContain(face)
        if (gutters === 0) expect(plan.faces).toEqual([...faces].sort())
        else expect(plan.faces.length).toBeGreaterThan(faces.size - 1)
        expect(plan.faces.length).toBeGreaterThan(0)
      }
    // A 96-texel block wholly inside one tile reads one face.
    const inner = farBlockPlans(layoutOf(96)).find(
      (plan) => plan.x === 96 && plan.y === 96,
    )
    expect(inner?.faces).toEqual([0])
    // The first block holds face 0's corner gutter: its −a and −b neighbors.
    expect(farBlockPlans(layoutOf(96))[0]?.faces.length).toBeGreaterThan(1)
  })

  it('stand at no angle from a direction inside them, and at the nearest texel’s from one outside', () => {
    const plans = farBlockPlans(layoutOf(128))
    /** A texel's diagonal at the face's center, radians: what a block's edge may stand nearer than its nearest texel center. */
    const texel = (Math.PI / 4) * (2 / TILE) * Math.SQRT2
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: plans.length - 1 }),
        unitVector,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (k, eye, u, v) => {
          const plan = plans[k]!
          const direction = (x: number, y: number): Vec3 => {
            const tile = Math.floor(x / SPAN)
            const level = Math.floor(y / SPAN)
            return cubeDirection(
              tile as CubeFace,
              cubeTexelCoordinate(TILE, GUTTER, x - tile * SPAN),
              cubeTexelCoordinate(TILE, GUTTER, y - level * SPAN),
            )
          }
          // A texel of the block: its center is inside the block.
          const x =
            plan.x + Math.min(plan.width - 1, Math.floor(u * plan.width))
          const y =
            plan.y + Math.min(plan.height - 1, Math.floor(v * plan.height))
          expect(farBlockAngle(plan, direction(x, y), ALL_LEVELS)).toBe(0)
          // Against the nearest of the block's texel centers, every fourth and its rim.
          let nearest = Infinity
          for (let j = plan.y; j < plan.y + plan.height; j += 1) {
            const rim = j === plan.y || j === plan.y + plan.height - 1
            for (let i = plan.x; i < plan.x + plan.width; i += rim ? 1 : 4)
              nearest = Math.min(nearest, angleBetween(eye, direction(i, j)))
          }
          const found = farBlockAngle(plan, eye, ALL_LEVELS)
          expect(found).toBeLessThanOrEqual(nearest + 1e-9)
          expect(found).toBeGreaterThanOrEqual(nearest - 4 * texel)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('hold no column of a level the body does not have', () => {
    const plans = farBlockPlans(layoutOf(128))
    const up: Vec3 = { x: 1, y: 0, z: 0 }
    for (const plan of plans) {
      const low = farBlockAngle(plan, up, LOW_LEVEL)
      expect(Number.isFinite(low)).toBe(plan.levels.includes(0))
    }
  })
})

describe('what is in view', () => {
  it('is a cap that grows with the eye’s height and never passes the whole body', () => {
    // From the ground, a top 10 km up is in view 3.2° round.
    expect(farViewCap(EARTH, 2, 10_000)).toBeCloseTo(0.0568, 3)
    // From 400 km, 19.8° of ground and the top's 3.2° past it.
    expect(farViewCap(EARTH, 400_000, 10_000)).toBeCloseTo(0.4018, 3)
    expect(farViewCap(EARTH, 1e12, 10_000)).toBeLessThanOrEqual(Math.PI)
    expect(farViewCap(EARTH, -50, 0)).toBe(0)
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        (low, more) => {
          expect(farViewCap(EARTH, low + more, 10_000)).toBeGreaterThanOrEqual(
            farViewCap(EARTH, low, 10_000),
          )
        },
      ),
    )
  })
})

describe('the far atlas’s schedule', () => {
  const quiet = (eye: Vec3, more: Partial<Frame> = {}): Frame => ({
    event: false,
    eye,
    cap: farViewCap(EARTH, 400_000, 10_500),
    levels: ALL_LEVELS,
    owed: 0,
    blocks: 1,
    ...more,
  })
  const UP: Vec3 = Vec.normalize({ x: 0.8, y: 0.5, z: 0.33 })

  /** Frames until the atlas owes nothing, the first an event. */
  function settle(session: Session, frame: Frame, most = 2000): number {
    for (let n = 0; n < most; n += 1) {
      const { result } = step(session, { ...frame, event: n === 0 })
      if (!result.pending) return n + 1
    }
    throw new Error('the atlas never settled')
  }

  it('reports no block fresh while it holds a field older than a face it reads, and spends no bake on faces a block has read', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BLOCKS),
        fc.array(
          fc.record({
            event: fc.boolean(),
            eye: unitVector,
            blocks: fc.constantFrom(1, 2, 4),
            own: fc.boolean(),
          }),
          { minLength: 1, maxLength: 160 },
        ),
        (block, frames) => {
          const session = sessionOf(block)
          let generation = 0
          for (const frame of frames) {
            // The atlas's own events are rarer than the field's.
            if (frame.own && frame.event) generation += 1
            const { result, before } = step(
              session,
              quiet(frame.eye, {
                event: frame.event,
                blocks: frame.blocks,
                generation,
              }),
            )
            expect(result.bake.length).toBeLessThanOrEqual(frame.blocks)
            expect(new Set(result.bake).size).toBe(result.bake.length)
            for (const k of result.bake) {
              const was = before.blocks[k]!
              const now = result.state.blocks[k]!
              // A bake reads newer faces than the last, or a newer atlas.
              expect(now.read > was.read || now.own > was.own).toBe(true)
            }
            let behind = 0
            session.state.blocks.forEach((record, k) => {
              const fresh =
                record.own === generation &&
                record.read >= session.cube.generation
              if (!fresh) behind += 1
              else expect(session.holds[k]).toBe(session.cube.generation)
            })
            expect(result.pending).toBe(behind > 0)
          }
        },
      ),
      { numRuns: 40 },
    )
  })

  it.each(BLOCKS)(
    'in blocks of %i, a scrub, which jumps every frame, still reaches every block and never calls the atlas whole',
    (block) => {
      const session = sessionOf(block)
      const held = heldOf(session.plans, ALL_LEVELS)
      // A face comes back every sixth frame, so a block is ready at least
      // that often, and the longest behind goes first.
      const frames = 8 * held.length
      for (let n = 0; n < frames; n += 1) {
        const { result } = step(session, quiet(UP, { event: true }))
        expect(result.pending).toBe(true)
      }
      for (const k of held) expect(session.bakes[k]).toBeGreaterThan(0)
      // No block is starved by the ones in view: the bakes are even to within a few.
      const counts = held.map((k) => session.bakes[k]!)
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(4)
    },
  )

  it('bakes nothing under a clock that stands still once it is whole, and at any pace what `cachePace` owes', () => {
    for (const block of BLOCKS) {
      const session = sessionOf(block)
      settle(session, quiet(UP))
      const units = heldOf(session.plans, ALL_LEVELS).length
      for (let n = 0; n < 640; n += 1)
        expect(step(session, quiet(UP)).result.bake).toEqual([])

      // At 1×: a field at 25 m/s over a sixtieth of a second.
      for (const warp of [1, 1000]) {
        const owed = farOwed((25 * warp) / 60, TILE, EARTH)
        let credit = session.state.credit
        let baked = 0
        const order: number[] = []
        for (let n = 0; n < 640; n += 1) {
          const pace = cachePace({ units, owed, credit, cap: 1 })
          credit = pace.credit
          const { result } = step(session, quiet(UP, { owed }))
          expect(result.bake.length).toBe(pace.bake)
          expect(result.pending).toBe(false)
          baked += result.bake.length
          order.push(...result.bake)
        }
        // Earth's least texel is 27.6 km, so a tenth of it at 25 m/s is
        // 110 s: 640 frames at 1× are a tenth of a cycle, and under a warp
        // of 1,000 the cap, a block every frame.
        if (warp === 1) {
          expect(baked).toBe(Math.floor(640 * units * owed))
          expect(baked).toBeLessThan(units / 8)
        } else {
          expect(baked).toBe(640)
          // The cycle goes round: no block twice before every block once.
          expect(new Set(order.slice(0, units)).size).toBe(units)
        }
      }
    }
  })

  it('bakes only the blocks of the levels a body has', () => {
    for (const block of BLOCKS) {
      const session = sessionOf(block)
      const frames = settle(session, quiet(UP, { levels: LOW_LEVEL }))
      const held = heldOf(session.plans, LOW_LEVEL)
      expect(held.length).toBeLessThan(session.plans.length / 2)
      session.bakes.forEach((count, k) => {
        expect(count).toBe(held.includes(k) ? 1 : 0)
      })
      // Six frames of faces, and a block a frame.
      expect(frames).toBeLessThanOrEqual(held.length + 6)
    }
  })

  it('after an event bakes the blocks in view first, the nearest first, and is whole in view within B7’s 48 frames from 400 km', () => {
    /** The eye's places: a face's center, an edge's middle, a cube's corner, and E2's. */
    const places: readonly Vec3[] = [
      { x: 1, y: 0, z: 0 },
      Vec.normalize({ x: 1, y: 1, z: 0 }),
      Vec.normalize({ x: 1, y: 1, z: 1 }),
      UP,
    ]
    const stances = {
      ground: 2,
      orbit: 400_000,
      // The whole disc in frame through a 60° lens: 2.1 radii out.
      disc: 2.1 * EARTH,
    } as const
    const frames: Record<string, number> = {}
    for (const block of BLOCKS)
      for (const [name, height] of Object.entries(stances))
        for (const levels of [LOW_LEVEL, ALL_LEVELS]) {
          let worst = 0
          for (const eye of places) {
            const session = sessionOf(block)
            // Whole first, so the event is one of a running session.
            const cap = farViewCap(EARTH, height, 10_500)
            settle(session, quiet(eye, { cap, levels }))
            let whole = -1
            for (let n = 0; n < 400 && whole < 0; n += 1) {
              const { result, facts } = step(
                session,
                quiet(eye, { cap, levels, event: n === 0 }),
              )
              const inView = (k: number): boolean =>
                farBlockAngle(session.plans[k]!, eye, levels) <= facts.cap
              // A block out of view is baked only on a frame that leaves
              // no block in view both behind and ready: one still behind
              // is waiting for a face.
              if (result.bake.some((k) => !inView(k)))
                session.state.blocks.forEach((record, k) => {
                  const behind = record.read < session.cube.generation
                  if (!behind || !inView(k)) return
                  if (!session.plans[k]!.levels.some((level) => levels[level]))
                    return
                  expect(
                    session.plans[k]!.faces.some(
                      (face) =>
                        session.cube.faces[face]! < session.cube.generation,
                    ),
                  ).toBe(true)
                })
              if (result.pendingInView === 0) whole = n + 1
            }
            expect(whole).toBeGreaterThan(0)
            worst = Math.max(worst, whole)
          }
          frames[`${block} ${name} ${levels === LOW_LEVEL ? 'one' : 'three'}`] =
            worst
        }
    // Frames from an event to no block pending in view, a block a frame,
    // the worst of the four places: the figures the design's §4.7 quotes.
    expect(frames).toMatchInlineSnapshot(`
      {
        "128 disc one": 35,
        "128 disc three": 87,
        "128 ground one": 12,
        "128 ground three": 36,
        "128 orbit one": 13,
        "128 orbit three": 37,
        "192 disc one": 22,
        "192 disc three": 46,
        "192 ground one": 8,
        "192 ground three": 17,
        "192 orbit one": 12,
        "192 orbit three": 25,
        "96 disc one": 35,
        "96 disc three": 110,
        "96 ground one": 8,
        "96 ground three": 17,
        "96 orbit one": 12,
        "96 orbit three": 35,
      }
    `)
    for (const block of BLOCKS) {
      expect(frames[`${block} orbit one`]).toBeLessThanOrEqual(48)
      expect(frames[`${block} orbit three`]).toBeLessThanOrEqual(48)
    }
  })
})
