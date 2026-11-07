import type { ReactNode } from 'react'

/**
 * One setting: what it is on the left, the control that sets it on the right.
 *
 * The row every settings page is made of, and the reason it is one component
 * rather than three: the display page drew a framed card with the options
 * under the label, a framed card with the options beside it, and a bare label
 * over a bare slider — three geometries for one kind of thing, so the eye had
 * to re-find the control on every row. Here the control is always in the same
 * column, and a hairline under the row separates it from the next one, which
 * is the Hairline Rule rather than a frame per row.
 *
 * **The container decides the arrangement, not the viewport.** The same rows
 * are drawn in the author's 19rem Graphics panel and on the settings page, and
 * only the page has room for a second column — so below 32rem of container
 * (`@lg`) the control drops under its label and takes the full width, and at
 * or above it the two sit side by side. The viewport says nothing about which
 * of those a row is in, and rule 30 says not to ask it.
 *
 * `changed` draws a bar in the row's left gutter when the value differs from
 * its default — the editor's modified-line mark, and a line rather than a dot
 * because the system has two circles and neither is this. It is what makes a
 * page's "restore defaults" a decision rather than a guess about what it will
 * undo, and since a bar is not a word it carries one for a screen reader.
 */
export function SettingRow({
  label,
  detail,
  changed = false,
  labelId,
  onHover,
  children,
}: {
  label: string
  /** One line saying what the setting does or costs. */
  detail?: ReactNode
  /** Whether the value differs from the preference's default. */
  changed?: boolean
  /** For a control that names itself through `aria-labelledby`. */
  labelId?: string
  /**
   * The pointer entering and leaving the row — for a page with a picture of
   * the thing being set, where the row being read lights its part of it.
   */
  onHover?: (over: boolean) => void
  /** The control: an option group, a slider with its reading, an action. */
  children: ReactNode
}) {
  return (
    <div
      onPointerEnter={onHover === undefined ? undefined : () => onHover(true)}
      onPointerLeave={onHover === undefined ? undefined : () => onHover(false)}
      className="group/row relative grid gap-x-6 gap-y-1.5 border-b border-slate-800/70 py-2.5 pl-2.5 last:border-b-0 @lg:grid-cols-[minmax(0,1fr)_auto] @lg:items-center"
    >
      {changed && (
        <span
          aria-hidden
          title="Changed from the default"
          className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-sky-400/80"
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="type-ui text-slate-200">
          {label}
          {changed && <span className="sr-only"> (changed)</span>}
        </span>
        {detail !== undefined && (
          <span className="type-ui text-pretty text-slate-400">{detail}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 @lg:justify-end">
        {children}
      </div>
    </div>
  )
}
