import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec, vec3 } from '@inertialref/spatial'
import {
  type BodyFixedDirection,
  bodyFixedFrameId,
  systemId,
} from '@inertialref/universe'
import { CHARACTER, createCharacter, stepCharacter } from './character.ts'
import { createEntity, type Entity } from './entity.ts'
import { TICK_DURATION } from './clock.ts'
import { World } from './world.ts'

function sphere(gravity = 9.81) {
  const world = new World({ seed: 'inertialref' })
  const mars = world
    .loadSystem(systemId('SOL'))
    .planets.find((body) => body.name === 'Mars')!
  const radius = 1e6
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
      for (let i = 0; i < 64; i += 1) entity = next(body, entity, contact)
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
