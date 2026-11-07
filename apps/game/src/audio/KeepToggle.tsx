import { ArrowDownToLine, HardDrive, LoaderCircle } from 'lucide-react'
import type { SoundtrackTrack } from '@inertialref/protocol'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { megabytes } from './catalog.ts'
import { fileFor, offlineLibrary } from './player.ts'
import { useSoundtrack } from './soundtrackStore.ts'

/**
 * Whether one track is kept on this device, as a toggle.
 *
 * Icon-only, with `TransportButton`'s tooltip for its name, because it sits on
 * every row of a fifty-track list and a word on each would be a column of
 * fifty "Keep"s. The three states are three glyphs — an arrow down to a line
 * for "can be kept", a spinner while it downloads, a drive once it is on the
 * device — and `aria-pressed` carries the state for a reader, with the size
 * in the name so the cost is known before the press.
 *
 * Drawn only where the browser offers Cache Storage at all; a private window
 * that refuses it has no offline tier, and a switch that cannot work is not
 * drawn rather than drawn dead.
 */
export function KeepToggle({ track }: { track: SoundtrackTrack }) {
  const supported = useSoundtrack((state) => state.offline.supported)
  const file = fileFor(track)
  const kept = useSoundtrack(
    (state) => file !== null && state.offline.kept.includes(file.name),
  )
  const progress = useSoundtrack((state) =>
    file === null ? undefined : state.offline.downloading[file.name],
  )
  if (!supported || file === null) return null

  const downloading = progress !== undefined
  const size = megabytes(file.bytes)
  const label = downloading
    ? `Keeping “${track.title}”, ${Math.round(progress * 100)}% — press to stop`
    : kept
      ? `“${track.title}” is kept on this device — press to remove it`
      : `Keep “${track.title}” on this device (${size})`
  const Icon = downloading ? LoaderCircle : kept ? HardDrive : ArrowDownToLine

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={label}
          aria-pressed={kept}
          onClick={(event) => {
            releaseFocus(event)
            if (kept || downloading) void offlineLibrary.release(file)
            else void offlineLibrary.keep(file)
          }}
          className={`size-7 shrink-0 rounded border shadow-none ${FOCUS_RING} ${
            kept
              ? 'border-sky-500/50 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
              : 'border-slate-700 bg-transparent text-slate-400 hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200'
          }`}
        >
          <Icon
            aria-hidden
            className={`size-3.5 ${downloading ? 'motion-safe:animate-spin' : ''}`}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
