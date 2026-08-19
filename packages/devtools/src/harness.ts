import { getLogger, type LogRecord, type Result, RingBufferSink, logHub } from '@inertialref/shared'
import { circularSpeed } from '@inertialref/physics'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import { snapshot, type World, type WorldSnapshot } from '@inertialref/simulation'
import {
  bodyFrameId,
  type EntityId,
  findBody,
  formatAddress,
  installSurfaceFrame,
  parseAddress,
  systemFrameId,
  type SystemId,
  systemId,
  systemsWithin,
  walkBodies,
} from '@inertialref/universe'
import { captureSave, parseSave, restoreSave, serializeSave } from '@inertialref/persistence'
import type { RenderScene } from '@inertialref/rendering'
import type { PoolStats, WorkerPool } from '@inertialref/workers'
import { runCapabilityChecks, summarizeCapabilities, type CapabilityResult } from './capabilities.ts'
import { inspectEntity, inspectRender, inspectWorld, type EntityInspection, type RenderInspection, type WorldInspection } from './inspect.ts'

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

export interface HarnessHost {
  /**
   * Must be a *getter*, not a captured reference.
   *
   * Loading a save replaces the world wholesale. A host that copied the
   * reference in at construction leaves the harness — and therefore the debug
   * overlay — reporting on the world that was thrown away, while the frame loop
   * runs the new one. That split brain looked exactly like "load silently does
   * nothing" from the outside.
   */
  readonly world: World
  /** The entity the camera follows. */
  player(): EntityId | null
  setPlayer(id: EntityId): void
  scene(): RenderScene | null
  pool(): WorkerPool | null
  /** Frame timing from the render loop, if there is one. */
  frameStats(): { fps: number; frameMs: number; ticksLastFrame: number } | null
  /** Replace the running world (used by load). */
  replaceWorld(world: World, player: EntityId | null): void
}

export interface HarnessStatus {
  readonly world: WorldInspection
  readonly player: EntityInspection | null
  readonly render: RenderInspection | null
  readonly workers: PoolStats | null
  readonly frame: { fps: number; frameMs: number; ticksLastFrame: number } | null
}

export interface ScenarioResult {
  readonly name: string
  readonly ticks: number
  readonly detail: string
  readonly status: HarnessStatus
}

const log = getLogger('devtools.harness')

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
    const scene = this.#host.scene()
    return {
      world: inspectWorld(this.world),
      player: player === null ? null : inspectEntity(this.world, player),
      render: scene === null ? null : inspectRender(scene),
      workers: this.#host.pool()?.stats() ?? null,
      frame: this.#host.frameStats(),
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
      player === null ? '' : `${player.speedText}${player.altitudeText === null ? '' : ` alt ${player.altitudeText}`}`,
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
    return target === null || target === undefined ? null : inspectEntity(this.world, target)
  }

  logs(limit = 40): readonly LogRecord[] {
    return this.#logSink.records().slice(-limit)
  }

  /** Star systems within `lightYears` of the player, nearest first. */
  systemsNearby(lightYears = 8): readonly { id: string; name: string; lightYears: number }[] {
    const player = this.#host.player()
    const centre =
      player === null ? (this.world.loadedSystems()[0]?.position ?? UV.UNIVERSE_ORIGIN) : this.world.canonicalPositionOf(player)
    return systemsWithin(this.world.galaxySeed, centre, lightYears * 9.4607304725808e15)
      .map((stub) => ({
        id: stub.id as string,
        name: stub.name,
        lightYears: UV.distance(stub.position, centre) / 9.4607304725808e15,
      }))
      .sort((a, b) => a.lightYears - b.lightYears)
  }

  /** Bodies of a loaded system, as a flat listing. */
  bodies(system?: string): readonly { address: string; name: string; kind: string; radiusKm: number; auFromStar: number; moons: number }[] {
    const target = this.world.system((system as SystemId | undefined) ?? (this.world.loadedSystems()[0]?.id as SystemId))
    if (target === undefined) return []
    return [...walkBodies(target)].map((body) => ({
      address: formatAddress(body.address),
      name: body.name,
      kind: body.kind,
      radiusKm: body.radius / 1000,
      auFromStar: body.elements.semiMajorAxis / 1.495978707e11,
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
  control(input: { translation?: [number, number, number]; rotation?: [number, number, number] }): void {
    const player = this.#requirePlayer()
    const entity = this.world.entities.require(player)
    this.world.entities.update(player, {
      control: {
        translation: input.translation === undefined ? entity.control.translation : vec3(...input.translation),
        rotation: input.rotation === undefined ? entity.control.rotation : vec3(...input.rotation),
      },
    })
  }

  hold(): void {
    this.control({ translation: [0, 0, 0], rotation: [0, 0, 0] })
  }

  flightAssist(enabled: boolean): void {
    this.world.entities.update(this.#requirePlayer(), { flightAssist: enabled })
  }

  /**
   * Put the player in a circular orbit around a body.
   *
   * Named for what it does physically rather than "teleport": it sets a state
   * that is a valid solution of the two-body problem, so the ship stays there.
   */
  orbit(address: string, altitudeKm = 400): HarnessStatus {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body') throw new Error(`${address} is not a body address`)
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
              UV.difference(this.world.frames.pose(parent, time).position, bodyPose.position),
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
    this.world.entities.update(player, { control: { translation: Vec.ZERO, rotation: Vec.ZERO } })
    log.info('placed in orbit', { address, altitudeKm, speed })
    return this.status()
  }

  /** Park the player on the ground at a latitude/longitude, ready to fly. */
  land(address: string, latitude = 0, longitude = 0): HarnessStatus {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body') throw new Error(`${address} is not a body address`)
    const system = this.world.loadSystem(parsed.system)
    const body = findBody(system, parsed.body)
    if (body === undefined) throw new Error(`No body at ${address}`)

    const frame = installSurfaceFrame(this.world.frames, body, latitude, longitude)
    const player = this.#requirePlayer()
    this.world.teleport(
      player,
      {
        frame,
        // A few metres up, so the contact test settles it onto the ground on
        // the next tick rather than starting it inside the terrain.
        position: vec3(0, 3, 0),
        orientation: Q.IDENTITY,
        velocity: Vec.ZERO,
        angularVelocity: Vec.ZERO,
      },
      true,
    )
    this.world.entities.update(player, { control: { translation: Vec.ZERO, rotation: Vec.ZERO } })
    return this.status()
  }

  /** Drop the player into interstellar space near a system. */
  goToSystem(system: string, distanceAu = 60): HarnessStatus {
    const target = this.world.loadSystem(systemId(system))
    const player = this.#requirePlayer()
    this.world.teleport(player, {
      frame: systemFrameId(target.id),
      position: vec3(distanceAu * 1.495978707e11, 0, 0),
      orientation: Q.IDENTITY,
      velocity: Vec.ZERO,
      angularVelocity: Vec.ZERO,
    })
    this.world.entities.update(player, { control: { translation: Vec.ZERO, rotation: Vec.ZERO } })
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
    const player = this.#requirePlayer()
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body') throw new Error(`${address} is not a body address`)
    const time = this.world.clock.time
    const bodyPose = this.world.frames.pose(bodyFrameId(parsed), time)
    const state = this.world.entities.require(player).state
    const framePose = this.world.frames.pose(state.frame, time)
    const toTarget = Q.rotateInverse(
      framePose.orientation,
      UV.difference(bodyPose.position, this.world.canonicalPositionOf(player)),
    )
    this.world.teleport(player, {
      ...state,
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), Vec.normalize(toTarget)),
      angularVelocity: Vec.ZERO,
    })
    return this.status()
  }

  /** Aim the ship at a body and light the main drive. */
  burnToward(address: string, throttle = 1): HarnessStatus {
    const player = this.#requirePlayer()
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body') throw new Error(`${address} is not a body address`)
    const bodyPose = this.world.frames.pose(bodyFrameId(parsed), this.world.clock.time)
    const state = this.world.entities.require(player).state
    const framePose = this.world.frames.pose(state.frame, this.world.clock.time)
    const here = this.world.canonicalPositionOf(player)
    const toTarget = Q.rotateInverse(framePose.orientation, UV.difference(bodyPose.position, here))
    // Forward is −Z, so the orientation that points the nose at the target is
    // the rotation taking −Z onto the target direction.
    const orientation = Q.fromUnitVectors(vec3(0, 0, -1), Vec.normalize(toTarget))
    this.world.entities.update(player, {
      state: { ...state, orientation, angularVelocity: Vec.ZERO },
      control: { translation: vec3(0, 0, throttle), rotation: Vec.ZERO },
    })
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
  async selfTest(): Promise<{ passed: number; total: number; results: readonly CapabilityResult[]; report: string }> {
    const results = await runCapabilityChecks({ world: this.world, pool: this.#host.pool() })
    const report = summarizeCapabilities(results)
    log.info('self test complete', { passed: results.filter((r) => r.passed).length, total: results.length })
    return { passed: results.filter((r) => r.passed).length, total: results.length, results, report }
  }

  /** Named, repeatable set-ups. Each returns the resulting status. */
  async scenario(name: string): Promise<ScenarioResult> {
    const before = this.world.clock.tick
    switch (name) {
      case 'orbit': {
        const target = this.#firstSolidBodyAddress()
        this.orbit(target, 300)
        this.step(64)
        return this.#scenarioResult(name, before, `circular orbit 300 km above ${target}`)
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
        throw new Error(`Unknown scenario "${name}". Try: orbit, approach, surface, interstellar`)
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

  #scenarioResult(name: string, beforeTick: number, detail: string): ScenarioResult {
    return { name, ticks: this.world.clock.tick - beforeTick, detail, status: this.status() }
  }

  #firstSolidBodyAddress(): string {
    const system = this.world.loadedSystems()[0] ?? this.world.loadSystem(systemId('SOL'))
    for (const body of walkBodies(system)) {
      if (body.kind === 'rocky' && body.radius > 1e6) return formatAddress(body.address)
    }
    throw new Error('no solid body available')
  }

  #requirePlayer(): EntityId {
    const player = this.#host.player()
    if (player === null) throw new Error('No player entity')
    return player
  }
}
