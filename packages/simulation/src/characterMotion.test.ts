import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec, vec3 } from '@inertialref/spatial'
import {
  type BodyFixedDirection,
  bodyFixedFrameId,
  systemId,
} from '@inertialref/universe'
import {
  CHARACTER,
  type CharacterInput,
  createCharacter,
  stepCharacter,
} from './character.ts'
import { createEntity, type Entity } from './entity.ts'
import { TICK_DURATION } from './clock.ts'
import { World } from './world.ts'

const sphereRadius = 1e6

function sphere(gravity = 9.81) {
  const world = new World({ seed: 'inertialref' })
  const mars = world
    .loadSystem(systemId('SOL'))
    .planets.find((body) => body.name === 'Mars')!
  const radius = sphereRadius
  const body = {
    ...mars,
    radius,
    polarRadius: radius,
    mu: gravity * radius * radius,
  }
  const initial = world.spawnCharacter(mars, 0, 0)
  const entity = createEntity({
    ...initial,
    state: {
      ...initial.state,
      frame: bodyFixedFrameId(body.address),
      position: vec3(radius, 0, 0),
    },
    character: createCharacter(),
  })
  const ground = { contactRadius: () => radius }
  return { body, entity, ground, radius }
}

function next(
  body: ReturnType<typeof sphere>['body'],
  entity: Entity,
  contact: (direction: BodyFixedDirection) => number,
): Entity {
  const result = stepCharacter(
    { contactRadius: (_body, direction) => contact(direction) },
    body,
    entity,
    TICK_DURATION,
  )
  return { ...entity, state: result.state, character: result.character }
}

describe('character motor geometry', () => {
  it.each([0.2, 3.71, 40])(
    'jumps and lands under %s m/s² gravity',
    (gravity) => {
      const fixture = sphere(gravity)
      const { body, radius } = fixture
      let entity = next(body, fixture.entity, () => radius)
      entity = {
        ...entity,
        character: {
          ...entity.character!,
          input: { ...entity.character!.input, jump: true },
        },
      }
      let highest = 0
      const ticks = Math.ceil(
        ((CHARACTER.jumpSpeed * 2) / gravity + 1) / TICK_DURATION,
      )
      for (let tick = 0; tick < ticks; tick += 1) {
        entity = next(body, entity, () => radius)
        const altitude = Vec.length(entity.state.position) - radius
        expect(altitude).toBeGreaterThanOrEqual(-1e-7)
        highest = Math.max(highest, altitude)
      }
      const analytic = CHARACTER.jumpSpeed ** 2 / (2 * gravity)
      // Semi-implicit fixed stepping loses at most v*dt of apex; inverse-square
      // gravity changes by less than 0.02 m here, even on the low-gravity sphere.
      expect(highest).toBeGreaterThan(
        analytic - CHARACTER.jumpSpeed * TICK_DURATION - 0.02,
      )
      expect(highest).toBeLessThan(analytic + 0.02)
      expect(entity.character?.grounded).toBe(true)
    },
  )

  it('climbs a boot-height step and stops at a higher obstacle', () => {
    for (const height of [0.25, 0.8]) {
      const { body, entity: initial, radius } = sphere()
      const contact = (d: BodyFixedDirection): number =>
        radius + (d.y * radius > 1 ? height : 0)
      let entity = next(body, initial, contact)
      entity = {
        ...entity,
        character: {
          ...entity.character!,
          input: { ...entity.character!.input, forward: 1 },
        },
      }
      for (let i = 0; i < 128; i += 1) entity = next(body, entity, contact)
      if (height < CHARACTER.stepHeight) {
        expect(entity.state.position.y).toBeGreaterThan(4)
        expect(Vec.length(entity.state.position) - radius).toBeCloseTo(
          height,
          5,
        )
      } else expect(entity.state.position.y).toBeLessThan(1)
    }
  })

  it('faces north with zero heading and keeps radial up while moving', () => {
    const { body, entity: initial, radius } = sphere()
    expect(
      Vec.dot(Q.basis(initial.state.orientation).forward, vec3(0, 1, 0)),
    ).toBeCloseTo(1, 8)
    let entity = next(body, initial, () => radius)
    entity = {
      ...entity,
      character: {
        ...entity.character!,
        input: { ...entity.character!.input, forward: 1, right: 1 },
      },
    }
    for (let i = 0; i < 128; i += 1) entity = next(body, entity, () => radius)
    expect(
      Vec.dot(
        Q.basis(entity.state.orientation).up,
        Vec.normalize(entity.state.position),
      ),
    ).toBeCloseTo(1, 10)
  })
})

it('stops at a steep grade and cannot fly through a terrain cliff', () => {
  const { body, entity: initial, radius } = sphere()
  const slope = (d: BodyFixedDirection): number =>
    radius + Math.max(0, d.y * radius - 1) * Math.tan(Math.PI / 3)
  let entity = next(body, initial, slope)
  entity = {
    ...entity,
    character: {
      ...entity.character!,
      input: { ...entity.character!.input, forward: 1 },
    },
  }
  for (let i = 0; i < 128; i += 1) entity = next(body, entity, slope)
  expect(entity.state.position.y).toBeLessThan(1.2)
  const cliff = (d: BodyFixedDirection): number =>
    radius + (d.y * radius > 1 ? 100 : 0)
  entity = {
    ...initial,
    state: { ...initial.state, position: vec3(radius + 2, 0, 0) },
    character: {
      ...createCharacter(true),
      flying: true,
      input: { ...createCharacter().input, forward: 1 },
    },
  }
  for (let i = 0; i < 128; i += 1) entity = next(body, entity, cliff)
  expect(entity.state.position.y).toBeLessThan(1)
  expect(Vec.length(entity.state.position) - radius).toBeCloseTo(2, 5)
})

/** The fixture's entity with these keys held, ready to step. */
function holding(entity: Entity, input: Partial<CharacterInput>): Entity {
  return {
    ...entity,
    character: {
      ...entity.character!,
      input: { ...entity.character!.input, ...input },
    },
  }
}

describe('momentum and the edges of a jump', () => {
  it('keeps the momentum it left the ground with, and only leans it in the air', () => {
    const { body, entity: initial, radius } = sphere()
    let entity = holding(
      next(body, initial, () => radius),
      { forward: 1 },
    )
    for (let i = 0; i < 64; i += 1) entity = next(body, entity, () => radius)
    const launchSpeed = Vec.length(entity.state.velocity)
    expect(launchSpeed).toBeCloseTo(CHARACTER.walkSpeed, 9)
    // Jump, then let go of everything: a walker in the air does not stop.
    entity = holding(entity, { jump: true })
    entity = next(body, entity, () => radius)
    entity = holding(entity, { forward: 0, jump: false })
    expect(entity.character?.grounded).toBe(false)
    let ticks = 0
    while (!entity.character?.grounded && ticks < 400) {
      entity = next(body, entity, () => radius)
      ticks += 1
      if (!entity.character?.grounded) {
        const up = Vec.normalize(entity.state.position)
        const planar = Vec.sub(
          entity.state.velocity,
          Vec.scale(up, Vec.dot(entity.state.velocity, up)),
        )
        expect(Vec.length(planar)).toBeCloseTo(launchSpeed, 9)
      }
    }
    expect(ticks).toBeGreaterThan(40)
    // Holding the opposite key in flight leans the arc but cannot turn it.
    let against = holding(
      next(body, initial, () => radius),
      { forward: 1 },
    )
    for (let i = 0; i < 64; i += 1) against = next(body, against, () => radius)
    against = next(body, holding(against, { jump: true }), () => radius)
    against = holding(against, { forward: -1, jump: false })
    const start = against.state.position.y
    while (!against.character?.grounded)
      against = next(body, against, () => radius)
    const airtime = (2 * CHARACTER.jumpSpeed) / 9.81
    const drift = against.state.position.y - start
    expect(drift).toBeGreaterThan(CHARACTER.walkSpeed * airtime * 0.5)
    expect(drift).toBeLessThan(CHARACTER.walkSpeed * airtime)
  })

  it('honors a jump pressed just after an edge and refuses one pressed later', () => {
    const ledge = (d: BodyFixedDirection): number =>
      sphereRadius + (d.y * sphereRadius > 1 ? -5 : 0)
    const walkOff = (pressAfter: number) => {
      const { body, entity: initial } = sphere()
      let entity = holding(next(body, initial, ledge), { forward: 1 })
      for (let i = 0; i < 128 && entity.character?.grounded; i += 1)
        entity = next(body, entity, ledge)
      expect(entity.character?.grounded).toBe(false)
      for (let i = 0; i < pressAfter; i += 1) entity = next(body, entity, ledge)
      entity = next(body, holding(entity, { jump: true }), ledge)
      const up = Vec.normalize(entity.state.position)
      return Vec.dot(entity.state.velocity, up)
    }
    expect(walkOff(CHARACTER.coyoteTicks - 2)).toBeGreaterThan(
      CHARACTER.jumpSpeed - 1,
    )
    expect(walkOff(CHARACTER.coyoteTicks + 4)).toBeLessThan(0)
  })

  it('does not let the coyote window double a jump', () => {
    const { body, entity: initial, radius } = sphere()
    let entity = next(body, holding(initial, { jump: true }), () => radius)
    entity = next(body, holding(entity, { jump: false }), () => radius)
    const before = Vec.dot(
      entity.state.velocity,
      Vec.normalize(entity.state.position),
    )
    entity = next(body, holding(entity, { jump: true }), () => radius)
    const after = Vec.dot(
      entity.state.velocity,
      Vec.normalize(entity.state.position),
    )
    expect(after).toBeLessThan(before)
  })

  it('banks a jump pressed just before landing and spends it on the ground', () => {
    const { body, entity: initial, radius } = sphere()
    let entity = next(body, holding(initial, { jump: true }), () => radius)
    entity = holding(entity, { jump: false })
    let ticks = 0
    while (
      ticks < 400 &&
      (Vec.length(entity.state.position) - radius > 0.4 ||
        Vec.dot(entity.state.velocity, Vec.normalize(entity.state.position)) >
          0)
    ) {
      entity = next(body, entity, () => radius)
      ticks += 1
    }
    // Falling, a few centimeters up: press, release, and land.
    expect(entity.character?.grounded).toBe(false)
    entity = next(body, holding(entity, { jump: true }), () => radius)
    entity = holding(entity, { jump: false })
    expect(entity.character?.jumpBuffer).toBeGreaterThan(0)
    let launched = false
    for (let i = 0; i < CHARACTER.jumpBufferTicks + 2; i += 1) {
      entity = next(body, entity, () => radius)
      const up = Vec.normalize(entity.state.position)
      if (Vec.dot(entity.state.velocity, up) > CHARACTER.jumpSpeed - 1)
        launched = true
    }
    expect(launched).toBe(true)
  })

  it('slides along a wall it walks into at an angle', () => {
    const wall = (d: BodyFixedDirection): number =>
      sphereRadius + (d.y * sphereRadius > 1 ? 100 : 0)
    const { body, entity: initial } = sphere()
    // Heading is north; forward and right together is a 45° approach.
    let entity = holding(next(body, initial, wall), { forward: 1, right: 1 })
    for (let i = 0; i < 128; i += 1) entity = next(body, entity, wall)
    // The half-meter look-ahead that refuses a slope keeps a suit's width
    // of standoff from a wall; the walk reaches it and turns, not stops.
    expect(entity.state.position.y).toBeLessThan(1.05)
    expect(entity.state.position.y).toBeGreaterThan(0.5)
    // Along the wall the walk continues at the component it arrived with.
    expect(Math.abs(entity.state.position.z)).toBeGreaterThan(3)
    expect(entity.character?.grounded).toBe(true)
  })
})
