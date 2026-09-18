import type { Kilograms } from '@inertialref/shared'
import type { ControlInput, ThrusterProfile } from '@inertialref/physics'
import type { FrameState } from '@inertialref/spatial'
import type { EntityId } from '@inertialref/universe'
import type { Entity, EntityInit, EntityKind, RailsEpoch } from './entity.ts'

/*
 * The facts about an entity that decide its next tick.
 *
 * Three readers need the same list: the state hash, whose claim is that two
 * worlds agreeing on it agree about the future; the save, which has to carry
 * enough to make that claim hold across a reload; and the restore, which
 * rebuilds an entity from what the save carried. Each of them choosing its
 * own fields is how a ship with 90 kN of main drive saved as "has thrusters",
 * came back with the debug ship's 30, and hashed identically to the original
 * until the first tick under throttle — the equality check every persistence
 * test rests on passed, and the motion was wrong.
 *
 * So the list is here, once. `stateHash` writes its line from it, and the
 * persistence adapter holds its wire record to these keys with a type-level
 * check, at the one place that can see both. A field added to `Entity` that
 * reaches the integrator is added here, and the save refuses to compile until
 * it carries it.
 *
 * Two of `Entity`'s fields are deliberately not in it. `address` names what a
 * generated entity is a manifestation of, and a dynamic entity has none that
 * a save could regenerate from; `spawnedAt` is a sort key for the dock.
 * Neither reaches the integrator.
 */
export interface CanonicalEntity {
  readonly id: EntityId
  readonly kind: EntityKind
  readonly name: string
  readonly state: FrameState
  readonly mass: Kilograms
  readonly thrusters: ThrusterProfile | null
  readonly control: ControlInput
  readonly flightAssist: boolean
  readonly ballisticCoefficient: number
  /**
   * The world's bookkeeping rather than the entity's, and canonical for the
   * same reason the epoch is: a landed entity is stepped as one, so two worlds
   * that agree on every field of the entity and disagree here part on the next
   * tick.
   */
  readonly landed: boolean
  readonly rails: RailsEpoch | null
}

export function canonicalEntity(
  entity: Entity,
  landed: boolean,
): CanonicalEntity {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    state: entity.state,
    mass: entity.mass,
    thrusters: entity.thrusters,
    control: entity.control,
    flightAssist: entity.flightAssist,
    ballisticCoefficient: entity.ballisticCoefficient,
    landed,
    rails: entity.rails,
  }
}

/**
 * The spawn that puts this entity back, whole at birth.
 *
 * Whole because a write after the spawn goes through a verb, and the verbs
 * drop the epoch on a non-neutral input. `landed` is not a spawn argument —
 * it is a consequence of geometry the contact test computes — so the caller
 * restores it through `World.restoreLanded` beside the spawn.
 */
export function canonicalEntityInit(entity: CanonicalEntity): EntityInit {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    state: entity.state,
    mass: entity.mass,
    thrusters: entity.thrusters,
    control: entity.control,
    flightAssist: entity.flightAssist,
    ballisticCoefficient: entity.ballisticCoefficient,
    rails: entity.rails,
  }
}

const xyz = (v: { x: number; y: number; z: number }): string =>
  `${v.x},${v.y},${v.z}`

/**
 * One entity's line of the state hash: every canonical field, in a fixed
 * order, with numbers written at full precision.
 *
 * `entityState.test.ts` holds this to the type: a value of every key must move
 * the line, so a field added to `CanonicalEntity` and forgotten here fails a
 * test rather than passing a hash that no longer covers the future.
 */
export function canonicalEntityLine(entity: CanonicalEntity): string {
  const s = entity.state
  const c = entity.control
  const r = entity.rails
  const t = entity.thrusters
  return (
    `${entity.id}|${entity.kind}|${entity.name}|${s.frame}|${xyz(s.position)}` +
    `|${xyz(s.velocity)}` +
    `|${s.orientation.x},${s.orientation.y},${s.orientation.z},${s.orientation.w}` +
    `|${xyz(s.angularVelocity)}` +
    `|mass:${entity.mass}` +
    (t === null
      ? '|inert'
      : `|thrust:${t.mainThrust},${t.rcsThrust},${t.torque}`) +
    `|${xyz(c.translation)}` +
    `|${xyz(c.rotation)}` +
    `|${c.throttle}` +
    `|${entity.flightAssist ? 'assist' : 'manual'}` +
    `|bc:${entity.ballisticCoefficient}` +
    `|${entity.landed ? 'landed' : 'free'}` +
    (r === null
      ? '|integrated'
      : `|rails:${r.time}:${xyz(r.position)}:${xyz(r.velocity)}` +
        `:${r.orientation.x},${r.orientation.y},${r.orientation.z},${r.orientation.w}` +
        `:${xyz(r.angularVelocity)}`)
  )
}
