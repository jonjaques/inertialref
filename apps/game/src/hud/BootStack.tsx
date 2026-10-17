import { Check, LoaderCircle } from 'lucide-react'
import type { FirstLightState } from '../render/bootState.ts'

/**
 * The ledger's running line, broken over two: the stage, then its count.
 *
 * `BootLine` sets the same three cells in one row, which needs the width of
 * the longest stage name plus a count, and the front door's footer never has
 * it — five links already fill the 33rem column. In a wrapping row the line
 * then moved between beside the links and below them as the stage names
 * changed length, and the column, centered on its height, moved with it. Two
 * lines at a fixed width hold one shape whatever the stage is called.
 *
 * Right-aligned with the glyph in a trailing cell, as the cover's ledger sets
 * its rows: a label of any length ends on the same edge as the ring. Placement
 * and exit are the page's, as they are for `BootLine`.
 */
export function BootStack({ boot }: { readonly boot: FirstLightState }) {
  const running = boot.stages[boot.stages.length - 1]
  const finished = boot.phase !== 'booting'
  if (running === undefined) return null
  return (
    <span className="type-readout grid w-[min(18rem,100%)] grid-cols-[minmax(0,1fr)_0.75rem] gap-x-2 text-right text-slate-400">
      <span className="truncate text-slate-300">
        {running.label}
        {!finished && running.count === null ? '…' : ''}
      </span>
      <span
        className="flex size-3 items-center justify-center self-center text-sky-400"
        aria-hidden="true"
      >
        {finished ? (
          <Check className="size-3" />
        ) : (
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        )}
      </span>
      {running.count !== null && <span>{running.count}</span>}
    </span>
  )
}
