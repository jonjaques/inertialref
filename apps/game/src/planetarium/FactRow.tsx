import type { Fact } from '@inertialref/devtools'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING } from '../hud/focus.ts'

/**
 * One reading, and what to do when there is not one.
 *
 * The two halves are set in two different faces and that is the whole point: a
 * label is a word — the Record register, proportional, sentence case — and a
 * value is a reading the universe produced — the Instrument register,
 * monospaced and tabular. `hud/Row.tsx` makes the same argument and this is the
 * astronomer's version of it, with a third part: the gloss, which carries the
 * same quantity in the unit a reader actually thinks in. `5.97×10²⁴ kg` is a
 * number nobody has an intuition for and `1.00 M⊕` is the point of it.
 *
 * **An empty field is drawn, not skipped.** A row that is simply absent cannot
 * distinguish "this body has no atmosphere" from "nobody has measured its
 * atmosphere", and those are the two answers a planetarium most needs to keep
 * apart. So a `null` value is a muted "no data" with the reason behind a
 * tooltip — and the reason is in the universe's own voice, because the
 * planetarium is a reading room for a galaxy that is out there rather than a
 * debugger with a starfield behind it. `dossier.ts` § the header.
 *
 * The trigger is a real `<button>` rather than a `<span title>`. `title` is not
 * reachable from a keyboard and is announced inconsistently, and the reason is
 * the only content of the row.
 */
export function FactRow({ fact }: { fact: Fact }) {
  return (
    <div className="flex min-h-6 items-baseline justify-between gap-3">
      <span className="type-ui shrink-0 text-slate-400">{fact.label}</span>
      {fact.value === null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`type-readout cursor-help rounded text-right text-slate-400 underline decoration-slate-400/50 decoration-dotted underline-offset-4 transition-colors hover:text-slate-300 ${FOCUS_RING}`}
            >
              no data
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{fact.pending}</TooltipContent>
        </Tooltip>
      ) : (
        // Wrapping rather than truncating. This panel exists to be read, and a
        // reading clipped at the panel edge is a value you cannot recover —
        // the gloss is the half that drops to a second line, which is what it
        // is for.
        <span className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-1.5">
          <span className="type-readout text-right text-slate-200">
            {fact.value}
          </span>
          {/*
           * The gloss is `slate-400`, which is also the label's grade — and it
           * is not a missing distinction. `slate-500` measures 3.2:1 against
           * the Sun filling the frame and 4.24:1 on a fully opaque panel, so no
           * alpha and no darker ground gets it to 4.5:1; 400 is the floor and
           * there is nothing below it to be subordinate in. What separates a
           * label from a gloss here is position, face and size — sentence-case
           * sans on the left against a mono micro reading on the right — which
           * is what `DESIGN.md` § Neutral says to use once the grade runs out.
           */}
          {fact.note !== undefined && (
            <span className="type-micro text-right text-slate-400">
              {fact.note}
            </span>
          )}
        </span>
      )}
    </div>
  )
}
