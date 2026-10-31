import { isPadStick, type PadControl } from './pad.ts'
import { isPlayStation, type PadFamily, padNames } from './padFamily.ts'

/**
 * One pad control, drawn as the prompt a game prints for it.
 *
 * Drawn here in `currentColor` rather than taken from a glyph set, and that
 * is a choice against Kenney's CC0 Input Prompts, which are the best licensed
 * set there is: they are filled icons in their own palette, and this
 * interface's rule is one accent and hairlines — a colored ✕ in a slate panel
 * would be the only four-color object on the screen. The PlayStation shapes
 * appear only for a PlayStation pad, to name a button on the pad the player
 * is holding, which is the one use of them that is not borrowing a brand.
 *
 * The words are the accessible name, so a screen reader says "Cross" where
 * the eye sees the shape.
 */
export function PadGlyph({
  control,
  family,
  className = '',
}: {
  readonly control: PadControl
  readonly family: PadFamily
  readonly className?: string
}) {
  const { glyph, name } = padNames(control, family)
  const face =
    control === 'south' ||
    control === 'east' ||
    control === 'west' ||
    control === 'north'
  const arm =
    control === 'up' ||
    control === 'down' ||
    control === 'left' ||
    control === 'right'
  if (face || arm)
    return (
      <svg
        role="img"
        aria-label={name}
        viewBox="0 0 16 16"
        className={`inline-block size-[1.4em] shrink-0 align-[-0.3em] ${className}`}
      >
        <title>{name}</title>
        {face ? faceMark(control, family, glyph) : dpadMark(control)}
      </svg>
    )
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`inline-flex h-[1.4em] shrink-0 items-center rounded-[0.35em] border border-current px-[0.35em] text-[0.9em] leading-none whitespace-nowrap ${
        isPadStick(control) ? 'rounded-full' : ''
      } ${className}`}
    >
      {glyph}
    </span>
  )
}

/**
 * A face button: a ring, and the shape or letter printed on it. A function
 * returning marks rather than a component, because this file draws one
 * component and these are its parts.
 */
function faceMark(
  control: 'south' | 'east' | 'west' | 'north',
  family: PadFamily,
  letter: string,
) {
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  return (
    <>
      <circle cx="8" cy="8" r="7.2" {...stroke} />
      {!isPlayStation(family) ? (
        <text
          x="8"
          y="8"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="8.5"
          fill="currentColor"
          className="font-semibold"
        >
          {letter}
        </text>
      ) : control === 'south' ? (
        <path d="M5.2 5.2 10.8 10.8M10.8 5.2 5.2 10.8" {...stroke} />
      ) : control === 'east' ? (
        <circle cx="8" cy="8" r="3.1" {...stroke} />
      ) : control === 'west' ? (
        <rect x="5.1" y="5.1" width="5.8" height="5.8" {...stroke} />
      ) : (
        <path d="M8 4.6 11.2 10.2H4.8Z" {...stroke} />
      )}
    </>
  )
}

/** The d-pad, with the pressed arm filled. */
function dpadMark(control: 'up' | 'down' | 'left' | 'right') {
  const arms = {
    up: 'M6 1.5h4v4.5L8 8 6 6Z',
    down: 'M6 14.5h4V10L8 8l-2 2Z',
    left: 'M1.5 6v4H6L8 8 6 6Z',
    right: 'M14.5 6v4H10L8 8l2-2Z',
  } as const
  return (
    <>
      {(Object.keys(arms) as (keyof typeof arms)[]).map((one) => (
        <path
          key={one}
          d={arms[one]}
          fill={one === control ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      ))}
    </>
  )
}
