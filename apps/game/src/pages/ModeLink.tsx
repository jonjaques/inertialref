import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import type { ModeCard } from './modes.ts'
import { StatusBadge } from './StatusBadge.tsx'

/**
 * A door: a mode you can actually walk into.
 *
 * There are two of these, which is the whole reason this is worth being a card
 * at all. Five equal cards is a scaffold — a list pretending to be a decision —
 * and it was what this page had. Two doors and a quiet line of what is not open
 * yet (`ModeRow`) is the same information with the hierarchy the page actually
 * has.
 */
export function ModeLink({ mode }: { mode: ModeCard }) {
  const Icon = mode.icon
  return (
    <Link
      to={mode.to}
      // The surfaces are near-opaque rather than a wash. They sit over a sunlit
      // planet at the brightest end of the frame, and a 50% slate over that is
      // a lighter grey than the type on it.
      className={`group flex items-center gap-4 rounded-lg border px-4 py-3.5 backdrop-blur-sm transition-colors ${FOCUS_RING} ${
        mode.accent
          ? 'border-sky-500/40 bg-sky-950/70 hover:border-sky-400/70 hover:bg-sky-900/60'
          : 'border-slate-700/60 bg-slate-950/80 hover:border-slate-500 hover:bg-slate-900/85'
      }`}
    >
      <Icon
        aria-hidden
        className={`size-7 shrink-0 transition-colors ${
          mode.accent
            ? 'text-sky-300'
            : 'text-slate-400 group-hover:text-sky-300'
        }`}
        strokeWidth={1.25}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2.5">
          {/*
           * The display face, at the smallest size it is ever set.
           *
           * A mode is a *place* — the same thing the IR menu names beside the
           * mark — and naming places is the display face's job in this system.
           * It is also the only thing on this card that is not the prose sans
           * or the mono, which is what makes a door read as a door rather than
           * as a row with an icon.
           */}
          <span className="type-title truncate text-slate-100">
            {mode.title}
          </span>
          <StatusBadge status={mode.status} />
        </span>
        <span className="type-ui mt-1 block text-slate-400">{mode.blurb}</span>
      </span>
      <ArrowRight
        aria-hidden
        // Named properties rather than `transition-all`, which would also
        // animate anything a future class touches — including layout.
        className="size-4 shrink-0 -translate-x-1 text-slate-700 opacity-0 transition-[translate,color,opacity] group-hover:translate-x-0 group-hover:text-sky-300 group-hover:opacity-100"
      />
    </Link>
  )
}
