'use no memo'
import { useCallback, useRef, useState } from 'react'
import { useDrop } from 'react-dnd'
import { DropLine } from './DropLine.tsx'
import { insertionIndex, isColumn, type DockZone } from './layout.ts'
import { PanelSlot } from './PanelSlot.tsx'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'

/**
 * One zone: the panels in it, and the half of the drop gesture only a browser
 * can do.
 *
 * `'use no memo'`: `hover` writes the drop indicator on every pointer move
 * during a drag, and the React Compiler's assumption that a render is a pure
 * function of its props does not survive a component whose output depends on a
 * ref-held measurement taken mid-gesture. Same opt-out and same reason as
 * `hud/PerfPanel.tsx`.
 */
export function DockZoneView({
  zone,
  ids,
  byId,
  onMove,
  onHide,
}: {
  zone: DockZone
  ids: readonly string[]
  byId: Map<string, DockPanelDefinition>
  onMove: (id: string, zone: DockZone, index: number) => void
  onHide: (id: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<number | null>(null)

  /*
   * Where the pointer means to insert, measured against the panels on screen.
   *
   * The extents are read from the DOM on each hover rather than cached at drag
   * start. It is a handful of `getBoundingClientRect` calls — a zone holds
   * three or four panels — and the alternative is a cache that goes stale the
   * moment the drag itself reflows the stack, which is exactly when it is being
   * consulted.
   */
  const indexAt = useCallback(
    (client: { x: number; y: number } | null): number => {
      const node = container.current
      if (node === null || client === null) return ids.length
      const column = isColumn(zone)
      const bounds = [...node.querySelectorAll('[data-dock-panel]')].map(
        (element) => {
          const rect = element.getBoundingClientRect()
          return column
            ? { start: rect.top, end: rect.bottom }
            : { start: rect.left, end: rect.right }
        },
      )
      return insertionIndex(column ? client.y : client.x, bounds)
    },
    [ids.length, zone],
  )

  const [{ over, active }, drop] = useDrop<
    PanelDragItem,
    void,
    { over: boolean; active: boolean }
  >(
    () => ({
      accept: PANEL_DRAG_TYPE,
      hover: (_item, monitor) => {
        setIndicator(indexAt(monitor.getClientOffset()))
      },
      drop: (item, monitor) => {
        setIndicator(null)
        onMove(item.id, zone, indexAt(monitor.getClientOffset()))
      },
      collect: (monitor) => ({
        over: monitor.isOver({ shallow: true }),
        // True while *anything* dockable is in flight, anywhere — which is what
        // reveals an empty zone. Without it there is no way to dock into a side
        // that has been emptied, because there is nothing on screen to aim at.
        active: monitor.canDrop(),
      }),
    }),
    [indexAt, onMove, zone],
  )

  const empty = ids.length === 0
  if (empty && !active) return null

  const column = isColumn(zone)
  return (
    <div
      ref={(node) => {
        container.current = node
        drop(node)
      }}
      data-dock-zone={zone}
      className={[
        'pointer-events-auto flex min-h-0 gap-2 rounded-lg transition-colors',
        column
          ? 'w-[19rem] max-w-[45vw] flex-col overflow-y-auto'
          : 'w-full flex-row items-end overflow-x-auto',
        empty
          ? 'border border-dashed border-sky-500/40 bg-sky-500/5 ' +
            (column ? 'min-h-24' : 'min-h-16')
          : '',
        over ? 'bg-sky-500/5' : '',
      ].join(' ')}
      onDragLeave={() => setIndicator(null)}
    >
      {ids.map((id, index) => {
        const definition = byId.get(id)
        if (definition === undefined) return null
        return (
          <PanelSlot
            key={id}
            definition={definition}
            zone={zone}
            indicate={over && indicator === index}
            onHide={onHide}
          />
        )
      })}
      {over && indicator === ids.length && <DropLine zone={zone} />}
      {empty && (
        <p className="m-auto px-3 py-4 text-center font-mono text-[10px] tracking-widest text-sky-300/70 uppercase">
          drop here
        </p>
      )}
    </div>
  )
}
