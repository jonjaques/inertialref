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
 * This frame's motion for a held look, in drag pixels, signed as a drag is:
 * x right, y down.
 */
export function lookDelta(
  values: ReadonlyMap<ActionId, number>,
  ids: LookIds,
  seconds: number,
  speed = 1,
): { readonly x: number; readonly y: number } {
  const rate = LOOK_PIXELS_PER_SECOND * speed * seconds
  return {
    x: ((values.get(ids.right) ?? 0) - (values.get(ids.left) ?? 0)) * rate,
    y: ((values.get(ids.down) ?? 0) - (values.get(ids.up) ?? 0)) * rate,
  }
}
