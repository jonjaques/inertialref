import { type PadControl, isPadStick } from './pad.ts'

/*
 * Which pad is attached, and what its controls are called.
 *
 * A binding names a position (`pad.ts`); the label names what is printed
 * there. They part company on the face buttons, where the bottom one is ✕ on a
 * PlayStation pad, A on an Xbox pad and B on a Nintendo one — so a prompt that
 * printed one family's glyph for every pad would tell a third of players to
 * press a button that is somewhere else. The family is read from
 * `Gamepad.id`, which every engine fills differently:
 *
 *   Chromium  `DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)`
 *   Firefox   `054c-0ce6-DualSense Wireless Controller`
 *   Safari    `DualSense Wireless Controller`
 *
 * The USB vendor and product are the reliable half where they are present,
 * and the product name is the fallback where they are not. An unrecognized pad
 * is labeled as an Xbox pad, because that is the layout nearly every generic
 * XInput controller copies.
 */

export type PadFamily =
  'dualsense' | 'dualshock' | 'xbox' | 'switch' | 'generic'

const SONY = '054c'
const DUALSENSE_PRODUCTS = ['0ce6', '0df2']
const MICROSOFT = '045e'
const NINTENDO = '057e'

/** The USB vendor and product, from either engine's format, or null. */
export function usbIds(
  id: string,
): { readonly vendor: string; readonly product: string } | null {
  const chromium = /Vendor: ([0-9a-f]{4}) Product: ([0-9a-f]{4})/i.exec(id)
  const firefox = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id)
  const found = chromium ?? firefox
  if (found?.[1] === undefined || found[2] === undefined) return null
  return {
    vendor: found[1].toLowerCase().padStart(4, '0'),
    product: found[2].toLowerCase().padStart(4, '0'),
  }
}

export function padFamily(id: string): PadFamily {
  const ids = usbIds(id)
  if (ids !== null) {
    if (ids.vendor === SONY)
      return DUALSENSE_PRODUCTS.includes(ids.product)
        ? 'dualsense'
        : 'dualshock'
    if (ids.vendor === MICROSOFT) return 'xbox'
    if (ids.vendor === NINTENDO) return 'switch'
  }
  const name = id.toLowerCase()
  if (name.includes('dualsense')) return 'dualsense'
  // A DualShock 4 names itself "Wireless Controller" and nothing else.
  if (name.includes('dualshock') || name.startsWith('wireless controller'))
    return 'dualshock'
  if (name.includes('xbox') || name.includes('xinput')) return 'xbox'
  if (name.includes('pro controller') || name.includes('joy-con'))
    return 'switch'
  return 'generic'
}

/** Whether a family prints PlayStation's shapes on its face buttons. */
export const isPlayStation = (family: PadFamily): boolean =>
  family === 'dualsense' || family === 'dualshock'

/** A product name, for the connection notice and the controls page. */
export function familyName(family: PadFamily): string {
  switch (family) {
    case 'dualsense':
      return 'DualSense'
    case 'dualshock':
      return 'DualShock 4'
    case 'xbox':
      return 'Xbox controller'
    case 'switch':
      return 'Switch Pro controller'
    case 'generic':
      return 'Controller'
  }
}

/** Two names per control: the glyph a prompt prints, and the words for it. */
interface PadNames {
  readonly glyph: string
  readonly name: string
}

type ButtonTable = Readonly<
  Record<Exclude<PadControl, `${'ls' | 'rs'}.${string}`>, PadNames>
>

const SHARED = {
  up: { glyph: 'D-pad ↑', name: 'D-pad up' },
  down: { glyph: 'D-pad ↓', name: 'D-pad down' },
  left: { glyph: 'D-pad ←', name: 'D-pad left' },
  right: { glyph: 'D-pad →', name: 'D-pad right' },
} as const

/*
 * The four shapes as text, for a title and a screen reader.
 *
 * `✕` is U+2715 and not the letter x, and `○` `□` `△` are the geometric shapes
 * rather than emoji, so no platform swaps in a colored picture. The visual
 * prompt draws the shapes itself (`PadGlyph`); these are for where only a
 * string can go.
 */
const PLAYSTATION: ButtonTable = {
  south: { glyph: '✕', name: 'Cross' },
  east: { glyph: '○', name: 'Circle' },
  west: { glyph: '□', name: 'Square' },
  north: { glyph: '△', name: 'Triangle' },
  l1: { glyph: 'L1', name: 'L1' },
  r1: { glyph: 'R1', name: 'R1' },
  l2: { glyph: 'L2', name: 'L2' },
  r2: { glyph: 'R2', name: 'R2' },
  select: { glyph: 'Create', name: 'Create' },
  start: { glyph: 'Options', name: 'Options' },
  l3: { glyph: 'L3', name: 'L3, press the left stick' },
  r3: { glyph: 'R3', name: 'R3, press the right stick' },
  ...SHARED,
  home: { glyph: 'PS', name: 'PS button' },
  touchpad: { glyph: 'Touchpad', name: 'Touchpad press' },
}

const XBOX: ButtonTable = {
  south: { glyph: 'A', name: 'A' },
  east: { glyph: 'B', name: 'B' },
  west: { glyph: 'X', name: 'X' },
  north: { glyph: 'Y', name: 'Y' },
  l1: { glyph: 'LB', name: 'Left bumper' },
  r1: { glyph: 'RB', name: 'Right bumper' },
  l2: { glyph: 'LT', name: 'Left trigger' },
  r2: { glyph: 'RT', name: 'Right trigger' },
  select: { glyph: 'View', name: 'View' },
  start: { glyph: 'Menu', name: 'Menu' },
  l3: { glyph: 'LS', name: 'Press the left stick' },
  r3: { glyph: 'RS', name: 'Press the right stick' },
  ...SHARED,
  home: { glyph: 'Guide', name: 'Xbox button' },
  touchpad: { glyph: 'Share', name: 'Share' },
}

/** Nintendo's letters sit where Xbox's mirror: A is east, B is south. */
const SWITCH: ButtonTable = {
  south: { glyph: 'B', name: 'B' },
  east: { glyph: 'A', name: 'A' },
  west: { glyph: 'Y', name: 'Y' },
  north: { glyph: 'X', name: 'X' },
  l1: { glyph: 'L', name: 'L' },
  r1: { glyph: 'R', name: 'R' },
  l2: { glyph: 'ZL', name: 'ZL' },
  r2: { glyph: 'ZR', name: 'ZR' },
  select: { glyph: '−', name: 'Minus' },
  start: { glyph: '+', name: 'Plus' },
  l3: { glyph: 'L stick', name: 'Press the left stick' },
  r3: { glyph: 'R stick', name: 'Press the right stick' },
  ...SHARED,
  home: { glyph: 'Home', name: 'Home' },
  touchpad: { glyph: 'Capture', name: 'Capture' },
}

function buttonTable(family: PadFamily): ButtonTable {
  if (isPlayStation(family)) return PLAYSTATION
  if (family === 'switch') return SWITCH
  return XBOX
}

const ARROWS = { up: '↑', down: '↓', left: '←', right: '→' } as const

/** What a control is called on this family of pad. */
export function padNames(control: PadControl, family: PadFamily): PadNames {
  if (isPadStick(control)) {
    const left = control.startsWith('ls')
    const direction = control.slice(3) as keyof typeof ARROWS
    const stick = family === 'xbox' || family === 'generic' ? 'S' : ''
    return {
      glyph: `${left ? 'L' : 'R'}${stick} ${ARROWS[direction]}`,
      name: `${left ? 'Left' : 'Right'} stick ${direction}`,
    }
  }
  const names = buttonTable(family)[control]
  // The DualShock 4 called its select button Share; the DualSense renamed it.
  if (family === 'dualshock' && control === 'select')
    return { glyph: 'Share', name: 'Share' }
  return names
}

/** The glyph alone, which is what a prompt and a tooltip print. */
export const padLabel = (control: PadControl, family: PadFamily): string =>
  padNames(control, family).glyph
