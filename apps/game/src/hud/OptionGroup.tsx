import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FOCUS_RING, releaseFocus } from './focus.ts'

/**
 * A short, closed set of choices, all on screen at once.
 *
 * The shape a setting takes here when the options are countable and worth
 * naming: anti-aliasing is `off · 2× · 4×`, extended-range output is
 * `auto · extended · standard`. Both were a single button that *cycled* —
 * press it and the label changes — which is the control you reach for when the
 * set is unbounded, and it hides two thirds of it. A radio group says what the
 * options are, which one is current, and how to reach a specific one in one
 * press. It is also the shape a screen reader can report.
 *
 * Generic over the value because it was two components before this and they had
 * already drifted: the anti-aliasing group was 24px tall and the output control
 * was a 24px push button, sitting one section apart in the same panel.
 *
 * `type="single"` in Radix reports `''` when the pressed item is pressed again
 * — deselecting is a thing a toggle group can legitimately do, and it is not a
 * thing either of these may do: there is no "no anti-aliasing level", `off` is
 * already one of the three. So an empty value is ignored rather than written,
 * which turns the second press into a no-op instead of a renderer rebuilt for a
 * setting nobody chose.
 */
export function OptionGroup<T extends string>({
  label,
  value,
  values,
  labels,
  onChange,
  className = '',
}: {
  /** The accessible name of the set, e.g. "Anti-aliasing". */
  label: string
  value: T
  values: readonly T[]
  /**
   * What each option is called, where the stored id is not a word.
   *
   * `off · 2× · 4×` and `sparse · normal · dense` are already the words; an
   * orbit scope is `context` and `all`, which are the names the presentation
   * field goes by and not a choice anybody recognizes on a chip. The id stays
   * the value — a stored preference must not change when a label is reworded.
   */
  labels?: Readonly<Record<string, string>>
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        if (next === '') return
        onChange(next as T)
      }}
      className={`shrink-0 ${className}`}
    >
      {values.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          onClick={releaseFocus}
          // 24 px tall and 24 wide at the narrowest label (`4x`), which is
          // WCAG 2.2's target minimum. `size="sm"` alone is `h-8`, which is
          // taller than every other control in these panels.
          className={`type-label h-6 min-w-6 border-slate-700 px-2 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
        >
          {labels?.[option] ?? option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
