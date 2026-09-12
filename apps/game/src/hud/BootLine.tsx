import { Check, LoaderCircle } from 'lucide-react'
import type { FirstLightState } from '../render/bootState.ts'

/**
 * The ledger's running line, on its own, for a page that stays readable
 * while the scene boots.
 *
 * The front door and the reading room are the two places a person can be
 * doing something during the wait, and a cover over either would take the
 * page away to say how long until the picture behind it arrives. So the
 * cover stays under those pages as a black ground, and the page draws this
 * where its own layout has a line to spare — the front door's footer, the
 * horizon's readout — in the Instrument register, because it is a readout.
 *
 * The running stage and its count, the ring while it runs and the check at
 * first light: the same three cells as a ledger row, in a row. No rule and no
 * history, because a page has room for one line and the ledger is the
 * cover's. What it does not do is decide when to leave; the page owns that,
 * because the exit belongs with whatever takes the line's place.
 */
export function BootLine({ boot }: { readonly boot: FirstLightState }) {
  const running = boot.stages[boot.stages.length - 1]
  const finished = boot.phase !== 'booting'
  if (running === undefined) return null
  return (
    <span className="type-readout inline-flex min-w-0 items-center gap-2 text-slate-400">
      <span className="truncate text-slate-300">
        {running.label}
        {!finished && running.count === null ? '…' : ''}
      </span>
      {running.count !== null && <span>{running.count}</span>}
      <span
        className="flex size-3 shrink-0 items-center justify-center text-sky-400"
        aria-hidden="true"
      >
        {finished ? (
          <Check className="size-3" />
        ) : (
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        )}
      </span>
    </span>
  )
}
