import { OptionGroup } from './OptionGroup.tsx'

/** Picture labels wrap within the dock instead of compressing their explanation. */
export function PictureRow<T extends string>({
  label,
  detail,
  value,
  values,
  labels,
  disabled,
  onChange,
}: {
  label: string
  detail: string
  value: T
  values: readonly T[]
  labels: Readonly<Record<T, string>>
  disabled: (value: T) => string | undefined
  onChange: (value: T) => void
}) {
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1.5 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1.5">
      <span className="type-ui text-slate-300">{label}</span>
      <OptionGroup
        label={label}
        value={value}
        values={values}
        labels={labels}
        disabled={disabled}
        onChange={onChange}
        className="max-w-full flex-wrap justify-start"
      />
      <span className="type-ui text-pretty text-slate-400">{detail}</span>
    </div>
  )
}
