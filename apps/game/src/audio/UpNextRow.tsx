import type { SoundtrackTrack } from '@inertialref/protocol'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { byline, clock } from './catalog.ts'

/**
 * A track the queue will reach, which a press plays now.
 *
 * A row rather than a list item with a play glyph beside it: the whole row is
 * the target, as `SwitchRow` makes the whole row its switch's, and the press
 * jumps the queue to it — the tracks between are not skipped from the cycle,
 * they are still to come after it (`jumpQueue`).
 */
export function UpNextRow({
  track,
  onPlay,
}: {
  track: SoundtrackTrack
  onPlay: () => void
}) {
  return (
    <button
      type="button"
      title={`Play “${track.title}” now`}
      onClick={(event) => {
        releaseFocus(event)
        onPlay()
      }}
      className={`flex min-h-9 w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-slate-800/60 ${FOCUS_RING}`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="type-ui truncate text-slate-200">{track.title}</span>
        <span className="type-micro truncate text-slate-400">
          {byline(track)}
        </span>
      </span>
      <span className="type-readout shrink-0 text-slate-400">
        {clock(track.duration)}
      </span>
    </button>
  )
}
