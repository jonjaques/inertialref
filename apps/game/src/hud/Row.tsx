/**
 * A label and its value, on one line.
 *
 * The densest thing in the interface and the reason the dock exists: a
 * coordinate system you cannot see is a coordinate system you cannot debug.
 * Deliberately not a shadcn control — there is no registry component for "a
 * definition list row inside a 27 rem panel", and inventing one out of `Badge`
 * or `Separator` would be costume rather than structure.
 */
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
            ? 'text-right break-all text-slate-300'
            : 'truncate text-right text-slate-300'
        }
      >
        {value}
      </span>
    </div>
  )
}
