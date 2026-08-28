/*
 * A key combination, by the physical key rather than by the character on it.
 *
 * `event.code` and not `event.key`, and the difference is the whole reason this
 * file exists. Six window-level listeners read one or the other with no rule
 * about which, which is why `+` carried a comment about `Shift`: `+` *is*
 * `Shift+Equal` on every layout this ships to, so a handler reading `event.key`
 * sees a modifier that carries no information, and one reading `event.code`
 * sees `Equal` whether or not Shift is down. A binding tied to the physical key
 * is the only kind that survives a keyboard change — a French AZERTY user who
 * rebinds a key gets the key they pressed, not the letter that key would type
 * on a keyboard they do not own.
 *
 * The *label* is the other half, and it goes the other way: nobody wants to be
 * told to press `BracketLeft`. `navigator.keyboard.getLayoutMap()` answers what
 * a physical key types on the keyboard actually attached, and where it does not
 * exist — every browser but Chromium's, as of writing — the table below is the
 * US answer, which is the right guess and is labelled as one.
 *
 * A leaf module: `state/preferences.ts` needs to guard a stored chord and
 * `keymap.ts` needs to resolve one, and neither may import the other.
 */

/**
 * A physical key plus the two modifiers a binding may carry.
 *
 * Not four modifiers. `Meta` and `Ctrl` belong to the browser and the operating
 * system — `Cmd+W`, `Ctrl+R`, `Cmd+Left` — and a mode that claims one is
 * breaking the platform to move a camera. The editor refuses them, and the
 * shape refusing to hold them is what keeps a default table from quietly
 * containing one.
 */
export interface Chord {
  /** `KeyboardEvent.code`: `KeyW`, `BracketLeft`, `ArrowUp`, `F5`. */
  readonly code: string
  readonly shift: boolean
  readonly alt: boolean
}

export const chord = (
  code: string,
  modifiers: { shift?: boolean; alt?: boolean } = {},
): Chord => ({
  code,
  shift: modifiers.shift === true,
  alt: modifiers.alt === true,
})

/**
 * The keys no binding may take, whatever the editor is asked for.
 *
 * `Tab` is how a browser moves focus and a window-level `preventDefault` always
 * wins, so a mode that binds it owns focus navigation whether it means to or
 * not — `useShipControls` documents the session where every focus ring in the
 * overlay was unreachable by keyboard for exactly this reason. `Escape` closes
 * a dialog and skips a cutscene, which are the platform's gesture and the one
 * act that must never be rebindable away. `F11` and `F12` are full screen and
 * devtools.
 */
export const REFUSED_CODES: readonly string[] = ['Tab', 'Escape', 'F11', 'F12']

/** Whether a chord may be bound at all. */
export const isBindable = (candidate: Chord): boolean =>
  !REFUSED_CODES.includes(candidate.code) && candidate.code !== ''

export const chordEquals = (a: Chord, b: Chord): boolean =>
  a.code === b.code && a.shift === b.shift && a.alt === b.alt

/** What a keyboard event is, as a chord — or null when it is the browser's. */
export function chordFromEvent(event: {
  readonly code: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}): Chord | null {
  // A modified key is on its way somewhere else. Declining it here rather than
  // per-action is what keeps `Cmd+R` a reload in every mode.
  if (event.ctrlKey || event.metaKey) return null
  const candidate = chord(event.code, {
    shift: event.shiftKey,
    alt: event.altKey,
  })
  return isBindable(candidate) ? candidate : null
}

/**
 * The stored form: modifiers then the code, joined by `+`.
 *
 * A string rather than an object, because this is what lands in
 * `localStorage` and a hand-edited `"Shift+KeyH"` is a thing somebody can read
 * and fix. The order is fixed so the serialization is a function of the chord
 * rather than of the order its fields were written.
 */
export function formatChord(candidate: Chord): string {
  const parts: string[] = []
  if (candidate.alt) parts.push('Alt')
  if (candidate.shift) parts.push('Shift')
  parts.push(candidate.code)
  return parts.join('+')
}

/** The inverse. `null` for anything this build would not have written. */
export function parseChord(text: string): Chord | null {
  if (typeof text !== 'string' || text === '') return null
  const parts = text.split('+')
  const code = parts.pop()
  if (code === undefined || code === '') return null
  let shift = false
  let alt = false
  for (const part of parts) {
    if (part === 'Shift') shift = true
    else if (part === 'Alt') alt = true
    // Anything else is from a build that meant something else — including the
    // `Ctrl` and `Meta` this shape deliberately cannot hold.
    else return null
  }
  const candidate = chord(code, { shift, alt })
  return isBindable(candidate) ? candidate : null
}

/**
 * What a physical key types, on a US layout.
 *
 * The fallback for every browser without `navigator.keyboard`, and the source
 * of the glyphs that are not letters at all — an arrow key types nothing, so no
 * layout map has an answer for it. Only the codes this build actually binds
 * plus the ranges a rebind can reach: a `code` with no entry falls back to
 * itself, which is ugly and is never wrong.
 */
const US_LABELS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Minus: '−',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: '’',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
}

/**
 * The characters Shift produces on a US layout, for the punctuation this binds.
 *
 * `Shift+Slash` is `?` and `Shift+Comma` is `<`, and printing them as
 * "Shift + /" would be describing the gesture instead of naming the key. The
 * keys sheet says `?` because that is what the help is called everywhere.
 */
const US_SHIFTED: Readonly<Record<string, string>> = {
  Slash: '?',
  Comma: '<',
  Period: '>',
  Semicolon: ':',
  Quote: '"',
  Backquote: '~',
  Minus: '_',
  Equal: '+',
  BracketLeft: '{',
  BracketRight: '}',
  Backslash: '|',
}

/** What one physical key is called, before any modifier. */
export function codeLabel(
  code: string,
  layout?: ReadonlyMap<string, string> | null,
): string {
  const mapped = layout?.get(code)
  if (mapped !== undefined && mapped !== '') return mapped.toUpperCase()
  const known = US_LABELS[code]
  if (known !== undefined) return known
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  return code
}

/**
 * What to tell somebody to press.
 *
 * A shifted punctuation key gets the character it produces rather than
 * "Shift + the unshifted one", because that is what every keyboard in the world
 * has printed on it and it is how the help has always read. A shifted letter
 * keeps the modifier, because `Shift+H` is genuinely two keys and `H` alone is
 * already bound to something else.
 */
export function chordLabel(
  candidate: Chord,
  layout?: ReadonlyMap<string, string> | null,
): string {
  const shifted = candidate.shift ? US_SHIFTED[candidate.code] : undefined
  const base =
    shifted !== undefined && layout?.get(candidate.code) === undefined
      ? shifted
      : null
  const parts: string[] = []
  if (candidate.alt) parts.push('Alt')
  if (base === null && candidate.shift) parts.push('Shift')
  parts.push(base ?? codeLabel(candidate.code, layout))
  return parts.join(' + ')
}

/**
 * The browser's answer for what the attached keyboard types, or null.
 *
 * Asked once and cached by the caller: `getLayoutMap` is a promise and this is
 * read by every label on screen. Chromium is the only family that implements
 * it, which is stated rather than hidden — the fallback is the US table above
 * and it is right for most people and wrong for some, and a label that is
 * wrong is better than a label that is absent.
 */
export async function keyboardLayout(): Promise<ReadonlyMap<
  string,
  string
> | null> {
  const keyboard = (
    navigator as Navigator & {
      keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> }
    }
  ).keyboard
  if (keyboard?.getLayoutMap === undefined) return null
  try {
    return await keyboard.getLayoutMap()
  } catch {
    return null
  }
}
