import { err, ok, type Result } from '@inertialref/shared'
import {
  canonicalPosition,
  Quaternion as Q,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { type Entity, surfacePlacementPose } from '@inertialref/simulation'
import {
  type Body,
  bodyFixedDirection,
  bodyFixedFrameId,
  directionToGeodetic,
  type EntityId,
  findBody,
  hasSolidSurface,
  MARS_PAD,
  parseAddress,
} from '@inertialref/universe'
import type { Host } from './harness.ts'

/*
 * On foot: stepping out of a landed ship, and back into it.
 *
 * The canonical half of walking, over the same `Host` the observatory is
 * built on, so `openSession`, `pnpm sim` and `ir` can put a walker on the
 * ground without a browser. A walker is a world entity and the player while
 * it walks; the ship it left stays where it landed, and the walker carries
 * that ship's id as its `vessel`, which the save keeps.
 *
 * **A ship verb aimed at a walker boards first.** `goTo`, `orbit`, `shot`,
 * `land`, `face`, `burnToward`, `control`, `throttle` — every harness verb
 * that moves or flies the player's ship steps the walker back into its vessel
 * and then acts on the ship, which is what the dock's travel buttons do and
 * what keeps `ir.goTo` working from the console while walking. A walker whose
 * vessel is gone has no ship to fly, and the verb throws saying so.
 *
 * Held input from the flight keys is not a verb: it is a key a walker pressed
 * while the character context did not own it, and boarding on it would take
 * a walker who meant to walk off the ground. The engine drops it on foot.
 *
 * Pointer lock, the look, the view and the camera's memory are the browser's,
 * and stay in the app's controller. So does the clock: stepping out runs time
 * at 1× because a walker under warp covers kilometers a frame, and that is
 * the game's rule about its own controls, not a fact about the world.
 */

/** Meters of clearance either side of an unknown hull. */
const DEFAULT_BEAM = 6

/**
 * Where the Mars pad fixture stands its walker: on the pad's +X axis, clear of
 * the 46 m Rocinante's beam, facing along the pad's length.
 */
const PAD_SIDE = 22

export interface StepOutSite {
  readonly body: Body
  readonly latitude: number
  readonly longitude: number
  readonly heading: number
}

export interface OnFootStatus {
  /** Whether the player is a walker. */
  readonly active: boolean
  /** Whether a walker is out or could step out now. */
  readonly available: boolean
  readonly walker: EntityId | null
  /** The player's ship: the one it flies, or on foot the one it steps into. */
  readonly ship: EntityId | null
  readonly canFly: boolean
  readonly flying: boolean
  readonly grounded: boolean
  readonly crouched: boolean
}

export class OnFoot {
  readonly #host: Host
  readonly #land: (address: string, latitude: number, longitude: number) => void

  /**
   * `land` parks the player's ship on a surface, as the harness's verb does:
   * the fixture lands before it steps out, and one placement rule per
   * maneuver means this module asks rather than writing a second one.
   */
  constructor(
    host: Host,
    land: (address: string, latitude: number, longitude: number) => void,
  ) {
    this.#host = host
    this.#land = land
  }

  /** The player, while the player is a walker. */
  walker(): Entity | null {
    const id = this.#host.player()
    const entity = id === null ? undefined : this.#host.world.entities.get(id)
    return entity?.character == null ? null : entity
  }

  get active(): boolean {
    return this.walker() !== null
  }

  /**
   * The player's ship, whichever way the player is standing.
   *
   * On foot it is the walker's vessel, so a picture of the walker beside its
   * ship and a picture of the ship flying agree about which hull that is.
   */
  ship(): EntityId | null {
    const walker = this.walker()
    if (walker !== null) {
      const vessel = walker.character?.vessel ?? null
      return vessel !== null && this.#host.world.entities.has(vessel)
        ? vessel
        : null
    }
    return this.#host.player()
  }

  /**
   * Where a walker would step out: beside the landed ship, on its body.
   *
   * Only a landed ship on solid ground. `beamMeters` is the drawn hull's,
   * which the world does not know; the walker stands three meters clear of
   * it, or four from the ship's center, whichever is farther.
   */
  site(beamMeters = DEFAULT_BEAM): StepOutSite | null {
    const world = this.#host.world
    const player = this.#host.player()
    if (player === null || !world.isLanded(player)) return null
    const entity = world.entities.require(player)
    if (entity.character !== null) return null
    const body = world.bodyAt(entity.state.frame)
    if (body === null || !hasSolidSurface(body)) return null
    const time = world.clock.time
    const spin = world.frames.pose(bodyFixedFrameId(body.address), time)
    const position = canonicalPosition(world.frames, entity.state, time)
    const up = Vec.normalize(UV.difference(position, spin.position))
    const east = Vec.normalize(
      Vec.cross(Q.rotate(spin.orientation, vec3(0, 1, 0)), up),
    )
    const offset = Vec.scale(east, Math.max(4, beamMeters / 2 + 3))
    const direction = bodyFixedDirection(spin, UV.translate(position, offset))
    return { body, ...directionToGeodetic(direction), heading: 0 }
  }

  available(beamMeters = DEFAULT_BEAM): boolean {
    return this.active || this.site(beamMeters) !== null
  }

  /** Step out beside the landed ship. On foot already, the walker answers. */
  stepOut(beamMeters = DEFAULT_BEAM): Result<Entity, string> {
    const walker = this.walker()
    if (walker !== null) return ok(walker)
    const site = this.site(beamMeters)
    const vessel = this.#host.player()
    if (site === null || vessel === null)
      return err('Land on solid ground to walk.')
    return ok(this.#spawn(site, vessel))
  }

  /**
   * Step back into the vessel, and fly it.
   *
   * In flight already, the ship answers. A walker whose vessel is gone stays
   * on foot: there is no hull to put it in.
   */
  board(): Result<EntityId, string> {
    const world = this.#host.world
    const walker = this.walker()
    if (walker === null) {
      const player = this.#host.player()
      return player === null ? err('No player entity') : ok(player)
    }
    const vessel = this.ship()
    if (vessel === null) return err('There is no ship to step back into.')
    this.#host.controlPlayer(vessel)
    world.removeCharacter(walker.id)
    this.#host.render.declareCut()
    return ok(vessel)
  }

  /**
   * A reproducible scale check: the ship parked on the Mars pad, and a walker
   * beside the 46 m Rocinante the cinema stages there.
   */
  atMarsPad(): Entity {
    const boarded = this.board()
    if (!boarded.ok) throw new Error(boarded.error)
    this.#land(MARS_PAD.bodyAddress, MARS_PAD.latitude, MARS_PAD.longitude)
    const world = this.#host.world
    world.runTicks(1)
    const vessel = this.#host.player()
    if (vessel === null) throw new Error('No player entity')
    const address = parseAddress(MARS_PAD.bodyAddress)
    if (address.kind !== 'body')
      throw new Error(`${MARS_PAD.bodyAddress} is not a body address`)
    const body = findBody(world.loadSystem(address.system), address.body)
    if (body === undefined) throw new Error(`No body at ${MARS_PAD.id}`)
    const spin = world.frames.pose(
      bodyFixedFrameId(body.address),
      world.clock.time,
    )
    const pad = surfacePlacementPose(MARS_PAD, body, spin)
    const side = UV.translate(
      pad.position,
      Q.rotate(pad.orientation, vec3(PAD_SIDE, 0, 0)),
    )
    const site = directionToGeodetic(bodyFixedDirection(spin, side))
    return this.#spawn(
      { body, ...site, heading: MARS_PAD.heading - Math.PI / 2 },
      vessel,
    )
  }

  status(): OnFootStatus {
    const character = this.walker()?.character ?? null
    return {
      active: character !== null,
      available: this.available(),
      walker: character === null ? null : this.#host.player(),
      ship: this.ship(),
      canFly: character?.canFly ?? this.#host.canFly,
      flying: character?.flying ?? false,
      grounded: character?.grounded ?? false,
      crouched: character?.crouched ?? false,
    }
  }

  #spawn(site: StepOutSite, vessel: EntityId): Entity {
    const walker = this.#host.world.spawnCharacter(
      site.body,
      site.latitude,
      site.longitude,
      { canFly: this.#host.canFly, heading: site.heading, vessel },
    )
    this.#host.controlPlayer(walker.id)
    this.#host.render.declareCut()
    return walker
  }
}
