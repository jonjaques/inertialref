import { DRAG_RADIANS_PER_PIXEL, clampPitch } from '@inertialref/rendering'
import {
  canonicalPosition,
  Quaternion as Q,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  bodyFixedDirection,
  bodyFixedFrameId,
  directionToGeodetic,
  type Body,
  type EntityId,
  MARS_PAD,
  systemId,
} from '@inertialref/universe'
import {
  surfacePlacementPose,
  type CharacterInput,
} from '@inertialref/simulation'
import type { GameEngine } from './GameEngine.ts'

export interface CharacterStatus {
  readonly active: boolean
  readonly available: boolean
  readonly locked: boolean
  readonly view: 'first' | 'third'
  readonly flying: boolean
  readonly canFly: boolean
  readonly grounded: boolean
  readonly crouched: boolean
  readonly error: string | null
}

/** Input and view policy; World alone moves the character. */
export class CharacterController {
  readonly #engine: GameEngine
  #ship: EntityId | null = null
  #padPreview = false
  #pitch = 0
  #yaw = 0
  locked = false
  view: 'first' | 'third' = 'first'
  error: string | null = null

  constructor(engine: GameEngine) {
    this.#engine = engine
  }

  get entity() {
    const id = this.#engine.player()
    return id === null ? null : (this.#engine.world.entities.get(id) ?? null)
  }
  get active(): boolean {
    return this.entity?.character != null
  }
  get pitch(): number {
    return this.#pitch
  }
  get ship(): EntityId | null {
    return this.#ship
  }

  get padPreview(): boolean {
    return this.#padPreview
  }

  #site(): {
    body: Body
    latitude: number
    longitude: number
    heading: number
    pitch: number
  } | null {
    const engine = this.#engine
    if (engine.harness.cutsceneStatus() !== null) return null
    const observed = engine.harness.observerStatus()
    if (observed?.target !== null && observed?.target !== undefined) {
      const body = engine.world.bodyAt(observed.target.frame)
      const stance = observed.surface?.stance
      if (
        body === null ||
        stance === undefined ||
        stance.height > 3 ||
        observed.descent !== null ||
        observed.traveling
      )
        return null
      return { body, ...stance }
    }
    const entity = this.entity
    if (entity === null || !engine.world.landedEntities().includes(entity.id))
      return null
    const body = engine.world.bodyAt(entity.state.frame)
    if (body === null) return null
    const spin = engine.world.frames.pose(
      bodyFixedFrameId(body.address),
      engine.world.clock.time,
    )
    const position = canonicalPosition(
      engine.world.frames,
      entity.state,
      engine.world.clock.time,
    )
    const up = Vec.normalize(UV.difference(position, spin.position))
    const east = Vec.normalize(
      Vec.cross(Q.rotate(spin.orientation, vec3(0, 1, 0)), up),
    )
    const offset = Vec.scale(
      east,
      Math.max(4, (engine.hull?.beamMeters ?? 6) / 2 + 3),
    )
    const direction = bodyFixedDirection(spin, UV.translate(position, offset))
    return { body, ...directionToGeodetic(direction), heading: 0, pitch: 0 }
  }

  available(): boolean {
    if (this.active) return true
    const site = this.#site()
    return (
      site !== null &&
      site.body.kind !== 'gas-giant' &&
      site.body.kind !== 'ice-giant'
    )
  }

  enter(): boolean {
    if (this.active) {
      this.error = null
      return true
    }
    const site = this.#site()
    if (site === null || !this.available()) {
      this.error = 'Land on solid ground to walk.'
      return false
    }
    this.#ship = this.#engine.player()
    const character = this.#engine.world.spawnCharacter(
      site.body,
      site.latitude,
      site.longitude,
      {
        canFly: this.#engine.session.canFly,
        heading: site.heading,
      },
    )
    this.#engine.session.controlPlayer(character.id)
    this.#yaw = site.heading
    this.#pitch = site.pitch
    this.view = 'first'
    this.error = null
    this.#engine.world.clock.setTimeScale(1)
    this.#engine.world.clock.setPaused(false)
    this.#engine.declareCut()
    return true
  }

  lockChanged(locked: boolean): void {
    this.locked = locked && this.active
    if (!this.locked) this.stop()
    else this.error = null
  }

  input(input: Partial<CharacterInput>): void {
    const entity = this.entity
    if (!this.locked || entity?.character == null) return
    this.#engine.world.setCharacterInput(entity.id, input)
  }

  look(dx: number, dy: number): void {
    const entity = this.entity
    if (
      !this.locked ||
      entity?.character == null ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy)
    )
      return
    const angle =
      DRAG_RADIANS_PER_PIXEL *
      this.#engine.harness.flightCamera.dragSensitivity()
    this.#yaw += dx * angle
    this.#pitch = clampPitch(this.#pitch - dy * angle)
    this.#engine.world.setCharacterInput(entity.id, { yaw: this.#yaw })
  }

  toggleView(): void {
    if (!this.active) return
    this.view = this.view === 'first' ? 'third' : 'first'
    this.#engine.declareCut()
  }

  toggleFlight(): boolean {
    const entity = this.entity
    if (!this.locked || entity?.character == null) return false
    return this.#engine.world.setCharacterFlying(
      entity.id,
      !entity.character.flying,
    )
  }

  stop(): void {
    const entity = this.entity
    if (entity?.character == null) return
    this.#engine.world.setCharacterInput(entity.id, {
      forward: 0,
      right: 0,
      sprint: false,
      crouch: false,
      jump: false,
      ascend: false,
      descend: false,
    })
  }

  leave(): void {
    if (!this.active) return
    const character = this.entity
    this.stop()
    this.locked = false
    if (this.#ship !== null && this.#engine.world.entities.has(this.#ship))
      this.#engine.session.controlPlayer(this.#ship)
    if (character?.character != null && this.#engine.player() !== character.id)
      this.#engine.world.removeCharacter(character.id)
    this.#padPreview = false
    this.#engine.declareCut()
  }

  reset(): void {
    this.locked = false
    this.#ship =
      this.#engine.world.entities
        .ordered()
        .find((entity) => entity.kind === 'ship')?.id ?? null
    this.#padPreview = false
    this.#pitch = 0
    this.#yaw = this.entity?.character?.input.yaw ?? 0
    this.error = null
    const entity = this.entity
    if (entity?.character != null) {
      this.#engine.world.setCharacterFlightPermission(
        entity.id,
        this.#engine.session.canFly,
      )
      this.stop()
    }
  }

  /** Reproducible scale check beside the cinema's 46 m Rocinante and Mars pad. */
  atMarsPad(): boolean {
    if (this.active) this.leave()
    const engine = this.#engine
    engine.harness.stopCutscene()
    engine.harness.observatory.clear()
    engine.harness.land(
      MARS_PAD.bodyAddress,
      MARS_PAD.latitude,
      MARS_PAD.longitude,
    )
    engine.world.runTicks(1)
    this.#ship = engine.player()
    const body = engine.world.loadSystem(systemId('SOL')).planets[3]!
    const spin = engine.world.frames.pose(
      bodyFixedFrameId(body.address),
      engine.world.clock.time,
    )
    const pad = surfacePlacementPose(MARS_PAD, body, spin)
    const side = UV.translate(
      pad.position,
      Q.rotate(pad.orientation, vec3(22, 0, 0)),
    )
    const site = directionToGeodetic(bodyFixedDirection(spin, side))
    const heading = MARS_PAD.heading - Math.PI / 2
    const avatar = engine.world.spawnCharacter(
      body,
      site.latitude,
      site.longitude,
      { canFly: engine.session.canFly, heading },
    )
    engine.session.controlPlayer(avatar.id)
    engine.world.clock.setTimeScale(1)
    engine.world.clock.setPaused(false)
    this.#yaw = heading
    this.#pitch = 0.25
    this.view = 'third'
    this.#padPreview = true
    engine.declareCut()
    return true
  }

  status(): CharacterStatus {
    const character = this.entity?.character
    return {
      active: this.active,
      available: this.available(),
      locked: this.locked,
      view: this.view,
      flying: character?.flying ?? false,
      canFly: character?.canFly ?? this.#engine.session.canFly,
      grounded: character?.grounded ?? false,
      crouched: character?.crouched ?? false,
      error: this.error,
    }
  }
}
