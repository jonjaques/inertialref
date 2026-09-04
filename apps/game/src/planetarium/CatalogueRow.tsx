import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TravelTarget } from '@inertialref/devtools'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { iconForKind, starColour } from './kinds.ts'

/**
 * One row of the catalog: what it is, what it is called, where it sits.
 *
 * Three facts share this row and none of them is the same fact.
 *
 * **The glyph is the class.** It used to be the address's *depth* — a star, a
 * circle for anything two levels down and a globe for everything else — so
 * Ganymede and Pluto drew identically and Bennu drew as Earth. `kinds.ts` owns
 * that mapping now and there are nine shapes.
 *
 * **The tint is the sky.** A star carries its own colour, computed from its
 * effective temperature, because `docs/design/art.md` puts that on the list of
 * things this game may not invent: a K dwarf is orange and does not get to be a
 * nicer orange. A body has no light of its own, so it takes the interface's
 * ink and says whether it is loaded with it.
 *
 * **The number is what explains the order.** A system's is its distance from
 * the eye, because the survey is sorted by it. A body's is its semi-major axis,
 * because the tree under a star is sorted outward — a column of distances from
 * the camera under a heading sorted by orbit is two orders in one list, and the
 * reader has to work out which one they are looking at.
 *
 * **The row is a tree item, and the list has one tab stop.** The panel that
 * renders these owns the keyboard: `Tab` lands on the current row and leaves
 * from it, the arrows move between rows and fold a system open or closed. So
 * exactly one row carries `tabIndex` 0 — `tabbable` — and the rest are
 * reachable by arrow and by pointer only. The hierarchy is stated with
 * `aria-level` rather than nested groups, which ARIA allows for a tree whose
 * DOM is flat, and it is flat here because each row is its own `<li>`.
 */
export function CatalogueRow({
  row,
  selected,
  indent,
  measure,
  tabbable,
  parent,
  expanded,
  onExpand,
  onFocus,
}: {
  row: TravelTarget
  selected: boolean
  /** 0 for a system, 1 for a planet, 2 for a moon. Drawn, not derived. */
  indent: number
  /** The reading at the end of the row, already in its own unit. */
  measure: string
  /** Whether this is the list's one tab stop. */
  tabbable: boolean
  /** The system row a body's `←` returns to; absent on a system. */
  parent?: string
  /** Present only on a system that has bodies to fold. */
  expanded?: boolean
  onExpand?: () => void
  onFocus: () => void
}) {
  const Glyph = iconForKind(row.bodyKind)
  const tint = starColour(row.colour)
  const foldable = expanded !== undefined && onExpand !== undefined
  const Chevron = expanded === true ? ChevronDown : ChevronRight

  return (
    <li role="none" className="flex items-stretch">
      {/*
       * The disclosure is its own button, beside the row rather than inside it.
       *
       * Nested interactive elements are invalid and a screen reader reports
       * them as one confused control — and the two really are different verbs:
       * folding Sol away is not the same act as pointing the camera at it, and
       * a reader who wanted the first and got the second has just flown four
       * light years. 24 px wide, which is WCAG 2.2's target minimum.
       *
       * Out of the tab order, for a pointer only: the keyboard folds with `→`
       * and `←` on the row itself, which is the tree pattern, and a second
       * stop per system would put the depth this list just gave up straight
       * back.
       */}
      {foldable ? (
        <button
          type="button"
          tabIndex={-1}
          // State as well as action: out of the tab order it is still a
          // control a screen reader reaches by pointer or by touch, and
          // "Expand Sol" alone says what pressing it does and not what it
          // would be undoing.
          aria-expanded={expanded}
          aria-label={`${expanded === true ? 'Collapse' : 'Expand'} ${row.name}`}
          onClick={(event) => {
            releaseFocus(event)
            onExpand()
          }}
          className={`flex w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:text-sky-300 ${FOCUS_RING}`}
        >
          <Chevron aria-hidden className="size-3.5" />
        </button>
      ) : (
        <span aria-hidden className="w-6 shrink-0" />
      )}

      <button
        type="button"
        role="treeitem"
        aria-level={indent + 1}
        aria-selected={selected}
        aria-expanded={foldable ? expanded : undefined}
        tabIndex={tabbable ? 0 : -1}
        data-catalog-row=""
        data-address={row.address}
        data-parent={parent}
        title={row.detail}
        onClick={(event) => {
          releaseFocus(event)
          onFocus()
        }}
        style={{ paddingLeft: `${indent * 0.75 + 0.125}rem` }}
        /*
         * 28 px rather than the 44 the touch guidance asks for, and it is a
         * trade rather than an oversight: Sol is a hundred and twenty-nine
         * bodies, and at 44 px this list is five and a half thousand pixels
         * tall. It clears WCAG 2.2's 24 px target minimum, the row is the full
         * width of the panel, and the disclosure beside it is what keeps the
         * list short enough to be scanned rather than scrolled.
         */
        className={`group flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded pr-1.5 text-left transition-colors ${FOCUS_RING} ${
          selected
            ? 'bg-sky-500/15 text-sky-100'
            : 'text-slate-300 hover:bg-slate-800/60 hover:text-sky-100'
        }`}
      >
        <Glyph
          aria-hidden
          className={`size-3.5 shrink-0 transition-colors ${
            tint !== null
              ? ''
              : // Loaded means the system is generated and its frames
                // installed — the difference between a body you can look at
                // and one that is still a stub in the catalog.
                row.loaded
                ? 'text-sky-400/80'
                : 'text-slate-400'
          }`}
          // A star's measured colour beats the palette; nothing else has one.
          // Dimmed until the system is generated, which is the same claim the
          // slate glyph makes for a body and the only one left to make here.
          style={
            tint === null
              ? undefined
              : { color: tint, opacity: row.loaded ? 1 : 0.55 }
          }
        />
        <span className="type-ui min-w-0 flex-1 truncate">{row.name}</span>
        {/* The epistemic fact, stated rather than implied — the one claim
            PRODUCT.md says the interface always makes. It is a claim about the
            *record*, not about the place: a projected world is out there, it
            has simply been worked out from its star's parameters rather than
            confirmed by anybody going. `docs/design/galaxy.md` writes the
            sentence and this is the short form of it. Only `projected` is
            marked, because everything the catalog holds is observed and a badge
            on those would be noise on the majority of rows. */}
        {row.provenance === 'projected' && (
          <span
            aria-label="Projected from stellar parameters — not confirmed"
            title="Projected from stellar parameters — not confirmed"
            className="type-micro shrink-0 rounded-sm bg-slate-800/80 px-1 text-slate-400"
          >
            proj
          </span>
        )}
        <span className="type-micro shrink-0 text-slate-400 tabular-nums">
          {measure}
        </span>
      </button>
    </li>
  )
}
