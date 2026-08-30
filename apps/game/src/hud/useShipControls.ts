import { useRef } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useAction, useActions, useKeyContext } from '../input/useKeymap.ts'
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

export function useShipControls(
  engine: GameEngine | null,
  bindings: ControlBindings,
): void {
  /*
   * Which axes are held, as a Set the dispatcher fills through the edges.
   *
   * A ref rather than state: this changes on every key and the vector it
   * produces goes straight at the engine, so a re-render would be work for a
   * value no component reads. The dispatcher releases everything on a blur and
   * on the context leaving, so the set cannot be left with a thruster in it.
   */
  const held = useRef(new Set<string>())

  const apply = (): void => {
    const translation: [number, number, number] = [0, 0, 0]
    const rotation: [number, number, number] = [0, 0, 0]
    for (const id of held.current) {
      const binding = AXES[id]
      if (binding === undefined) continue
      const [axis, index, sign] = binding
      if (axis === 'translation') translation[index] += sign
      else rotation[index] += sign
    }
    if (engine === null) return
    engine.setControl(translation, rotation)
  }

  useActions(AXIS_IDS, (id, event) => {
    if (event.phase === 'down') held.current.add(id)
    else held.current.delete(id)
    apply()
  })

  useAction('flight.assist', () => bindings.onToggleAssist())
  useAction('flight.kill', () => bindings.onKillRotation())
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
