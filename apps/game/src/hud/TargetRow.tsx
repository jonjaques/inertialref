import type { TravelTarget } from '@inertialref/devtools'
import { FOCUS_RING, releaseFocus } from './focus.ts'

/**
 * One row of the destination listing.
 *
 * Its own module so the overlay's smoke test can render real targets through
 * it — the panel itself only fills its list from an effect, and effects do not
 * run when the tree is rendered to static markup in Node.
 */
export function TargetRow({
  target,
  selected,
  onSelect,
}: {
  target: TravelTarget
  selected: boolean
  onSelect: () => void
}) {
  // Depth is 0, 1 or 2 — system, planet, moon — and the indent is what makes the
  // flat list read as the containment tree the addresses already describe.
  const indent = ['pl-1', 'pl-4', 'pl-7'][target.depth] ?? 'pl-7'
  return (
    <button
      type="button"
      onClick={(event) => {
        releaseFocus(event)
        onSelect()
      }}
      title={`${target.name} · ${target.address}`}
      aria-pressed={selected}
      /*
       * `min-h-6` rather than the old `py-[1px]`.
       *
       * The rows were 19.9 px tall and stacked with no gap, so consecutive
       * targets sat 19.9 px apart — inside the 24 px circles WCAG 2.2's
       * spacing exception measures, which is the one way an undersized target
       * cannot be excused. This is the densest list in the interface and it
       * costs about four pixels a row; the alternative is the list being the
       * one place the dock is genuinely hard to hit.
       */
      className={`flex min-h-6 w-full items-center gap-2 py-[1px] pr-1.5 text-left ${indent} ${FOCUS_RING} ${
        selected ? 'bg-sky-500/20 text-sky-100' : 'hover:bg-slate-800/60'
      }`}
    >
      <span
        className={
          target.kind === 'system'
            ? 'shrink-0 text-amber-300/80'
            : 'shrink-0 text-slate-400'
        }
      >
        {target.kind === 'system' ? '★' : target.landable ? '◍' : '·'}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {target.name}
        <span className="ml-1.5 text-slate-400">{target.detail}</span>
      </span>
      {/* Loaded reads as a value, unloaded as a stale one — 300 against 400,
          which is the grade DESIGN.md already names for "a stale distance".
          It used to be 400 against 600, and 600 is below the contrast floor. */}
      <span
        className={`shrink-0 tabular-nums ${target.loaded ? 'text-slate-300' : 'text-slate-400'}`}
      >
        {target.distanceText}
      </span>
    </button>
  )
}
