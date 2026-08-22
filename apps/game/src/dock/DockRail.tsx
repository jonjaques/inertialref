import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { type DockLayout, DROP_ZONES } from './layout.ts'
import type { DockPanelDefinition } from './panels.ts'

/**
 * The launcher rail: one glyph per panel, lit when the panel is on screen.
 *
 * The only way a hidden panel comes back, and the reason `hidden` is a zone
 * rather than an absence. Icon-only and always present, because the alternative
 * — a "panels" menu — is one more click on the control a user reaches for most
 * while arranging a workspace.
 *
 * Icon-only is also why these carry a real tooltip rather than a `title`: with
 * no visible text the hint *is* the label, and a `title` that takes a second to
 * appear is one nobody waits for while hunting a closed panel.
 */
export function DockRail({
  panels,
  layout,
  onToggle,
}: {
  panels: readonly DockPanelDefinition[]
  layout: DockLayout
  onToggle: (id: string) => void
}) {
  const visible = new Set(DROP_ZONES.flatMap((zone) => [...layout[zone]]))
  return (
    <nav
      aria-label="Panels"
      className="pointer-events-auto flex flex-col gap-1 rounded-lg border border-slate-700/60 bg-slate-950/85 p-1 shadow-xl backdrop-blur"
    >
      {panels.map((panel) => {
        const Icon = panel.icon
        const on = visible.has(panel.id)
        return (
          <Tooltip key={panel.id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={on}
                aria-label={panel.title}
                onClick={(event) => {
                  releaseFocus(event)
                  onToggle(panel.id)
                }}
                className={`size-7 rounded ${FOCUS_RING} ${
                  on
                    ? 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-sky-200'
                }`}
              >
                <Icon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-mono text-[10px]">
              {`${panel.title} — ${panel.hint}`}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
