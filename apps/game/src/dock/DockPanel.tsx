'use no memo'
import { useDrag } from 'react-dnd'
import { GripVertical, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { isColumn, type DockZone } from './layout.ts'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'

/**
 * One docked panel: a grab handle, a title, a close button and the body its
 * definition produces on demand.
 *
 * `'use no memo'` for the same reason `Dock` carries it — this subtree is
 * rebuilt mid-gesture from a ref-held measurement, which is not a pure function
 * of its props.
 */
export function DockPanel({
  definition,
  zone,
  onHide,
}: {
  definition: DockPanelDefinition
  zone: DockZone
  onHide: (id: string) => void
}) {
  const [{ dragging }, drag, preview] = useDrag<
    PanelDragItem,
    void,
    { dragging: boolean }
  >(
    () => ({
      type: PANEL_DRAG_TYPE,
      item: { id: definition.id, from: zone },
      collect: (monitor) => ({ dragging: monitor.isDragging() }),
    }),
    [definition.id, zone],
  )

  const Icon = definition.icon
  return (
    <section
      data-dock-panel={definition.id}
      // The preview connector on the whole panel, the drag connector on the
      // header alone: the drag image should be the thing being moved, and the
      // grab handle should be the one strip that is not also a control.
      ref={(node) => {
        preview(node)
      }}
      className={[
        'flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-slate-700/60',
        'bg-slate-950/85 font-mono text-[11px] leading-relaxed text-slate-300 shadow-xl backdrop-blur',
        isColumn(zone) ? '' : 'w-[22rem] max-w-[80vw]',
        // 40% rather than hidden: a panel that vanishes while dragged takes the
        // stack's layout with it, so every other panel jumps and the drop
        // indicator is measured against positions that no longer exist.
        dragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      <header
        ref={(node) => {
          drag(node)
        }}
        className="flex cursor-grab items-center gap-1.5 border-b border-slate-800 px-2 py-1 select-none active:cursor-grabbing"
      >
        <GripVertical
          aria-hidden
          className="size-3 shrink-0 text-slate-400"
          strokeWidth={2}
        />
        <Icon aria-hidden className="size-3.5 shrink-0 text-sky-400/80" />
        <h2 className="truncate text-[10px] tracking-widest text-sky-300 uppercase">
          {definition.title}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${definition.title}`}
              onClick={(event) => {
                releaseFocus(event)
                onHide(definition.id)
              }}
              className={`ml-auto shrink-0 rounded text-slate-400 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-[10px]">
            {`Close ${definition.title} — reopen from the rail`}
          </TooltipContent>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {definition.render()}
      </div>
    </section>
  )
}
