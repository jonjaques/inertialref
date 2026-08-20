import {
  AU,
  getLogger,
  LIGHT_YEAR,
  logHub,
  type LogRecord,
  type Result,
  RingBufferSink,
} from '@inertialref/shared'
import { circularSpeed } from '@inertialref/physics'
import {
  Quaternion as Q,
  type UniverseVector,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  snapshot,
  type World,
  type WorldSnapshot,
} from '@inertialref/simulation'
import {
  type Body,
  bodyFrameId,
  type EntityId,
  findBody,
  formatAddress,
  installSurfaceFrame,
  isLandable,
  parseAddress,
  systemFrameId,
  systemId,
  type SystemId,
  systemsWithin,
  walkBodies,
} from '@inertialref/universe'
import {
  captureSave,
  parseSave,
  restoreSave,
  serializeSave,
} from '@inertialref/persistence'
import type { RenderScene } from '@inertialref/rendering'
import type { PoolStats, WorkerPool } from '@inertialref/workers'
import {
  runCapabilityChecks,
  summarizeCapabilities,
  type CapabilityResult,
} from './capabilities.ts'
import {
  inspectEntity,
  inspectRender,
  inspectWorld,
  type EntityInspection,
  type RenderInspection,
  type WorldInspection,
} from './inspect.ts'
import {
  currentSystemOf,
  resolveDestination,
  type TravelTarget,
  type TravelTargetOptions,
  travelTargets,
  viewingAltitudeKm,
} from './travel.ts'

/*
 * The scriptable harness.
 *
 * One object that can drive and interrogate the whole game without touching the
 * UI. The app exposes it on `window`, so a browser console — or an agent
 * driving the browser — can set up a scenario, step the simulation
 * deterministically, and read back structured state instead of squinting at
 * pixels. Everything it returns is JSON-serialisable for exactly that reason.
 *
 * This is also why it lives in a package rather than in the app: the same
 * harness drives the headless Node runner, so a scenario that reproduces a bug
 * in the browser can be replayed in a test.
 */

/** Frame timing from a render loop. One definition; it used to have three. */
export interface FrameStats {
  readonly fps: number
  readonly frameMs: number
  readonly ticksLastFrame: number
}

/**
 * What every host can answer, whether or not it draws anything.
 *
 * `world` must be a *getter*, not a captured reference. Loading a save replaces
 * the world wholesale, and a host that copied the reference in at construction
 * leaves the harness — and therefore the debug overlay — reporting on the world
 * that was thrown away while the frame loop runs the new one. That split brain
 * looked exactly like "load silently does nothing" from the outside.
 * `openSession` is the one implementation that matters; it gets this right once.
 */
export interface SimulationHost {
  readonly world: World
  /** The entity the camera follows. */
  player(): EntityId | null
  setPlayer(id: EntityId): void
  pool(): WorkerPool | null
  /** Replace the running world (used by load). */
  replaceWorld(world: World, player: EntityId | null): void
}

/**
 * The half only a host that renders can answer.
 *
 * Split out because it was not optional before, so the headless runner and the
 * tests each had to write `scene: () => null, frameStats: () => null` and, in
 * the runner's case, a `replaceWorld` that threw — three of eight members
 * stubbed to satisfy a port for questions they have no concept of.
 */
export interface PresentationHost {
  scene(): RenderScene | null
  frameStats(): FrameStats | null
}

export type HarnessHost = SimulationHost & Partial<PresentationHost>

export interface HarnessStatus {
  readonly world: WorldInspection
  readonly player: EntityInspection | null
  readonly render: RenderInspection | null
  readonly workers: PoolStats | null
  readonly frame: FrameStats | null
}

export interface ScenarioResult {
  readonly name: string
  readonly ticks: number
  readonly detail: string
  readonly status: HarnessStatus
}

const log = getLogger('devtools.harness')

/**
 * The hold-off distance for a system with nothing to orbit.
 *
 * Outside every planet of a typical system, so arriving never drops the ship
 * inside a body or inside a sphere of influence it did not ask for. It is a
 * long way from anything to look at, which is why it is the fallback rather
 * than the default.
 */
const ARRIVAL_DISTANCE_AU = 40

export class GameHarness {
  readonly #host: HarnessHost
  readonly #logSink = new RingBufferSink(256)

  constructor(host: HarnessHost) {
    this.#host = host
    logHub.addSink(this.#logSink)
  }

  get world(): World {
    return this.#host.world
  }

  /* --------------------------------------------------------------------- */
  /* Reading                                                                */
  /* --------------------------------------------------------------------- */

  /** Everything the debug overlay shows, as data. */
  status(): HarnessStatus {
    const player = this.#host.player()
    const scene = this.#host.scene?.() ?? null
    return {
      world: inspectWorld(this.world),
      player: player === null ? null : inspectEntity(this.world, player),
      render: scene === null ? null : inspectRender(scene),
      workers: this.#host.pool()?.stats() ?? null,
      frame: this.#host.frameStats?.() ?? null,
    }
  }

  /** Compact one-line summary, for a quick look from a console. */
  summary(): string {
    const status = this.status()
    const player = status.player
    return [
      `tick ${status.world.tick} (${status.world.timeText}, ${status.world.timeScale}x${status.world.paused ? ', paused' : ''})`,
      `hash ${status.world.stateHash}`,
      player === null ? 'no player' : `${player.name} in ${player.frame}`,
      player === null
        ? ''
        : `${player.speedText}${player.altitudeText === null ? '' : ` alt ${player.altitudeText}`}`,
      `systems ${status.world.loadedSystems.length}, frames ${status.world.frames}`,
    ]
      .filter((part) => part.length > 0)
      .join(' | ')
  }

  snapshot(alpha = 0): WorldSnapshot {
    return snapshot(this.world, alpha)
  }

  inspect(id?: string): EntityInspection | null {
    const target = (id as EntityId | undefined) ?? this.#host.player()
    return target === null || target === undefined
      ? null
      : inspectEntity(this.world, target)
  }

  logs(limit = 40): readonly LogRecord[] {
    return this.#logSink.records().slice(-limit)
  }

  /** Star systems within `lightYears` of the player, nearest first. */
  systemsNearby(
    lightYears = 8,
  ): readonly { id: string; name: string; lightYears: number }[] {
    const centre = this.#here()
    return systemsWithin(this.world.galaxySeed, centre, lightYears * LIGHT_YEAR)
      .map((stub) => ({
        id: stub.id as string,
        name: stub.name,
        lightYears: UV.distance(stub.position, centre) / LIGHT_YEAR,
      }))
      .sort((a, b) => a.lightYears - b.lightYears)
  }

  /**
   * Everywhere the player can be sent right now, nearest system first, each
   * system followed by its bodies if it is loaded.
   *
   * The one call that answers "where can I go?", which nothing answered before:
   * every other verb here takes an address and none of them would tell you one.
   * The debug overlay renders this list and the console prints it.
   */
  targets(options: TravelTargetOptions = {}): readonly TravelTarget[] {
    return travelTargets(this.world, this.#here(), options)
  }

  /**
   * Generate a system and install its frames without going there.
   *
   * `bodies()` only sees systems that are loaded, so browsing what is in the
   * next system along used to require flying to it first. This is the seam that
   * makes looking cheaper than travelling.
   */
  loadSystem(system: string): readonly {
    address: string
    name: string
    kind: string
    radiusKm: number
    auFromStar: number
    moons: number
  }[] {
    const target = this.world.loadSystem(systemId(system))
    return this.bodies(target.id)
  }

  /** Bodies of a loaded system, as a flat listing. */
  bodies(system?: string): readonly {
    address: string
    name: string
    kind: string
    radiusKm: number
    auFromStar: number
    moons: number
  }[] {
    const target = this.world.system(
      (system as SystemId | undefined) ??
        (this.world.loadedSystems()[0]?.id as SystemId),
    )
    if (target === undefined) return []
    return [...walkBodies(target)].map((body) => ({
      address: formatAddress(body.address),
      name: body.name,
      kind: body.kind,
      radiusKm: body.radius / 1000,
      auFromStar: body.elements.semiMajorAxis / AU,
      moons: body.moons.length,
    }))
  }

  /* --------------------------------------------------------------------- */
  /* Driving                                                                */
  /* --------------------------------------------------------------------- */

  /** Advance exactly n ticks, ignoring wall clock. */
  step(ticks = 1): HarnessStatus {
    this.world.runTicks(ticks)
    return this.status()
  }

  /** Advance n seconds of simulation time, exactly. */
  runSeconds(seconds: number): HarnessStatus {
    return this.step(Math.round(seconds * 64))
  }

  pause(): void {
    this.world.clock.setPaused(true)
  }

  resume(): void {
    this.world.clock.setPaused(false)
  }

  timeWarp(scale: number): void {
    this.world.clock.setTimeScale(scale)
  }

  /** Set the player's control input directly, as the keyboard would. */
  control(input: {
    translation?: [number, number, number]
    rotation?: [number, number, number]
  }): void {
    const player = this.#requirePlayer()
    const entity = this.world.entities.require(player)
    this.world.setControl(
      player,
      input.translation === undefined
        ? entity.control.translation
        : vec3(...input.translation),
      input.rotation === undefined
        ? entity.control.rotation
        : vec3(...input.rotation),
    )
  }

  hold(): void {
    this.control({ translation: [0, 0, 0], rotation: [0, 0, 0] })
  }

  flightAssist(enabled: boolean): void {
    this.world.setFlightAssist(this.#requirePlayer(), enabled)
  }

  /**
   * Put the player in a circular orbit around a body.
   *
   * Named for what it does physically rather than "teleport": it sets a state
   * that is a valid solution of the two-body problem, so the ship stays there.
   */
  orbit(address: string, altitudeKm = 400): HarnessStatus {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    const system = this.world.loadSystem(parsed.system)
    const body = findBody(system, parsed.body)
    if (body === undefined) throw new Error(`No body at ${address}`)

    const radius = body.radius + altitudeKm * 1000
    const speed = circularSpeed(body.mu, radius)
    const player = this.#requirePlayer()
    const frame = bodyFrameId(body.address)

    // Placed on the sunward side, and pointing along the orbit. A debug tool
    // that drops you on the night side of an unlit world, facing away from
    // everything, is technically correct and useless.
    const time = this.world.clock.time
    const bodyPose = this.world.frames.pose(frame, time)
    const parent = this.world.frames.get(frame).parent
    const toStar =
      parent === null
        ? vec3(1, 0, 0)
        : Vec.normalize(
            Q.rotateInverse(
              bodyPose.orientation,
              UV.difference(
                this.world.frames.pose(parent, time).position,
                bodyPose.position,
              ),
            ),
          )
    const alongOrbit = Vec.normalize(Vec.cross(vec3(0, 1, 0), toStar))

    this.world.teleport(player, {
      frame,
      position: Vec.scale(toStar, radius),
      // Nose along the direction of travel: forward is −Z.
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), alongOrbit),
      velocity: Vec.scale(alongOrbit, speed),
      angularVelocity: Vec.ZERO,
    })
    this.world.setControl(player, Vec.ZERO, Vec.ZERO)
    log.info('placed in orbit', { address, altitudeKm, speed })
    return this.status()
  }

  /** Park the player on the ground at a latitude/longitude, ready to fly. */
  land(address: string, latitude = 0, longitude = 0): HarnessStatus {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    const system = this.world.loadSystem(parsed.system)
    const body = findBody(system, parsed.body)
    if (body === undefined) throw new Error(`No body at ${address}`)

    const frame = installSurfaceFrame(
      this.world.frames,
      body,
      latitude,
      longitude,
    )
    const player = this.#requirePlayer()
    this.world.teleport(player, {
      frame,
      // On the pad, which is what the origin of a surface frame *is*:
      // `installSurfaceFrame` derives the frame's elevation from the terrain at
      // this exact quantised latitude/longitude, so local y = 0 is the ground.
      //
      // This used to be `vec3(0, 3, 0)` with `landed = true`, and the two
      // contradicted each other. `stepFlight` short-circuits to `stepLanded`
      // when an entity is already landed, so the contact test never ran and the
      // ship hovered at y = 3 forever while the overlay reported an altitude of
      // 0. Dropping the flag alone was not enough: 3 m is inside
      // LANDING_CLEARANCE, so the contact test then registered a landing at 3 m
      // and `#land`'s `max(0, y)` kept it there.
      position: Vec.ZERO,
      orientation: Q.IDENTITY,
      velocity: Vec.ZERO,
      angularVelocity: Vec.ZERO,
    })
    this.world.setControl(player, Vec.ZERO, Vec.ZERO)
    return this.status()
  }

  /**
   * Go anywhere, given anything that names it.
   *
   * The god-mode front door, and the only travel verb that does not require you
   * to already know what kind of thing you are naming. A body address arrives
   * in a circular orbit framing that body; a system designation arrives at its
   * first planet, because a star system's *contents* are what you asked for.
   *
   * Passing `distanceAu` asks for the other thing — a hold-off in the system
   * frame, out in the dark, which is where `goToSystem` alone leaves you. That
   * is a real place to want to be and a terrible place to arrive by default: at
   * 40 AU a red dwarf is a sub-pixel point, so "travel to Proxima" appeared to
   * do nothing at all.
   *
   * `orbit`, `land`, `goToSystem` and `face` are still the primitives and still
   * take exactly one kind of argument each — this dispatches to them rather
   * than reimplementing them, so there is one placement rule per manoeuvre.
   */
  goTo(
    destination: string,
    options: { altitudeKm?: number; distanceAu?: number } = {},
  ): HarnessStatus {
    const target = resolveDestination(
      destination,
      this.world.galaxy,
      currentSystemOf(this.world, this.#host.player()),
    )
    const system = this.world.loadSystem(target.system)

    if (target.kind === 'body') {
      const body = findBody(
        system,
        target.address.kind === 'body' ? target.address.body : [],
      )
      if (body === undefined) throw new Error(`No body at ${target.text}`)
      return this.#arriveAt(target.text, body, options.altitudeKm)
    }

    const first = system.planets[0]
    if (first !== undefined && options.distanceAu === undefined) {
      return this.#arriveAt(
        formatAddress(first.address),
        first,
        options.altitudeKm,
      )
    }

    this.goToSystem(target.system, options.distanceAu ?? ARRIVAL_DISTANCE_AU)
    // Arriving with the nose pointed at nothing is how you conclude the game is
    // broken. `goToSystem` places the ship on the +X axis of the system frame,
    // whose origin is the star.
    this.#lookAt(
      this.world.frames.pose(
        systemFrameId(target.system),
        this.world.clock.time,
      ).position,
    )
    return this.status()
  }

  /**
   * Circular orbit at a framing altitude, nose on the body.
   *
   * The second half is the part that is easy to leave out: `orbit` aims along
   * the track, which is right for flying and wrong for arriving — you teleport
   * into orbit and see empty space, which reads as "the planet did not load".
   * A rotation does not change the orbit, and `GameEngine`'s opening shot has
   * always done this exact pair for this exact reason.
   */
  #arriveAt(address: string, body: Body, altitudeKm?: number): HarnessStatus {
    this.orbit(address, altitudeKm ?? viewingAltitudeKm(body))
    return this.face(address)
  }

  /** Drop the player into interstellar space near a system. */
  goToSystem(system: string, distanceAu = 60): HarnessStatus {
    const target = this.world.loadSystem(systemId(system))
    const player = this.#requirePlayer()
    this.world.teleport(player, {
      frame: systemFrameId(target.id),
      position: vec3(distanceAu * AU, 0, 0),
      orientation: Q.IDENTITY,
      velocity: Vec.ZERO,
      angularVelocity: Vec.ZERO,
    })
    this.world.setControl(player, Vec.ZERO, Vec.ZERO)
    return this.status()
  }

  /**
   * Point the nose at a body without touching its trajectory.
   *
   * Separate from `burnToward` because looking and burning are different acts:
   * this one is free, and it is what you want when setting up a screenshot or
   * checking that a body is where the HUD says it is.
   */
  face(address: string): HarnessStatus {
    this.#lookAt(this.#bodyPosition(address))
    return this.status()
  }

  /** Aim the ship at a body and light the main drive. */
  burnToward(address: string, throttle = 1): HarnessStatus {
    this.#lookAt(this.#bodyPosition(address))
    this.world.setControl(this.#requirePlayer(), vec3(0, 0, throttle), Vec.ZERO)
    return this.status()
  }

  /* --------------------------------------------------------------------- */
  /* Persistence                                                            */
  /* --------------------------------------------------------------------- */

  save(): string {
    return serializeSave(captureSave(this.world, this.#host.player()))
  }

  load(text: string): Result<string, string> {
    const parsed = parseSave(text)
    if (!parsed.ok) return parsed
    const restored = restoreSave(parsed.value)
    if (!restored.ok) return restored
    this.#host.replaceWorld(restored.value.world, restored.value.playerEntity)
    return { ok: true, value: restored.value.world.stateHash() }
  }

  /* --------------------------------------------------------------------- */
  /* Proving                                                                */
  /* --------------------------------------------------------------------- */

  /** Run the twelve milestone capability checks against the live build. */
  async selfTest(): Promise<{
    passed: number
    total: number
    results: readonly CapabilityResult[]
    report: string
  }> {
    const results = await runCapabilityChecks({
      world: this.world,
      pool: this.#host.pool(),
    })
    const report = summarizeCapabilities(results)
    log.info('self test complete', {
      passed: results.filter((r) => r.passed).length,
      total: results.length,
    })
    return {
      passed: results.filter((r) => r.passed).length,
      total: results.length,
      results,
      report,
    }
  }

  /** Named, repeatable set-ups. Each returns the resulting status. */
  async scenario(name: string): Promise<ScenarioResult> {
    const before = this.world.clock.tick
    switch (name) {
      case 'orbit': {
        const target = this.#firstSolidBodyAddress()
        this.orbit(target, 300)
        this.step(64)
        return this.#scenarioResult(
          name,
          before,
          `circular orbit 300 km above ${target}`,
        )
      }
      case 'approach': {
        const target = this.#firstSolidBodyAddress()
        this.orbit(target, 200_000)
        this.burnToward(target, 1)
        this.step(64 * 60)
        return this.#scenarioResult(name, before, `burning toward ${target}`)
      }
      case 'surface': {
        const target = this.#firstSolidBodyAddress()
        this.land(target, 0.35, -1.1)
        this.step(64)
        return this.#scenarioResult(name, before, `parked on ${target}`)
      }
      case 'interstellar': {
        this.goToSystem('HIP71683', 4_000)
        this.step(64)
        return this.#scenarioResult(name, before, 'holding off Alpha Centauri')
      }
      default:
        throw new Error(
          `Unknown scenario "${name}". Try: orbit, approach, surface, interstellar`,
        )
    }
  }

  scenarios(): readonly string[] {
    return ['orbit', 'approach', 'surface', 'interstellar']
  }

  /** Text help, so the console is discoverable without reading this file. */
  help(): string {
    return [
      'InertialRef harness',
      '  ir.summary()                  one-line state',
      '  ir.status()                   full structured state',
      '  ir.inspect(id?)               one entity, in detail',
      '  ir.step(ticks) / ir.runSeconds(s)',
      '  ir.pause() / ir.resume() / ir.timeWarp(x)',
      '  ir.control({translation,rotation}) / ir.hold()',
      '  ir.targets()                  everywhere you can go, nearest first',
      '  ir.goTo(target)               a system id or a body address; does the right thing',
      '  ir.loadSystem(id)             generate a system without travelling to it',
      '  ir.bodies() / ir.systemsNearby(ly)',
      '  ir.orbit(address, altitudeKm) / ir.land(address, lat, lon)',
      '  ir.face(address)              point the nose at something',
      '  ir.goToSystem(id, au) / ir.burnToward(address, throttle)',
      '  ir.save() / ir.load(text)',
      '  await ir.selfTest()           the twelve milestone capabilities',
      '  await ir.scenario(name)       ' + this.scenarios().join(', '),
      '  ir.logs(n)',
    ].join('\n')
  }

  /** Where the listing is taken from: the player, or the first system loaded. */
  #here(): UniverseVector {
    const player = this.#host.player()
    if (player === null)
      return this.world.loadedSystems()[0]?.position ?? UV.UNIVERSE_ORIGIN
    return this.world.canonicalPositionOf(player)
  }

  #bodyPosition(address: string): UniverseVector {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    return this.world.frames.pose(bodyFrameId(parsed), this.world.clock.time)
      .position
  }

  /**
   * Point the nose at a universe position, changing nothing else.
   *
   * One implementation, because `face` and `burnToward` had two: the same
   * frame-relative rotation written out twice, differing only in whether it
   * then set the throttle. Forward is −Z, so the orientation that aims at the
   * target is the rotation taking −Z onto the target direction, and it goes
   * through `teleport` rather than `entities.update` because a discontinuous
   * change of attitude has to reset the interpolation history with it.
   */
  #lookAt(target: UniverseVector): void {
    const player = this.#requirePlayer()
    const state = this.world.entities.require(player).state
    const framePose = this.world.frames.pose(state.frame, this.world.clock.time)
    const toTarget = Q.rotateInverse(
      framePose.orientation,
      UV.difference(target, this.world.canonicalPositionOf(player)),
    )
    this.world.teleport(player, {
      ...state,
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), Vec.normalize(toTarget)),
      angularVelocity: Vec.ZERO,
    })
  }

  #scenarioResult(
    name: string,
    beforeTick: number,
    detail: string,
  ): ScenarioResult {
    return {
      name,
      ticks: this.world.clock.tick - beforeTick,
      detail,
      status: this.status(),
    }
  }

  #firstSolidBodyAddress(): string {
    const system =
      this.world.loadedSystems()[0] ?? this.world.loadSystem(systemId('SOL'))
    for (const body of walkBodies(system)) {
      if (isLandable(body)) return formatAddress(body.address)
    }
    throw new Error('no solid body available')
  }

  #requirePlayer(): EntityId {
    const player = this.#host.player()
    if (player === null) throw new Error('No player entity')
    return player
  }
}
