import { Quaternion as Q } from '@inertialref/spatial'
import {
  applyDrag,
  applyLook,
  chaseOffsetFor,
  clampOrbitDistance,
  DEFAULT_FLIGHT_CAMERA,
  type FlightCameraState,
  type FlightView,
  isCentred,
  type LookOffset,
  NO_LOOK,
  type ObserverState,
  orbitToward,
  zoomFactorForNotches,
} from '@inertialref/rendering'
import { dragSensitivityOf } from './dragSensitivity.ts'
import type { Host } from './harness.ts'

/*
 * The flight camera: which view the ship arm stands in, and where.
 *
 * `packages/rendering/src/camera.ts` holds the arithmetic — where the eye is
 * for a state — and this holds the state and the verbs a hand or a script
 * moves it with. It is the ship arm's counterpart to the observatory, and it
 * is deliberately smaller: the observatory resolves addresses and eases
 * between them, while this never asks the world where anything is. The one
 * thing it reads from a frame is the ship's attitude, once, so that entering
 * the orbit view is a cut nobody sees.
 *
 * Nothing here is canonical. A view is presentation; `world.stateHash()`
 * does not know it exists.
 */

export interface FlightCameraStatus {
  readonly view: FlightView
  /** The orbit arm, in hull lengths about the ship. */
  readonly orbit: ObserverState
  /** Where the head is turned from the view's own aim. */
  readonly look: LookOffset
  /** Whether the head is turned at all. */
  readonly aimed: boolean
}

const VIEWS: readonly FlightView[] = ['chase', 'orbit']

export class FlightCamera {
  readonly #host: Host
  #state: FlightCameraState = DEFAULT_FLIGHT_CAMERA

  constructor(host: Host) {
    this.#host = host
  }

  get state(): FlightCameraState {
    return this.#state
  }

  status(): FlightCameraStatus {
    return {
      view: this.#state.view,
      orbit: this.#state.orbit,
      look: this.#state.look,
      aimed: !isCentred(this.#state.look),
    }
  }

  /**
   * Stand in a view.
   *
   * Entering the orbit opens it where the chase camera was standing — the
   * chase offset, turned by the ship's attitude, read off this frame's scene
   * — so the switch is a change of what the camera does next rather than a
   * jump. The head is centred on every switch: a look is an offset from the
   * view's own aim, and the aim it was measured against is gone.
   */
  setView(view: FlightView): FlightCameraStatus {
    const held = this.#state
    let orbit = held.orbit
    if (view === 'orbit' && held.view !== 'orbit') {
      const scene = this.#host.render.scene()
      if (scene !== null) {
        const standoff = chaseOffsetFor(1)
        orbit = orbitToward(
          scene.camera.up,
          Q.rotate(scene.camera.orientation, standoff),
          Math.hypot(standoff.y, standoff.z),
        )
      }
    }
    this.#state = { view, orbit, look: NO_LOOK }
    return this.status()
  }

  /** The next view along: chase, orbit, chase. */
  cycleView(): FlightCameraStatus {
    const at = VIEWS.indexOf(this.#state.view)
    return this.setView(VIEWS[(at + 1) % VIEWS.length] as FlightView)
  }

  /**
   * A drag, in pixels. In the orbit it orbits; in the chase it turns the
   * head, because there is nothing else a drag from a chase position can
   * mean — the eye is bolted to the hull.
   */
  drag(
    dxPixels: number,
    dyPixels: number,
    sensitivity = this.dragSensitivity(),
  ): void {
    const held = this.#state
    if (held.view === 'orbit') {
      const orbit = applyDrag(held.orbit, dxPixels, dyPixels, sensitivity)
      this.#state = { ...held, orbit }
      return
    }
    this.turn(dxPixels, dyPixels, sensitivity)
  }

  /** A drag applied to the look alone, whichever view is up. */
  turn(
    dxPixels: number,
    dyPixels: number,
    sensitivity = this.dragSensitivity(),
  ): void {
    const held = this.#state
    this.#state = {
      ...held,
      look: applyLook(held.look, dxPixels, dyPixels, sensitivity),
    }
  }

  /** Multiply the orbit's distance; above 1 retreats. Nothing in the chase. */
  zoom(factor: number): void {
    const held = this.#state
    if (held.view !== 'orbit' || !(factor > 0)) return
    this.#state = {
      ...held,
      orbit: {
        ...held.orbit,
        distance: clampOrbitDistance(held.orbit.distance * factor),
      },
    }
  }

  zoomNotches(notches: number): void {
    this.zoom(zoomFactorForNotches(notches))
  }

  /** Look where the view aims again. */
  recentre(): FlightCameraStatus {
    this.#state = { ...this.#state, look: NO_LOOK }
    return this.status()
  }

  /** Back to the chase, as a session opens. */
  reset(): FlightCameraStatus {
    this.#state = DEFAULT_FLIGHT_CAMERA
    return this.status()
  }

  /** Radians per CSS pixel of drag, as a multiple of the reference. */
  dragSensitivity(): number {
    return dragSensitivityOf(this.#host.render)
  }
}
