/**
 * A label and its value, on one line.
 *
 * The densest thing in the interface and the reason the panels exist: a
 * coordinate system you cannot see is a coordinate system you cannot debug.
 * Deliberately not a shadcn control — there is no registry component for "a
 * definition list row inside a 19 rem panel", and inventing one out of `Badge`
 * or `Separator` would be costume rather than structure.
 *
 * **The two halves are set in two different faces, and that is the whole
 * point.** A label is a word — the Record register, proportional, sentence
 * case — and a value is a reading the simulation produced — the Instrument
 * register, monospaced and tabular. They used to be the same monospace at the
 * same size in two grades of grey, which meant a column of forty rows had one
 * texture and the eye had nothing to catch on. Face is the strongest axis
 * available for a distinction this repetitive, and it costs no space at all.
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
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-ui shrink-0 text-slate-400">{label}</span>
      <span
        // A truncated readout in a panel whose entire purpose is inspectability
        // is a value you cannot read and cannot recover. The title is the
        // recovery, and it costs nothing on the rows that do not truncate.
        title={wrap ? undefined : value}
        className={
          wrap
            ? 'type-readout text-right break-all text-slate-300'
            : 'type-readout truncate text-right text-slate-300'
        }
      >
        {value}
      </span>
    </div>
  )
}
