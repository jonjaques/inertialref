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
  readonly onShowNavigation: () => void
  readonly onShowPerformance: () => void
}

const AXIS_KEYS: Readonly<
  Record<
    string,
    [axis: 'translation' | 'rotation', index: 0 | 1 | 2, sign: number]
  >
> = {
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

/**
 * Whether the keystroke belongs to something being typed into.
 *
 * The overlay grew a text field for addresses, and flight input is a
 * window-level listener: without this, typing `SOL` fires the retro thruster
 * twice and toggles nothing you meant. The keys are not remapped and the field
 * is not special — the handler simply declines to read input aimed elsewhere.
 */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * Whether the keystroke is aimed at a control in the overlay.
 *
 * Only `Tab` asks. It is bound to collapsing the dock *and* it is the browser's
 * only way between focusable elements, and a window-level `preventDefault` wins
 * both — so with focus on a dock button, Tab collapsed the panel the button was
 * in rather than moving to the next one, and there was no key that would.
 *
 * Same shape as `isTyping` and for the same reason: the handler declines input
 * aimed at something else rather than the overlay learning about flight. From
 * the canvas or the body — which is where focus is during flight, because every
 * control hands it straight back — nothing has changed.
 */
function isOverlayControl(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof HTMLElement && target.closest('.hud-layer') !== null
}

export function useShipControls(
  engine: GameEngine,
  bindings: ControlBindings,
): void {
  const held = useRef(new Set<string>())
  // The bindings close over React state, so a new object arrives on every
  // render — several times a second while the HUD polls. Reading them through a
  // ref keeps one subscription for the life of the engine instead of tearing
  // down and rebuilding three window listeners at the HUD's refresh rate.
  const latest = useRef(bindings)
  useEffect(() => {
    latest.current = bindings
  })

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
      if (event.repeat || isTyping(event)) return
      if (event.code in AXIS_KEYS) {
        held.current.add(event.code)
        apply()
        event.preventDefault()
        return
      }
      switch (event.code) {
        case 'KeyZ':
          latest.current.onToggleAssist()
          break
        case 'KeyX':
          latest.current.onKillRotation()
          break
        case 'Space':
          latest.current.onPause()
          event.preventDefault()
          break
        case 'BracketRight':
          latest.current.onWarp(1)
          break
        case 'BracketLeft':
          latest.current.onWarp(-1)
          break
        case 'F5':
          latest.current.onSave()
          event.preventDefault()
          break
        case 'F9':
          latest.current.onLoad()
          event.preventDefault()
          break
        case 'Tab':
          if (isOverlayControl(event)) break
          latest.current.onToggleHud()
          event.preventDefault()
          break
        case 'KeyG':
          latest.current.onShowNavigation()
          break
        case 'KeyP':
          latest.current.onShowPerformance()
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
  }, [engine])
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
  ['G', 'navigation panel'],
  ['P', 'performance panel'],
  ['Tab', 'collapse the dock · within it, moves between controls'],
]
