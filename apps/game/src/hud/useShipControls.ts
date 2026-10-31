import { useEffect, useRef } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  useAction,
  useActions,
  useKeyContext,
  useKeymap,
} from '../input/useKeymap.ts'
import type { ActionId } from '../input/keymap.ts'

/*
 * Keyboard flight.
 *
 * Held keys are collected into a control vector and pushed at the engine, which
 * stores it on the entity; the fixed-step simulation reads it. Nothing here
 * moves the ship — a keydown handler that nudged a position would make flight
 * behavior depend on key-repeat rate, which is the input equivalent of tying
 * physics to the frame rate.
 *
 * What is left of this hook is that arithmetic. Which key produces which axis
 * is `input/keymap.ts`, and it has to be: the planetarium binds the arrows to
 * orbiting a camera and `F` to framing a target, and both are flight axes here.
 * Two window listeners claiming one key is not a conflict anybody can diagnose
 * — the ship simply drifts while you look at Saturn — and the contexts are what
 * make it impossible rather than merely avoided.
 */

export interface ControlBindings {
  readonly onToggleAssist: () => void
  readonly onKillRotation: () => void
  readonly onPause: () => void
  readonly onWarp: (direction: number) => void
  readonly onSave: () => void
  readonly onLoad: () => void
}

/** Which axis each held flight action drives, and which way. */
const AXES: Readonly<
  Record<
    string,
    [axis: 'translation' | 'rotation', index: 0 | 1 | 2, sign: number]
  >
> = {
  'flight.fore': ['translation', 2, 1],
  'flight.aft': ['translation', 2, -1],
  'flight.right': ['translation', 0, 1],
  'flight.left': ['translation', 0, -1],
  'flight.up': ['translation', 1, 1],
  'flight.down': ['translation', 1, -1],
  'flight.pitchUp': ['rotation', 0, 1],
  'flight.pitchDown': ['rotation', 0, -1],
  'flight.yawLeft': ['rotation', 1, 1],
  'flight.yawRight': ['rotation', 1, -1],
  'flight.rollLeft': ['rotation', 2, 1],
  'flight.rollRight': ['rotation', 2, -1],
}

const AXIS_IDS = Object.keys(AXES) as readonly ActionId[]

/**
 * How far one press walks the throttle.
 *
 * A twentieth: fine enough to set a quarter burn from the keyboard, coarse
 * enough that a held key crosses the whole range in under a second at the
 * operating system's repeat rate. The throttle is not an axis — it is a
 * setting the drive keeps — so it goes at the engine as a value and never
 * through the held set above.
 */
const THROTTLE_STEP = 0.05

/**
 * How often the drive's rumble is renewed, and how long each effect runs.
 *
 * The Gamepad API has no "rumble until told to stop": an effect has a
 * duration and a newer one preempts it. So a continuous hum is a chain of
 * short effects, each a little longer than the gap to the next so the motor
 * never spins down between them, and the chain simply stops being renewed
 * when the drive is cut.
 */
const DRIVE_RENEW_SECONDS = 0.1
const DRIVE_EFFECT_MS = 140

export function useShipControls(
  engine: GameEngine,
  bindings: ControlBindings,
): void {
  /*
   * Which axes are held, and how far, as a map the dispatcher fills through
   * the edges.
   *
   * A magnitude rather than membership, because a stick halfway out is half a
   * thruster — and a key is a stick at full throw, so the keyboard's arithmetic
   * is the same sum with every value one. A ref rather than state: this changes
   * on every key and every stick movement and the vector goes straight at the
   * engine, so a re-render would be work for a value no component reads. The
   * dispatcher releases everything on a blur and on the context leaving, so
   * the map cannot be left with a thruster in it.
   */
  const held = useRef(new Map<string, number>())

  const apply = (): void => {
    const translation: [number, number, number] = [0, 0, 0]
    const rotation: [number, number, number] = [0, 0, 0]
    for (const [id, value] of held.current) {
      const binding = AXES[id]
      if (binding === undefined) continue
      const [axis, index, sign] = binding
      if (axis === 'translation') translation[index] += sign * value
      else rotation[index] += sign * value
    }
    engine.setControl(translation, rotation)
  }

  useActions(AXIS_IDS, (id, event) => {
    if (event.phase === 'up') held.current.delete(id)
    else held.current.set(id, event.value)
    apply()
  })

  useAction('flight.throttleUp', () => engine.nudgeThrottle(THROTTLE_STEP))
  useAction('flight.throttleDown', () => engine.nudgeThrottle(-THROTTLE_STEP))
  useAction('flight.throttleFull', () => engine.setThrottle(1))
  useAction('flight.throttleCut', () => engine.setThrottle(0))
  const store = useKeymap()
  // A state change felt as well as read: a tick for the assist, a thump for
  // the reaction wheels catching the spin. The store drops both unless the
  // pad is the hand in use, so a keyboard press never buzzes a pad on a desk.
  useAction('flight.assist', () => {
    bindings.onToggleAssist()
    store.rumble(0, 0.35, 60)
  })
  useAction('flight.kill', () => {
    bindings.onKillRotation()
    store.rumble(0.55, 0.3, 160)
  })

  /*
   * The main drive, felt: the light motor at the throttle, for as long as the
   * pilot is flying. Only while `flight` is live — the ship keeps burning
   * under the planetarium and a walk, and a pad humming in somebody's hand
   * while they look at Saturn is the ship's drive reaching through a mode it
   * has no part in.
   */
  useEffect(() => {
    let since = DRIVE_RENEW_SECONDS
    return store.onFrame((seconds) => {
      since += seconds
      if (since < DRIVE_RENEW_SECONDS) return
      since = 0
      if (!store.live.includes('flight')) return
      const throttle = engine.throttle()
      if (throttle <= 0) return
      store.rumble(throttle * 0.15, throttle * 0.45, DRIVE_EFFECT_MS)
    })
  }, [store, engine])
  useAction('time.pause', () => bindings.onPause())
  useAction('time.faster', () => bindings.onWarp(1))
  useAction('time.slower', () => bindings.onWarp(-1))
  useAction('session.save', () => bindings.onSave())
  useAction('session.load', () => bindings.onLoad())
}

/**
 * Say the flight axes are live for as long as this is mounted.
 *
 * A hook of its own rather than an option on the one above, because the two
 * answer different questions: `App` owns the transport verbs in every mode, and
 * only a flight mode owns the axes. As an option it was a boolean threaded
 * through the shell that turned a whole listener off — which is also how
 * `pause: false` came to exist for the cinema, a special case the contexts now
 * make unnecessary.
 */
export function useFlightContext(): void {
  useKeyContext({ context: 'flight' })
}
