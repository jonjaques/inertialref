import { describe, expect, it } from 'vitest'
import { deg, type Radians } from '@inertialref/shared'
import { Vec, vec3 } from '@inertialref/spatial'
import { TEST_CATALOG } from '@inertialref/universe'
import type { GameHarness } from './harness.ts'
import { Maneuvers } from './maneuvers.ts'
import { openSession } from './session.ts'

const MARS = 'g:milky-way/s:SOL/b:3'
const EARTH = 'g:milky-way/s:SOL/b:2'

/** A session is a `Host`, so the verbs are tested without the harness. */
function flying() {
  const session = openSession({ seed: 'inertialref', catalog: TEST_CATALOG })
  return { session, verbs: new Maneuvers(session) }
}

/** The nose against the way back to the frame's origin, where its body is. */
const onTheBody = (result: {
  readonly heading: { x: number; y: number; z: number }
  readonly state: { readonly position: { x: number; y: number; z: number } }
}): number =>
  Vec.dot(
    vec3(result.heading.x, result.heading.y, result.heading.z),
    Vec.normalize(Vec.negate(result.state.position)),
  )

describe('the flying verbs', () => {
  it('lands at the equator without angles, and refuses a non-finite one unwritten', () => {
    const { session, verbs } = flying()
    const before = session.world.stateHash()
    expect(() => verbs.land(MARS, deg(Number.NaN), deg(0))).toThrow(/finite/)
    expect(() => verbs.land(MARS, deg(20), deg(Number.NaN))).toThrow(/finite/)
    expect(session.world.stateHash()).toBe(before)
    // A console call with no angles: `undefined` reaches the verb untyped.
    const result = verbs.land(MARS)
    expect(Number.isFinite(result.state.position.x)).toBe(true)
    expect(result.state.frame).not.toMatch(/NaN/)
    session.world.runTicks(1)
    session.dispose()
  })

  it('takes a coasting ship off rails, and says so from the world', () => {
    const { session, verbs } = flying()
    verbs.orbit(EARTH, 400)
    const ship = session.player()!
    session.world.runTicks(600)
    expect(session.world.entities.require(ship).rails).not.toBeNull()
    expect(verbs.orbit(MARS, 400).droppedEpoch).toBe(true)
    expect(session.world.entities.require(ship).rails).toBeNull()
    session.dispose()
  })

  it('orbits sunward, nose along the track, and says what it wrote', () => {
    const { session, verbs } = flying()
    const result = verbs.orbit(EARTH, 400)
    expect(result.state.frame).toBe(`b:${EARTH}`)
    expect(result.droppedEpoch).toBe(true)
    // Along the track, not at the planet: that is `goTo`'s second half.
    expect(
      Vec.dot(result.heading, Vec.normalize(result.state.velocity)),
    ).toBeCloseTo(1, 9)
    // Sunward, which is a full face from where the ship sits.
    expect(result.phase).toBeLessThan(1)
    session.dispose()
  })

  it('arrives looking at what it was sent to', () => {
    const { session, verbs } = flying()
    expect(onTheBody(verbs.goTo('b:2'))).toBeCloseTo(1, 6)
    session.dispose()
  })

  it('faces a body without touching the trajectory', () => {
    const { session, verbs } = flying()
    const before = verbs.orbit(EARTH, 400).state
    const result = verbs.face(EARTH)
    expect(result.state.position).toEqual(before.position)
    expect(result.state.velocity).toEqual(before.velocity)
    expect(onTheBody(result)).toBeCloseTo(1, 9)
    expect(session.harness.inspect()?.throttle).toBe(0)
    session.dispose()
  })

  it('burns toward a body: faced, and the drive lit to the asked setting', () => {
    const { session, verbs } = flying()
    verbs.orbit(EARTH, 400)
    const result = verbs.burnToward(EARTH, 0.5)
    expect(onTheBody(result)).toBeCloseTo(1, 9)
    expect(session.harness.inspect()?.throttle).toBe(0.5)
    session.dispose()
  })

  it('lands in degrees, and a surface frame has no phase', () => {
    const { session, verbs } = flying()
    const result = verbs.land(MARS, deg(20), deg(-60))
    // The frame id carries the quantized radians: 20° is 0.349066 rad.
    expect(result.state.frame).toContain('0.349066')
    expect(result.state.frame).toContain('-1.047198')
    expect(result.phase).toBeNull()
    session.dispose()
  })

  it('has no phase in interstellar space or around a star', () => {
    const { session, verbs } = flying()
    expect(verbs.goToSystem('HIP71683', 40).phase).toBeNull()
    expect(verbs.goTo('HIP71683').phase).toBeNull()
    session.dispose()
  })

  it('takes no radian where it promises degrees', () => {
    // The brand is the whole check, and it is a compile-time one: this body
    // never runs, and `pnpm typecheck` fails if the line below stops being
    // an error.
    const misuse = (ir: GameHarness, radians: Radians): void => {
      // @ts-expect-error a bare number is not an angle in degrees
      ir.land(MARS, radians, radians)
    }
    expect(misuse).toBeTypeOf('function')
  })
})
