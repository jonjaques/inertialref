import { Link } from 'react-router'
import { House, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FOCUS_RING } from '../hud/focus.ts'
import { CINEMA, HOME } from '../pages/paths.ts'

/*
 * What a scene leaves you looking at when it runs out.
 *
 * This replaced two words and two ghost buttons floating in the middle of the
 * frame with nothing behind them. It read as a bug, and measured like one: the
 * last shot of `tng-intro` ends over a sunlit Earth, so "scene ended" in the
 * display serif came out at about 1.6:1 and the outlined buttons beside it were
 * a pair of rectangles you could see through. `DESIGN.md` § Pages already had
 * the answer for type over a live scene — a scrim and one panel — and this is
 * that pattern at card scale.
 *
 * Three ways out, and the third is the one that was missing entirely: from a
 * finished scene the only exits were the library and the browser's back button.
 * The IR menu's mark does go home, but it is a 16 px glyph on a bar that fades
 * with the transport, which is not a way out anybody finds on their first
 * evening.
 *
 * Dismissable, because the frame underneath is the end of the scene rather than
 * a chase camera now — so "let me look at it" is a reasonable thing to want,
 * and the transport is right there with the whole scrubber on it.
 */
export function EndCard({
  title,
  detail,
  onReplay,
  onDismiss,
}: {
  title: string
  /** One quiet line under the title — a running time, or what went wrong. */
  detail: string
  onReplay: () => void
  /** Absent when there is no picture worth uncovering. */
  onDismiss?: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      {/*
       * A card, not a full-screen scrim. The scene behind it has just finished
       * and is worth seeing; `pages/OverlayPage` dims the whole frame because a
       * settings dialog is read *instead* of the scene, and this is read
       * *beside* it.
       */}
      <div className="pointer-events-auto flex max-w-[min(26rem,calc(100vw-3rem))] flex-col items-center gap-3 rounded-lg border border-slate-700/60 bg-slate-950/85 px-6 py-5 text-center shadow-2xl shadow-black/60 backdrop-blur">
        <div>
          <p className="type-title text-slate-100">{title}</p>
          <p className="type-micro mt-1 text-slate-400">{detail}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            onClick={onReplay}
            className={`type-ui h-auto gap-1.5 rounded border-sky-500/50 bg-sky-500/15 px-3 py-1.5 font-normal text-sky-200 shadow-none hover:bg-sky-500/25 hover:text-sky-100 ${FOCUS_RING}`}
          >
            <RotateCcw className="size-3.5" /> Replay
          </Button>
          <Button
            asChild
            variant="outline"
            className={`type-ui h-auto gap-1.5 rounded border-slate-700 bg-transparent px-3 py-1.5 font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Link to={CINEMA}>
              <X className="size-3.5" /> Library
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className={`type-ui h-auto gap-1.5 rounded border-slate-700 bg-transparent px-3 py-1.5 font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Link to={HOME}>
              <House className="size-3.5" /> Menu
            </Link>
          </Button>
        </div>
        {onDismiss !== undefined && (
          <button
            type="button"
            onClick={onDismiss}
            className={`type-ui rounded px-1 text-slate-400 underline-offset-4 hover:text-sky-200 hover:underline ${FOCUS_RING}`}
          >
            Stay on the last frame
          </button>
        )}
      </div>
    </div>
  )
}
