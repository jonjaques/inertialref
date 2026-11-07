import { Slider } from '@/components/ui/slider'
import { releaseFocus } from './focus.ts'

/**
 * A setting's slider: the travel, then what it reads.
 *
 * The reading sits at the end of the travel rather than above it, because in a
 * `SettingRow` the label is already on the left and a second label over the
 * track would be the row naming itself twice. The reading is a fixed width,
 * so a value that grows a digit does not slide the travel under the pointer.
 *
 * The geometry is `LensSlider`'s — 24px of hit area around a 6px track, the
 * padded root being what a pointer lands on — and its width follows the row:
 * the full width when the row has stacked the control under its label, a
 * fixed one when the control sits beside it, so sliders on one page share a
 * travel and a value reads the same distance along every one of them.
 */
export function SliderControl({
  label,
  min,
  max,
  step,
  value,
  reading,
  spoken,
  disabled = false,
  onChange,
}: {
  /** The slider's name, as the row's label says it. */
  label: string
  min: number
  max: number
  step: number
  value: number
  /** What the value reads, drawn beside the travel. */
  reading: string
  /** What a screen reader says for it, when the reading is a unit glyph. */
  spoken?: string
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-3 @lg:w-64">
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={spoken ?? reading}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next)
        }}
        onClick={releaseFocus}
        className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
      />
      <span className="type-readout w-14 shrink-0 text-right text-slate-300">
        {reading}
      </span>
    </div>
  )
}
