import { OptionGroup } from './OptionGroup.tsx'

/**
 * One surface lever: a label, the line that says what it costs, and the
 * option group that sets it — the two-line shape `SwitchRow` uses, for the
 * reason it gives: on one line the explanation is the half that truncates.
 */
export function SurfaceRow<T extends string>({
  label,
  detail,
  value,
  values,
  onChange,
}: {
  label: string
  detail: string
  value: T
  values: readonly T[]
  onChange: (next: T) => void
}) {
  return (
    <div className="mt-1 flex min-h-9 items-center justify-between gap-2.5 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="type-ui text-slate-300">{label}</span>
        <span className="type-ui text-pretty text-slate-400">{detail}</span>
      </span>
      <OptionGroup
        label={label}
        value={value}
        values={values}
        onChange={onChange}
      />
    </div>
  )
}
