import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Music } from 'lucide-react'
import { licenseOf } from '@inertialref/protocol'
import { useChromeHidden } from '../hud/chrome.ts'
import { useCompact } from '../hud/viewport.ts'
import { MUSIC_CARD, usePersistentState } from '../state/preferences.ts'
import { byline, trackById } from './catalog.ts'
import { useSoundtrack } from './soundtrackStore.ts'

/*
 * Who made what is playing, for six seconds after it starts.
 *
 * The credit is an obligation for most of these tracks — CC BY asks for the
 * title, the creator, the license and what was changed — and a courtesy for
 * the rest, and the moment it is most useful is the moment the music changes
 * and somebody wonders what this is. So it appears when a track begins, says
 * it, and goes; `Shift+M` (or the panel's title) brings it back.
 *
 * **The top edge, between the panes.** The bottom band is spoken for — the
 * menu at its center, a notice at `bottom-16`, the drop handle and the flight
 * strip in its left corner — and both top corners are the panes'. The top
 * edge's middle is an edge, which the Edge Rule allows, and in the Planetarium
 * nothing else is ever there; flight's on-foot hint is, which is the
 * placement to revisit when the soundtrack plays in flight. Its width stops
 * short of both panes, a calculation on the layer rather than the viewport
 * (rule 30), and on a phone, where the panes are a sheet behind the bar, it
 * takes the width it needs.
 *
 * Out of the frame with the rest of the chrome, and gone during a cutscene —
 * the Cinema Rule — and announced, politely, because a reader that never
 * hears it gets no credit at all.
 */

const SHOWN_MS = 6_000

export function NowPlayingCard({ visible }: { visible: boolean }) {
  const card = useSoundtrack((state) => state.card)
  const [enabled] = usePersistentState(MUSIC_CARD)
  const chromeHidden = useChromeHidden()
  const compact = useCompact()
  const [shown, setShown] = useState<number | null>(null)

  useEffect(() => {
    if (card === null) return
    setShown(card.serial)
    const timer = setTimeout(
      () => setShown((held) => (held === card.serial ? null : held)),
      SHOWN_MS,
    )
    return () => clearTimeout(timer)
  }, [card])

  const track = trackById(card?.trackId ?? null)
  const open =
    visible &&
    enabled &&
    !chromeHidden &&
    track !== null &&
    shown !== null &&
    shown === card?.serial

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key={card!.serial}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          // Centered by margins, not a translate: Motion owns this element's
          // transform for the drop, and a second writer would fight it.
          className={`pointer-events-none absolute top-3 right-3 left-3 z-30 mx-auto flex w-fit items-center gap-2.5 rounded-lg border border-slate-700/60 bg-slate-950/85 px-3 py-1.5 shadow-xl backdrop-blur ${
            compact ? 'max-w-full' : 'max-w-[min(24rem,calc(100%-39.5rem))]'
          }`}
        >
          <Music aria-hidden className="size-4 shrink-0 text-sky-400/80" />
          <div className="flex min-w-0 flex-col">
            <span className="sr-only">Now playing: </span>
            <span className="type-body truncate text-slate-200">
              {track.title}
            </span>
            <span className="type-ui truncate text-slate-400">
              {byline(track)} · {track.release} · {licenseOf(track).name}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
