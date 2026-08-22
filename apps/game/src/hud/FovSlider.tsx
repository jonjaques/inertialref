import { Slider } from '@/components/ui/slider'
import { FOV_MAX, FOV_MIN } from './controls.ts'
import { releaseFocus } from './focus.ts'

/**
 * The lens, as one slider — shared by the camera panel and the planetarium's
 * view panel, which had two of these with the range written out twice.
 *
 * Radix's `Slider` rather than `<input type="range">`, and the reason is the
 * track: a range input's thumb is sized by the user agent — which SC 2.5.8
 * exempts — but the *track* is what a pointer lands on, and it was 16 px. That
 * was patched by forcing the input to `h-6` and letting the thumb overflow it,
 * which works and is a hack. Radix draws both, so the padded hit area and the
 * 6 px visible track are different boxes on purpose.
 */
export function FovSlider({
  fov,
  onFov,
}: {
  fov: number
  onFov: (fov: number) => void
}) {
  return (
    <Slider
      min={FOV_MIN}
      max={FOV_MAX}
      step={1}
      value={[fov]}
      aria-label="Field of view, degrees"
      onValueChange={([next]) => {
        if (next !== undefined) onFov(next)
      }}
      // A pointer that grabbed the thumb has the keyboard; hand it back, the
      // same as every other control in the overlay. Not on `onValueChange`,
      // which also fires for the arrow keys — see `releaseFocus`.
      onClick={releaseFocus}
      // 24 px of hit area around a 6 px track. `py-2.5` rather than `h-6`,
      // because the root is what receives the pointer and the track inside it
      // keeps its own height.
      className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
    />
  )
}
