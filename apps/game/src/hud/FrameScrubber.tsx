import { Slider } from '@/components/ui/slider'

/**
 * The playhead, as a slider.
 *
 * The visual half of what `useScrubber` is the behavioural half of: there are
 * two transports over one director — the cinema player and the debug overlay —
 * and they were two range inputs with the same two off-by-ones. `useScrubber`
 * owns the drag latch and the guarded seek; this owns the control they drive.
 *
 * `max` is clamped at or above `min` because a one-frame scene would otherwise
 * put the two the wrong way round, which browsers resolve by pinning the value
 * to `min` — a scrubber that silently refuses to move.
 */
export function FrameScrubber({
  frame,
  durationFrames,
  onGrab,
  onSeek,
  className = '',
}: {
  frame: number
  durationFrames: number
  /** `useScrubber`'s `grab`: the poll leaves the value alone while held. */
  onGrab: () => void
  onSeek: (frame: number) => void
  className?: string
}) {
  const last = Math.max(0, durationFrames - 1)
  return (
    <Slider
      min={0}
      max={last}
      step={1}
      value={[Math.min(Math.max(0, Math.floor(frame)), last)]}
      aria-label="Frame"
      onPointerDown={onGrab}
      onValueChange={([next]) => {
        if (next !== undefined) onSeek(next)
      }}
      // A 4 px track in 16 px of hit area. A transport bar is dragged rather
      // than nudged, so the target is the whole strip and the rule stays thin
      // enough not to read as chrome over a picture.
      className={`min-w-0 py-1.5 [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-track]]:h-1 ${className}`}
    />
  )
}
