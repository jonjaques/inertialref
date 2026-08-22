import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from './focus.ts'

/*
 * An icon-only transport control.
 *
 * One definition for what used to be two — the cinema player's and the debug
 * overlay's — which had drifted into different paddings, different icon sizes
 * and different ideas of what "primary" looked like, on two bars that can be on
 * screen in the same session.
 *
 * A real tooltip rather than a `title`, and this is the one place in the
 * interface where that is clearly right: an icon-only button has no visible
 * name, so the hint is not a redundant hover affordance, it is the label. The
 * `title` attribute takes about a second to appear and cannot be styled;
 * everywhere a control has readable text, `title` stays — it is doing a
 * different job there, which is recovering a value that truncated.
 *
 * Radix portals the content to `<body>` at `z-50`, outside `.hud-layer` and
 * above all of it, which is what a tooltip should be. `aria-label` is on the
 * button regardless: a tooltip is not an accessible name.
 */
export function TransportButton({
  label,
  icon: Icon,
  onClick,
  primary = false,
  disabled = false,
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={(event) => {
            releaseFocus(event)
            onClick()
          }}
          className={`size-7 rounded border shadow-none ${FOCUS_RING} ${
            primary
              ? 'border-sky-500/50 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
              : 'border-slate-700 bg-transparent text-slate-400 hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200'
          }`}
        >
          <Icon className={primary ? 'size-4' : 'size-3.5'} />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{label}</TooltipContent>
    </Tooltip>
  )
}
