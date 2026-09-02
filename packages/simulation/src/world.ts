import {
  getLogger,
  invariant,
  LIGHT_YEAR,
  type Logger,
  type Meters,
  type Seconds,
  type Tick,
  tick as asTick,
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
  directionToGeodetic,
  dynamicEntityId,
  type EntityId,
  findBody,
  type GalaxyId,
  galaxySeedOf,
  generateSystem,
  installSurfaceFrame,
  installSystemFrames,
  MILKY_WAY,
  parseSurfaceFrameId,
  resolveSystem,
  SOL_ONLY_CATALOG,
  type StarCatalog,
  type StarSystem,
  systemFrameId,
  type SystemId,
  systemsWithin,
  uninstallSystemFrames,
  walkBodies,
  planetCount,
} from '@inertialref/universe'
import { periapsis, visViva } from '@inertialref/physics'
import type { FrameBinding } from './binding.ts'
import { SimulationClock, TICK_DURATION, timeOfTick } from './clock.ts'
import {
  createEntity,
  DEBUG_SHIP_THRUSTERS,
  type Entity,
  type EntityInit,
  EntityStore,
  type RailsEpoch,
} from './entity.ts'
import {
  coastState,
  considerFrameChange,
  type FlightWorld,
  railsEpoch,
  railsSpeedBound,
  type SoiWatch,
  stepFlight,
} from './flight.ts'

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

/**
 * How often, in ticks, a coasting entity's sphere-of-influence tests may run.
 *
 * A coast is evaluated at whatever tick a frame lands on, but the tests that
 * can *change* something — entering a moon's sphere, leaving a planet's — run
 * only on ticks that are multiples of this, so that a frame jumping ten
 * thousand ticks and a frame stepping them make the same tests at the same
 * instants and land on the same frame. One second: a crossing is noticed at
 * most a second late, which at Earth's 30 km/s is 30 km into a sphere 900,000
 * km across, well inside the 5% hysteresis the boundary already carries.
 */
export const RAILS_CHUNK = 64

export interface WorldEvent {
  readonly tick: Tick
  readonly kind:
    | 'frame-change'
    | 'touchdown'
    | 'lift-off'
    | 'system-loaded'
    | 'system-unloaded'
  readonly entity: EntityId | null
  readonly detail: string
}

export interface WorldOptions {
  readonly seed: string
  readonly galaxy?: GalaxyId
  readonly startTick?: Tick
  readonly maxSteps?: number
  /**
   * The star catalog this world is generated against.
   *
   * A second generation input alongside the seed, and required to be explicit
   * for the reason `docs/design/galaxy.md` Rule 1 gives: the catalog changes
   * when astronomy publishes, and a universe that changed silently underneath a
   * save would invalidate every address in it. Defaults to `SOL_ONLY_CATALOG`,
   * which is one star and no claims — enough for a test, and a working if much
   * emptier galaxy for a host whose catalog asset failed to load.
   */
  readonly catalog?: StarCatalog
}

/**
 * What the world keeps beside a coasting entity, derived from its epoch.
 *
 * `nextCheck` is the first tick its sphere-of-influence tests have to run on,
 * and until then a frame may jump straight over it. `speedBound` is the
 * periapsis speed of its conic, which is what the tests' gaps are divided by.
 * Neither is canonical: a world that lost both rebuilds them from the epoch and
 * makes its next test on the next boundary, which is a test the bound would
 * only have said was unnecessary.
 */
interface CoastRecord {
  nextCheck: number
  readonly speedBound: number
}

export class World implements FlightWorld {
  readonly seedText: string
  readonly rootSeed: Seed
  readonly galaxy: GalaxyId
  readonly galaxySeed: Seed
  readonly catalog: StarCatalog
  readonly frames = new FrameGraph()
  readonly entities = new EntityStore()
  readonly clock: SimulationClock

  readonly #systems = new Map<SystemId, StarSystem>()
  readonly #bindings = new Map<FrameId, FrameBinding>()
  readonly #children = new Map<FrameId, FrameBinding[]>()
  readonly #landed = new Set<EntityId>()
  readonly #previous = new Map<EntityId, FrameState>()
  readonly #altitudes = new Map<EntityId, number>()
  /**
   * The ground altitude an integrated tick measured under where it left the
   * entity, at the instant it left it there — the next tick's starting point,
   * so the next tick reuses it rather than sampling the terrain again. Only
   * ever the contact test's own sample; anything else that moves an entity
   * drops it, and a fresh sample is bit-identical to the reuse.
   */
  readonly #groundAhead = new Map<EntityId, number>()
  /** Sphere-of-influence bounds carried between ticks; see `SoiWatch`. */
  readonly #soi = new Map<EntityId, SoiWatch>()
  readonly #coasting = new Map<EntityId, CoastRecord>()
  readonly #events: WorldEvent[] = []
  readonly #log: Logger

  constructor(options: WorldOptions) {
    this.seedText = options.seed
    this.rootSeed = rootSeed(options.seed)
    this.galaxy = options.galaxy ?? MILKY_WAY
    this.galaxySeed = galaxySeedOf(this.rootSeed, this.galaxy)
    this.catalog = options.catalog ?? SOL_ONLY_CATALOG
    this.clock = new SimulationClock({
      ...(options.startTick === undefined
        ? {}
        : { startTick: options.startTick }),
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

    const stub = resolveSystem(this.galaxySeed, this.catalog, id)
    invariant(stub !== undefined, `Unknown system ${id}`)
    const system = generateSystem(this.rootSeed, this.galaxy, stub)
    installSystemFrames(this.frames, system)
    this.#systems.set(id, system)
    this.#bindSystem(system)
    this.#record(
      'system-loaded',
      null,
      `${system.name} (${planetCount(system)} planets)`,
    )
    this.#log.info('system loaded', {
      system: id,
      planets: planetCount(system),
      bodies: system.planets.length,
    })
    return system
  }

  unloadSystem(id: SystemId): void {
    const system = this.#systems.get(id)
    if (system === undefined) return
    for (const entity of this.entities.all()) {
      const chain = this.frames.has(entity.state.frame)
        ? this.frames.chain(entity.state.frame)
        : []
      invariant(
        !chain.includes(systemFrameId(id)),
        `Cannot unload ${id}: entity ${entity.id} is still inside it`,
      )
    }
    // Surface frames are created on demand; drop them before their parents.
    for (const frame of this.frames.ids()) {
      if (
        frame.startsWith('sf:') &&
        this.frames.chain(frame).includes(systemFrameId(id))
      ) {
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
      mu: system.star.mu,
      radius: system.star.radius,
      sphereOfInfluence: SYSTEM_INFLUENCE_RADIUS,
      atmosphere: null,
      maxSpeed: 0,
      spinFrame: null,
      parent: ROOT_FRAME,
      body: null,
    })

    const bindBody = (body: Body, parent: FrameId, parentMu: number): void => {
      const frame = bodyFrameId(body.address)
      this.#addBinding({
        frame,
        mu: body.mu,
        radius: body.radius,
        sphereOfInfluence: body.sphereOfInfluence,
        atmosphere: body.atmosphere,
        // The same `G(M + m)` the orbit evaluator runs on, so the bound is the
        // speed the frame actually moves at rather than a hair under it.
        maxSpeed: visViva(
          parentMu + body.mu,
          periapsis(body.elements),
          body.elements.semiMajorAxis,
        ),
        spinFrame: bodyFixedFrameId(body.address),
        parent,
        body,
      })
      for (const moon of body.moons) bindBody(moon, frame, body.mu)
    }
    for (const planet of system.planets)
      bindBody(planet, systemFrame, system.star.mu)
  }

  #unbindSystem(system: StarSystem): void {
    for (const body of walkBodies(system))
      this.#removeBinding(bodyFrameId(body.address))
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
      const siblings = (this.#children.get(parent) ?? []).filter(
        (b) => b.frame !== frame,
      )
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

  /** Whether an entity is coasting on rails rather than being integrated. */
  isCoasting(id: EntityId): boolean {
    // `?.rails !== null` alone says a missing entity coasts.
    return (this.entities.get(id)?.rails ?? null) !== null
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
    // The grammar belongs to `universe`, beside the formatter that mints it.
    // Re-deriving it here meant the `-0` idempotency guard had no counterpart
    // on the load path, which is where a landed save is restored.
    const parsed = parseSurfaceFrameId(id)
    if (parsed === null) return false

    const system =
      this.#systems.get(parsed.address.system) ??
      this.loadSystem(parsed.address.system)
    const body = findBody(system, parsed.address.body)
    if (body === undefined) return false
    installSurfaceFrame(this.frames, body, parsed.latitude, parsed.longitude)
    return this.frames.has(id)
  }

  /** Move an entity into another frame without moving it in the universe. */
  reframeEntity(id: EntityId, frame: FrameId): Entity {
    const entity = this.entities.require(id)
    const state = reframe(this.frames, entity.state, frame, this.clock.time)
    this.#landed.delete(id)
    this.#forgetDerived(id)
    return this.entities.update(id, { state, rails: null })
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
  teleport(id: EntityId, state: FrameState): Entity {
    // Off the rails as well: the epoch describes where the entity was, and it
    // is not there now. It earns a new one on its next coasting tick.
    const entity = this.entities.update(id, { state, rails: null })
    this.#previous.set(id, state)
    this.#altitudes.delete(id)
    this.#forgetDerived(id)
    // Landedness is *not* a parameter. It is a consequence of geometry that
    // `#land` computes from the contact test, and letting a caller assert it
    // produced states `#land` would never produce: the harness teleported a
    // ship to 3 m up and declared it landed, `stepFlight` short-circuited to
    // `stepLanded` before the contact test could run, and the ship hovered
    // there permanently while `altitudeOf` reported 0.
    this.#landed.delete(id)
    return entity
  }

  /* ----------------------------------------------------------------------- */
  /* Player input                                                             */
  /* ----------------------------------------------------------------------- */

  /*
   * Control lives here rather than in the caller for the same reason `teleport`
   * does: `entities.update` is public and unrestricted, so the door that skips
   * the interpolation and landed-set bookkeeping was exactly as wide as the one
   * that does it. These three are the whole of what a player can change.
   *
   * Each takes an entity off the rails when what it changes is a term the
   * coast does not carry — thrust, a torque the assist will now apply, a spin
   * that is no longer the epoch's. A neutral input on a coasting ship changes
   * nothing and leaves the epoch alone, so a key that is released twice does
   * not re-anchor the conic on a different rounding.
   */

  setControl(id: EntityId, translation: Vec3, rotation: Vec3): Entity {
    const neutral =
      Vec.lengthSquared(translation) === 0 && Vec.lengthSquared(rotation) === 0
    if (!neutral) this.#leaveRails(id)
    return this.entities.update(id, { control: { translation, rotation } })
  }

  setFlightAssist(id: EntityId, enabled: boolean): boolean {
    const entity = this.entities.require(id)
    if (enabled && Vec.lengthSquared(entity.state.angularVelocity) !== 0)
      this.#leaveRails(id)
    this.entities.update(id, { flightAssist: enabled })
    return enabled
  }

  /** Zero the spin without disturbing the trajectory. */
  killRotation(id: EntityId): Entity {
    const entity = this.entities.require(id)
    if (Vec.lengthSquared(entity.state.angularVelocity) !== 0)
      this.#leaveRails(id)
    const state = { ...entity.state, angularVelocity: Vec.ZERO }
    const updated = this.entities.update(id, { state })
    // Interpolation history has to follow, or the overlay lerps the old spin
    // into the new one for a frame.
    this.#previous.set(id, state)
    return updated
  }

  canonicalPositionOf(id: EntityId): UniverseVector {
    return canonicalPosition(
      this.frames,
      this.entities.require(id).state,
      this.clock.time,
    )
  }

  /* ----------------------------------------------------------------------- */
  /* Stepping                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Advance exactly one fixed tick.
   *
   * An entity on rails is evaluated from its epoch rather than integrated,
   * and its sphere-of-influence tests run only on a `RAILS_CHUNK` boundary —
   * the same instants `#jump` tests at, so that stepping and jumping agree.
   */
  step(): void {
    const time = this.clock.time
    const after = time + TICK_DURATION
    const tick = this.clock.tick + 1
    const boundary = tick % RAILS_CHUNK === 0
    let checks: EntityId[] | null = null
    for (const entity of this.entities.ordered()) {
      this.#previous.set(entity.id, entity.state)

      if (entity.rails !== null) {
        const record = this.#coastRecord(entity)
        this.#coast(entity, entity.rails, after)
        if (boundary && tick >= record.nextCheck)
          (checks ??= []).push(entity.id)
        continue
      }

      const result = stepFlight(this, entity, this.#landed.has(entity.id), {
        dt: TICK_DURATION,
        time,
        previousAltitude: this.#groundAhead.get(entity.id),
        soi: this.#soi.get(entity.id) ?? null,
      })

      if (result.altitude !== null)
        this.#altitudes.set(entity.id, result.altitude)
      else this.#altitudes.delete(entity.id)
      if (result.soi !== null) this.#soi.set(entity.id, result.soi)
      else this.#soi.delete(entity.id)

      if (result.frameChange !== null) {
        this.#record(
          'frame-change',
          entity.id,
          `${result.frameChange.from} → ${result.frameChange.to} (${result.frameChange.reason})`,
        )
      }

      if (result.touchdown) {
        this.entities.update(entity.id, { state: result.state })
        this.#land(entity.id, after, result.impactSpeed)
        continue
      }

      if (result.liftOff) {
        // Commit the unstick offset before re-framing, or the ship is handed
        // back to the inertial frame still sitting on the ground.
        this.entities.update(entity.id, { state: result.state })
        this.#liftOff(entity.id, after)
        continue
      }

      // Only the contact test's own sample is worth carrying: a frame change
      // moved the origin the number was measured from. Touchdown and lift-off
      // drop it through `#forgetDerived` on their own paths above.
      if (result.frameChange === null && result.altitude !== null)
        this.#groundAhead.set(entity.id, result.altitude)
      else this.#groundAhead.delete(entity.id)
      this.entities.update(entity.id, { state: result.state })
      // The ground and the frame settled, the tick may find nothing left to
      // integrate — in which case the next one coasts from here.
      if (!this.#landed.has(entity.id)) this.#enterRails(entity.id, after)
    }
    this.clock.commitTick()
    if (checks !== null)
      for (const id of checks) this.#railsCheck(id, after, tick)
  }

  /** Run n ticks with no wall clock. Deterministic by construction. */
  runTicks(count: number): void {
    invariant(
      Number.isInteger(count) && count >= 0,
      `runTicks needs a whole count, got ${count}`,
    )
    this.#run(count, Infinity)
  }

  /**
   * Advance by wall-clock seconds. Returns the number of ticks actually run.
   *
   * The only place real time enters the simulation, and all it decides is how
   * many identical fixed steps to take — and how many of those may be taken
   * one at a time.
   */
  advance(realSeconds: Seconds): number {
    const { wanted, budget } = this.clock.plan(realSeconds)
    const ran = this.#run(wanted, budget)
    this.clock.settle(ran)
    return ran
  }

  /**
   * Run up to `count` ticks, integrating at most `budget` of them.
   *
   * Every tick that every entity coasts over is jumped, in one move, to the
   * next instant any coasting entity has a test to make; every other tick is
   * stepped and counted against the budget. A frame at 100,000× over a
   * coasting ship is therefore one jump, and the same frame over a thrusting
   * one is the budget's worth of integration and a dropped remainder — which
   * is what the ceiling always meant.
   */
  #run(count: number, budget: number): number {
    let ran = 0
    let integrated = 0
    while (ran < count) {
      const jump = this.#coastable(count - ran)
      if (jump > 0) {
        this.#jump(jump)
        ran += jump
        continue
      }
      if (integrated >= budget) break
      this.step()
      ran += 1
      integrated += 1
    }
    return ran
  }

  /**
   * How many ticks may be jumped from here, or 0 if anything has to step.
   *
   * At least one when every entity is on rails, because a record's `nextCheck`
   * is always past the current tick; `remaining` when there are no entities at
   * all, which is a universe of planets and nothing that integrates.
   */
  #coastable(remaining: number): number {
    let jump = remaining
    const tick = this.clock.tick
    for (const entity of this.entities.all()) {
      if (entity.rails === null) return 0
      jump = Math.min(jump, this.#coastRecord(entity).nextCheck - tick)
    }
    return jump
  }

  /** Move every coasting entity `count` ticks on, and test the ones that are due. */
  #jump(count: number): void {
    const tick = this.clock.tick + count
    const time = timeOfTick(asTick(tick))
    const boundary = tick % RAILS_CHUNK === 0
    let checks: EntityId[] | null = null
    for (const entity of this.entities.ordered()) {
      const epoch = entity.rails
      invariant(epoch !== null, `#jump over an integrating entity ${entity.id}`)
      // Interpolation wants the tick before, which a jump of one already
      // holds and a longer one evaluates — one more propagation, so the frame
      // after a jump is presented from the same pair a stepped one would be.
      this.#previous.set(
        entity.id,
        count === 1
          ? entity.state
          : coastState(
              this,
              entity.state.frame,
              epoch,
              timeOfTick(asTick(tick - 1)),
            ),
      )
      const record = this.#coastRecord(entity)
      this.#coast(entity, epoch, time)
      if (boundary && tick >= record.nextCheck) (checks ??= []).push(entity.id)
    }
    this.clock.commitTicks(count)
    if (checks !== null)
      for (const id of checks) this.#railsCheck(id, time, tick)
  }

  /** Put a coasting entity where its epoch says it is at `time`. */
  #coast(entity: Entity, epoch: RailsEpoch, time: Seconds): void {
    const state = coastState(this, entity.state.frame, epoch, time)
    this.entities.update(entity.id, { state })
    const binding = this.binding(state.frame)
    // Above the ground band by the rails' own condition, where the datum is
    // the exact answer and the one the integrator would give.
    if (binding !== undefined && binding.body !== null)
      this.#altitudes.set(
        entity.id,
        Vec.length(state.position) - binding.radius,
      )
    else this.#altitudes.delete(entity.id)
  }

  /** The record beside a coasting entity, rebuilt from the epoch if it is missing. */
  #coastRecord(entity: Entity): CoastRecord {
    const held = this.#coasting.get(entity.id)
    if (held !== undefined) return held
    const epoch = entity.rails
    invariant(epoch !== null, `no coast record for ${entity.id}`)
    const record: CoastRecord = {
      nextCheck: nextBoundary(this.clock.tick),
      speedBound: railsSpeedBound(this, entity.state.frame, epoch),
    }
    this.#coasting.set(entity.id, record)
    return record
  }

  /**
   * Run a coasting entity's sphere-of-influence tests at a boundary.
   *
   * A crossing re-frames the entity at this instant — exactly, because the
   * coast put it here at this instant — and puts it back on rails in the new
   * frame if the new conic allows, from a fresh epoch. No crossing sets the
   * next boundary the tests could possibly matter on.
   *
   * Runs after the clock has committed `tick`, so `tick` is passed rather than
   * read: the event a crossing records is stamped with the tick that was being
   * stepped, the way the integrated path stamps its own before the commit.
   */
  #railsCheck(id: EntityId, time: Seconds, tick: number): void {
    const entity = this.entities.require(id)
    const epoch = entity.rails
    if (epoch === null) return
    const record = this.#coastRecord(entity)
    const binding = this.binding(entity.state.frame)
    if (binding === undefined) {
      // Deep space: nothing to enter and nothing to leave, ever.
      record.nextCheck = Infinity
      return
    }
    const verdict = considerFrameChange(
      this,
      entity,
      binding,
      time,
      this.#soi.get(id) ?? null,
      record.speedBound,
    )
    if (verdict.change === null) {
      this.#soi.set(id, verdict.watch)
      record.nextCheck = nextCheckAfter(tick, verdict.safeFor)
      return
    }
    const { state, change } = verdict.change
    this.entities.update(id, { state, rails: null })
    this.#previous.set(id, state)
    this.#forgetDerived(id)
    this.#record(
      'frame-change',
      id,
      `${change.from} → ${change.to} (${change.reason})`,
      tick - 1,
    )
    this.#enterRails(id, time)
  }

  /**
   * Put an entity on rails from `time`, if its state allows it.
   *
   * The coast record is not built here: `#coastRecord` rebuilds it from the
   * epoch on first use, and the first use is after the tick commits, so the
   * boundary it seeds is the same one either way. One construction site.
   */
  #enterRails(id: EntityId, time: Seconds): void {
    const entity = this.entities.require(id)
    const epoch = railsEpoch(this, entity, this.#landed.has(id), time)
    this.#coasting.delete(id)
    if (epoch !== null) this.entities.update(id, { rails: epoch })
  }

  /**
   * Take an entity off the rails; the next tick integrates it.
   *
   * Through `#forgetDerived` rather than dropping the coast record alone,
   * because a coast moves the entity and `#groundAhead` is a measurement under
   * where it *was*. A ship that entered rails at a 130 km periapsis and
   * coasted out to 2,418 km would otherwise hand the next integrated tick an
   * altitude 2,288 km stale. Harmless today — every rails-eligible state is
   * above the drag ceiling, so the one branch that reads the value takes the
   * same side either way — and harmless by three steps of reasoning rather
   * than by construction, which is the wrong kind of safe for a field whose
   * docstring promises it is only ever the contact test's own sample.
   */
  #leaveRails(id: EntityId): void {
    const entity = this.entities.get(id)
    if (entity === undefined || entity.rails === null) return
    this.entities.update(id, { rails: null })
    this.#forgetDerived(id)
  }

  /** Drop everything derived from an entity's motion that a move invalidates. */
  #forgetDerived(id: EntityId): void {
    this.#groundAhead.delete(id)
    this.#soi.delete(id)
    this.#coasting.delete(id)
  }

  #land(id: EntityId, time: Seconds, impactSpeed: number): void {
    const entity = this.entities.require(id)
    const binding = this.binding(entity.state.frame)
    if (
      binding?.body === null ||
      binding === undefined ||
      binding.spinFrame === null
    )
      return
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
        // Sit on the surface, not a fraction of a meter inside it: the contact
        // test fires on the tick that crosses zero, which is usually just past.
        position: vec3(
          landedState.position.x,
          Math.max(0, landedState.position.y),
          landedState.position.z,
        ),
        // Attached to the ground: no residual motion in the surface frame.
        velocity: Vec.ZERO,
        angularVelocity: Vec.ZERO,
      },
    })
    this.#landed.add(id)
    this.#forgetDerived(id)
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
    this.#forgetDerived(id)
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
  updateInterest(
    centre: UniverseVector,
    radius: Meters = 6 * LIGHT_YEAR,
  ): {
    loaded: readonly SystemId[]
    unloaded: readonly SystemId[]
  } {
    const wanted = systemsWithin(this.galaxySeed, this.catalog, centre, radius)
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
      for (const frame of this.frames.chain(entity.state.frame))
        occupied.add(frame)
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

  #record(
    kind: WorldEvent['kind'],
    entity: EntityId | null,
    detail: string,
    tick: Tick | number = this.clock.tick,
  ): void {
    this.#events.push({ tick: asTick(tick), kind, entity, detail })
    if (this.#events.length > 256) this.#events.shift()
  }

  /**
   * A hash of everything canonical.
   *
   * Two runs that agree on this agree on the universe. Used by the determinism
   * tests, by the harness, and (later) as a desync check against a server.
   *
   * `angularVelocity`, `control` and `flightAssist` are in here now. They were
   * not, and the docstring said "everything canonical" anyway, so two worlds
   * differing only in the fields that `killRotation` and flight assist write
   * hashed identically at the instant they diverged. That matters because it is
   * where a real bug already lived — a save taken mid-burn resumed coasting —
   * and the persistence test caught it only by stepping 300 further ticks and
   * letting the difference show up in position. This makes it detectable at the
   * tick it happens.
   *
   * The rails epoch is in it for the same reason: two worlds that agree on a
   * coasting entity's state and disagree on its epoch diverge on the next tick,
   * in the low bits, and a hash that ignored the epoch would call them equal.
   */
  stateHash(): string {
    const parts: string[] = [`t=${this.clock.tick}`, `seed=${this.seedText}`]
    for (const entity of this.entities.ordered()) {
      const s = entity.state
      const c = entity.control
      const r = entity.rails
      parts.push(
        `${entity.id}|${s.frame}|${s.position.x},${s.position.y},${s.position.z}` +
          `|${s.velocity.x},${s.velocity.y},${s.velocity.z}` +
          `|${s.orientation.x},${s.orientation.y},${s.orientation.z},${s.orientation.w}` +
          `|${s.angularVelocity.x},${s.angularVelocity.y},${s.angularVelocity.z}` +
          `|${c.translation.x},${c.translation.y},${c.translation.z}` +
          `|${c.rotation.x},${c.rotation.y},${c.rotation.z}` +
          `|${entity.flightAssist ? 'assist' : 'manual'}` +
          `|${this.#landed.has(entity.id) ? 'landed' : 'free'}` +
          (r === null
            ? '|integrated'
            : `|rails:${r.time}:${r.position.x},${r.position.y},${r.position.z}` +
              `:${r.velocity.x},${r.velocity.y},${r.velocity.z}` +
              `:${r.orientation.x},${r.orientation.y},${r.orientation.z},${r.orientation.w}` +
              `:${r.angularVelocity.x},${r.angularVelocity.y},${r.angularVelocity.z}`),
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

/** The first `RAILS_CHUNK` boundary strictly after `tick`. */
const nextBoundary = (tick: number): number =>
  (Math.floor(tick / RAILS_CHUNK) + 1) * RAILS_CHUNK

/**
 * The first boundary on or after the instant a test could matter, and never
 * the one being stood on. `safeFor` is seconds; `Infinity` stays `Infinity`,
 * which is a coast nothing can interrupt.
 */
const nextCheckAfter = (tick: number, safeFor: Seconds): number =>
  Math.max(
    nextBoundary(tick),
    Math.ceil((tick + Math.floor(safeFor / TICK_DURATION)) / RAILS_CHUNK) *
      RAILS_CHUNK,
  )

export { timeOfTick, Q }
