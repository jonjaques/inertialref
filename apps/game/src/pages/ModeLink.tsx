import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { FOCUS_RING } from '../hud/focus.ts'
import { type ModeCard, STATUS_LABEL, STATUS_TONE } from './modes.ts'

/** One of the menu's five choices: a glyph, a name, a claim and a status. */
export function ModeLink({ mode }: { mode: ModeCard }) {
  const Icon = mode.icon
  return (
    <Link
      to={mode.to}
      // The surfaces are near-opaque rather than a wash. They sit over a sunlit
      // planet at the brightest end of the frame, and a 50% slate over that is
      // a lighter grey than the type on it.
      className={`group flex items-center gap-4 rounded-lg border px-4 py-3 backdrop-blur-sm transition-colors ${FOCUS_RING} ${
        mode.accent
          ? 'border-sky-500/40 bg-sky-950/70 hover:border-sky-400/70 hover:bg-sky-900/60'
          : 'border-slate-700/60 bg-slate-950/80 hover:border-slate-500 hover:bg-slate-900/85'
      }`}
    >
      <Icon
        aria-hidden
        className={`size-6 shrink-0 transition-colors ${
          mode.accent
            ? 'text-sky-300'
            : 'text-slate-400 group-hover:text-sky-300'
        }`}
        strokeWidth={1.5}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-slate-100">{mode.title}</span>
          {/* shadcn's `Badge`, with its radius overridden: the registry's is a
              `rounded-full` pill and this system has two radii, neither of
              which is a pill. 10px, not the variant's 12, for the same reason —
              the type scale bottoms out at 10 and a badge is not the place to
              add a step. */}
          <Badge
            variant="outline"
            className={`rounded border px-1.5 py-px font-mono text-[10px] font-normal tracking-widest uppercase ${STATUS_TONE[mode.status]}`}
          >
            {STATUS_LABEL[mode.status]}
          </Badge>
        </span>
        <span className="mt-0.5 block font-mono text-[11px] leading-snug text-slate-400">
          {mode.blurb}
        </span>
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
