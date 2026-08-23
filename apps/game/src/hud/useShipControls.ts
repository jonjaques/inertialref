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
 * Only `Space` asks, and it is the one key that has to: it is the pause key
 * *and* it is how a keyboard activates a focused button, and a window-level
 * `preventDefault` on keydown cancels the activation before the click event
 * that would have carried it ever exists. So with focus on any dock, shell-bar
 * or settings button, pressing Space paused the simulation and the button did
 * nothing — silently, because there is no error in cancelling an event.
 * `hud/focus.ts` depends on this guard: it deliberately keeps focus after a
 * keyboard activation, which is only navigable if Space still activates.
 *
 * Same shape as `isTyping` and for the same reason: the handler declines input
 * aimed at something else rather than the overlay learning about flight. From
 * the canvas or the body — which is where focus is during flight, because every
 * control hands it straight back on a *pointer* click — nothing has changed.
 *
 * `F5` and `F9` deliberately do not ask. No control in the overlay responds to
 * either, so declining them would not activate anything; it would hand the key
 * back to the browser, and F5 is Reload. Losing the session because focus
 * happened to be on a dock button is worse than the thing that would fix.
 */
function isOverlayControl(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof HTMLElement && target.closest('.hud-layer') !== null
}

export interface ControlOptions {
  /**
   * Whether the flight axes are live.
   *
   * Off outside the flight modes, and it has to be: the planetarium binds the
   * arrow keys to orbiting a camera and `F` to framing a target, and both are
   * flight axes here. Two window-level handlers claiming the same key is not a
   * conflict a user can diagnose — the ship simply drifts while they look at
   * Saturn.
   */
  readonly axes: boolean
  /**
   * Whether `Space` pauses the simulation here.
   *
   * Off in the cinema mode, and for the same reason `axes` exists — except
   * that this one is invisible rather than merely confusing. The player binds
   * Space to its own transport, both handlers are on `window`, and neither
   * `preventDefault` stops the other (only `stopImmediatePropagation` would):
   * one press flipped `clock.paused` twice and nothing moved. A dead transport
   * control with no error anywhere.
   *
   * The rest of the bindings stay live in every mode, because warping, saving
   * and loading mean the same thing wherever you are.
   */
  readonly pause: boolean
}

export function useShipControls(
  engine: GameEngine,
  bindings: ControlBindings,
  options: ControlOptions = { axes: true, pause: true },
): void {
  const held = useRef(new Set<string>())
  const axes = options.axes
  const pause = options.pause
  // The bindings close over React state, so a new object arrives on every
  // render — several times a second while the HUD polls. Reading them through a
  // ref keeps one subscription for the life of the engine instead of tearing
  // down and rebuilding three window listeners at the HUD's refresh rate.
  const latest = useRef(bindings)
  useEffect(() => {
    latest.current = bindings
  })

  useEffect(() => {
    // The set is captured once here rather than read through the ref in the
    // cleanup: a ref's `.current` at teardown is not necessarily the one this
    // effect has been filling, and the keys this effect must release are the
    // ones it collected.
    const heldKeys = held.current
    const apply = (): void => {
      const translation: [number, number, number] = [0, 0, 0]
      const rotation: [number, number, number] = [0, 0, 0]
      for (const code of heldKeys) {
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
      if (axes && event.code in AXIS_KEYS) {
        heldKeys.add(event.code)
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
          // The focused control's activation wins, and the mode's own
          // transport wins — see `isOverlayControl` and `ControlOptions.pause`.
          if (!pause || isOverlayControl(event)) break
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
        /*
         * `H`, `G` and `P` are deliberately absent, and they are still bound.
         *
         * They are about what is on screen rather than about the ship, and
         * what is on screen is now a per-mode workspace rather than one dock
         * `App` owns — so they moved to `dock/useWorkspaceKeys.ts`, beside the
         * state they change. Routing them from here would mean an event bus in
         * place of a function call.
         *
         * None of them is `Tab`, which is the part worth keeping written down.
         * Tab was the original binding for the collapse, guarded by "unless
         * focus is already in the overlay" — and that guard could never open.
         * On load `document.activeElement` is `<body>`, whose
         * `closest('.hud-layer')` is null, so the guard was false, the dock
         * toggled and `preventDefault` cancelled the browser's focus move.
         * Every subsequent Tab did the same, and with no `tabIndex` on the
         * canvas there was no focusable element outside the layer to bootstrap
         * from: focus could never enter the overlay at all, and every focus
         * ring and `aria-expanded` in it was unreachable by keyboard.
         *
         * There is no version of this that keeps both. Tab is how a browser
         * moves focus and a window-level `preventDefault` always wins, so a
         * mode that binds it owns focus navigation whether it means to or not.
         * Tab goes back to the browser; the panes get a letter.
         */
        default:
          break
      }
    }

    const up = (event: KeyboardEvent): void => {
      if (heldKeys.delete(event.code)) apply()
    }
    // Releasing focus with keys held would otherwise leave the drive burning.
    const blur = (): void => {
      heldKeys.clear()
      apply()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      // Leaving a mode with keys held would otherwise leave the drive burning
      // for the rest of the session, with nothing on screen still listening for
      // the key-up that would stop it.
      if (heldKeys.size > 0) {
        heldKeys.clear()
        engine.setControl([0, 0, 0], [0, 0, 0])
      }
    }
  }, [engine, axes, pause])
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
  ['G', 'the navigate panel'],
  ['P', 'the perf panel'],
  ['H', 'hide both panes, or bring them back'],
  ['Tab', 'move between the controls on screen'],
]
