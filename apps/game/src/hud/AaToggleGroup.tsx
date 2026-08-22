import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AaLevel } from '../render/output.ts'
import { FOCUS_RING, releaseFocus } from './focus.ts'

/**
 * The anti-aliasing level, as a single-select group.
 *
 * `type="single"` in Radix reports `''` when the pressed item is pressed again
 * — deselecting is a thing a toggle group can legitimately do, and it is not a
 * thing this control may do: there is no "no anti-aliasing level", `off` is
 * already one of the three. So an empty value is ignored rather than written,
 * which turns the second press into a no-op instead of a renderer rebuilt for a
 * setting nobody chose.
 */
export function AaToggleGroup({
  value,
  values,
  onChange,
}: {
  value: AaLevel
  values: readonly AaLevel[]
  onChange: (level: AaLevel) => void
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={value}
      aria-label="Anti-aliasing"
      onValueChange={(next) => {
        if (next === '') return
        onChange(next as AaLevel)
      }}
      className="shrink-0"
    >
      {values.map((level) => (
        <ToggleGroupItem
          key={level}
          value={level}
          onClick={releaseFocus}
          // 24 px tall and 24 wide at the narrowest label (`4x`), which is
          // WCAG 2.2's target minimum. `size="sm"` alone is `h-8`, which is
          // taller than every other control in this panel.
          className={`h-6 min-w-6 border-slate-700 px-2 text-[10px] tracking-widest uppercase data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
        >
          {level}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
