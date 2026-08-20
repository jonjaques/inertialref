import type { Kilograms, Seconds } from '@inertialref/shared'
import type { ControlInput, ThrusterProfile } from '@inertialref/physics'
import { NEUTRAL_CONTROL } from '@inertialref/physics'
import { type FrameState, restState } from '@inertialref/spatial'
import type { EntityId, UniverseAddress } from '@inertialref/universe'

/*
 * Entities.
 *
 * An entity is identity + kinematics + a small amount of behaviour, and
 * explicitly *not* a rendering object: it exists whether or not anything is
 * drawing it, and its representation (point, sphere, mesh, walkable terrain) is
 * chosen elsewhere from distance. Canonical state lives here and only here —
 * never in a React component, never on a Three.js object.
 *
 * Entities are immutable records replaced wholesale on update. That costs an
 * allocation per moved entity per tick and buys the thing this architecture
 * needs most: a previous state to interpolate from, and snapshots that cannot
 * be mutated by the renderer holding them.
 */

export type EntityKind = 'ship' | 'probe' | 'debris' | 'marker'

export interface Entity {
  readonly id: EntityId
  readonly kind: EntityKind
  readonly name: string
  /** Position, orientation and motion, expressed in some reference frame. */
  readonly state: FrameState
  readonly mass: Kilograms
  /** Null for anything that cannot manoeuvre. */
  readonly thrusters: ThrusterProfile | null
  readonly control: ControlInput
  /** Rotational damping — "flight assist" — on by default for playability. */
  readonly flightAssist: boolean
  /** mass / (drag coefficient × area), kg/m². Governs atmospheric entry. */
  readonly ballisticCoefficient: number
  /** What this entity is a manifestation of, when it is a generated thing. */
  readonly address: UniverseAddress | null
  /** Tick the entity was created on; devtools sort by it. */
  readonly spawnedAt: Seconds
}

export interface EntityInit {
  readonly id: EntityId
  readonly kind: EntityKind
  readonly name: string
  readonly state?: FrameState
  readonly frame?: FrameState['frame']
  readonly mass?: Kilograms
  readonly thrusters?: ThrusterProfile | null
  readonly ballisticCoefficient?: number
  readonly address?: UniverseAddress | null
  readonly spawnedAt?: Seconds
}

export function createEntity(init: EntityInit): Entity {
  const state =
    init.state ?? restState(init.frame ?? ('universe' as FrameState['frame']))
  return {
    id: init.id,
    kind: init.kind,
    name: init.name,
    state,
    mass: init.mass ?? 1_000,
    thrusters: init.thrusters ?? null,
    control: NEUTRAL_CONTROL,
    flightAssist: true,
    ballisticCoefficient: init.ballisticCoefficient ?? 400,
    address: init.address ?? null,
    spawnedAt: init.spawnedAt ?? 0,
  }
}

/** The debug spacecraft the vertical slice flies. */
export const DEBUG_SHIP_THRUSTERS: ThrusterProfile = {
  // 3 g of main drive, enough to cross a system in minutes under time warp
  // without being so brisk that manoeuvring near a surface is unmanageable.
  mainThrust: 30,
  rcsThrust: 8,
  torque: 1.2,
}

export class EntityStore {
  readonly #entities = new Map<EntityId, Entity>()
  #nextDynamicId = 0

  add(entity: Entity): Entity {
    this.#entities.set(entity.id, entity)
    return entity
  }

  get(id: EntityId): Entity | undefined {
    return this.#entities.get(id)
  }

  require(id: EntityId): Entity {
    const entity = this.#entities.get(id)
    if (entity === undefined) throw new Error(`Unknown entity ${id}`)
    return entity
  }

  has(id: EntityId): boolean {
    return this.#entities.has(id)
  }

  remove(id: EntityId): boolean {
    return this.#entities.delete(id)
  }

  update(id: EntityId, change: Partial<Entity>): Entity {
    const entity = this.require(id)
    const next = { ...entity, ...change }
    this.#entities.set(id, next)
    return next
  }

  get size(): number {
    return this.#entities.size
  }

  /**
   * Entities in id order, not insertion order.
   *
   * Simulation systems iterate this. Insertion order depends on which entity
   * happened to be spawned first, which depends on load order — sorting makes
   * the step deterministic even once entities start interacting.
   */
  ordered(): readonly Entity[] {
    return [...this.#entities.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
  }

  all(): IterableIterator<Entity> {
    return this.#entities.values()
  }

  /** Allocate the next dynamic entity id. Persisted, so replays agree. */
  nextDynamicIndex(): number {
    return this.#nextDynamicId++
  }

  get dynamicIdCounter(): number {
    return this.#nextDynamicId
  }

  restoreDynamicIdCounter(value: number): void {
    this.#nextDynamicId = value
  }

  clear(): void {
    this.#entities.clear()
    this.#nextDynamicId = 0
  }
}
