import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { FOCUS_RING, releaseFocus } from './focus.ts'
import { isBoolean, usePersistentState } from './panelState.ts'

/*
 * A titled, collapsible group — the unit every panel in the dock is built
 * from. `id` is what its open state is remembered by.
 *
 * Radix's `Collapsible` under it, rather than the `{open && …}` this used to
 * be. What that buys is not the toggle, which was four lines: it is
 * `aria-controls` pointing at a content region that has an id, `data-state` on
 * both halves, and the content staying in the accessibility tree's shape when
 * it is closed. The open state is still ours, because it outlives the mount —
 * `usePersistentState` is the only reason a dock full of collapsed sections
 * survives a reload.
 *
 * Labels are `slate-400` and not the `slate-500` they used to be, and that is a
 * contrast floor rather than a preference. Measured with the Sun filling the
 * frame, a 500 label on this panel is 3.2:1; on a *fully opaque* slate-950 it is
 * still only 4.24:1. Nothing about the panel can reach 4.5:1 from there — the
 * ink has to move, so it did, here, once, for every panel.
 */

export function Section({
  id,
  title,
  trailing,
  children,
}: {
  id: string
  title: string
  trailing?: string
  children: ReactNode
}) {
  const [open, setOpen] = usePersistentState(`section.${id}`, true, isBoolean)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2 last:mb-0">
      <CollapsibleTrigger
        // Radix drives the open state, so this only has to hand focus back to
        // the flight loop — the toggle itself is `onOpenChange` above.
        onClick={releaseFocus}
        className={`type-label flex min-h-6 w-full items-center gap-1 text-left text-sky-400/80 hover:text-sky-300 ${FOCUS_RING}`}
      >
        {/* Lucide rather than `▾`/`▸`. The two glyphs are different widths in
            most monospace faces, so every heading shifted a fraction of a
            character sideways as it opened. */}
        <Chevron aria-hidden className="size-3 shrink-0 text-slate-400" />
        <span className="shrink-0">{title}</span>
        {/* Trailing is the dynamic half — a body name, a system count — so it
            is the half that shrinks. A long one used to squeeze the title it
            was annotating out of its own heading. */}
        {trailing !== undefined && (
          <span
            className="type-micro ml-auto min-w-0 truncate normal-case text-slate-400"
            title={trailing}
          >
            {trailing}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}
