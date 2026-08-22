import type { ReactNode } from 'react'
import { FOCUS_RING, releaseFocus } from './focus.ts'
import { isBoolean, usePersistentState } from './panelState.ts'

/*
 * The three pieces of chrome every panel in the dock is built from.
 *
 * They exist as one definition because the dock is now two panels rather than
 * one, and a label that reads `text-slate-400` in one and `text-slate-300` in
 * the other is the sort of drift that makes an overlay look like two overlays.
 *
 * Labels are `slate-400` and not the `slate-500` they used to be, and that is a
 * contrast floor rather than a preference. Measured with the Sun filling the
 * frame, a 500 label on this panel is 3.2:1; on a *fully opaque* slate-950 it is
 * still only 4.24:1. Nothing about the panel can reach 4.5:1 from there — the
 * ink has to move, so it did, here, once, for every panel.
 */

/** A titled, collapsible group. `id` is what its open state is remembered by. */
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
  return (
    <div className="mb-2 last:mb-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          releaseFocus(event)
          setOpen(!open)
        }}
        className={`flex min-h-6 w-full items-center gap-1 text-left text-[10px] tracking-widest text-sky-400/80 uppercase hover:text-sky-300 ${FOCUS_RING}`}
      >
        <span className="w-2 shrink-0 text-slate-400">{open ? '▾' : '▸'}</span>
        <span className="shrink-0">{title}</span>
        {/* Trailing is the dynamic half — a body name, a system count — so it
            is the half that shrinks. A long one used to squeeze the title it
            was annotating out of its own heading. */}
        {trailing !== undefined && (
          <span
            className="ml-auto min-w-0 truncate normal-case tracking-normal text-slate-400"
            title={trailing}
          >
            {trailing}
          </span>
        )}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  )
}

export function Row({
  label,
  value,
  wrap = false,
}: {
  label: string
  value: string
  wrap?: boolean
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span
        // A truncated readout in a panel whose entire purpose is inspectability
        // is a value you cannot read and cannot recover. The title is the
        // recovery, and it costs nothing on the rows that do not truncate.
        title={wrap ? undefined : value}
        className={
          wrap
            ? 'break-all text-right text-slate-300'
            : 'truncate text-right text-slate-300'
        }
      >
        {value}
      </span>
    </div>
  )
}

/**
 * A button that gives focus back to the flight loop when a pointer took it.
 *
 * See `releaseFocus`. Every control in this overlay is fire-and-forget, so
 * there is nothing to lose by refusing pointer focus, and the alternative is
 * remembering this at each call site.
 */
export function Action({
  label,
  onClick,
  disabled = false,
  title,
  tone = 'normal',
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  tone?: 'normal' | 'primary'
}) {
  const palette =
    tone === 'primary'
      ? 'border-sky-500/50 bg-sky-500/15 text-sky-200 hover:border-sky-400 hover:bg-sky-500/25'
      : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-sky-500/60 hover:text-sky-200'
  return (
    <button
      type="button"
      title={title ?? label}
      disabled={disabled}
      onClick={(event) => {
        releaseFocus(event)
        onClick()
      }}
      /*
       * `min-h-6 min-w-6` — 24 px, which is WCAG 2.2's target minimum and not
       * a round number picked for looks. At `py-0.5` around a 10 px label these
       * came out 22 px tall and the narrowest (`−`, `+`) were 20 px wide, which
       * passes only through the spacing exception and only while the gaps
       * around them stay wide. The box grows; the label does not.
       */
      className={`inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded border px-1.5 py-0.5 text-[10px] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-slate-700 disabled:hover:text-slate-300 ${FOCUS_RING} ${palette}`}
    >
      {label}
    </button>
  )
}
