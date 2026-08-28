import { Slider } from '@/components/ui/slider'
import {
  LENS_CHANNELS,
  type CameraState,
  type LensChannelId,
} from './controls.ts'
import { releaseFocus } from './focus.ts'

/**
 * One channel of the lens, as one slider — shared by the camera panel and the
 * planetarium's view panel, which had two copies of the range written out.
 *
 * A channel id rather than four components, because `react/no-multi-comp` is an
 * error here and four sliders that differ only in their arithmetic would be
 * four files. The arithmetic is in `controls.ts`, where it can be tested
 * without a renderer, and this is the part that cannot: a padded hit area over
 * a thin track.
 *
 * Radix's `Slider` rather than `<input type="range">`, and the reason is the
 * track: a range input's thumb is sized by the user agent — which SC 2.5.8
 * exempts — but the *track* is what a pointer lands on, and it was 16 px. That
 * was patched by forcing the input to `h-6` and letting the thumb overflow it,
 * which works and is a hack. Radix draws both, so the padded hit area and the
 * 6 px visible track are different boxes on purpose.
 */
export function LensSlider({
  channel,
  camera,
}: {
  channel: LensChannelId
  camera: CameraState
}) {
  const spec = LENS_CHANNELS[channel]
  // A thousand steps over a logarithmic travel: fine enough that the readout
  // moves on every arrow key at the narrow end, coarse enough that the value is
  // an integer the slider can hold rather than a float it rounds.
  const STEPS = 1000
  return (
    <Slider
      min={0}
      max={STEPS}
      step={1}
      value={[Math.round(spec.scrub(camera.lens) * STEPS)]}
      aria-label={spec.description}
      onValueChange={([next]) => {
        if (next !== undefined)
          camera.onLens(spec.at(camera.lens, next / STEPS))
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
