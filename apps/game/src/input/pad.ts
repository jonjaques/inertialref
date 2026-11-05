/*
 * A control on a gamepad, by its place on the pad rather than by what is
 * printed on it.
 *
 * The W3C "standard" mapping numbers the buttons the same way on every pad it
 * covers: 0 is the bottom face button whether it says ✕, A or B. So a binding
 * names the *position* — `south`, `l2`, `ls.up` — and the glyph is decided when
 * it is drawn, from the family of the pad actually attached (`padFamily.ts`).
 * This is the gamepad's half of the argument `chord.ts` makes for
 * `event.code`: a binding tied to the physical control survives a change of
 * hardware, and a label tied to the hardware is the only kind worth reading.
 *
 * A leaf module, for the reason `chord.ts` is one: `state/preferences.ts`
 * guards a stored pad binding and `keymap.ts` resolves one, and neither may
 * import the other.
 */

/**
 * The eighteen buttons of the standard mapping, in index order.
 *
 * Sixteen are the specification's; `home` (16) and `touchpad` (17) are what
 * Chromium reports for the PS and touchpad-click buttons of a DualSense and a
 * DualShock 4, and what it reports for the Guide and Share buttons where a pad
 * has them. A pad that reports fewer simply never presses the missing ones.
 */
export const PAD_BUTTONS = [
  'south',
  'east',
  'west',
  'north',
  'l1',
  'r1',
  'l2',
  'r2',
  'select',
  'start',
  'l3',
  'r3',
  'up',
  'down',
  'left',
  'right',
  'home',
  'touchpad',
] as const

export type PadButton = (typeof PAD_BUTTONS)[number]

/**
 * The eight stick half-axes.
 *
 * A half-axis rather than an axis, because a binding drives *one* action and
 * the actions are pairs — `flight.pitchUp` and `flight.pitchDown` — exactly as
 * the keyboard's are. Bound to a held action a half-axis is a magnitude; bound
 * to a press it is a flick, with hysteresis (`padShape.ts`).
 *
 * Up is up on the stick, which is −1 on the wire: the standard mapping reports
 * the vertical axes with down positive, and an inverted look is a preference
 * applied to the magnitude, never a different name for the direction.
 */
export const PAD_STICKS = [
  'ls.up',
  'ls.down',
  'ls.left',
  'ls.right',
  'rs.up',
  'rs.down',
  'rs.left',
  'rs.right',
] as const

export type PadStick = (typeof PAD_STICKS)[number]

export type PadControl = PadButton | PadStick

export const PAD_CONTROLS: readonly PadControl[] = [
  ...PAD_BUTTONS,
  ...PAD_STICKS,
]

export const isPadButton = (value: string): value is PadButton =>
  (PAD_BUTTONS as readonly string[]).includes(value)

export const isPadStick = (value: string): value is PadStick =>
  (PAD_STICKS as readonly string[]).includes(value)

export const isPadControl = (value: unknown): value is PadControl =>
  typeof value === 'string' && (isPadButton(value) || isPadStick(value))

/** The standard-mapping index of a button. */
export const buttonIndex = (button: PadButton): number =>
  PAD_BUTTONS.indexOf(button)

/** Which stick a half-axis belongs to, and which of its two axes and signs. */
export function stickAxis(stick: PadStick): {
  readonly side: 'left' | 'right'
  readonly axis: 'x' | 'y'
  /** +1 when the half-axis is the positive end of the wire axis. */
  readonly sign: 1 | -1
} {
  const side = stick.startsWith('ls') ? 'left' : 'right'
  const direction = stick.slice(3)
  if (direction === 'left') return { side, axis: 'x', sign: -1 }
  if (direction === 'right') return { side, axis: 'x', sign: 1 }
  if (direction === 'up') return { side, axis: 'y', sign: -1 }
  return { side, axis: 'y', sign: 1 }
}

/**
 * The buttons a binding may not take, whatever it is asked for.
 *
 * `home` belongs to the operating system: macOS opens Launchpad or the Game
 * Center overlay on it and Windows the Game Bar, so a binding there fires an
 * act *and* takes the player out of the window. It is the pad's `Cmd+Tab`, and
 * the editor refuses it for the reason it refuses `Ctrl` and `Meta`.
 */
export const REFUSED_PAD: readonly PadControl[] = ['home']

/** Whether the editor may bind this control. */
export const isPadBindable = (control: PadControl): boolean =>
  !REFUSED_PAD.includes(control)

/** The stored form is the name, so a hand-edited `"l2"` reads as what it is. */
export function parsePad(text: unknown): PadControl | null {
  return isPadControl(text) && isPadBindable(text) ? text : null
}
