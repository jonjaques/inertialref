/*
 * What a stick's numbers mean, before anything binds them.
 *
 * A pad does not report zero at rest. A DualSense's sticks settle anywhere
 * inside a few hundredths of center and drift with wear, so the raw axes read
 * as a ship that turns by itself — the deadzone exists to make rest mean rest.
 * How it is cut decides how the stick feels, and the obvious cut is wrong
 * twice over:
 *
 *  - **Per axis** (`|x| < dz → 0`) snaps the stick to a cross: near center a
 *    diagonal push loses whichever component is still inside, so a slow
 *    pitch-and-yaw turns into pitch, then a lurch of yaw. A *radial* cut tests
 *    the vector's length and keeps its direction.
 *  - **Radial, unscaled** (`|v| < dz → 0`, else `v`) leaves a step: the first
 *    value past the deadzone is `dz` itself, so the finest turn the stick can
 *    ask for is the deadzone's size. *Scaling* the remainder back to 0..1 makes
 *    the response start at zero and still reach one at the rim.
 *
 * That is the scaled radial deadzone from Josh Sutphin's "Doing Thumbstick
 * Dead Zones Right", which is what nearly every shipped game converged on. An
 * outer deadzone does the same at the rim: a worn stick whose throw stops at
 * 0.96 would otherwise never reach full rate.
 *
 * The curve is applied to the scaled magnitude, never per axis, for the same
 * reason the cut is radial: a per-axis power bends a diagonal toward the axis
 * that is further out.
 */

export interface StickShape {
  /** Below this length the stick is at rest. 0..0.5. */
  readonly deadzone: number
  /** Past this length the stick is at full throw. A hair under 1. */
  readonly outer: number
  /**
   * The exponent on the scaled magnitude. 1 is linear; above 1 spends more of
   * the throw on fine control and less on the top end.
   */
  readonly curve: number
}

/**
 * The defaults, and each is a preference the controls page exposes.
 *
 * 0.12 is generous for a new pad and right for a worn one, which is the side to
 * err on: a deadzone too small is a ship that turns by itself, and nothing on
 * screen says why. The 1.6 curve spends the first half of the throw on fine
 * control — enough to hold a planet's limb in a long lens — and still reaches
 * full rate at the rim.
 */
export const DEFAULT_STICK: StickShape = {
  deadzone: 0.12,
  outer: 0.97,
  curve: 1.6,
}

/** One stick's two axes, after shaping. Each component is −1..1. */
export interface StickValue {
  readonly x: number
  readonly y: number
}

export const AT_REST: StickValue = { x: 0, y: 0 }

/**
 * A stick's raw axes, shaped: radial deadzone, outer deadzone, curve.
 *
 * The output's length is in 0..1 and its direction is the input's, whatever
 * the input — including a pad that reports a corner at (1, 1), whose length is
 * √2 and which a careless remap would turn into a faster diagonal.
 */
export function shapeStick(
  rawX: number,
  rawY: number,
  shape: StickShape = DEFAULT_STICK,
): StickValue {
  const x = Number.isFinite(rawX) ? rawX : 0
  const y = Number.isFinite(rawY) ? rawY : 0
  const length = Math.hypot(x, y)
  if (length <= shape.deadzone) return AT_REST
  const span = Math.max(shape.outer - shape.deadzone, 1e-6)
  const scaled = Math.min((length - shape.deadzone) / span, 1)
  const magnitude = scaled ** shape.curve
  return { x: (x / length) * magnitude, y: (y / length) * magnitude }
}

/**
 * A trigger's travel, shaped: a deadzone at rest and a curve.
 *
 * A trigger has no direction, so this is the stick's arithmetic in one
 * dimension. The deadzone is smaller than a stick's, because a trigger sits on
 * a spring against a stop and reads a clean zero — what it needs is protection
 * from a finger *resting* on it.
 */
export function shapeTrigger(raw: number, deadzone = 0.04, curve = 1): number {
  if (!Number.isFinite(raw) || raw <= deadzone) return 0
  return Math.min((raw - deadzone) / (1 - deadzone), 1) ** curve
}

/**
 * When an analog control counts as pressed, and when it stops.
 *
 * Two thresholds rather than one, because a trigger squeezed to exactly the
 * threshold reads either side of it from one poll to the next — 250 times a
 * second in Chromium — and a single threshold turns that into a press per
 * crossing: the cinema's play key toggling at the poll rate. A gap between the
 * two makes a press a decision the finger has to undo.
 */
export interface Hysteresis {
  readonly press: number
  readonly release: number
}

/** For a trigger used as a button: half travel in, a third of it back out. */
export const TRIGGER_PRESS: Hysteresis = { press: 0.5, release: 0.3 }

/**
 * For a stick flicked as a button. Further in than a trigger, because a stick
 * is pushed through its own half-travel on the way to every diagonal.
 */
export const FLICK_PRESS: Hysteresis = { press: 0.6, release: 0.35 }

/** Whether a control held at `value` is down, given whether it was. */
export function latch(
  value: number,
  wasDown: boolean,
  thresholds: Hysteresis,
): boolean {
  return wasDown ? value > thresholds.release : value >= thresholds.press
}

/**
 * How a held pad button repeats a press action that asks for repeats.
 *
 * A keyboard's repeat is the operating system's and a pad has none, so the
 * throttle walk and the surface climb — the acts `keymap.ts` marks `repeats`
 * because leaning on them is how somebody asks for more — would be one step
 * per press on a pad. Slightly quicker than a typical keyboard repeat, because
 * a d-pad is held with a thumb that is about to be needed somewhere else.
 */
export const PAD_REPEAT = { delay: 0.4, interval: 0.06 } as const

/**
 * How many repeats fall due in one poll, for a control held `held` seconds
 * that had already produced `fired` of them.
 *
 * A count rather than a boolean, because a poll can be late — a frame held by
 * a measurement, a long task — and a throttle walk that silently drops the
 * steps it owed has moved by less than the hand asked for.
 */
export function repeatsDue(held: number, fired: number): number {
  if (!(held >= PAD_REPEAT.delay)) return 0
  const owed = Math.floor((held - PAD_REPEAT.delay) / PAD_REPEAT.interval) + 1
  return Math.max(owed - fired, 0)
}
