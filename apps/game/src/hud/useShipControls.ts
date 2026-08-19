import { useEffect, useRef } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'

/*
 * Keyboard flight.
 *
 * Held keys are collected into a control vector and pushed at the engine, which
 * stores it on the entity; the fixed-step simulation reads it. Nothing here
 * moves the ship — a keydown handler that nudged a position would make flight
 * behaviour depend on key-repeat rate, which is the input equivalent of tying
 * physics to the frame rate.
 */

export interface ControlBindings {
  readonly onToggleAssist: () => void
  readonly onKillRotation: () => void
  readonly onPause: () => void
  readonly onWarp: (direction: number) => void
  readonly onSave: () => void
  readonly onLoad: () => void
  readonly onToggleHud: () => void
}

const AXIS_KEYS: Readonly<Record<string, [axis: 'translation' | 'rotation', index: 0 | 1 | 2, sign: number]>> = {
  KeyW: ['translation', 2, 1],
  KeyS: ['translation', 2, -1],
  KeyD: ['translation', 0, 1],
  KeyA: ['translation', 0, -1],
  KeyR: ['translation', 1, 1],
  KeyF: ['translation', 1, -1],
  ArrowUp: ['rotation', 0, 1],
  ArrowDown: ['rotation', 0, -1],
  ArrowLeft: ['rotation', 1, 1],
  ArrowRight: ['rotation', 1, -1],
  KeyQ: ['rotation', 2, 1],
  KeyE: ['rotation', 2, -1],
}

export function useShipControls(engine: GameEngine, bindings: ControlBindings): void {
  const held = useRef(new Set<string>())

  useEffect(() => {
    const apply = (): void => {
      const translation: [number, number, number] = [0, 0, 0]
      const rotation: [number, number, number] = [0, 0, 0]
      for (const code of held.current) {
        const binding = AXIS_KEYS[code]
        if (binding === undefined) continue
        const [axis, index, sign] = binding
        if (axis === 'translation') translation[index] += sign
        else rotation[index] += sign
      }
      engine.setControl(translation, rotation)
    }

    const down = (event: KeyboardEvent): void => {
      if (event.repeat) return
      if (event.code in AXIS_KEYS) {
        held.current.add(event.code)
        apply()
        event.preventDefault()
        return
      }
      switch (event.code) {
        case 'KeyZ':
          bindings.onToggleAssist()
          break
        case 'KeyX':
          bindings.onKillRotation()
          break
        case 'Space':
          bindings.onPause()
          event.preventDefault()
          break
        case 'BracketRight':
          bindings.onWarp(1)
          break
        case 'BracketLeft':
          bindings.onWarp(-1)
          break
        case 'F5':
          bindings.onSave()
          event.preventDefault()
          break
        case 'F9':
          bindings.onLoad()
          event.preventDefault()
          break
        case 'Tab':
          bindings.onToggleHud()
          event.preventDefault()
          break
        default:
          break
      }
    }

    const up = (event: KeyboardEvent): void => {
      if (held.current.delete(event.code)) apply()
    }
    // Releasing focus with keys held would otherwise leave the drive burning.
    const blur = (): void => {
      held.current.clear()
      apply()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [engine, bindings])
}

export const CONTROL_HELP: readonly (readonly [string, string])[] = [
  ['W / S', 'main drive fore / aft'],
  ['A / D', 'translate left / right'],
  ['R / F', 'translate up / down'],
  ['↑ ↓ ← →', 'pitch / yaw'],
  ['Q / E', 'roll'],
  ['Z', 'flight assist'],
  ['X', 'kill rotation'],
  ['Space', 'pause'],
  ['[ / ]', 'time warp'],
  ['F5 / F9', 'save / load'],
  ['Tab', 'hide panel'],
]
