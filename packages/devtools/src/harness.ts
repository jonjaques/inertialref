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
  type FrameId,
  Quaternion as Q,
  type UniverseVector,
  UV,
  Vec,
  type Vec3,
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
  hasSolidSurface,
  installSurfaceFrame,
  isLandable,
  parseAddress,
  systemFrameId,
  systemId,
  type SystemId,
  surveySites,
  systemsWithin,
  walkBodies,
} from '@inertialref/universe'
import {
  captureSave,
  parseSave,
  restoreSave,
  serializeSave,
} from '@inertialref/persistence'
import {
  FLIGHT_FOV,
  type Lens,
  LENS_PRESETS,
  lensForFov,
  type LensReadout,
  lensReadout,
  type LensView,
  MIN_STANCE_HEIGHT,
  type RenderScene,
  verticalFovDegrees,
} from '@inertialref/rendering'
import type { PoolStats, WorkerPool } from '@inertialref/workers'
import type { AuthorityPort, AuthorityStatus } from '@inertialref/net'
import { describeDrift, type VersionDrift } from '@inertialref/protocol'
import {
  runCapabilityChecks,
  summarizeCapabilities,
  type CapabilityResult,
} from './capabilities.ts'
import { type Dossier, dossier } from './dossier.ts'
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
  searchTargets,
  type TravelTarget,
  type TravelTargetOptions,
  travelTargets,
  viewingAltitudeKm,
} from './travel.ts'
import { findPicture, type Picture, PICTURES } from './pictures.ts'
import { findShot, placeShot, SHOTS } from './shots.ts'
import {
  CutsceneDirector,
  type CutsceneOutcome,
  type CutsceneStatus,
} from './cutscene.ts'
import {
  Observatory,
  type ObserverPose,
  type ObserverStatus,
} from './observatory.ts'
import {
  type DescentOptions,
  type DescentReport,
  summarizeDescent,
  simulateDescent,
  type TerrainReport,
} from './descent.ts'
import {
  summarizeBaseline,
  type BaselineOptions,
  type TerrainBaseline,
  terrainBaseline,
} from './terrainBaseline.ts'
import {
  makeTimingVerb,
  type ProfileReport,
  summarizeProfile,
  type TimingPort,
  type TimingVerb,
} from './profile.ts'
import { terrainZoo, type ZooEntry } from './terrainZoo.ts'
import { TNG_INTRO } from './cutscenes/tngIntro.ts'
import type { CinematicSample } from '@inertialref/rendering'

/*
 * The scriptable harness.
 *
 * One object that can drive and interrogate the whole game without touching the
 * UI. The app exposes it on `window`, so a browser console — or an agent
 * driving the browser — can set up a scenario, step the simulation
 * deterministically, and read back structured state instead of squinting at
 * pixels. Everything it returns is JSON-serializable for exactly that reason.
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
  /**
   * Whoever owns the part of the simulation this client does not.
   *
   * Optional because a host may not have one yet, not because being alone is a
   * missing authority — a solo player has a `LocalAuthority`, which is an
   * implementation rather than the absence of one. `openSession` always
   * supplies it.
   */
  authority?(): AuthorityPort
  /**
   * The host's clock, for the things here that measure rather than simulate.
   *
   * Optional because a host may not have one and the terrain baseline degrades
   * to "not timed" rather than reaching for `performance.now()` itself — which
   * nothing below `apps/` is allowed to do. Both real hosts supply it.
   */
  now?(): number
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
  /**
   * The lens the picture is being taken with, and the pixels it lands on.
   *
   * A getter rather than a setter for the same reason `world` is: the engine
   * resolves the lens every frame under the pose's own precedence — a script's
   * lens, then the flight one — and a host that pushed a copy in here would
   * hold a second producer of it, which is the rule this phase exists to keep.
   * `ir.lens()` reads it to print the instrument; the terrain predicate reads it
   * to measure one. The observatory does not — it takes `framingLens()` below,
   * and the block there says why. Absent headlessly, where there is no camera
   * and no display.
   */
  lensView(): LensView | null
  /**
   * The lens the framing solver uses: the flight one, never the composed one.
   *
   * Separate from `lensView` because the observatory is the one consumer that
   * must not see the cutscene arm. It produces a camera only when that arm is
   * null, so framing a target against a script's lens is the observatory
   * depending on the arm it is defined as the fallback for — and the standoff it
   * solves is *stored*, so the error outlives the cutscene that caused it.
   * Measured: `focus('s:SOL/b:2')` during `tng-intro` parks the camera 29.8 Mm
   * out against the 20.8 Mm the flight lens asks for, 43% too far, permanently.
   */
  framingLens(): Lens
  /**
   * Fit a lens, for the two verbs that solve one.
   *
   * `preset` and `rise` compose a picture whose lens is part of it — Earth is
   * 1.9° across from Luna and Mars is 42.39° from Phobos, so a rise that did
   * not fit its own lens would produce two very different frames under one
   * name. Optional, because a headless host has no camera to fit it to and the
   * arithmetic is worth running there anyway.
   *
   * Not a second producer of the lens: `engine.lens` still resolves the
   * cutscene arm first and the flight lens second, and this writes the same
   * flight lens a panel's slider writes.
   */
  setFlightLens?(lens: Lens): void
  /**
   * How many display pixels one CSS pixel is, on this host.
   *
   * The drag sensitivity needs both and they are not the same number.
   * `lensView().viewport` is *display* pixels with supersampling divided out
   * and the device ratio deliberately kept — the terrain predicate and the
   * circle of confusion are claims about physical pixels. A pointer delta is in
   * CSS pixels. On a 2× display the two differ by two, and a sensitivity that
   * conflated them moved the picture at half the rate of the hand.
   *
   * 1 headlessly, and 1 is also the honest answer for a display that has no
   * ratio to report.
   */
  pixelRatio?(): number
  /**
   * Put the interface in or out of the frame.
   *
   * A plate is defined as the frame taken with the chrome cleared, and a plate
   * has to be reproducible from a script — so the state `Shift+H` reaches has
   * to be reachable from here too. Optional for the same reason: headlessly
   * there is no interface to clear.
   */
  setChrome?(visible: boolean): void
  /**
   * Put the sky's own layers — names and traces — in or out of the frame.
   *
   * Separate from `setChrome` because they are different claims: chrome is the
   * interface and these are content, so `Shift+H` clears the first and leaves
   * the second. A plate wants both gone, because a thumbnail of a picture is a
   * thumbnail of what the camera does and the layers are the viewer's.
   */
  setLayers?(visible: boolean): void
  /**
   * What the terrain streamer is doing this frame.
   *
   * The one number in the terrain rig that cannot be derived: `simulateDescent`
   * says what the streamer *would* be asked for, and this says what it actually
   * has — how many patches are on screen, how deep the worker queue is, and
   * whether the cache is holding. The two disagreeing is the interesting case
   * and there was no way to see it.
   */
  terrain(): TerrainReport | null
  /**
   * The performance timeline, when the host has one.
   *
   * Optional rather than stubbed, because a host without one has a real answer
   * — "this runtime does not put entries anywhere" — and `ir.profile()` says so
   * instead of returning an empty report that reads like a fast session.
   */
  timing?(): TimingPort
}

export type HarnessHost = SimulationHost & Partial<PresentationHost>

export interface HarnessStatus {
  readonly world: WorldInspection
  readonly player: EntityInspection | null
  readonly render: RenderInspection | null
  readonly workers: PoolStats | null
  readonly frame: FrameStats | null
  readonly authority: AuthorityStatus | null
  /**
   * The lens the frame was composed through, fully derived.
   *
   * On `status` rather than only on `ir.lens()` because it is what makes a
   * captured still reproducible: a plate is a body, a pose *and* an optical
   * setup, and the third has never been written down. `ir.shot` returns this
   * object, so a bookmark carries the lens it was taken with — which is the
   * record the photo-mode metadata seam eventually stamps.
   */
  readonly lens: LensReadout | null
}

export interface ScenarioResult {
  readonly name: string
  readonly ticks: number
  readonly detail: string
  readonly status: HarnessStatus
}

/** What a successful `load` gives back. */
export interface LoadOutcome {
  /** The restored world's state hash — the canonical round-trip comparison. */
  readonly stateHash: string
  /**
   * How the save's universe differs from this build's. Empty is the usual case
   * and the only one where the loaded world is exactly the saved one.
   */
  readonly drift: readonly VersionDrift[]
}

const log = getLogger('devtools.harness')

export class GameHarness {
  readonly #host: HarnessHost
  readonly #logSink = new RingBufferSink(256)
  readonly #cutscenes: CutsceneDirector
  readonly #observatory: Observatory
  /** The track overlay's switch. Session-local; see `trackOverlay`. */
  #trackOverlay = false

  constructor(host: HarnessHost) {
    this.#host = host
    this.#cutscenes = new CutsceneDirector(host, [TNG_INTRO])
    this.#observatory = new Observatory(host)
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
      authority: this.#host.authority?.().status() ?? null,
      lens: this.lens(),
    }
  }

  /**
   * The camera's optics, as an instrument: focal length, aperture, the derived
   * depth of field, the diffraction limit and the exposure.
   *
   * Null headlessly, where there is no display to resolve a circle of confusion
   * against — the honest answer rather than a plausible one taken at a nominal
   * resolution nobody is looking at.
   */
  lens(): LensReadout | null {
    const view = this.#host.lensView?.() ?? null
    return view === null ? null : lensReadout(view.lens, view.viewport)
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
      // Headless counterpart of the overlay's authority section, so `pnpm sim`
      // shows that the port was joined rather than merely constructed.
      status.authority === null
        ? ''
        : `auth ${status.authority.kind} ${status.authority.partition ?? 'none'}` +
          (status.authority.peers > 0
            ? ` +${status.authority.peers}`
            : ' alone'),
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
    return systemsWithin(
      this.world.galaxySeed,
      this.world.catalog,
      centre,
      lightYears * LIGHT_YEAR,
    )
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
    /*
     * `origin: 'observer'` falls back to the player rather than returning
     * nothing, and that is not defensiveness — the observatory holds no target
     * until the planetarium's first focus lands, which is several frames after
     * the panel's first poll. A listing that was empty for those frames would
     * flash a "nothing within 16 ly" empty state on every entry to the mode.
     */
    const from =
      (options.origin === 'observer' ? this.observatory.eye : null) ??
      this.#here()
    return travelTargets(this.world, from, options)
  }

  /**
   * Everywhere matching what somebody typed, nearest first — the *whole*
   * catalog, not the survey.
   *
   * Split from `targets` by question rather than by cost: that one asks "what
   * is near me", which is a star sweep and cannot run per keystroke; this asks
   * "what is called this", which is an index lookup and must. Filtering the
   * survey's result — which is what the two panels did — could only ever find
   * what was already within a few light years of the camera.
   */
  search(
    text: string,
    options: TravelTargetOptions = {},
  ): readonly TravelTarget[] {
    const from =
      (options.origin === 'observer' ? this.observatory.eye : null) ??
      this.#here()
    return searchTargets(this.world, from, text)
  }

  /**
   * Everything known about one star or one body, as a page of astronomy.
   *
   * The object panel's whole source. Split from `inspect` — which is an
   * *entity* readout, a pose and a velocity — because a body is not an entity
   * and the question "what is Europa" has no answer in the entity store.
   */
  dossier(address: string): Dossier | null {
    return dossier(this.#host, address)
  }

  /**
   * Generate a system and install its frames without going there.
   *
   * `bodies()` only sees systems that are loaded, so browsing what is in the
   * next system along used to require flying to it first. This is the seam that
   * makes looking cheaper than traveling.
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
   * Put the player in a circular orbit around a body — or, given a system
   * address, around its star.
   *
   * Named for what it does physically rather than "teleport": it sets a state
   * that is a valid solution of the two-body problem, so the ship stays there.
   */
  orbit(address: string, altitudeKm?: number): HarnessStatus {
    const parsed = parseAddress(address)
    // A star is somewhere you can orbit too: a system address names one, and
    // refusing it forced "orbit the star" through goToSystem's hold-off in the
    // dark. The star lives at its system frame's origin, so this is the same
    // maneuver with the system frame standing in for a body frame.
    if (parsed.kind === 'system')
      return this.#orbitStar(parsed.system, altitudeKm)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    const system = this.world.loadSystem(parsed.system)
    const body = findBody(system, parsed.body)
    if (body === undefined) throw new Error(`No body at ${address}`)

    const radius = body.radius + (altitudeKm ?? 400) * 1000
    const speed = circularSpeed(body.mu, radius)
    const player = this.#requirePlayer()
    const frame = bodyFrameId(body.address)

    // Placed on the sunward side, and pointing along the orbit. A debug tool
    // that drops you on the night side of an unlit world, facing away from
    // everything, is technically correct and useless.
    const toStar = this.#toStar(parsed.system, frame)
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

  /**
   * Unit vector from a frame's origin toward the system's star, in that
   * frame's axes.
   *
   * The *star*, not the frame's parent. For a planet the two agree — its
   * parent is the system frame, whose origin is the star — and that
   * coincidence is exactly how the parent version shipped: every shot of a
   * moon was composed against the direction of its **planet**, so `full-face`
   * on Luna framed the earthlit side at whatever phase Earth happened to be
   * in, and `sunset` chased Earth's azimuth instead of the sun's.
   */
  #toStar(system: SystemId, frame: FrameId): Vec3 {
    const time = this.world.clock.time
    const pose = this.world.frames.pose(frame, time)
    const star = this.world.frames.pose(systemFrameId(system), time).position
    const offset = UV.difference(star, pose.position)
    // The star's own frame asking for the star: no direction exists. The +X
    // convention matches goToSystem's placement axis.
    if (Vec.length(offset) < 1) return vec3(1, 0, 0)
    return Vec.normalize(Q.rotateInverse(pose.orientation, offset))
  }

  /**
   * Spin the ship at its own orbital rate, so a framed composition *holds*.
   *
   * A teleport leaves the angular velocity at zero, which is a ship whose nose
   * points at a fixed direction in inertial space — so as the orbit proceeds,
   * the body it was framing slides out of the picture. What a locked-on camera
   * does is rotate once per revolution about the orbit normal, and that rate is
   * `ω = r × v / |r|²` exactly — set it and the nose stays on the body while
   * the terrain turns underneath, which is the whole point of watching a
   * bookmark with time running.
   *
   * Flight assist is switched off with it, deliberately: assist reads any
   * uncommanded spin as tumble and damps it back to zero within seconds,
   * un-tracking the shot. `ir.flightAssist(true)` or the keybinding restores
   * it the moment you want to fly rather than film.
   */
  #trackOrbit(): void {
    const player = this.#requirePlayer()
    const state = this.world.entities.require(player).state
    const r2 = Vec.lengthSquared(state.position)
    if (r2 < 1) return
    const omegaFrame = Vec.scale(
      Vec.cross(state.position, state.velocity),
      1 / r2,
    )
    this.world.setFlightAssist(player, false)
    this.world.teleport(player, {
      ...state,
      // The integrator composes angular velocity in *body* axes.
      angularVelocity: Q.rotateInverse(state.orientation, omegaFrame),
    })
  }

  /**
   * A circular orbit around the system's star itself.
   *
   * The star is not a `Body` — it has no address and no frame of its own; it
   * *is* the system frame's origin — so none of the body machinery applies.
   * The default altitude parks eight stellar radii out, where the disk
   * subtends ~14°: a sun hanging in the sky. The one-radius-up rule planets
   * use would put a wall of light across the whole view.
   */
  #orbitStar(system: SystemId, altitudeKm?: number): HarnessStatus {
    const target = this.world.loadSystem(systemId(system))
    const star = target.star
    const radius = star.radius + (altitudeKm ?? (star.radius * 7) / 1000) * 1000
    const speed = circularSpeed(star.mu, radius)
    const player = this.#requirePlayer()

    // On +X of the system frame — the same axis goToSystem uses — orbiting in
    // the system's reference plane, prograde like everything else in it.
    const alongOrbit = Vec.cross(vec3(0, 1, 0), vec3(1, 0, 0))
    this.world.teleport(player, {
      frame: systemFrameId(target.id),
      position: vec3(radius, 0, 0),
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), alongOrbit),
      velocity: Vec.scale(alongOrbit, speed),
      angularVelocity: Vec.ZERO,
    })
    this.world.setControl(player, Vec.ZERO, Vec.ZERO)
    log.info('placed in orbit of the star', { system: target.id, speed })
    return this.status()
  }

  /**
   * Frame a named, repeatable composition of a body — a camera bookmark.
   *
   * `orbit` places you for flying; this places you for looking, at the
   * distances and phase angles the reference photographs were taken from. The
   * ship is left in a circular orbit through the bookmark position so the
   * composition holds instead of falling, and the nose — which is the camera —
   * is aimed by the shot itself: the body's center, the sunward horizon, or
   * the star's reflection off the surface.
   *
   * With no address it re-frames the body whose frame the player is already
   * in, so `ir.shot('crescent')` after any arrival does what it sounds like.
   */
  shot(name = 'full-face', address?: string): HarnessStatus {
    const shot = findShot(name)
    // Lenient like `goTo`, because this is typed at a console: `b:2` relative
    // to the current system is the way anyone actually names a body.
    const target = resolveDestination(
      address ?? this.#currentBodyAddress(),
      this.world.galaxy,
      currentSystemOf(this.world, this.#host.player()),
    )
    if (target.kind !== 'body')
      throw new Error(`${address ?? ''} names a system; shots frame a body`)
    const system = this.world.loadSystem(target.system)
    const body = findBody(
      system,
      target.address.kind === 'body' ? target.address.body : [],
    )
    if (body === undefined) throw new Error(`No body at ${target.text}`)

    const player = this.#requirePlayer()
    const frame = bodyFrameId(body.address)

    // The sun direction in the body's frame, exactly as `orbit` derives it.
    const toStar = this.#toStar(target.system, frame)

    // Clamped inside the sphere of influence for the same reason
    // `viewingAltitudeKm` is: a "parking orbit" outside the SOI is reframed to
    // the parent and becomes a departure.
    const placement = placeShot(
      shot,
      body.radius,
      toStar,
      body.sphereOfInfluence * 0.85,
      /*
       * The lens the camera is actually wearing, not the flight default.
       *
       * Nine of the sixteen name their standoff as a *fill* of the frame, which
       * is a claim about an angle — so solved against 65° while the slider sits
       * at 20°, `close` parks the hull where the disk subtends 61° in a 20°
       * field and the frame is all ground. `Observatory.compose` passes its own
       * lens for exactly this reason; a bookmark that framed against a lens
       * nobody is looking through is the defect `ir.preset` was fixed for.
       */
      verticalFovDegrees(this.#host.framingLens?.() ?? LENS_PRESETS.flight),
    )
    const distance = Vec.length(placement.position)
    this.world.teleport(player, {
      frame,
      position: placement.position,
      orientation: placement.orientation,
      velocity: Vec.scale(placement.along, circularSpeed(body.mu, distance)),
      angularVelocity: Vec.ZERO,
    })
    this.world.setControl(player, Vec.ZERO, Vec.ZERO)
    this.#trackOrbit()
    log.info('framed shot', { shot: name, address: target.text, distance })
    return this.status()
  }

  /** The compositions `shot` can frame. */
  shots(): readonly { name: string; description: string }[] {
    return SHOTS.map(({ id, why }) => ({ name: id, description: why }))
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
   * in a circular orbit framing that body; a system designation arrives in a
   * close orbit of the star itself, looking at it — you asked for the star,
   * and the star is what fills the view.
   *
   * Passing `distanceAu` asks for the other thing — a hold-off in the system
   * frame, out in the dark, which is where `goToSystem` alone leaves you. That
   * is a real place to want to be and a terrible place to arrive by default: at
   * 40 AU a red dwarf is a sub-pixel point, so "travel to Proxima" appeared to
   * do nothing at all.
   *
   * `orbit`, `land`, `goToSystem` and `face` are still the primitives and still
   * take exactly one kind of argument each — this dispatches to them rather
   * than reimplementing them, so there is one placement rule per maneuver.
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

    // A system designation arrives at the star itself, in a close orbit with
    // the nose on it. It used to arrive at the first planet, which answered a
    // question nobody asked: travel to *Proxima* should end with Proxima
    // filling the view, and its planets are one `ir.targets()` away.
    if (options.distanceAu === undefined) {
      this.#orbitStar(target.system, options.altitudeKm)
      this.#lookAt(
        this.world.frames.pose(
          systemFrameId(target.system),
          this.world.clock.time,
        ).position,
      )
      this.#trackOrbit()
      return this.status()
    }

    this.goToSystem(target.system, options.distanceAu)
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
    this.face(address)
    // Arrivals are for looking too: hold the body in frame around the orbit
    // rather than letting it drift out over the next few minutes of warp.
    this.#trackOrbit()
    return this.status()
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

  /**
   * Restore a save into this session.
   *
   * Restored against *this* world's catalog, not the one the save names: a
   * save is a set of references, and resolving them needs the catalog the
   * client actually has. What the save was written against comes back as
   * `drift`, which used to be computed only while building the message for a
   * load that had already failed — so the interesting case, a load that
   * succeeded into a sky that had moved, was silent.
   */
  load(text: string): Result<LoadOutcome, string> {
    const parsed = parseSave(text)
    if (!parsed.ok) return parsed
    const restored = restoreSave(parsed.value, this.world.catalog)
    if (!restored.ok) return restored
    this.#host.replaceWorld(restored.value.world, restored.value.playerEntity)
    if (restored.value.drift.length > 0) {
      log.warn('loaded a save from a different universe', {
        drift: describeDrift(restored.value.drift),
      })
    }
    return {
      ok: true,
      value: {
        stateHash: restored.value.world.stateHash(),
        drift: restored.value.drift,
      },
    }
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
      case 'descent': {
        /*
         * The terrain rig's own scenario: orbit to two meters over every zoo
         * body, on paper.
         *
         * The only scenario that moves no ship and runs no physics, because
         * that is what it is proving — the descent is a camera and a selection
         * rule, so it produces the same numbers here, in a browser console and
         * in a Node test.
         *
         * The camera is left on the last body's *summit*, which is the place
         * this milestone's first phase made visitable. Phase 0 had to leave it
         * in a basin: the zoo's declaration order puts `icy-active` last, which
         * on this seed is Miranda, and Miranda's summit stands 4,826 m over a
         * fade line at 2,605 m — so "something on screen when it returns" was a
         * bare datum sphere. There is no fade, and the summit is ground.
         */
        const zoo = this.zoo()
        if (zoo.length === 0) throw new Error('the terrain zoo came back empty')
        const reports = zoo.map((entry) => this.descend(entry.address))
        const last = zoo[zoo.length - 1]
        if (last !== undefined) {
          this.visit(last.address, {
            site: 'summit',
            height: MIN_STANCE_HEIGHT,
          })
        }
        return this.#scenarioResult(
          name,
          before,
          reports.map((report) => report.text).join('\n'),
        )
      }
      default:
        throw new Error(
          `Unknown scenario "${name}". Try: ${this.scenarios().join(', ')}`,
        )
    }
  }

  scenarios(): readonly string[] {
    return ['orbit', 'approach', 'surface', 'interstellar', 'descent']
  }

  /* --------------------------------------------------------------------- */
  /* Cutscenes                                                              */
  /* --------------------------------------------------------------------- */

  /**
   * Play a scripted scene. Presentation only: the camera and the hero hull
   * follow the script while the world keeps ticking, and stopping — or the
   * script ending — restores the player's captured state, clock settings
   * included. The game boots exactly as it always did; this runs only when
   * asked to, from the dock's cutscene section or here.
   */
  play(id = 'tng-intro'): CutsceneStatus {
    return this.#cutscenes.play(id)
  }

  /** Stop the running cutscene and restore the player. Safe when idle. */
  stopCutscene(): void {
    this.#cutscenes.stop()
  }

  /**
   * Jump the playhead to a reference frame. Pause first for a frame-exact
   * still — that pairing is the verification pipeline's capture loop.
   */
  seekCutscene(frame: number): CutsceneStatus {
    return this.#cutscenes.seek(frame)
  }

  /** The scripted scenes `play` accepts, described. */
  cutscenes(): readonly { id: string; description: string; seconds: number }[] {
    return this.#cutscenes.list()
  }

  /** The running cutscene's playhead, or null when idle. */
  cutsceneStatus(): CutsceneStatus | null {
    return this.#cutscenes.status()
  }

  /**
   * How the last cutscene left — ran out, was stopped, or lost its world.
   *
   * `cutsceneStatus()` goes null for all three, so this is what distinguishes
   * an end card from a closed transport.
   */
  cutsceneOutcome(): CutsceneOutcome | null {
    return this.#cutscenes.lastOutcome()
  }

  /**
   * The frame's cinematic state, for the rendering host. Called once per
   * rendered frame with the snapshot's `renderTime`; null when idle.
   */
  cutsceneSample(renderTime: number): CinematicSample | null {
    return this.#cutscenes.sample(renderTime)
  }

  /**
   * The cinematic state at a reference frame, without moving the playhead.
   *
   * For anything that needs a *neighboring* frame rather than the one on
   * screen — the track overlay finite-differences the hull's camera-relative
   * offset either side of it to get a velocity. `cutsceneSample` cannot serve
   * that: it is the host's per-frame ask and re-bases the playhead on every
   * call. `CutsceneDirector.peek` carries the rest of the reasoning.
   */
  cutscenePeek(frame: number): CinematicSample | null {
    return this.#cutscenes.peek(frame)
  }

  /**
   * Draw the reference edit's tracked subject over the scene as it plays.
   *
   * A debug surface for the seek-and-compare loop: the reference's box for the
   * frame on screen, the render's own hull projected and boxed beside it, and
   * the hull's nose and velocity as two short vectors — so "the descent is
   * late" is a picture rather than two columns of a CSV.
   *
   * A flag rather than a drawing, because this layer has no DOM and no React:
   * `apps/game/src/hud/TrackOverlay.tsx` reads it once a frame while a scene is
   * playing and draws nothing at all when it is false, which is the same
   * arrangement every other presentation switch here uses.
   *
   * **Deliberately not persisted and not in the URL.** A capture run navigates
   * a fresh page and never turns this on, so it cannot end up in a render of
   * the sequence — which is the one thing a surface drawn over the picture must
   * never do. A remembered flag would put it in the next capture instead.
   */
  trackOverlay(on = true): boolean {
    this.#trackOverlay = on === true
    log.info('track overlay', { showing: this.#trackOverlay })
    return this.#trackOverlay
  }

  /** Whether `trackOverlay` is on. Read once a rendered frame by the host. */
  get trackOverlayShowing(): boolean {
    return this.#trackOverlay
  }

  /* --------------------------------------------------------------------- */
  /* The planetarium                                                        */
  /* --------------------------------------------------------------------- */

  /**
   * The free camera the planetarium is built on.
   *
   * Exposed as the object rather than wrapped verb by verb: a pointer drag is
   * forty calls a second and going through the harness for each would be a
   * layer that exists only to be crossed. The convenience verbs below are the
   * ones worth typing at a console.
   */
  get observatory(): Observatory {
    return this.#observatory
  }

  /**
   * Look at something without going there.
   *
   * The planetarium's whole verb, and the difference from `goTo` is the point:
   * `goTo` teleports the *ship*, changing canonical state; this moves only a
   * camera. `ir.look('s:SOL/b:5')` and `ir.goTo('s:SOL/b:5')` end with Jupiter
   * filling the frame, and only one of them leaves you in orbit of it.
   */
  look(
    destination: string,
    options?: { fill?: number; ease?: boolean },
  ): ObserverStatus {
    return this.#observatory.focus(destination, options ?? {})
  }

  /**
   * Turn the head, in degrees, without moving the camera.
   *
   * The free-look offset as a harness verb, so every act a planetarium button
   * offers is reachable from a script — which is what makes a plate a command
   * rather than a gesture. In orbit the pair is an offset from the pose, so
   * `ir.aim(0, 0)` is the way back to whatever the pose is looking at.
   *
   * Standing it is not an offset at all: the stance *is* the heading and the
   * pitch, so these are absolute — a compass bearing and an angle above the
   * horizon, which is what `ir.visit` already takes. `ir.aim(0, 0)` on the
   * ground therefore faces due north and level, which is a place rather than a
   * recentring. The way back to the composed aim on either arm is
   * `observatory.centre()` — the panel's Recentre button — which levels to the
   * horizon without touching the bearing.
   */
  aim(yaw = 0, pitch = 0): ObserverStatus {
    this.#observatory.setLook((yaw * Math.PI) / 180, (pitch * Math.PI) / 180)
    return this.#observatory.status()
  }

  /**
   * Take a named composition of whatever the camera is on.
   *
   * The observatory's placer for the same sixteen `ir.shot` frames with a hull.
   * `ir.shot('gibbous')` teleports the ship into the picture; this moves the
   * camera into it, changing no canonical state — and three of the sixteen were
   * reachable only the first way until the aim became an offset.
   */
  compose(id = 'portrait'): ObserverStatus {
    return this.#observatory.compose(id)
  }

  /**
   * Stand on a moon with its parent over the horizon. Earthrise.
   *
   * The one composition that names two bodies, so it is the one that cannot be
   * a `compose` id. The lens it solves comes back rather than being applied: the
   * observatory has no lens of its own by design, so fitting it is the shell's
   * — `ir.rise()` from a console reports the angle and leaves the camera panel
   * alone, which is the honest split rather than a verb that quietly moves a
   * control somebody else owns.
   */
  rise(options: { clearance?: number; height?: number } = {}): {
    status: ObserverStatus
    fovDeg: number
  } {
    return this.#observatory.rise({
      ...(options.clearance === undefined
        ? {}
        : { clearance: (options.clearance * Math.PI) / 180 }),
      ...(options.height === undefined ? {} : { height: options.height }),
    })
  }

  /**
   * Take a named picture — the same frame, every time.
   *
   * A composition plus the two things a composition leaves out: an address and
   * a lens. That is what makes it a fixture rather than a framing, and a
   * fixture is what a before/after plate is — the geology phase is judged from
   * these, so they exist before the geology does.
   *
   * The lens **is** fitted, through the host's own owner of it — a picture that
   * named a lens and did not wear it would be a fixture that produced a
   * different frame on a machine with a different slider position. It comes
   * back as well, because a caller composing a plate has to be able to say what
   * the picture was taken at.
   *
   * Headlessly the port is absent and the fit is a silent no-op: the arithmetic
   * is worth running there and there is no display for a field of view to be
   * about.
   */
  preset(id: string): {
    status: ObserverStatus
    fovDeg: number
    picture: Picture
  } {
    const picture = findPicture(id)
    this.#observatory.focus(picture.address, { ease: false })
    if (picture.framing.kind === 'rise') {
      /*
       * The rise solves its own lens from the geometry, so the stance comes
       * first and the lens is fitted after. The other order would frame the
       * horizon against an angle solved for a different picture.
       */
      const risen = this.#observatory.rise()
      this.#fitLens(risen.fovDeg)
      return { status: risen.status, fovDeg: risen.fovDeg, picture }
    }
    const fovDeg = picture.fovDeg ?? FLIGHT_FOV
    // The other order, and for the reverse reason: a `fill` standoff is solved
    // against the lens, so the lens has to be fitted before the composition is
    // placed or the camera stands off at the angle it had a moment ago.
    this.#fitLens(fovDeg)
    return {
      status: this.#observatory.compose(picture.framing.composition),
      fovDeg,
      picture,
    }
  }

  /**
   * Fit an angle, where the host has a camera to fit it to.
   *
   * Silent headlessly rather than a refusal: `pnpm sim` runs every one of these
   * for the arithmetic, and there is no display for a field of view to be about.
   */
  #fitLens(fovDeg: number): void {
    /*
     * The focal length alone, laid over the lens already on the camera.
     *
     * A `Picture` names a field of view and nothing else, but `lensForFov`
     * returns a whole instrument — zoom 1, f/2.8, focus at infinity, 1/60 s,
     * ISO 100 — and `requestLens` now routes that into the persisted
     * `camera.lens`. Assigning it wholesale therefore discards an aperture and
     * a focus distance somebody set for a depth-of-field shot, permanently and
     * across a reload, as a side effect of pressing a framing button. `zoom` is
     * the one channel that does have to go back to 1: the picture's angle is a
     * claim about what the frame contains, and a zoom left on top of it would
     * make the frame something else.
     */
    const current = this.#host.framingLens?.()
    const fitted = lensForFov(fovDeg, current?.gauge)
    this.#host.setFlightLens?.(
      current === undefined
        ? fitted
        : { ...current, focalLength: fitted.focalLength, zoom: 1 },
    )
  }

  /**
   * Put the interface in or out of the frame.
   *
   * The harness half of `Shift+H`, and the reason it is a verb at all: a plate
   * is defined as the frame taken with the chrome cleared, and
   * `pnpm presets:plates` is a script. A gesture no script can make is a
   * fixture nobody can regenerate.
   */
  chrome(visible: boolean): boolean {
    this.#host.setChrome?.(visible)
    return visible
  }

  /**
   * Names and traces in or out of the frame.
   *
   * Not part of `chrome`, because they are content rather than interface — the
   * viewer turned them on and `Shift+H` leaves them alone. A plate is the one
   * capture that wants them gone: the thumbnail is of what the preset does, and
   * a trace slashing across it promises a layer the press does not set.
   */
  layers(visible: boolean): boolean {
    this.#host.setLayers?.(visible)
    return visible
  }

  /** The pictures `preset` can take. */
  presets(): readonly { id: string; label: string; why: string }[] {
    return PICTURES.map(({ id, label, why }) => ({ id, label, why }))
  }

  /* --------------------------------------------------------------------- */
  /* Terrain                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * The named places on a body — what `visit` and `descend` take.
   *
   * Derived from the body's own field rather than authored, so a site survives
   * regeneration by construction: "the highest ground on this world" is still
   * the interesting place after the generator changes, and a latitude written
   * down last month is not. See `surveySites`.
   *
   * Empty on a giant, the same answer `Observatory.sites` gives. `surveySites`
   * derives from `body.surface`, which every body carries — Jupiter included —
   * so without the filter here the Surface panel draws six clickable cards for
   * ground that `visit` refuses, and each of them throws out of an onClick.
   */
  sites(address?: string): readonly {
    id: string
    name: string
    detail: string
    latitude: number
    longitude: number
    elevation: number
    region: string
  }[] {
    const body = this.#requireBody(address)
    // The observatory's own gate: a giant's SurfaceParameters run through the
    // survey without complaint, but every row would be a place `visit` refuses
    // to stand — six clickable throws in the Surface panel. An empty list is
    // the answer the panel draws an honest empty state for.
    if (!hasSolidSurface(body)) return []
    return surveySites(body).map((site) => ({
      id: site.id,
      name: site.name,
      detail: site.detail,
      latitude: (site.latitude * 180) / Math.PI,
      longitude: (site.longitude * 180) / Math.PI,
      elevation: site.elevation,
      region: `${site.region.face}.${site.region.level}.${site.region.i}.${site.region.j}`,
    }))
  }

  /**
   * Stand on a body and look at it. No ship, no physics, no canonical write.
   *
   * The planetarium's other camera arm — see `Observatory.stand`. `ir.land`
   * teleports the *ship* onto a pad and is a canonical change; this moves a
   * camera to a place a ship may never go, at a height a slider can scrub from
   * half a radius down to two meters.
   *
   * The height is set outright rather than eased, which is what makes a plate
   * loop work: `for (const h of heights) { ir.visit(a, {site, height: h}); await
   * ir.shot(...) }` captures a descent one frame per rung, with nothing
   * settling in between.
   */
  visit(
    address?: string,
    options: {
      site?: string
      latitude?: number
      longitude?: number
      height?: number
      heading?: number
      pitch?: number
    } = {},
  ): ObserverStatus {
    const target = address ?? this.observatory.target?.address
    if (target === undefined)
      throw new Error('Nothing to visit — pass an address')
    // Degrees at this boundary, radians below it. Every other harness verb that
    // takes a latitude does the same, and `ir.land` is the one that does not —
    // it takes radians, which is a wart this does not copy.
    return this.observatory.stand(target, {
      ...(options.site === undefined ? {} : { site: options.site }),
      ...(options.latitude === undefined
        ? {}
        : { latitude: (options.latitude * Math.PI) / 180 }),
      ...(options.longitude === undefined
        ? {}
        : { longitude: (options.longitude * Math.PI) / 180 }),
      ...(options.height === undefined ? {} : { height: options.height }),
      ...(options.heading === undefined
        ? {}
        : { heading: (options.heading * Math.PI) / 180 }),
      ...(options.pitch === undefined
        ? {}
        : { pitch: (options.pitch * Math.PI) / 180 }),
    })
  }

  /** Back to orbit, at the framing the camera had before the descent. */
  ascend(): ObserverStatus {
    return this.observatory.leaveSurface()
  }

  /**
   * Fly a descent on paper and report what the streamer would be asked for.
   *
   * The unit of terrain measurement. Pure arithmetic — no world state changes,
   * no worker runs, no frame is drawn — so it produces the same numbers in a
   * browser console, in `pnpm sim` and in a Node test. What it answers is the
   * gap-table line "no terrain perf baseline": the level churn, the peak burst
   * and the cache behavior of a descent from orbit to two meters.
   */
  descend(
    address?: string,
    options: Omit<DescentOptions, 'latitude' | 'longitude'> & {
      /**
       * Degrees, like every other verb on this object.
       *
       * `DescentOptions` below the harness is radians, and `Radians` is a bare
       * `number` — so a latitude copied out of `ir.sites()`, which prints
       * degrees, was read as radians and described ground 2,578° away with
       * nothing to catch it. `visit` converts at exactly this boundary and this
       * is the same boundary.
       */
      readonly latitude?: number
      readonly longitude?: number
    } = {},
  ): DescentReport & { readonly text: string } {
    // Degrees here, radians below — the same boundary `visit` states. Passing
    // the numbers straight through let `ir.sites()` output (degrees) land in
    // `geodeticDirection` as radians: a report about ground wrapped ~2,578°
    // from the place the caller named, with no error anywhere.
    const { latitude, longitude, ...rest } = options
    const body = this.#requireBody(address)
    // The refusal `visit` makes, made here too: a probe that reports a descent
    // onto a giant describes ground the camera declines to stand on, and the
    // report reads as a measurement rather than a place that does not exist.
    if (!hasSolidSurface(body)) {
      throw new Error(`${body.name} has no surface to descend to`)
    }
    /*
     * The lens the host is actually looking through, unless the caller names
     * one.
     *
     * `simulateDescent` otherwise answers for the flight lens over 1920×1080
     * while `ir.terrain()` beside it reports a live selection made at whatever
     * the camera panel is set to — up to three levels and 1.9× to 3.2× the
     * patches apart, with nothing in either report saying they are answers to
     * different questions. The pair is what the seam exists for: one says what
     * *would* be asked for, the other what is held, and the two disagreeing is
     * the interesting case only when they are asked at the same lens.
     */
    const live = this.#host.lensView?.() ?? null
    const optics =
      live === null
        ? {}
        : {
            lens: rest.lens ?? live.lens,
            viewport: rest.viewport ?? live.viewport,
          }
    const report = simulateDescent(body, {
      ...rest,
      ...optics,
      ...(latitude === undefined
        ? {}
        : { latitude: (latitude * Math.PI) / 180 }),
      ...(longitude === undefined
        ? {}
        : { longitude: (longitude * Math.PI) / 180 }),
    })
    const text = summarizeDescent(report)
    log.info('descent simulated', {
      body: report.body,
      site: report.site,
      levels: report.levels.join('→'),
      peakDrawn: report.peakDrawn,
      peakBurst: report.peakBurst,
    })
    return { ...report, text }
  }

  /**
   * What the live streamer has this frame, or null in a host that draws nothing.
   *
   * The counterpart to `descend`: that one says what should be asked for, this
   * says what is actually held. Headlessly it is always null, and that is the
   * honest answer rather than a zero.
   */
  terrain(): TerrainReport | null {
    return this.#host.terrain?.() ?? null
  }

  /**
   * One body per surface archetype, found rather than written down.
   *
   * The fixture every visual phase is judged through. It loads systems while it
   * searches — the same caveat capability check 3 carries — and stops as soon
   * as all four archetypes are filled.
   */
  zoo(): readonly ZooEntry[] {
    return terrainZoo(this.world)
  }

  /**
   * The Phase 0 baseline: the zoo, a descent over each member, and the measured
   * cost of generating the patches those descents ask for.
   *
   * The CPU half only. Frame cost, draw calls and the worker queue's real depth
   * need a browser, and the summary says so rather than inventing them.
   */
  terrainBaseline(
    options: BaselineOptions = {},
  ): TerrainBaseline & { readonly text: string } {
    const now = this.#host.now?.bind(this.#host) ?? null
    const baseline = terrainBaseline(this.world, now, options)
    return { ...baseline, text: summarizeBaseline(baseline) }
  }

  /**
   * The performance timeline: the level, the tracks, a marker, and the entries.
   *
   * A callable object, so the verb everybody wants — `ir.timing('trace')` — is
   * the short one and the rest hang off it. That is the shape `ir.terrain()`
   * and `ir.terrainBaseline()` already argue for: the console is discoverable
   * by tab-completion, and a verb that reads like a sentence is the one an
   * agent writes into a `--js` without checking.
   *
   * Built once and cached, because a fresh closure per read would make
   * `ir.timing.drain !== ir.timing.drain` and break any script that held onto
   * one.
   */
  get timing(): TimingVerb {
    this.#timingVerb ??= makeTimingVerb(() => this.#host.timing?.())
    return this.#timingVerb
  }

  #timingVerb: TimingVerb | null = null

  /**
   * Arm, record, disarm, report.
   *
   * The verb that matters, and the reason phase 5 exists: one `--js` call gives
   * a terminal a *sentence* about why the last two seconds were slow, rather
   * than a screenshot and a p95. It returns structured data and a `.text`
   * block, the shape `terrainBaseline` already established.
   *
   * The level is restored afterwards rather than left at `full`, so a profile
   * taken mid-session does not silently leave the retained timeline growing for
   * the rest of it. The drain before the wait discards whatever was already
   * held — a profile is a window, and boot's entries are not in it.
   */
  async profile(ms = 2000): Promise<ProfileReport> {
    const port = this.#host.timing?.()
    if (port === undefined) {
      return {
        ...summarizeProfile([]),
        verdict: 'this host has no performance timeline',
        text: 'this host has no performance timeline — nothing was recorded',
      }
    }
    const was = port.level()
    port.setLevel('full')
    port.drain()
    try {
      await port.wait(ms)
      return summarizeProfile(port.drain(), {
        droppedFrameMs: port.droppedFrameMs,
      })
    } finally {
      // In a `finally`, because a profile that threw and left the level at
      // `full` would keep retaining entries for the rest of the session — the
      // one failure mode a performance tool must not have.
      port.setLevel(was)
    }
  }

  /** The observatory's camera, or null when it has no target. */
  observerStatus(): ObserverStatus | null {
    return this.#observatory.target === null ? null : this.#observatory.status()
  }

  /**
   * The observatory's pose for this frame, for the rendering host.
   *
   * `dt` is wall-clock seconds, not simulation time — the fly-to easing is a
   * presentation filter and has to keep running while the clock is paused.
   */
  observerSample(dt: number): ObserverPose | null {
    return this.#observatory.sample(dt)
  }

  /** Text help, so the console is discoverable without reading this file. */
  help(): string {
    return [
      'InertialRef harness',
      '  ir.summary()                  one-line state',
      '  ir.status()                   full structured state',
      '  ir.inspect(id?)               one entity, in detail',
      '  ir.dossier(address)           one star or body, as a page of astronomy',
      '  ir.step(ticks) / ir.runSeconds(s)',
      '  ir.pause() / ir.resume() / ir.timeWarp(x)',
      '  ir.control({translation,rotation}) / ir.hold()',
      '  ir.targets()                  everywhere you can go, nearest first',
      '  ir.search(text)               the whole catalog, by name, nearest first',
      '  ir.goTo(target)               a system id or a body address; does the right thing',
      '  ir.loadSystem(id)             generate a system without traveling to it',
      '  ir.bodies() / ir.systemsNearby(ly)',
      '  ir.orbit(address, altitudeKm) / ir.land(address, lat, lon)',
      '  ir.shot(name, address?)       frame a camera bookmark: ' +
        SHOTS.map((s) => s.id).join(', '),
      '  ir.shots()                    the bookmarks, described',
      '  ir.face(address)              point the nose at something',
      '  ir.goToSystem(id, au) / ir.burnToward(address, throttle)',
      '  ir.save() / ir.load(text)',
      '  await ir.selfTest()           the twelve milestone capabilities',
      '  await ir.scenario(name)       ' + this.scenarios().join(', '),
      '  ir.play(id?)                  run a scripted scene: ' +
        this.cutscenes()
          .map((c) => c.id)
          .join(', '),
      '  ir.stopCutscene() / ir.seekCutscene(frame) / ir.cutsceneStatus()',
      '  ir.trackOverlay(on?)          the reference track over a playing scene',
      '  ir.look(target)               planetarium: move the camera, not the ship',
      '  ir.aim(yawDeg, pitchDeg)      turn the head without moving the camera',
      '  ir.compose(id)                a named composition, camera only',
      '  ir.rise()                     stand with the parent over the horizon',
      '  ir.preset(id)                 a named picture: address, framing, lens',
      '  ir.chrome(false)              clear the interface — the plate state',
      '  ir.layers(false)              names and traces off, for a plate',
      '  ir.observatory                the free camera itself — drag, zoom, setPhase',
      '  ir.sites(address?)            the named places on a body, derived from its own terrain',
      '  ir.visit(address?, {site, height, heading, pitch})',
      '                                stand on it — a camera, not the ship; degrees and meters',
      '  ir.ascend()                   back to orbit, at the framing you left',
      '  ir.descend(address?, {site, steps})',
      '                                fly a descent on paper: level churn, burst, cache',
      '  ir.terrain()                  the live streamer, and the rocks on it',
      '  ir.lens()                     the camera as an instrument: mm, f-stop, depth of field',
      '  ir.zoo()                      one body per surface archetype',
      '  ir.terrainBaseline()          the zoo, its descents, and measured patch cost',
      '  ir.timing(level?)             off | trace | full — what reaches the timeline',
      '  ir.timing.tracks() / .mark(name) / .drain()',
      '  await ir.profile(ms)          arm, record, disarm; .text is the answer',
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

  /**
   * The body whose frame the player is inside, as an address.
   *
   * The frame chain, not a stored field, for the same reason
   * `currentSystemOf` walks it: containment is what makes the player *at* a
   * body. A surface frame's parent is the body frame, so landing still counts.
   */
  #currentBodyAddress(): string {
    const player = this.#requirePlayer()
    const entity = this.world.entities.require(player)
    for (const frame of this.world.frames.chain(entity.state.frame)) {
      if (frame.startsWith('b:')) return frame.slice(2)
    }
    throw new Error(
      'The player is not at a body — pass an address, e.g. ir.shot("full-face", "b:2")',
    )
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

  /**
   * The body a terrain verb is about, from whatever the caller did not say.
   *
   * Three fallbacks in the order that makes a console usable: the address given,
   * then whatever the planetarium is looking at, then the body the ship is
   * inside. `ir.sites()` with no argument answers about the thing on screen,
   * which is the only reading anybody means.
   *
   * Through `resolveDestination`, the same resolver `look`, `goTo`, `orbit`,
   * `shot` and `visit` use, so `SOL`, `b:2` and `g:milky-way/s:SOL/b:2` mean
   * here what they mean there. `parseAddress` alone accepts only the
   * galaxy-qualified form, which made these two verbs the only ones in the
   * console with their own address vocabulary.
   *
   * The planetarium's target is skipped when it is a star, rather than throwing
   * on it: a system address is not a body, so the third fallback is what the
   * caller meant. Without that the ship's body was unreachable whenever the
   * camera happened to be holding a sun.
   */
  #requireBody(address?: string): Body {
    const looking = this.observatory.target
    const text =
      address ??
      (looking !== null && looking.kind !== 'star'
        ? looking.address
        : this.#currentBodyAddress())
    const resolved = resolveDestination(
      text,
      this.world.galaxy,
      currentSystemOf(this.world, this.#host.player()),
    )
    if (resolved.kind !== 'body' || resolved.address.kind !== 'body')
      throw new Error(`${text} is not a body address`)
    const system = this.world.loadSystem(resolved.system)
    const body = findBody(system, resolved.address.body)
    if (body === undefined) throw new Error(`No body at ${text}`)
    return body
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
