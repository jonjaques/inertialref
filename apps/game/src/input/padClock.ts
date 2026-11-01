import type { KeymapStore } from './keymapStore.ts'
import type { PadDriver, PadReading } from './padDriver.ts'

/*
 * When the pad is read.
 *
 * Once an animation frame, and only while a pad is attached or a held analog
 * action is down: a page with no pad pays nothing at all, and one with a pad
 * lying on the desk pays a list read and a few comparisons a frame. The scene
 * calls `store.tick` too, from its own loop and ahead of the simulation step
 * (`App`), so while it runs a stick moved this frame moves the ship this frame;
 * this clock is what keeps the pad live where the scene is not running — the
 * front door, the reading room, a dialog over a held frame.
 *
 * **The one `navigator.getGamepads()` in `apps/game/src`.** For the reason the
 * keymap's listener is single: two readers would be two ideas of which pad is
 * in use and two sets of latched edges, and a press would fire once per
 * reader.
 */

/** Every pad the browser exposes, or none when a permissions policy refuses. */
export function readPads(target: Window): readonly (PadReading | null)[] {
  try {
    return target.navigator.getGamepads?.() ?? []
  } catch {
    // `SecurityError` where `Permissions-Policy: gamepad=()` applies, which a
    // host embedding the page is entitled to set.
    return []
  }
}

const connectedCount = (target: Window): number =>
  readPads(target).filter((pad) => pad?.connected === true).length

export function startPadClock(
  store: KeymapStore,
  driver: PadDriver,
  target: Window,
): () => void {
  let frame: number | null = null
  const run = (timestamp: number): void => {
    frame = null
    try {
      store.tick(timestamp)
    } finally {
      // Re-armed even when a handler the tick reached throws: the throw is
      // that handler's, and a clock that stopped on it would leave the pad
      // dead outside the scene until a pad arriving woke it again.
      if (store.wantsFrames()) frame = target.requestAnimationFrame(run)
    }
  }
  const wake = (): void => {
    frame ??= target.requestAnimationFrame(run)
  }
  store.setPad(driver)
  store.setWake(wake)

  /*
   * A pad is exposed only after somebody presses something on it — the
   * specification's guard against fingerprinting by attached hardware — so
   * `gamepadconnected` is the first anybody hears of a pad, even one that was
   * plugged in before the page loaded.
   */
  const connected = (event: GamepadEvent): void => {
    store.setPads(connectedCount(target))
    store.announceConnection({ connected: true, id: event.gamepad.id })
    wake()
  }
  const disconnected = (event: GamepadEvent): void => {
    // Polled at once rather than at the next frame, so a pad pulled out
    // mid-burn lets go of its thrusters now and not when a frame next runs.
    driver.poll(0)
    store.setPads(connectedCount(target))
    store.announceConnection({ connected: false, id: event.gamepad.id })
  }
  target.addEventListener('gamepadconnected', connected)
  target.addEventListener('gamepaddisconnected', disconnected)
  store.setPads(connectedCount(target))
  if (store.wantsFrames()) wake()

  return () => {
    target.removeEventListener('gamepadconnected', connected)
    target.removeEventListener('gamepaddisconnected', disconnected)
    if (frame !== null) target.cancelAnimationFrame(frame)
    frame = null
    store.setWake(() => {})
    store.setPad(null)
  }
}
