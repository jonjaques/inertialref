import { BRANDMARK_PATHS, BRANDMARK_VIEW_BOX } from './brandmark.ts'

/*
 * The mark, in the interface.
 *
 * The drawing itself lives in `design/brand/brandmark.svg` and reaches this
 * file through `brandmark.ts`, which `pnpm brand` generates from it along with
 * the favicon, the PWA icons and the share card. There used to be two hand-kept
 * copies — this component and `public/favicon.svg` — with a comment on each
 * asking the next person to keep them in step. `pnpm brand --check` is in
 * `pnpm check` now, so it is checked rather than asked for.
 *
 * The construction, and why it is the way it is, is documented at the source.
 * What belongs here is why this is a component at all:
 *
 * Not a `createLucideIcon`, and deliberately: those are 24 x 24 two-pixel
 * strokes in `currentColor` by contract, and a logomark that inherited the
 * color of the text beside it would stop being a logomark. It takes a
 * `className` for sizing and nothing else.
 */
export function Logomark({ className = 'size-4' }: { className?: string }) {
  return (
    <svg
      viewBox={BRANDMARK_VIEW_BOX}
      className={className}
      fill="none"
      aria-hidden
      focusable="false"
    >
      {BRANDMARK_PATHS.map(({ d, fill }) => (
        <path key={d} d={d} fill={fill} />
      ))}
    </svg>
  )
}
