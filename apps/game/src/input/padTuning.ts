import type { PadFamily } from './padFamily.ts'
import { DEFAULT_STICK, type StickShape } from './padShape.ts'

/*
 * How the pad feels, as the controls page exposes it.
 *
 * A leaf, beside `pad.ts`, so `state/preferences.ts` can guard the stored value
 * without importing the dispatcher.
 */

export interface PadTuning {
  /** The sticks' radial deadzone, 0.02..0.4. */
  readonly deadzone: number
  /** The response curve's exponent, 1 (linear) ..3. */
  readonly curve: number
  /**
   * How fast a stick at full throw turns a camera, as a multiple of the
   * default. Applied to every analog camera — the planetarium's orbit and look,
   * the ship's head, the walker's — and never to the ship's attitude, which is
   * the ship's torque and not a preference about the hand.
   */
  readonly lookSpeed: number
  /** Stick back looks up. */
  readonly invertLook: boolean
  /** Stick back pitches the nose up, as in an aircraft. */
  readonly invertPitch: boolean
  /** Rumble, from the drive and the acts that change the ship's state. */
  readonly vibration: boolean
  /**
   * Whose glyphs the prompts print. `auto` reads the pad; the others are for
   * a pad that reports itself generically — most third-party pads do, and a
   * DualSense on a browser that drops the USB ids would read as one too.
   */
  readonly prompts: PadPrompts
}

export const PAD_PROMPTS = ['auto', 'dualsense', 'xbox', 'switch'] as const

export type PadPrompts = (typeof PAD_PROMPTS)[number]

/** The family a pad's prompts are drawn in, given what it says it is. */
export const promptFamily = (
  prompts: PadPrompts,
  reported: PadFamily,
): PadFamily => (prompts === 'auto' ? reported : prompts)

export const TUNING_RANGES = {
  deadzone: { min: 0.02, max: 0.4, step: 0.01 },
  curve: { min: 1, max: 3, step: 0.1 },
  lookSpeed: { min: 0.25, max: 4, step: 0.05 },
} as const

export const DEFAULT_TUNING: PadTuning = {
  deadzone: DEFAULT_STICK.deadzone,
  curve: DEFAULT_STICK.curve,
  lookSpeed: 1,
  invertLook: false,
  invertPitch: false,
  vibration: true,
  prompts: 'auto',
}

const within = (value: unknown, range: { min: number; max: number }) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= range.min &&
  value <= range.max

/**
 * Whether a stored value is a tuning this build can use.
 *
 * Every field is optional on the way in, and `reviveTuning` fills the absent
 * ones: a field added next year must not reset the deadzone somebody set this
 * year, which is what rejecting the whole record for one missing key would do.
 * A field that is present and wrong rejects the record, because a wrong value
 * is a file somebody edited by hand and guessed at.
 */
export function isPadTuning(value: unknown): value is PadTuning {
  if (typeof value !== 'object' || value === null) return false
  const held = value as Partial<Record<keyof PadTuning, unknown>>
  const flag = (field: unknown) =>
    field === undefined || typeof field === 'boolean'
  return (
    (held.deadzone === undefined ||
      within(held.deadzone, TUNING_RANGES.deadzone)) &&
    (held.curve === undefined || within(held.curve, TUNING_RANGES.curve)) &&
    (held.lookSpeed === undefined ||
      within(held.lookSpeed, TUNING_RANGES.lookSpeed)) &&
    flag(held.invertLook) &&
    flag(held.invertPitch) &&
    flag(held.vibration) &&
    (held.prompts === undefined ||
      (PAD_PROMPTS as readonly unknown[]).includes(held.prompts))
  )
}

export const reviveTuning = (value: PadTuning): PadTuning => ({
  ...DEFAULT_TUNING,
  ...value,
})

/** The stick shape a tuning asks for. */
export const stickShapeOf = (tuning: PadTuning): StickShape => ({
  ...DEFAULT_STICK,
  deadzone: tuning.deadzone,
  curve: tuning.curve,
})
