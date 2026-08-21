import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  LIGHT_YEAR,
  type Meters,
  type Seconds,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import { Rng, rootSeed } from '@inertialref/procedural'
import { circularSpeed } from '@inertialref/physics'
import {
  canonicalPosition,
  localToUniverse,
  POSITION_RESOLUTION,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  bodyFixedDirection,
  bodyFixedFrameId,
  bodyFrameId,
  surfaceRadius,
  systemFrameId,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { MAX_WARP_STEPS, TICK_DURATION, TICK_RATE } from './clock.ts'
import { snapshot } from './snapshot.ts'
import { World } from './world.ts'

const SOL = systemId('SOL')

// Available in every runtime this package targets, but not in the ES2023 lib,
// and packages/* deliberately does not pull in Node's type definitions.
declare const structuredClone: <T>(value: T) => T

function solarWorld(seed = 'inertialref'): World {
  const world = new World({ seed })
  world.loadSystem(SOL)
  return world
}

/** First planet with solid ground and an atmosphere — somewhere to land. */
function landingTarget(world: World) {
  const system = world.system(SOL)
  if (system === undefined) throw new Error('SOL not loaded')
  for (const body of walkBodies(system)) {
    if (body.kind === 'rocky' && body.atmosphere !== null && body.radius > 1e6)
      return body
  }
  const first = system.planets[0]
  if (first === undefined) throw new Error('no planets')
  return first
}

/** First solid body with no atmosphere at all — somewhere to hit hard. */
function airlessTarget(world: World) {
  const system = world.system(SOL)
  if (system === undefined) throw new Error('SOL not loaded')
  for (const body of walkBodies(system))
    if (body.kind === 'rocky' && body.atmosphere === null && body.radius > 1e6)
      return body
  throw new Error('no airless world')
}

/**
 * Distance from the centre to the actual ground under the +X axis.
 *
 * Not `body.radius`. The datum is a sea-level convention and the terrain sits
 * either side of it — on Venus it reaches 6.9 km above, and a ship "hovering
 * 30 m up" from the datum is nearly seven kilometres underground. These tests
 * used to spawn against the datum and passed only because the generated planet
 * they happened to land on had low ground at that longitude; the moment Sol's
 * bodies became the real ones, both landings began underground.
 */
function groundRadius(world: World, body: Body): number {
  const spin = world.frames.pose(
    bodyFixedFrameId(body.address),
    world.clock.time,
  )
  const centre = world.frames.pose(
    bodyFrameId(body.address),
    world.clock.time,
  ).position
  const above = UV.translate(centre, vec3(body.radius, 0, 0))
  return surfaceRadius(body, bodyFixedDirection(spin, above))
}

describe('simulation clock', () => {
  it('produces the same universe at 60 Hz and at 144 Hz', () => {
    // The headline determinism requirement: frame rate decides how many fixed
    // steps to run and nothing else.
    const runTo = (hz: number, targetTick: number): World => {
      const world = solarWorld()
      const planet = landingTarget(world)
      world.spawnShip(
        'probe',
        bodyFrameId(planet.address),
        vec3(planet.radius * 3, 0, 0),
      )
      // Run until the tick target rather than for a wall-clock duration: which
      // tick a given number of frames lands on is a property of floating-point
      // frame times, and is not what this test is about.
      while (world.clock.tick < targetTick) world.advance(1 / hz)
      return world
    }
    const slow = runTo(60, 256)
    const fast = runTo(144, 256)
    // A 60 Hz frame is longer than a 64 Hz tick, so it sometimes buys two; the
    // claim is not that both land on the same tick, it is that the state at a
    // given tick does not depend on the frame times that got there.
    const target = Math.max(slow.clock.tick, fast.clock.tick)
    slow.runTicks(target - slow.clock.tick)
    fast.runTicks(target - fast.clock.tick)
    expect(fast.stateHash()).toBe(slow.stateHash())
  })

  it('is unaffected by irregular frame times', () => {
    const rng = new Rng(rootSeed('frame-jitter'))
    const jittery = solarWorld()
    const steady = solarWorld()
    for (const world of [jittery, steady]) {
      const planet = landingTarget(world)
      world.spawnShip(
        'probe',
        bodyFrameId(planet.address),
        vec3(planet.radius * 4, 0, 0),
      )
    }

    // A stuttering client: frames from 4 ms to 60 ms.
    while (jittery.clock.tick < 600) jittery.advance(rng.range(0.004, 0.06))
    steady.runTicks(jittery.clock.tick)
    expect(jittery.stateHash()).toBe(steady.stateHash())
  })

  it('treats time warp as more ticks, not longer ticks', () => {
    const warped = solarWorld()
    const real = solarWorld()
    for (const world of [warped, real]) {
      const planet = landingTarget(world)
      world.spawnShip(
        'probe',
        bodyFrameId(planet.address),
        vec3(planet.radius * 5, 0, 0),
      )
    }
    warped.clock.setTimeScale(100)
    // 100x for one frame-second buys the same ticks as 1x for a hundred.
    while (warped.clock.tick < 3_200) warped.advance(1 / 60)
    real.runTicks(warped.clock.tick)
    expect(warped.stateHash()).toBe(real.stateHash())
    expect(warped.clock.time).toBeCloseTo(real.clock.time, 12)
  })

  it('converts ticks to seconds exactly', () => {
    const world = solarWorld()
    world.runTicks(TICK_RATE * 3)
    // 1/64 is exact in binary; at 60 Hz this assertion fails in the low bits.
    expect(world.clock.time).toBe(3)
    expect(TICK_DURATION * TICK_RATE).toBe(1)
  })

  it('drops ticks rather than spiralling after a long stall', () => {
    const world = solarWorld()
    const ran = world.advance(60)
    expect(ran).toBeLessThanOrEqual(8)
    expect(world.clock.status().droppedTicks).toBeGreaterThan(3_000)
  })

  it('still guards the stall at 1x once warp has been used', () => {
    // The warp budget must not become a bigger stall budget: coming back from a
    // backgrounded minute has to behave the same whether or not the player
    // warped earlier in the session.
    const world = solarWorld()
    world.clock.setTimeScale(1_000)
    world.advance(1 / 60)
    world.clock.setTimeScale(1)
    expect(world.advance(60)).toBeLessThanOrEqual(8)
  })

  it('delivers every time-warp detent the dock offers, up to the ceiling', () => {
    // The regression this exists for: the step budget was a flat 8 ticks per
    // frame, which is 480 ticks/s at 60 fps — 7.5x real time — so 25x, 100x,
    // 1000x and 100000x were all the same speed and the difference went into
    // droppedTicks without ever being shown. Reinstate `min(wanted, 8)` and this
    // goes red at 25x.
    const frame = 1 / 60
    for (const scale of [1, 5, 25, 100, 1_000]) {
      const world = solarWorld()
      world.clock.setTimeScale(scale)
      let ticks = 0
      for (let i = 0; i < 60; i++) ticks += world.advance(frame)
      // A second of frames should buy `scale` seconds of simulation. The bound
      // is one tick, not a tolerance: the accumulator carries a fractional
      // remainder across the last frame and that is the whole of the error.
      expect(Math.abs(ticks - scale * TICK_RATE)).toBeLessThanOrEqual(1)
      expect(world.clock.status().droppedTicks).toBe(0)
    }
  })

  it('says how much of the requested warp it is actually delivering', () => {
    const frame = 1 / 60
    const keepingUp = solarWorld()
    keepingUp.clock.setTimeScale(100)
    keepingUp.advance(frame)
    // Exactly, not approximately: it is a ratio of ticks wanted to ticks run.
    expect(keepingUp.clock.status().achievedTimeScale).toBe(100)

    const capped = solarWorld()
    capped.clock.setTimeScale(100_000)
    expect(capped.advance(frame)).toBe(MAX_WARP_STEPS)
    const status = capped.clock.status()
    expect(status.achievedTimeScale).toBeLessThan(100_000)

    // MAX_WARP_STEPS ticks per frame at 60 fps, as a multiple of the 64 Hz tick
    // rate — the ceiling stated where it comes from rather than as a number that
    // happens to pass.
    const ceiling = MAX_WARP_STEPS / frame / TICK_RATE
    // The ratio's denominator is floored to a whole tick, so it can be short by
    // one out of the ~107,000 this frame wanted. That, and not a chosen
    // tolerance, is the entire width of this bound.
    const wanted = Math.floor((100_000 * frame) / TICK_DURATION)
    expect(status.achievedTimeScale).toBeGreaterThanOrEqual(ceiling)
    expect(status.achievedTimeScale).toBeLessThanOrEqual(
      ceiling * (1 + 1 / wanted),
    )
  })

  it('never runs more ticks in one frame than the ceiling allows', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 1 / 240, max: 1, noNaN: true }),
        (scale, delta) => {
          const world = solarWorld()
          world.clock.setTimeScale(scale)
          expect(world.advance(delta)).toBeLessThanOrEqual(MAX_WARP_STEPS)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('pauses without drifting', () => {
    const world = solarWorld()
    world.clock.setPaused(true)
    expect(world.advance(5)).toBe(0)
    expect(world.clock.tick).toBe(0)
    world.clock.setPaused(false)
    expect(world.advance(1 / 64)).toBe(1)
  })
})

describe('flight', () => {
  it('holds a circular orbit', () => {
    const world = solarWorld()
    const planet = landingTarget(world)
    const radius = planet.radius * 2
    const speed = circularSpeed(planet.mu, radius)
    const ship = world.spawnShip(
      'orbiter',
      bodyFrameId(planet.address),
      vec3(radius, 0, 0),
    )
    world.entities.update(ship.id, {
      state: {
        ...world.entities.require(ship.id).state,
        velocity: vec3(0, 0, -speed),
      },
    })

    world.runTicks(20_000)
    const state = world.entities.require(ship.id).state
    expect(state.frame).toBe(bodyFrameId(planet.address))
    // Symplectic integration: the orbit may precess, its radius may not drift.
    expect(Vec.length(state.position) / radius).toBeCloseTo(1, 2)
    expect(Vec.length(state.velocity) / speed).toBeCloseTo(1, 2)
  })

  it('replays identically from identical inputs', () => {
    const run = (): string => {
      const world = solarWorld()
      const planet = landingTarget(world)
      const ship = world.spawnShip(
        'pilot',
        bodyFrameId(planet.address),
        vec3(planet.radius * 6, 0, 0),
      )
      const rng = new Rng(rootSeed('pilot-inputs'))
      for (let i = 0; i < 2_000; i += 1) {
        if (i % 40 === 0) {
          world.entities.update(ship.id, {
            control: {
              translation: vec3(
                rng.range(-1, 1),
                rng.range(-1, 1),
                rng.range(-1, 1),
              ),
              rotation: vec3(
                rng.range(-1, 1),
                rng.range(-1, 1),
                rng.range(-1, 1),
              ),
            },
          })
        }
        world.step()
      }
      return world.stateHash()
    }
    expect(run()).toBe(run())
  })

  it('descends into a planet frame on approach without moving', () => {
    const world = solarWorld()
    const planet = landingTarget(world)
    const system = world.system(SOL)
    if (system === undefined) throw new Error('no system')

    // Start in the system frame, just outside the planet's sphere of influence,
    // falling toward it.
    const t = world.clock.time
    const planetPose = world.frames.pose(bodyFrameId(planet.address), t)
    const systemPose = world.frames.pose(systemFrameId(SOL), t)
    const toPlanet = UV.difference(planetPose.position, systemPose.position)
    const inbound = Vec.withLength(
      toPlanet,
      Vec.length(toPlanet) - planet.sphereOfInfluence * 1.02,
    )
    const ship = world.spawnShip('inbound', systemFrameId(SOL), inbound)
    // Arrival speed of something that has just crossed interstellar space.
    const fall = Vec.scale(Vec.normalize(Vec.sub(toPlanet, inbound)), 200_000)
    world.entities.update(ship.id, {
      state: { ...world.entities.require(ship.id).state, velocity: fall },
    })

    const before = world.canonicalPositionOf(ship.id)
    let changedAt = -1
    for (let i = 0; i < 60_000 && changedAt < 0; i += 1) {
      const previousFrame = world.entities.require(ship.id).state.frame
      const canonicalBefore = world.canonicalPositionOf(ship.id)
      world.step()
      const state = world.entities.require(ship.id).state
      if (state.frame !== previousFrame) {
        changedAt = i
        // The transition itself must be invisible: same place, same instant.
        const canonicalAfter = canonicalPosition(
          world.frames,
          state,
          world.clock.time - TICK_DURATION,
        )
        expect(UV.distance(canonicalAfter, canonicalBefore)).toBeLessThan(
          Vec.length(fall) * TICK_DURATION * 2,
        )
      }
    }
    expect(changedAt).toBeGreaterThan(0)
    expect(world.entities.require(ship.id).state.frame).toBe(
      bodyFrameId(planet.address),
    )
    // It travelled; it did not teleport.
    expect(
      UV.distance(before, world.canonicalPositionOf(ship.id)),
    ).toBeGreaterThan(1e6)
    expect(world.events().some((e) => e.kind === 'frame-change')).toBe(true)
  })

  it('lands, sticks to the ground, and rides the rotation', () => {
    const world = solarWorld()
    const planet = landingTarget(world)
    // Hovering 30 m up, descending at 2 m/s: a controlled touchdown.
    const ship = world.spawnShip(
      'lander',
      bodyFrameId(planet.address),
      vec3(groundRadius(world, planet) + 30, 0, 0),
    )
    world.entities.update(ship.id, {
      state: {
        ...world.entities.require(ship.id).state,
        velocity: vec3(-2, 0, 0),
      },
    })

    let landedAt = -1
    for (let i = 0; i < 60_000 && landedAt < 0; i += 1) {
      world.step()
      if (world.isLanded(ship.id)) landedAt = i
    }
    expect(landedAt).toBeGreaterThan(0)

    const state = world.entities.require(ship.id).state
    expect(state.frame.startsWith('sf:')).toBe(true)
    expect(Vec.length(state.velocity)).toBe(0)

    // Standing still on the surface is not standing still in the universe: a
    // day later the ship has gone round with the planet.
    const before = world.canonicalPositionOf(ship.id)
    world.runTicks(TICK_RATE * 600)
    const after = world.canonicalPositionOf(ship.id)
    expect(UV.distance(before, after)).toBeGreaterThan(1_000)
    // ...but it has not moved relative to the ground.
    expect(
      Vec.length(world.entities.require(ship.id).state.position),
    ).toBeLessThan(5)
    expect(world.clock.time).toBeLessThan(SECONDS_PER_DAY)
  })

  it('hands back the ground speed on lift-off', () => {
    const world = solarWorld()
    const planet = landingTarget(world)
    const ship = world.spawnShip(
      'lander',
      bodyFrameId(planet.address),
      vec3(groundRadius(world, planet) + 30, 0, 0),
    )
    world.entities.update(ship.id, {
      state: {
        ...world.entities.require(ship.id).state,
        velocity: vec3(-2, 0, 0),
      },
    })
    for (let i = 0; i < 60_000 && !world.isLanded(ship.id); i += 1) world.step()
    expect(world.isLanded(ship.id)).toBe(true)

    world.entities.update(ship.id, {
      control: { translation: vec3(0, 1, 0), rotation: Vec.ZERO },
    })
    world.step()
    world.step()
    expect(world.isLanded(ship.id)).toBe(false)
    const state = world.entities.require(ship.id).state
    expect(state.frame).toBe(bodyFrameId(planet.address))
    // Inherited the planet's surface speed without anything computing it here.
    const surfaceSpeed =
      (2 * Math.PI * planet.radius) / Math.abs(planet.rotationPeriod)
    expect(Vec.length(state.velocity)).toBeGreaterThan(surfaceSpeed * 0.3)
  })

  it('stops a ship that hits the ground fast, and calls it what it is', () => {
    /*
     * No collision handling at all was the original state of this code: a ship
     * dropped from orbit flew straight through the planet and out the far side.
     *
     * On an **airless** body, deliberately. This used to run on whatever the
     * first rocky-with-an-atmosphere planet was, and against the real Solar
     * System that is Venus — where the surface air is 65 kg/m³, denser than any
     * other gas in the system, and 400 m/s becomes a few metres per second long
     * before the ground arrives. That is the drag model working, and it is not
     * what this test is about.
     */
    const world = solarWorld()
    const planet = airlessTarget(world)
    const ship = world.spawnShip(
      'doomed',
      bodyFrameId(planet.address),
      vec3(groundRadius(world, planet) + 5_000, 0, 0),
    )
    world.entities.update(ship.id, {
      state: {
        ...world.entities.require(ship.id).state,
        velocity: vec3(-400, 0, 0),
      },
    })
    for (let i = 0; i < 20_000 && !world.isLanded(ship.id); i += 1) world.step()

    expect(world.isLanded(ship.id)).toBe(true)
    const touchdown = world.events().find((e) => e.kind === 'touchdown')
    expect(touchdown?.detail).toMatch(/hard landing/)
    // Never below the surface.
    const altitude = world.altitudeOf(ship.id)
    expect(altitude === null || altitude > -50).toBe(true)
  })
})

describe('streaming', () => {
  it('loads and unloads systems as ordinary control flow', () => {
    const world = new World({ seed: 'inertialref' })
    const sol = world.loadSystem(SOL)
    const ship = world.spawnShip('scout', systemFrameId(SOL), vec3(1e9, 0, 0))

    const near = world.updateInterest(sol.position, 5 * LIGHT_YEAR)
    expect(near.loaded.length).toBeGreaterThan(0)
    expect(world.loadedSystems().length).toBeGreaterThan(1)

    // Move the interest centre far away: everything unloads except the system
    // the ship is actually in.
    const far = UV.translate(sol.position, vec3(200 * LIGHT_YEAR, 0, 0))
    world.updateInterest(far, 5 * LIGHT_YEAR)
    const remaining = world.loadedSystems().map((s) => s.id)
    expect(remaining).toContain(SOL)
    expect(world.entities.require(ship.id).state.frame).toBe(systemFrameId(SOL))
  })

  it('refuses to unload a system an entity is inside', () => {
    const world = solarWorld()
    world.spawnShip('scout', systemFrameId(SOL), vec3(1e9, 0, 0))
    expect(() => world.unloadSystem(SOL)).toThrow(/still inside/)
  })

  it('regenerates an unloaded system identically', () => {
    const world = solarWorld()
    const before = JSON.stringify(world.system(SOL))
    world.unloadSystem(SOL)
    expect(world.system(SOL)).toBeUndefined()
    world.loadSystem(SOL)
    expect(JSON.stringify(world.system(SOL))).toBe(before)
  })
})

describe('snapshots', () => {
  it('describes the world without exposing it', () => {
    const world = solarWorld()
    const planet = landingTarget(world)
    world.spawnShip(
      'probe',
      bodyFrameId(planet.address),
      vec3(planet.radius * 3, 0, 0),
    )
    world.runTicks(64)

    const shot = snapshot(world, 0.5)
    expect(shot.tick).toBe(64)
    expect(shot.entities).toHaveLength(1)
    expect(shot.bodies.length).toBeGreaterThan(0)
    expect(shot.stars).toHaveLength(1)
    const entity = shot.entities[0]
    if (entity === undefined) throw new Error('no entity')
    expect(entity.frameChain[0]).toBe('universe')
    expect(UV.isValid(entity.position)).toBe(true)
    // Structured-cloneable: no class instances, no functions.
    expect(() => structuredClone(shot)).not.toThrow()
  })

  it('interpolates bodies analytically rather than by lerping', () => {
    const world = solarWorld()
    world.runTicks(10)
    const a = snapshot(world, 0)
    const b = snapshot(world, 0.5)
    const c = snapshot(world, 1)
    const planetA = a.bodies[0]
    const planetB = b.bodies[0]
    const planetC = c.bodies[0]
    if (
      planetA === undefined ||
      planetB === undefined ||
      planetC === undefined
    ) {
      throw new Error('no bodies')
    }
    // Evaluated at the fractional time, so the half-alpha sample sits exactly
    // between the two whole ones — no interpolation error to accumulate.
    const midpoint = UV.distance(planetA.position, planetB.position)
    const full = UV.distance(planetA.position, planetC.position)
    expect(midpoint / full).toBeCloseTo(0.5, 6)
  })
})

describe('terrain is sampled in body-fixed axes', () => {
  /*
   * The regression these two guard is the one CONTEXT.md records and the one
   * that came back: terrain is a function of position on the *turning* body, so
   * an inertial direction leaves the mountains behind as the planet rotates.
   *
   * It reappeared in the pre-integration sample inside `stepFlight` — the one
   * the atmosphere is evaluated against — where nothing rendered wrong and no
   * test failed, because that altitude only ever feeds a drag coefficient.
   */
  it('holds the ground still under a point fixed to the rotating body', () => {
    const world = solarWorld()
    const planet = landingTarget(world)
    const spinFrame = bodyFixedFrameId(planet.address)
    world.ensureFrame(spinFrame)

    // One point, fixed in the body's own axes, sampled as the planet turns.
    const local = vec3(planet.radius * 1.001, 0, 0)
    const groundAt = (time: Seconds): Meters => {
      const pose = world.frames.pose(spinFrame, time)
      return surfaceRadius(
        planet,
        bodyFixedDirection(pose, localToUniverse(pose, local)),
      )
    }

    const samples = [0, 0.1, 0.25, 0.5, 0.75, 1].map((f) =>
      groundAt((SECONDS_PER_DAY * f) as Seconds),
    )
    const spread = Math.max(...samples) - Math.min(...samples)

    // Not zero: the sample round-trips through a rotation and a UniverseVector,
    // so it carries that round trip's error and nothing better. POSITION_RESOLUTION
    // is where that error is allowed to live — it is the coordinate system's own
    // floor, not a tolerance chosen to make this pass.
    expect(spread).toBeLessThan(POSITION_RESOLUTION)
    // And the point of the invariant: the drift is negligible against the relief
    // it would otherwise smear. Sampled inertially, a full rotation walks the
    // sample across the whole planet.
    expect(spread).toBeLessThan(planet.surface.maxElevation * 1e-6)
  })
})

describe('the state hash covers what it claims', () => {
  /*
   * AGENTS.md makes `stateHash` *the* determinism comparison, and its docstring
   * says "everything canonical". It used to hash position, velocity, orientation
   * and landedness — omitting angular velocity, control input and flight assist,
   * which is precisely where a shipped bug already lived ("a save taken mid-burn
   * resumed coasting"). Two worlds diverging in those fields compared equal at
   * the moment they diverged, and only drifted apart hundreds of ticks later.
   */
  const twoWorlds = () => {
    const make = () => {
      const world = solarWorld()
      const planet = landingTarget(world)
      const ship = world.spawnShip(
        'probe',
        bodyFrameId(planet.address),
        vec3(planet.radius * 3, 0, 0),
      )
      return { world, ship: ship.id }
    }
    return [make(), make()] as const
  }

  it('separates worlds that differ only in control input', () => {
    const [a, b] = twoWorlds()
    expect(a.world.stateHash()).toBe(b.world.stateHash())
    b.world.setControl(b.ship, vec3(0, 0, 1), Vec.ZERO)
    expect(a.world.stateHash()).not.toBe(b.world.stateHash())
  })

  it('separates worlds that differ only in flight assist', () => {
    const [a, b] = twoWorlds()
    b.world.setFlightAssist(
      b.ship,
      !b.world.entities.require(b.ship).flightAssist,
    )
    expect(a.world.stateHash()).not.toBe(b.world.stateHash())
  })

  it('separates worlds that differ only in angular velocity', () => {
    const [a, b] = twoWorlds()
    // Spin one up, then stop it with the command that writes angular velocity.
    b.world.setControl(b.ship, Vec.ZERO, vec3(0, 1, 0))
    b.world.runTicks(8)
    a.world.setControl(a.ship, Vec.ZERO, vec3(0, 1, 0))
    a.world.runTicks(8)
    expect(a.world.stateHash()).toBe(b.world.stateHash())

    b.world.killRotation(b.ship)
    expect(a.world.stateHash()).not.toBe(b.world.stateHash())
  })
})
