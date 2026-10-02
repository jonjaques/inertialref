import { DRAG_RADIANS_PER_PIXEL, clampPitch } from '@inertialref/rendering'
import type { EntityId } from '@inertialref/universe'
import type { Entity, CharacterInput } from '@inertialref/simulation'
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

/**
 * The browser's half of walking: pointer lock, the look and the view. The
 * camera's memory is the frame's (`onFootPresentation.ts`). Stepping out, stepping back in and the pad fixture are the
 * session's (`ir.onFoot`), so a console and a test reach the same walker; the
 * world alone moves it.
 */
export class CharacterController {
  readonly #engine: GameEngine
  /**
   * The walker the look was aimed for. A console can step a walker out
   * without passing through here, so the look re-aims at whichever walker it
   * finds rather than turning a new one by the last one's running yaw.
   */
  #looking: EntityId | null = null
  #pitch = 0
  #yaw = 0
  /** The walker the pointer lock was granted for; another one is not locked. */
  #lockedWalker: EntityId | null = null
  view: 'first' | 'third' = 'first'
  error: string | null = null

  constructor(engine: GameEngine) {
    this.#engine = engine
  }

  get #onFoot() {
    return this.#engine.harness.onFoot
  }

  get entity(): Entity | null {
    return this.#onFoot.walker()
  }
  get active(): boolean {
    return this.#onFoot.active
  }
  /**
   * Derived, because a console verb can board the ship under a held lock: a
   * walker that is gone is not one the pointer still steers, and the next
   * one to step out is not locked until the browser grants it.
   */
  get locked(): boolean {
    return this.#lockedWalker !== null && this.#lockedWalker === this.entity?.id
  }
  get pitch(): number {
    return this.#looking === this.entity?.id ? this.#pitch : 0
  }
  /** The ship the walker steps back into; see `OnFoot.ship`. */
  get ship(): EntityId | null {
    return this.#onFoot.ship()
  }

  /** Whether the walker is the pad fixture's, which the scene draws a Rocinante for. */
  get padPreview(): boolean {
    return this.#onFoot.padWalker() !== null
  }

  /**
   * Whether the mode may put a walker down at all.
   *
   * The planetarium's stance is an eye over ground the world has not been
   * asked to support, and its mode is a promise to leave the world alone, so
   * it flies free instead of spawning anyone; a scene holds the camera.
   */
  #mayStepOut(): boolean {
    const harness = this.#engine.harness
    return (
      harness.cutsceneStatus() === null &&
      harness.observerStatus()?.target == null
    )
  }

  available(): boolean {
    if (this.active) return true
    return this.#mayStepOut() && this.#onFoot.available(this.#beam())
  }

  enter(): boolean {
    if (this.active) {
      this.error = null
      return true
    }
    const stepped = this.#mayStepOut()
      ? this.#onFoot.stepOut(this.#beam())
      : null
    if (stepped === null || !stepped.ok) {
      this.error = 'Land on solid ground to walk.'
      return false
    }
    this.#arrive(stepped.value, { pitch: 0, view: 'first' })
    return true
  }

  lockChanged(locked: boolean): void {
    this.#lockedWalker = locked ? (this.entity?.id ?? null) : null
    if (this.#lockedWalker === null) this.stop()
    else this.error = null
  }

  input(input: Partial<CharacterInput>): void {
    const entity = this.entity
    if (!this.locked || entity === null) return
    this.#engine.world.setCharacterInput(entity.id, input)
  }

  look(dx: number, dy: number): void {
    const entity = this.entity
    if (
      !this.locked ||
      entity === null ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy)
    )
      return
    if (this.#looking !== entity.id) this.#aim(entity, 0)
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
    // A cut for the picture's history; the boom still eases out from the
    // head, which `onFootPresentation.ts` keeps across exactly this one.
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
    if (entity === null) return
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
    this.stop()
    this.#lockedWalker = null
    this.#onFoot.board()
  }

  /** Presentation only: a replaced world keeps none of this, and writes nothing. */
  reset(): void {
    this.#lockedWalker = null
    this.#looking = null
    this.error = null
  }

  /** Reproducible scale check beside the cinema's 46 m Rocinante and Mars pad. */
  atMarsPad(): void {
    this.leave()
    this.#arrive(this.#onFoot.atMarsPad(), { pitch: 0.25, view: 'third' })
  }

  status(): CharacterStatus {
    const onFoot = this.#onFoot.status()
    return {
      active: onFoot.active,
      available: this.available(),
      locked: this.locked,
      view: this.view,
      flying: onFoot.flying,
      canFly: onFoot.canFly,
      grounded: onFoot.grounded,
      crouched: onFoot.crouched,
      error: this.error,
    }
  }

  /** The drawn hull's beam, which the canonical step-out cannot see. */
  #beam(): number | undefined {
    return this.#engine.hull?.beamMeters
  }

  /**
   * A walker is out: aim the look where it faces. Time runs at 1× through
   * the game's `walkingPace` command, which whoever stepped out calls; the
   * session steps out headlessly at whatever rate it was asked.
   */
  #arrive(
    walker: Entity,
    framing: { readonly pitch: number; readonly view: 'first' | 'third' },
  ): void {
    this.#aim(walker, framing.pitch)
    this.view = framing.view
    this.error = null
  }

  /** Aim the look along the yaw the world last took for this walker. */
  #aim(walker: Entity, pitch: number): void {
    this.#looking = walker.id
    this.#yaw = walker.character?.input.yaw ?? 0
    this.#pitch = pitch
  }
}
