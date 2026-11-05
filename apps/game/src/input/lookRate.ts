import type { ActionId } from './keymap.ts'

/*
 * How fast a held look turns a camera.
 *
 * In the pixels a drag speaks, and that is the decision: every camera here
 * turns by `pixels × dragSensitivity()`, which is the lens's own pixel angle,
 * so a stick held at full throw sweeps the same number of *field-widths* per
 * second at any focal length. A rate in radians per second would swing a
 * long lens through several of its own frames a second — the defect a
 * constant radians-per-pixel drag had, met again by a hand that does not move
 * a pointer.
 *
 * 1400 px/s at full throw is about 84° a second at the flight lens on a
 * 1600 px window, and the response curve spends the first half of the throw
 * well under a third of that.
 */
export const LOOK_PIXELS_PER_SECOND = 1400

/**
 * How fast a held dolly closes in, in wheel notches per second at full press.
 * Six notches is a factor of about 2.7 a second: a moon to a limb in a breath,
 * and no overshoot a trigger released halfway cannot catch.
 */
export const DOLLY_NOTCHES_PER_SECOND = 6

/** The four ids of a look run, in the order `look()` in `keymap.ts` issues. */
export interface LookIds {
  readonly left: ActionId
  readonly right: ActionId
  readonly up: ActionId
  readonly down: ActionId
}

export const lookIds = (prefix: string): LookIds => ({
  left: `${prefix}.lookLeft`,
  right: `${prefix}.lookRight`,
  up: `${prefix}.lookUp`,
  down: `${prefix}.lookDown`,
})

/**
 * This frame's held look, in drag pixels, signed by where the *view* turns:
 * `right` positive turns the view right, `up` positive turns it up.
 *
 * Not signed as a drag, and the difference is the whole of the convention. A
 * drag grabs the picture — the ground under the pointer follows the pointer,
 * so dragging right swings the view left — while a stick is a rate pointed
 * where the player wants to look, so fed through as drag pixels a stick
 * pushed right would turn the chase camera left. Each consumer maps these to
 * its own verb's sign: the grab cameras through `asDrag`, and the walker as a
 * pointer-locked mouse, which turns the way it moves.
 */
export function lookDelta(
  values: ReadonlyMap<ActionId, number>,
  ids: LookIds,
  seconds: number,
  speed = 1,
): { readonly right: number; readonly up: number } {
  const rate = LOOK_PIXELS_PER_SECOND * speed * seconds
  return {
    right: ((values.get(ids.right) ?? 0) - (values.get(ids.left) ?? 0)) * rate,
    up: ((values.get(ids.up) ?? 0) - (values.get(ids.down) ?? 0)) * rate,
  }
}

/**
 * A held look as the drag that turns a grab camera the same way: the picture
 * pulled left to look right, pulled down to look up.
 */
export const asDrag = (look: {
  readonly right: number
  readonly up: number
}): { readonly x: number; readonly y: number } => ({
  x: -look.right,
  y: look.up,
})
