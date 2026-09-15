import { describe, expect, it } from 'vitest'
import { NEUTRAL_CONTROL } from '@inertialref/physics'
import { type FrameId, restState, vec3 } from '@inertialref/spatial'
import type { EntityId } from '@inertialref/universe'
import {
  type CanonicalEntity,
  canonicalEntity,
  canonicalEntityInit,
  canonicalEntityLine,
} from './entityState.ts'
import { createEntity, DEBUG_SHIP_THRUSTERS } from './entity.ts'

const frame = 'universe' as FrameId

const base: CanonicalEntity = {
  id: '#0' as EntityId,
  kind: 'ship',
  name: 'base',
  state: restState(frame),
  mass: 40_000,
  thrusters: DEBUG_SHIP_THRUSTERS,
  control: NEUTRAL_CONTROL,
  flightAssist: true,
  ballisticCoefficient: 320,
  landed: false,
  rails: null,
}

/*
 * A different value for every key of the type.
 *
 * The mapped type is the test: a field added to `CanonicalEntity` without a
 * row here does not compile, and a row whose value leaves the hash line
 * unchanged fails below. That is the one place the field-coverage decision is
 * made, and it is made against the type rather than against a reading of
 * `stateHash`.
 */
const moved: { readonly [K in keyof CanonicalEntity]: CanonicalEntity[K] } = {
  id: '#1' as EntityId,
  kind: 'probe',
  name: 'other',
  state: { ...restState(frame), velocity: vec3(0, 0, 1) },
  mass: 40_001,
  thrusters: { ...DEBUG_SHIP_THRUSTERS, mainThrust: 90 },
  control: { ...NEUTRAL_CONTROL, throttle: 0.5 },
  flightAssist: false,
  ballisticCoefficient: 900,
  landed: true,
  rails: {
    time: 0,
    position: vec3(0, 0, 0),
    velocity: vec3(0, 0, 0),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: vec3(0, 0, 0),
  },
}

describe('the canonical entity', () => {
  it('moves the hash line with every one of its fields', () => {
    const line = canonicalEntityLine(base)
    for (const key of Object.keys(moved) as (keyof CanonicalEntity)[]) {
      const changed = { ...base, [key]: moved[key] }
      expect(canonicalEntityLine(changed), key).not.toBe(line)
    }
  })

  it('distinguishes a drive from no drive, and one profile from another', () => {
    // The defect this module exists for: a profile reduced to a boolean, so
    // two ships with different drives were one line.
    const inert = canonicalEntityLine({ ...base, thrusters: null })
    const strong = canonicalEntityLine({
      ...base,
      thrusters: { mainThrust: 90, rcsThrust: 16, torque: 2.4 },
    })
    expect(inert).not.toBe(canonicalEntityLine(base))
    expect(strong).not.toBe(canonicalEntityLine(base))
  })

  it('round-trips through an entity and back, bit for bit', () => {
    const entity = createEntity(canonicalEntityInit(moved))
    expect(canonicalEntity(entity, moved.landed)).toEqual(moved)
    expect(canonicalEntityLine(canonicalEntity(entity, true))).toBe(
      canonicalEntityLine(moved),
    )
  })
})
