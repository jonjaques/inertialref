import {
  getLogger,
  invariant,
  LIGHT_YEAR,
  type Logger,
  type Meters,
  type Seconds,
  type Tick,
} from '@inertialref/shared'
import { hashString, rootSeed, type Seed } from '@inertialref/procedural'
import {
  canonicalPosition,
  type FrameId,
  FrameGraph,
  type FrameState,
  Quaternion as Q,
  reframe,
  restState,
  ROOT_FRAME,
  UV,
  type UniverseVector,
  universeToLocal,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  bodyFrameId,
  catalogStub,
  CATALOG,
  directionToGeodetic,
  type EntityId,
  findBody,
  dynamicEntityId,
  type GalaxyId,
  galaxySeedOf,
  generateSystem,
  installSurfaceFrame,
  installSystemFrames,
  MILKY_WAY,
  parseAddress,
  resolveSystem,
  type StarSystem,
  type SystemId,
  systemFrameId,
  systemsWithin,
  uninstallSystemFrames,
  walkBodies,
} from '@inertialref/universe'
import type { FrameBinding } from './binding.ts'
import { SimulationClock, TICK_DURATION, timeOfTick } from './clock.ts'
import { createEntity, DEBUG_SHIP_THRUSTERS, type Entity, type EntityInit, EntityStore } from './entity.ts'
import { type FlightWorld, stepFlight } from './flight.ts'

/*
 * The world.
 *
 * Owns the frame graph, the entities, the clock and the set of systems that are
 * currently loaded. Framework-free by construction: nothing in this file or
 * anything it imports touches React, the DOM or WebGL, which is what lets the
 * identical code run in a Web Worker, in Node tests and on a server.
 *
 * Loading and unloading are ordinary methods rather than a special "streaming
 * mode": a system that is not loaded still exists and is still addressable, it
 * simply has no frames installed.
 */

/** A system claims authority over everything within this radius. */
export const SYSTEM_INFLUENCE_RADIUS: Meters = 1 * LIGHT_YEAR

export interface WorldEvent {
  readonly tick: Tick
  readonly kind: 'frame-change' | 'touchdown' | 'lift-off' | 'system-loaded' | 'system-unloaded'
  readonly entity: EntityId | null
  readonly detail: string
}

export interface WorldOptions {
  readonly seed: string
  readonly galaxy?: GalaxyId
  readonly startTick?: Tick
  readonly maxSteps?: number
}

export class World implements FlightWorld {
  readonly seedText: string
  readonly rootSeed: Seed
  readonly galaxy: GalaxyId
  readonly galaxySeed: Seed
  readonly frames = new FrameGraph()
  readonly entities = new EntityStore()
  readonly clock: SimulationClock

  readonly #systems = new Map<SystemId, StarSystem>()
  readonly #bindings = new Map<FrameId, FrameBinding>()
  readonly #children = new Map<FrameId, FrameBinding[]>()
  readonly #landed = new Set<EntityId>()
  readonly #previous = new Map<EntityId, FrameState>()
  readonly #altitudes = new Map<EntityId, number>()
  readonly #events: WorldEvent[] = []
  readonly #log: Logger

  constructor(options: WorldOptions) {
    this.seedText = options.seed
    this.rootSeed = rootSeed(options.seed)
    this.galaxy = options.galaxy ?? MILKY_WAY
    this.galaxySeed = galaxySeedOf(this.rootSeed, this.galaxy)
    this.clock = new SimulationClock({
      ...(options.startTick === undefined ? {} : { startTick: options.startTick }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
    this.#log = getLogger('simulation.world', { seed: options.seed })
  }

  /* ----------------------------------------------------------------------- */
  /* Systems                                                                  */
  /* ----------------------------------------------------------------------- */

  loadSystem(id: SystemId): StarSystem {
    const existing = this.#systems.get(id)
    if (existing !== undefined) return existing

    const stub = resolveSystem(this.galaxySeed, id)
    invariant(stub !== undefined, `Unknown system ${id}`)
    const system = generateSystem(this.rootSeed, this.galaxy, stub)
    installSystemFrames(this.frames, system)
    this.#systems.set(id, system)
    this.#bindSystem(system)
    this.#record('system-loaded', null, `${system.name} (${system.planets.length} planets)`)
    this.#log.info('system loaded', { system: id, planets: system.planets.length })
    return system
  }

  unloadSystem(id: SystemId): void {
    const system = this.#systems.get(id)
    if (system === undefined) return
    for (const entity of this.entities.all()) {
      const chain = this.frames.has(entity.state.frame) ? this.frames.chain(entity.state.frame) : []
      invariant(
        !chain.includes(systemFrameId(id)),
        `Cannot unload ${id}: entity ${entity.id} is still inside it`,
      )
    }
    // Surface frames are created on demand; drop them before their parents.
    for (const frame of this.frames.ids()) {
      if (frame.startsWith('sf:') && this.frames.chain(frame).includes(systemFrameId(id))) {
        this.frames.remove(frame)
      }
    }
    uninstallSystemFrames(this.frames, system)
    this.#systems.delete(id)
    this.#unbindSystem(system)
    this.#record('system-unloaded', null, system.name)
  }

  system(id: SystemId): StarSystem | undefined {
    return this.#systems.get(id)
  }

  loadedSystems(): readonly StarSystem[] {
    return [...this.#systems.values()]
  }

  #bindSystem(system: StarSystem): void {
    const systemFrame = systemFrameId(system.id)
    this.#addBinding({
      frame: systemFrame,
      kind: 'system',
      system: system.id,
      mu: system.star.mu,
      radius: system.star.radius,
      sphereOfInfluence: SYSTEM_INFLUENCE_RADIUS,
      atmosphere: null,
      spinFrame: null,
      parent: ROOT_FRAME,
      children: [],
      body: null,
      star: system.star,
    })

    const bindBody = (body: Body, parent: FrameId): void => {
      const frame = bodyFrameId(body.address)
      this.#addBinding({
        frame,
        kind: 'body',
        system: system.id,
        mu: body.mu,
        radius: body.radius,
        sphereOfInfluence: body.sphereOfInfluence,
        atmosphere: body.atmosphere,
        spinFrame: bodyFixedFrameId(body.address),
        parent,
        children: [],
        body,
        star: null,
      })
      for (const moon of body.moons) bindBody(moon, frame)
    }
    for (const planet of system.planets) bindBody(planet, systemFrame)
  }

  #unbindSystem(system: StarSystem): void {
    for (const body of walkBodies(system)) this.#removeBinding(bodyFrameId(body.address))
    this.#removeBinding(systemFrameId(system.id))
  }

  #addBinding(binding: FrameBinding): void {
    this.#bindings.set(binding.frame, binding)
    const parent = binding.parent
    if (parent !== null) {
      const siblings = this.#children.get(parent) ?? []
      siblings.push(binding)
      this.#children.set(parent, siblings)
    }
  }

  #removeBinding(frame: FrameId): void {
    const binding = this.#bindings.get(frame)
    if (binding === undefined) return
    this.#bindings.delete(frame)
    this.#children.delete(frame)
    const parent = binding.parent
    if (parent !== null) {
      const siblings = (this.#children.get(parent) ?? []).filter((b) => b.frame !== frame)
      if (siblings.length === 0) this.#children.delete(parent)
      else this.#children.set(parent, siblings)
    }
  }

  /**
   * The binding governing a frame, walking up until one is found.
   *
   * A ship in a surface frame is three levels below the body that is pulling on
   * it, and this is what makes that work without registering a binding per
   * landing site.
   */
  binding(frame: FrameId): FrameBinding | undefined {
    let cursor: FrameId | null = frame
    while (cursor !== null) {
      const found = this.#bindings.get(cursor)
      if (found !== undefined) return found
      cursor = this.frames.has(cursor) ? this.frames.get(cursor).parent : null
    }
    return undefined
  }

  bindingsUnder(frame: FrameId): readonly FrameBinding[] {
    return this.#children.get(frame) ?? []
  }

  bodyAt(frame: FrameId): Body | null {
    return this.binding(frame)?.body ?? null
  }

  /* ----------------------------------------------------------------------- */
  /* Entities                                                                 */
  /* ----------------------------------------------------------------------- */

  spawn(init: EntityInit): Entity {
    const entity = createEntity({ ...init, spawnedAt: this.clock.time })
    this.entities.add(entity)
    this.#previous.set(entity.id, entity.state)
    return entity
  }

  /** Spawn the debug spacecraft, at rest in a frame. */
  spawnShip(name: string, frame: FrameId, position: Vec3): Entity {
    const id = dynamicEntityId(this.entities.nextDynamicIndex())
    return this.spawn({
      id,
      kind: 'ship',
      name,
      state: { ...restState(frame), position },
      mass: 40_000,
      thrusters: DEBUG_SHIP_THRUSTERS,
      ballisticCoefficient: 320,
    })
  }

  isLanded(id: EntityId): boolean {
    return this.#landed.has(id)
  }

  altitudeOf(id: EntityId): number | null {
    return this.#altitudes.get(id) ?? null
  }

  /**
   * Re-create a frame from its id.
   *
   * Surface frames are minted on landing rather than up front, so a save that
   * has a ship parked on a planet refers to a frame that does not exist yet
   * after a reload. Because terrain is a pure function of the seed, the frame
   * can be regenerated exactly — which is the persistence model working as
   * intended: store the reference, regenerate the content.
   */
  ensureFrame(id: FrameId): boolean {
    if (this.frames.has(id)) return true
    if (!id.startsWith('sf:')) return false
    const at = id.lastIndexOf('@')
    if (at < 0) return false
    const address = parseAddress(id.slice(3, at))
    if (address.kind !== 'body') return false
    const [latitude, longitude] = id
      .slice(at + 1)
      .split(',')
      .map((part) => Number.parseFloat(part))
    if (latitude === undefined || longitude === undefined) return false

    const system = this.#systems.get(address.system) ?? this.loadSystem(address.system)
    const body = findBody(system, address.body)
    if (body === undefined) return false
    installSurfaceFrame(this.frames, body, latitude, longitude)
    return this.frames.has(id)
  }

  /** Move an entity into another frame without moving it in the universe. */
  reframeEntity(id: EntityId, frame: FrameId): Entity {
    const entity = this.entities.require(id)
    const state = reframe(this.frames, entity.state, frame, this.clock.time)
    this.#landed.delete(id)
    return this.entities.update(id, { state })
  }

  /**
   * Set an entity's state discontinuously.
   *
   * Resets the interpolation history as well, which a plain update does not:
   * the presentation layer lerps between the previous tick and this one, so a
   * teleport without this smears the ship across the system for one frame.
   * Only debug tooling should be calling it — nothing in normal play moves an
   * entity without moving it.
   */
  teleport(id: EntityId, state: FrameState, landed = false): Entity {
    const entity = this.entities.update(id, { state })
    this.#previous.set(id, state)
    this.#altitudes.delete(id)
    if (landed) this.#landed.add(id)
    else this.#landed.delete(id)
    return entity
  }

  canonicalPositionOf(id: EntityId): UniverseVector {
    return canonicalPosition(this.frames, this.entities.require(id).state, this.clock.time)
  }

  /* ----------------------------------------------------------------------- */
  /* Stepping                                                                 */
  /* ----------------------------------------------------------------------- */

  /** Advance exactly one fixed tick. */
  step(): void {
    const time = this.clock.time
    for (const entity of this.entities.ordered()) {
      this.#previous.set(entity.id, entity.state)
      const result = stepFlight(this, entity, this.#landed.has(entity.id), {
        dt: TICK_DURATION,
        time,
      })

      if (result.altitude !== null) this.#altitudes.set(entity.id, result.altitude)
      else this.#altitudes.delete(entity.id)

      if (result.frameChange !== null) {
        this.#record(
          'frame-change',
          entity.id,
          `${result.frameChange.from} → ${result.frameChange.to} (${result.frameChange.reason})`,
        )
      }

      if (result.touchdown) {
        this.entities.update(entity.id, { state: result.state })
        this.#land(entity.id, time, result.impactSpeed)
        continue
      }

      if (result.liftOff) {
        // Commit the unstick offset before re-framing, or the ship is handed
        // back to the inertial frame still sitting on the ground.
        this.entities.update(entity.id, { state: result.state })
        this.#liftOff(entity.id, time)
        continue
      }

      this.entities.update(entity.id, { state: result.state })
    }
    this.clock.commitTick()
  }

  /** Run n ticks with no wall clock. Deterministic by construction. */
  runTicks(count: number): void {
    invariant(Number.isInteger(count) && count >= 0, `runTicks needs a whole count, got ${count}`)
    for (let i = 0; i < count; i += 1) this.step()
  }

  /**
   * Advance by wall-clock seconds. Returns the number of ticks actually run.
   *
   * The only place real time enters the simulation, and all it decides is how
   * many identical fixed steps to take.
   */
  advance(realSeconds: Seconds): number {
    const steps = this.clock.advance(realSeconds)
    this.runTicks(steps)
    return steps
  }

  #land(id: EntityId, time: Seconds, impactSpeed: number): void {
    const entity = this.entities.require(id)
    const binding = this.binding(entity.state.frame)
    if (binding?.body === null || binding === undefined || binding.spinFrame === null) return
    const body = binding.body

    const spinPose = this.frames.pose(binding.spinFrame, time)
    const universe = canonicalPosition(this.frames, entity.state, time)
    const bodyFixed = universeToLocal(spinPose, universe)
    const { latitude, longitude } = directionToGeodetic(bodyFixed)
    const frame = installSurfaceFrame(this.frames, body, latitude, longitude)
    const landedState = reframe(this.frames, entity.state, frame, time)
    this.entities.update(id, {
      state: {
        ...landedState,
        // Sit on the surface, not a fraction of a metre inside it: the contact
        // test fires on the tick that crosses zero, which is usually just past.
        position: vec3(landedState.position.x, Math.max(0, landedState.position.y), landedState.position.z),
        // Attached to the ground: no residual motion in the surface frame.
        velocity: Vec.ZERO,
        angularVelocity: Vec.ZERO,
      },
    })
    this.#landed.add(id)
    const quality = impactSpeed > 12 ? 'hard' : 'soft'
    this.#record(
      'touchdown',
      id,
      `${quality} landing on ${body.name} at ${(latitude * 57.2958).toFixed(2)}°, ${(longitude * 57.2958).toFixed(2)}° (${impactSpeed.toFixed(1)} m/s)`,
    )
  }

  #liftOff(id: EntityId, time: Seconds): void {
    const entity = this.entities.require(id)
    const binding = this.binding(entity.state.frame)
    if (binding === undefined) return
    // reframe supplies the ground speed the ship inherits — several hundred m/s
    // on a rotating planet — without anything here knowing that number.
    const state = reframe(this.frames, entity.state, binding.frame, time)
    this.entities.update(id, { state })
    this.#landed.delete(id)
    this.#record('lift-off', id, binding.body?.name ?? binding.frame)
  }

  /* ----------------------------------------------------------------------- */
  /* Streaming                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Load systems near a point and unload ones that are far away.
   *
   * Ordinary control flow, called every so often rather than at a mode
   * boundary. Systems containing an entity are never unloaded.
   */
  updateInterest(centre: UniverseVector, radius: Meters = 6 * LIGHT_YEAR): {
    loaded: readonly SystemId[]
    unloaded: readonly SystemId[]
  } {
    const wanted = systemsWithin(this.galaxySeed, centre, radius)
    const loaded: SystemId[] = []
    for (const stub of wanted) {
      if (!this.#systems.has(stub.id)) {
        this.loadSystem(stub.id)
        loaded.push(stub.id)
      }
    }

    const occupied = new Set<string>()
    for (const entity of this.entities.all()) {
      if (!this.frames.has(entity.state.frame)) continue
      for (const frame of this.frames.chain(entity.state.frame)) occupied.add(frame)
    }

    const unloaded: SystemId[] = []
    for (const system of [...this.#systems.values()]) {
      if (occupied.has(systemFrameId(system.id))) continue
      if (UV.distance(system.position, centre) > radius * 1.25) {
        this.unloadSystem(system.id)
        unloaded.push(system.id)
      }
    }
    return { loaded, unloaded }
  }

  /* ----------------------------------------------------------------------- */
  /* Introspection                                                            */
  /* ----------------------------------------------------------------------- */

  previousState(id: EntityId): FrameState | undefined {
    return this.#previous.get(id)
  }

  events(limit = 32): readonly WorldEvent[] {
    return this.#events.slice(-limit)
  }

  #record(kind: WorldEvent['kind'], entity: EntityId | null, detail: string): void {
    this.#events.push({ tick: this.clock.tick, kind, entity, detail })
    if (this.#events.length > 256) this.#events.shift()
  }

  /**
   * A hash of everything canonical.
   *
   * Two runs that agree on this agree on the universe. Used by the determinism
   * tests, by the harness, and (later) as a desync check against a server.
   */
  stateHash(): string {
    const parts: string[] = [`t=${this.clock.tick}`, `seed=${this.seedText}`]
    for (const entity of this.entities.ordered()) {
      const s = entity.state
      parts.push(
        `${entity.id}|${s.frame}|${s.position.x},${s.position.y},${s.position.z}` +
          `|${s.velocity.x},${s.velocity.y},${s.velocity.z}` +
          `|${s.orientation.x},${s.orientation.y},${s.orientation.z},${s.orientation.w}` +
          `|${this.#landed.has(entity.id) ? 'landed' : 'free'}`,
      )
    }
    return hashString(parts.join('\n')).toString(16).padStart(8, '0')
  }

  /** Restore internal bookkeeping after a load. */
  restoreLanded(ids: readonly EntityId[]): void {
    this.#landed.clear()
    for (const id of ids) this.#landed.add(id)
  }

  landedEntities(): readonly EntityId[] {
    return [...this.#landed]
  }
}

/** Convenience for tests and the harness: the catalogue stub for a known star. */
export function catalogSystemStub(id: SystemId) {
  const star = CATALOG.find((s) => s.id === id)
  invariant(star !== undefined, `No catalogue star ${id}`)
  return catalogStub(star)
}

export { timeOfTick, Q }
