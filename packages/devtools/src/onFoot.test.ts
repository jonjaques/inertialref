import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import {
  bodyFrameId,
  type EntityId,
  parseAddress,
  TEST_CATALOG,
} from '@inertialref/universe'
import { openSession, type SessionOptions } from './session.ts'

const MARS = 'g:milky-way/s:SOL/b:3'
const EARTH = 'g:milky-way/s:SOL/b:2'

/** A session whose ship is parked on Mars, landed after its first tick. */
function parked(options: SessionOptions = {}) {
  const session = openSession({
    seed: 'inertialref',
    catalog: TEST_CATALOG,
    ...options,
  })
  const ship = session.player()!
  session.harness.land(MARS, 0.35, -1.1)
  session.harness.step(1)
  return { session, ir: session.harness, ship }
}

describe('on foot, headlessly', () => {
  it('steps out beside a landed ship and back in, with no engine', () => {
    const { session, ir, ship } = parked()
    const walker = unwrap(ir.onFoot.stepOut(), 'step out')
    expect(session.player()).toBe(walker.id)
    expect(walker.character?.vessel).toBe(ship)
    expect(ir.onFoot.ship()).toBe(ship)
    ir.step(64)
    expect(ir.onFoot.status().grounded).toBe(true)
    // Beside it, not inside it and not across the plain: the default beam
    // puts the walker six meters out, and the surface curves under that.
    const apart = UV.distance(
      session.world.canonicalPositionOf(walker.id),
      session.world.canonicalPositionOf(ship),
    )
    expect(apart).toBeGreaterThan(5)
    expect(apart).toBeLessThan(7)

    expect(unwrap(ir.onFoot.board(), 'board')).toBe(ship)
    expect(session.player()).toBe(ship)
    expect(session.world.entities.has(walker.id)).toBe(false)
    expect(session.world.isLanded(ship)).toBe(true)
    session.dispose()
  })

  it('refuses to step out of a ship in flight, and writes nothing', () => {
    const session = openSession({ seed: 'inertialref', catalog: TEST_CATALOG })
    const before = session.world.stateHash()
    expect(session.harness.onFoot.available()).toBe(false)
    expect(session.harness.onFoot.stepOut().ok).toBe(false)
    expect(session.world.stateHash()).toBe(before)
    session.dispose()
  })

  it('refuses flight to a loaded walker its host does not grant it', () => {
    const granted = parked({ canFly: true })
    const walker = unwrap(granted.ir.onFoot.stepOut(), 'step out')
    granted.ir.step(1)
    expect(granted.session.world.setCharacterFlying(walker.id, true)).toBe(true)
    const text = granted.ir.save()

    const refused = openSession({
      seed: 'inertialref',
      catalog: TEST_CATALOG,
      canFly: false,
    })
    expect(refused.harness.load(text).ok).toBe(true)
    const loaded = refused.world.entities.require(walker.id).character!
    expect(loaded.canFly).toBe(false)
    expect(loaded.flying).toBe(false)
    expect(refused.world.setCharacterFlying(walker.id, true)).toBe(false)
    expect(refused.harness.onFoot.status().canFly).toBe(false)
    granted.session.dispose()
    refused.dispose()
  })

  it('steps back into the ship it left after a load, not the first one', () => {
    // Two ships landed on Mars, and the walker belongs to the second. Entity
    // order names the first, so a rule that guessed would pass with one ship
    // and fail here.
    const { session, ir, ship: first } = parked()
    const second = session.world.spawnShip(
      'Second',
      bodyFrameId(parseAddress(MARS)),
      vec3(0, 0, 0),
    ).id
    session.controlPlayer(second)
    ir.land(MARS, 0.36, -1.1)
    ir.step(1)
    expect(session.world.isLanded(first)).toBe(true)
    expect(session.world.isLanded(second)).toBe(true)
    unwrap(ir.onFoot.stepOut(), 'step out')
    const text = ir.save()

    const reloaded = openSession({ seed: 'inertialref', catalog: TEST_CATALOG })
    expect(reloaded.harness.load(text).ok).toBe(true)
    expect(unwrap(reloaded.harness.onFoot.board(), 'board')).toBe(second)
    expect(reloaded.player()).toBe(second)
    session.dispose()
    reloaded.dispose()
  })
})

describe('a ship verb on foot', () => {
  /** Out of the ship, holding forward, so a verb that ignored it would show. */
  function walking() {
    const parkedShip = parked()
    const walker = unwrap(parkedShip.ir.onFoot.stepOut(), 'step out')
    parkedShip.session.world.setCharacterInput(walker.id, { forward: 1 })
    return { ...parkedShip, walker: walker.id }
  }

  const boarded = (
    session: ReturnType<typeof openSession>,
    ship: EntityId,
    walker: EntityId,
  ): void => {
    expect(session.player()).toBe(ship)
    expect(session.world.entities.has(walker)).toBe(false)
  }

  it('goTo boards, then flies the ship there', () => {
    const { session, ir, ship, walker } = walking()
    ir.goTo('b:2')
    boarded(session, ship, walker)
    expect(session.world.entities.require(ship).state.frame).toBe(
      bodyFrameId(parseAddress(EARTH)),
    )
    session.dispose()
  })

  it('face boards, then turns the ship and nothing else', () => {
    const { session, ir, ship, walker } = walking()
    const where = session.world.entities.require(ship).state.position
    ir.face(EARTH)
    boarded(session, ship, walker)
    const state = session.world.entities.require(ship).state
    expect(state.position).toEqual(where)
    // The nose, not a walker's head: forward is −Z in the ship's own axes.
    const forward = Q.rotate(
      session.world.frames.pose(state.frame, session.world.clock.time)
        .orientation,
      Q.rotate(state.orientation, vec3(0, 0, -1)),
    )
    const toEarth = UV.difference(
      session.world.frames.pose(
        bodyFrameId(parseAddress(EARTH)),
        session.world.clock.time,
      ).position,
      session.world.canonicalPositionOf(ship),
    )
    expect(Vec.dot(forward, Vec.normalize(toEarth))).toBeCloseTo(1, 6)
    session.dispose()
  })

  it('burnToward boards, then lights the ship', () => {
    const { session, ir, ship, walker } = walking()
    ir.burnToward(EARTH, 0.5)
    boarded(session, ship, walker)
    expect(session.world.entities.require(ship).control.throttle).toBe(0.5)
    session.dispose()
  })

  it('throws when the walker has no ship to step back into', () => {
    const { session, ir } = parked()
    const mars = session.world.bodyAt(bodyFrameId(parseAddress(MARS)))!
    const stray = session.world.spawnCharacter(mars, 0.2, -1.1)
    session.controlPlayer(stray.id)
    const before = session.world.stateHash()
    expect(() => ir.goTo('b:2')).toThrow(/no ship/)
    expect(() => ir.face(EARTH)).toThrow(/no ship/)
    expect(() => ir.burnToward(EARTH)).toThrow(/no ship/)
    expect(session.player()).toBe(stray.id)
    expect(session.world.stateHash()).toBe(before)
    session.dispose()
  })
})
