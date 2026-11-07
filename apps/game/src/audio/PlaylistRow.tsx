import type { KeyboardEvent, PointerEvent, Ref } from 'react'
import { GripVertical, Music } from 'lucide-react'
import {
  SOUNDTRACK_CATEGORY_TITLES,
  type SoundtrackTrack,
} from '@inertialref/protocol'
import { Switch } from '@/components/ui/switch'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { byline, clock } from './catalog.ts'
import { KeepToggle } from './KeepToggle.tsx'

/**
 * One track in the playlist editor: the handle that moves it, what it is,
 * whether it is kept on this device, and whether it plays.
 *
 * **Off has two causes, and the row says which.** A track switched off here
 * reads dim with its switch off; a track whose whole category is off keeps
 * its own switch and says "off" after the category's name, because switching
 * the category back on brings it back exactly as it was left. Dimming is by
 * ink, not by opacity — chrome text bottoms out at `slate-400` (DESIGN.md §
 * Neutral), and an opacity under that would put the title below it.
 */
export function PlaylistRow({
  track,
  position,
  on,
  categoryOn,
  playing,
  dragging,
  hintId,
  rowRef,
  handleRef,
  onToggle,
  onHandleKey,
  onHandleDown,
  onHandleMove,
  onHandleUp,
  onHandleCancel,
}: {
  track: SoundtrackTrack
  /** One-based, in the order drawn. */
  position: number
  on: boolean
  categoryOn: boolean
  playing: boolean
  dragging: boolean
  /** The id of the sentence that says how a handle works. */
  hintId: string
  rowRef: Ref<HTMLLIElement>
  handleRef: Ref<HTMLButtonElement>
  onToggle: (on: boolean) => void
  onHandleKey: (event: KeyboardEvent<HTMLButtonElement>) => void
  onHandleDown: (event: PointerEvent<HTMLButtonElement>) => void
  onHandleMove: (event: PointerEvent<HTMLButtonElement>) => void
  onHandleUp: (event: PointerEvent<HTMLButtonElement>) => void
  onHandleCancel: () => void
}) {
  const heard = on && categoryOn
  return (
    <li
      ref={rowRef}
      className={`flex min-h-11 items-center gap-2 border-b border-slate-800/70 py-1 pr-1 last:border-b-0 ${
        dragging ? 'rounded bg-sky-500/10 ring-1 ring-sky-500/40' : ''
      }`}
    >
      <button
        ref={handleRef}
        type="button"
        aria-label={`Move “${track.title}”, position ${position}`}
        aria-describedby={hintId}
        onKeyDown={onHandleKey}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleCancel}
        onLostPointerCapture={onHandleCancel}
        // `touch-none`: on a touch screen the browser would otherwise take
        // the first few pixels of the drag as a scroll and cancel the pointer.
        className={`flex size-7 shrink-0 touch-none items-center justify-center rounded text-slate-400 hover:text-sky-200 ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        } ${FOCUS_RING}`}
      >
        <GripVertical aria-hidden className="size-3.5" />
      </button>
      <span className="type-readout flex w-6 shrink-0 justify-end text-slate-400">
        {playing ? (
          <>
            <Music aria-hidden className="size-3.5 text-sky-300" />
            <span className="sr-only">Playing now</span>
          </>
        ) : (
          position
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`type-ui truncate ${heard ? 'text-slate-200' : 'text-slate-400'}`}
          title={track.title}
        >
          {track.title}
        </span>
        <span className="type-micro truncate text-slate-400">
          {byline(track)} · {SOUNDTRACK_CATEGORY_TITLES[track.category].title}
          {categoryOn ? '' : ' (off)'} · {clock(track.duration)}
        </span>
      </span>
      <KeepToggle track={track} />
      <Switch
        size="sm"
        checked={on}
        aria-label={`Play “${track.title}”`}
        onCheckedChange={onToggle}
        onClick={releaseFocus}
        className="shrink-0"
      />
    </li>
  )
}
