import type { ReactNode } from 'react'
import { usePersistentState } from './panelState.ts'

/*
 * The three pieces of chrome every panel in the dock is built from.
 *
 * They exist as one definition because the dock is now two panels rather than
 * one, and a label that reads `text-slate-500` in one and `text-slate-400` in
 * the other is the sort of drift that makes an overlay look like two overlays.
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
  const [open, setOpen] = usePersistentState(`section.${id}`, true)
  return (
    <div className="mb-2 last:mb-0">
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.blur()
          setOpen(!open)
        }}
        className="flex w-full items-center gap-1 text-left text-[10px] uppercase tracking-widest text-sky-400/80 hover:text-sky-300"
      >
        <span className="w-2 text-slate-500">{open ? '▾' : '▸'}</span>
        <span>{title}</span>
        {trailing !== undefined && <span className="ml-auto normal-case tracking-normal text-slate-500">{trailing}</span>}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  )
}

export function Row({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={wrap ? 'break-all text-right text-slate-300' : 'truncate text-right text-slate-300'}>
        {value}
      </span>
    </div>
  )
}

/**
 * A button that gives focus straight back.
 *
 * Flight input is a window-level keydown handler, so a button that keeps focus
 * swallows Space — the pause key — and turns it into a second click on itself.
 * Every control in this overlay is fire-and-forget, so there is nothing to lose
 * by refusing focus, and the alternative is remembering this at each call site.
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
        event.currentTarget.blur()
        onClick()
      }}
      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-slate-700 disabled:hover:text-slate-300 ${palette}`}
    >
      {label}
    </button>
  )
}
