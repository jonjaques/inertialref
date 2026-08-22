'use no memo'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useDrag, useDrop } from 'react-dnd'
import { GripVertical, X } from 'lucide-react'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import {
  type DockLayout,
  type DockZone,
  DROP_ZONES,
  insertionIndex,
  movePanel,
} from './layout.ts'
import type { DockLayoutUpdate } from './useDockLayout.ts'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'

/*
 * The dock: panels in zones, moved by dragging their headers.
 *
 * Everything about *where* a panel ends up is in `layout.ts`, tested in Node.
 * What is here is the two things only a browser can do — measure where a
 * pointer is, and paint the result — and the seam between them is
 * `insertionIndex`, which takes a coordinate and a list of extents and returns
 * a number that `movePanel` can use.
 *
 * `'use no memo'`: `hover` writes the drop indicator on every pointer move
 * during a drag, and the React Compiler's assumption that a render is a pure
 * function of its props does not survive a component whose output depends on a
 * ref-held measurement taken mid-gesture. Same opt-out and same reason as
 * `hud/PerfPanel.tsx`.
 */

/** Side zones are columns, the bottom bar is a row. */
const isColumn = (zone: DockZone): boolean => zone !== 'bottom'

export interface DockProps {
  readonly panels: readonly DockPanelDefinition[]
  readonly layout: DockLayout
  readonly onLayout: (update: DockLayoutUpdate) => void
  /**
   * The launcher, rendered as the row's first item rather than positioned over
   * it. Absolute positioning was the first version and it overlapped the left
   * zone the moment a panel was docked there — the rail has to take part in the
   * same layout as the thing it sits beside.
   */
  readonly rail?: ReactNode
}

export function Dock({ panels, layout, onLayout, rail }: DockProps) {
  const byId = new Map(panels.map((panel) => [panel.id, panel]))
  /*
   * Updater form, not a computed value, and the difference is load-bearing.
   *
   * One pointer gesture can deliver more than one drop — nested targets, a
   * synthesized drag, a hand that releases over a boundary — and two moves
   * composed against the same captured `layout` silently discard the first.
   * Against the previous state they compose, which is what the arithmetic in
   * `layout.ts` was written to allow.
   */
  const move = useCallback(
    (id: string, zone: DockZone, index: number) => {
      onLayout((current) => movePanel(current, id, zone, index))
    },
    [onLayout],
  )
  const hide = useCallback(
    (id: string) => {
      onLayout((current) => movePanel(current, id, 'hidden'))
    },
    [onLayout],
  )

  const zone = (name: DockZone) => (
    <DockZoneView
      zone={name}
      ids={layout[name]}
      byId={byId}
      onMove={move}
      onHide={hide}
    />
  )

  /*
   * The bottom bar spans the width and the sidebars stop above it, rather than
   * the other way round. That is the arrangement every editor converged on for
   * a reason worth restating: a transport or a timeline is read left to right
   * across the whole frame, and a catalogue is read top to bottom in a column —
   * so the bar gets the axis it needs and the columns get theirs.
   *
   * `pointer-events-none` on every container and `auto` on the panels
   * themselves: the gap in the middle is the scene, and it has to receive the
   * drags that orbit the camera.
   */
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col">
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {rail !== undefined && (
          <div className="pointer-events-none flex shrink-0 items-center">
            {rail}
          </div>
        )}
        {zone('left')}
        <div className="min-w-0 flex-1" />
        {zone('right')}
      </div>
      <div className="px-2 pb-2">{zone('bottom')}</div>
    </div>
  )
}

function DockZoneView({
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
      {over && indicator === ids.length && <DropLine column={column} />}
      {empty && (
        <p className="m-auto px-3 py-4 text-center font-mono text-[10px] tracking-widest text-sky-300/70 uppercase">
          drop here
        </p>
      )}
    </div>
  )
}

/** The insertion marker. A line, in the accent, on the stack's own axis. */
function DropLine({ column }: { column: boolean }) {
  return (
    <div
      aria-hidden
      className={
        column
          ? 'h-0.5 w-full shrink-0 rounded-full bg-sky-400'
          : 'h-full w-0.5 shrink-0 rounded-full bg-sky-400'
      }
    />
  )
}

function PanelSlot({
  definition,
  zone,
  indicate,
  onHide,
}: {
  definition: DockPanelDefinition
  zone: DockZone
  indicate: boolean
  onHide: (id: string) => void
}) {
  return (
    <>
      {indicate && <DropLine column={isColumn(zone)} />}
      <DockPanel definition={definition} zone={zone} onHide={onHide} />
    </>
  )
}

function DockPanel({
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
          className="size-3 shrink-0 text-slate-600"
          strokeWidth={2}
        />
        <Icon aria-hidden className="size-3.5 shrink-0 text-sky-400/80" />
        <h2 className="truncate text-[10px] tracking-widest text-sky-300 uppercase">
          {definition.title}
        </h2>
        <button
          type="button"
          aria-label={`Close ${definition.title}`}
          title={`Close ${definition.title}`}
          onClick={(event) => {
            releaseFocus(event)
            onHide(definition.id)
          }}
          className={`ml-auto shrink-0 rounded p-0.5 text-slate-600 hover:text-sky-200 ${FOCUS_RING}`}
        >
          <X className="size-3" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {definition.render()}
      </div>
    </section>
  )
}

/**
 * The launcher rail: one glyph per panel, lit when the panel is on screen.
 *
 * The only way a hidden panel comes back, and the reason `hidden` is a zone
 * rather than an absence. Icon-only and always present, because the alternative
 * — a "panels" menu — is one more click on the control a user reaches for most
 * while arranging a workspace.
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
          <button
            key={panel.id}
            type="button"
            aria-pressed={on}
            title={`${panel.title} — ${panel.hint}`}
            aria-label={panel.title}
            onClick={(event) => {
              releaseFocus(event)
              onToggle(panel.id)
            }}
            className={`rounded p-1.5 transition-colors ${FOCUS_RING} ${
              on
                ? 'bg-sky-500/15 text-sky-200'
                : 'text-slate-500 hover:bg-slate-800/60 hover:text-sky-200'
            }`}
          >
            <Icon className="size-4" />
          </button>
        )
      })}
    </nav>
  )
}
