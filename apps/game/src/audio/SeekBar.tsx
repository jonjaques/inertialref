import { useState } from 'react'
import { SliderControl } from '../hud/SliderControl.tsx'
import { clock } from './catalog.ts'

/**
 * The playhead, as a slider.
 *
 * The drag is drawn and not played. Every position a seek visits is a range
 * request against the Worker and a decoder flush, so the thumb follows the
 * pointer from local state and the player seeks once, where the drag ends —
 * or once per key press, which Radix reports as a commit of its own. Between
 * the two, the store's playhead keeps moving underneath and is ignored, so the
 * thumb does not jump back under the pointer four times a second.
 */
export function SeekBar({
  position,
  duration,
  disabled = false,
  onSeek,
}: {
  position: number
  duration: number
  disabled?: boolean
  onSeek: (seconds: number) => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const shown = Math.min(dragging ?? position, duration)
  return (
    <SliderControl
      label="Position in the track"
      min={0}
      max={Math.max(1, Math.floor(duration))}
      step={1}
      value={shown}
      reading={clock(shown)}
      spoken={`${clock(shown)} of ${clock(duration)}`}
      disabled={disabled || duration <= 0}
      onChange={setDragging}
      onCommit={(seconds) => {
        setDragging(null)
        onSeek(seconds)
      }}
    />
  )
}
