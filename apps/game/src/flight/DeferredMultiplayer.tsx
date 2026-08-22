import { Link } from 'react-router'
import { Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FOCUS_RING } from '../hud/focus.ts'
import { HOME, PLANETARIUM, PLAY_SOLO } from '../pages/paths.ts'

/**
 * What `/play/multiplayer` is instead of a game.
 *
 * `docs/design/modes.md` defers it deliberately, and the page's job is to say
 * why in terms of the seams that make it a later addition rather than a
 * rewrite — then offer the two modes that do work.
 */
export function DeferredMultiplayer() {
  return (
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-slate-700/60 bg-slate-950/85 p-6 backdrop-blur">
        <h1 className="flex items-center gap-2 text-lg text-slate-100">
          <Users aria-hidden className="size-5 text-slate-400" />
          Multiplayer is deferred
        </h1>
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-slate-400">
          Deliberately, and the seams are the reason it can wait: a star system
          is the unit of authority, partition keys are already a live field on
          every entity, and no hosting vendor’s SDK appears anywhere in the
          engine. See ADR-0008.
        </p>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-slate-400">
          With few players a shared galaxy is indistinguishable from solo online
          — so the mode degrades into one that already works, rather than
          failing.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-[11px]">
          <Button
            asChild
            variant="outline"
            className={`h-auto rounded border-sky-500/50 bg-sky-500/15 px-3 py-1.5 font-normal text-sky-200 shadow-none hover:bg-sky-500/25 hover:text-sky-100 ${FOCUS_RING}`}
          >
            <Link to={PLAY_SOLO}>play solo instead</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className={`h-auto rounded border-slate-700 bg-transparent px-3 py-1.5 font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Link to={PLANETARIUM}>open the planetarium</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className={`h-auto rounded border-slate-700 bg-transparent px-3 py-1.5 font-normal text-slate-400 shadow-none hover:border-slate-500 hover:bg-transparent hover:text-slate-300 ${FOCUS_RING}`}
          >
            <Link to={HOME}>back</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
