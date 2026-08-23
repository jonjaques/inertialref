/*
 * The mark.
 *
 * Three sheared bars, descending, narrowing and dimming — a vector still
 * carrying the momentum of the one before it, which is the only idea in the
 * product's name. It replaces a violet lightning glyph that shared no colour
 * with anything in the running interface and that DESIGN.md had already flagged
 * as a placeholder.
 *
 * Everything about the construction is a consequence of it having to survive a
 * 16 px browser tab:
 *
 *   - **Three parts, no strokes.** Filled shapes hold their weight at any size;
 *     a hairline outline at 16 px is either invisible or the whole mark.
 *   - **The gaps are wider than they look right at 32 px.** 3.75 units of 32 is
 *     just under 2 px in a favicon, which is the floor at which a gap still
 *     reads as a gap rather than as a smudge.
 *   - **The three tones are three steps of the accent ramp, not an opacity
 *     fade.** Opacity would composite against whatever is behind the mark, and
 *     the two places it is drawn — a tab strip and the menu bar — are different
 *     shades of dark on every platform.
 *
 * Not a `createLucideIcon`, and deliberately: those are 24 × 24 two-pixel
 * strokes in `currentColor` by contract, and a logomark that inherited the
 * colour of the text beside it would stop being a logomark. It takes a
 * `className` for sizing and nothing else.
 */

/** The accent ramp, brightest first: sky-100, sky-300, sky-500. */
const TONES = ['#e0f2fe', '#7dd3fc', '#0ea5e9'] as const

const BARS = [
  'M12 2.5H30L25 9H7Z',
  'M10 12.75H25.5L20.5 19.25H5Z',
  'M8 23H21L16 29.5H3Z',
] as const

export function Logomark({ className = 'size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden
      focusable="false"
    >
      {BARS.map((d, index) => (
        <path key={d} d={d} fill={TONES[index]} />
      ))}
    </svg>
  )
}
