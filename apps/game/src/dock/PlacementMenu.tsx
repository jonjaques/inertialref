import {
  type LucideIcon,
  PanelBottom,
  PanelTop,
  RectangleEllipsis,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING } from '../hud/focus.ts'
import {
  DOCK_PLACEMENTS,
  type DockPlacement,
  PLACEMENT_LABEL,
} from './placement.ts'

/** Each placement's glyph — the bar where it would be. */
const ICON: Readonly<Record<DockPlacement, LucideIcon>> = {
  floating: RectangleEllipsis,
  top: PanelTop,
  bottom: PanelBottom,
}

/**
 * Where the bar is, on the bar: a glyph showing the current placement, and a
 * menu of the three.
 *
 * A menu rather than a toggle that cycles, for the reason `hud/OptionGroup.tsx`
 * gives: three named options are worth seeing at once, and a control that
 * cycles hides two of them behind presses. A menu rather than the option group
 * itself because the group is three glyphs wide, on a bar that is already the
 * widest thing on screen and is about panels, not about itself.
 *
 * On the bar and not only in settings, because the bar is where somebody is
 * looking when they decide it is in the way.
 */
export function PlacementMenu({
  placement,
  onPlace,
  side,
}: {
  placement: DockPlacement
  onPlace: (placement: DockPlacement) => void
  /** Away from the edge the bar is on. */
  side: 'top' | 'bottom'
}) {
  const Icon = ICON[placement]
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Menu bar placement"
              className={`size-7 shrink-0 rounded text-slate-400 hover:bg-slate-800/60 hover:text-sky-200 data-[state=open]:bg-sky-500/15 data-[state=open]:text-sky-200 ${FOCUS_RING}`}
            >
              <Icon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>
          Menu bar — float it, or attach it to an edge
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side={side} align="end">
        <DropdownMenuLabel>Menu bar</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={placement}
          onValueChange={(next) => onPlace(next as DockPlacement)}
        >
          {DOCK_PLACEMENTS.map((option) => {
            const OptionIcon = ICON[option]
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <OptionIcon aria-hidden />
                {PLACEMENT_LABEL[option]}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
