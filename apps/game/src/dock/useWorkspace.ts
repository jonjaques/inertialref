import { useEffect, useState } from 'react'
import {
  type DockLayout,
  type DockZone,
  EMPTY_LAYOUT,
  isDockLayout,
  movePanel,
  normalizeLayout,
  type PaneZone,
  PANE_ZONES,
  togglePanel,
  zoneOf,
} from './layout.ts'
import {
  cascade,
  type FloatPoint,
  type FloatPositions,
  type FloatSize,
  isFloatPositions,
  NO_FLOATS,
  nudgeFloat,
  placeFloat,
  pruneFloats,
} from './floating.ts'
import { type DockPanelDefinition, layoutOf } from './panels.ts'
import { usePersistentState } from '../hud/panelState.ts'

/*
 * Everything the workspace remembers, in one hook.
 *
 * Four preferences, four keys, and they are deliberately *not* one object.
 * `localStorage` outlives the code that wrote it, so each of these has to be
 * repairable on its own: a layout whose panel ids moved on is worth keeping
 * even when the float positions beside it are nonsense, and a single blob
 * would throw all four away together the first time any one of them failed its
 * guard. That is the same argument `hud/panelState.ts` already makes about a
 * stored tab name, applied to a workspace.
 *
 * Normalising happens on *read* rather than only on write, for the reason
 * `useDockLayout` gave before this replaced it: what changes between sessions
 * is the panel set, so a layout written by yesterday's build is fine until
 * today's build adds a panel — and the write that would have repaired it may
 * never come.
 */

/** The panes' open state. Both open is the arrangement a fresh visitor gets. */
export type PaneState = { readonly [Z in PaneZone]: boolean }

const BOTH_OPEN: PaneState = { left: true, right: true }

const isPaneState = (value: unknown): value is PaneState =>
  typeof value === 'object' &&
  value !== null &&
  PANE_ZONES.every(
    (zone) => typeof (value as Record<string, unknown>)[zone] === 'boolean',
  )

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string')

/**
 * The box a stored float position is re-clamped against before it is believed.
 *
 * A panel's real height is content, so it is only knowable from the DOM — and
 * this runs before anything is drawn. The pane width plus a plausible body is
 * the conservative answer: it can pull a position further from the right edge
 * than strictly necessary, which is recoverable by dragging, where the failure
 * it prevents — a panel restored off-screen on a smaller display — is not.
 */
const ASSUMED_PANEL: FloatSize = { width: 304, height: 220 }

const viewportSize = (): FloatSize => ({
  width: typeof window === 'undefined' ? 1280 : window.innerWidth,
  height: typeof window === 'undefined' ? 800 : window.innerHeight,
})

export interface Workspace {
  readonly layout: DockLayout
  readonly floats: FloatPositions
  readonly panes: PaneState
  /** The frame a floating panel is clamped into, live across a resize. */
  readonly viewport: FloatSize
  /** Whether a panel is showing its header alone. */
  readonly isCollapsed: (panel: string) => boolean
  /** Drag one panel into a pane, at a slot. */
  readonly move: (panel: string, zone: DockZone, index: number) => void
  /** Close a panel. It goes to `hidden`, and the menu is how it comes back. */
  readonly hide: (panel: string) => void
  /** Open a closed panel where its definition says, or close an open one. */
  readonly toggle: (panel: string) => void
  /** Pull a panel out of its pane, at a point, or put it back where it belongs. */
  readonly float: (panel: string, at?: FloatPoint, size?: FloatSize) => void
  readonly dock: (panel: string) => void
  /** Move a floating panel by a drag delta. */
  readonly nudge: (
    panel: string,
    delta: FloatPoint,
    from: FloatPoint,
    size: FloatSize,
  ) => void
  readonly toggleCollapsed: (panel: string) => void
  readonly togglePane: (zone: PaneZone) => void
  readonly setPane: (zone: PaneZone, open: boolean) => void
  /** Every panel back where its definition says, nothing floating or closed. */
  readonly reset: () => void
}

export function useWorkspace(
  key: string,
  panels: readonly DockPanelDefinition[],
): Workspace {
  const known = layoutOf(panels)
  const [storedLayout, setLayout] = usePersistentState<DockLayout>(
    `dock.layout.${key}`,
    EMPTY_LAYOUT,
    isDockLayout,
  )
  const [storedFloats, setFloats] = usePersistentState<FloatPositions>(
    `dock.floats.${key}`,
    NO_FLOATS,
    isFloatPositions,
  )
  const [collapsed, setCollapsed] = usePersistentState<readonly string[]>(
    `dock.collapsed.${key}`,
    [],
    isStringArray,
  )
  const [panes, setPanes] = usePersistentState<PaneState>(
    `dock.panes.${key}`,
    BOTH_OPEN,
    isPaneState,
  )

  const layout = normalizeLayout(storedLayout, known)

  /*
   * A resize re-clamps every floating panel.
   *
   * Not cosmetic. Dragging a browser window narrower — or rotating a tablet —
   * leaves a panel that was near the right edge outside the frame, where the
   * menu still reports it as open and there is no gesture that reaches it. The
   * effect only writes when something actually moved, so the common case of a
   * resize with nothing floating is a comparison and no state change.
   */
  const [viewport, setViewport] = useState(viewportSize)
  useEffect(() => {
    const onResize = (): void => setViewport(viewportSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const floats = pruneFloats(
    storedFloats,
    layout.float,
    ASSUMED_PANEL,
    viewport,
  )

  /*
   * Every updater takes the previous state, never the value rendered above.
   *
   * One pointer gesture can deliver more than one drop — nested targets, a
   * synthesised drag, a hand that releases over a boundary — and two moves
   * composed against the same captured snapshot silently discard the first.
   * `dock/layout.ts` was written to make composing them safe; this is where
   * that is actually taken advantage of.
   */
  const update = (next: (previous: DockLayout) => DockLayout): void => {
    setLayout((previous) =>
      normalizeLayout(next(normalizeLayout(previous, known)), known),
    )
  }

  const zoneFor = (panel: string): DockZone =>
    panels.find((definition) => definition.id === panel)?.zone ?? 'right'

  return {
    layout,
    floats,
    panes,
    viewport,
    isCollapsed: (panel) => collapsed.includes(panel),

    move: (panel, zone, index) => {
      update((current) => movePanel(current, panel, zone, index))
    },

    hide: (panel) => {
      update((current) => movePanel(current, panel, 'hidden'))
    },

    toggle: (panel) => {
      update((current) => togglePanel(current, panel, zoneFor(panel)))
    },

    float: (panel, at, size) => {
      /*
       * The position is written before the move, and both are updater-form.
       *
       * A panel that arrived in `float` with no coordinate would render at the
       * cascade point for one frame and then jump when this landed — which
       * reads as the gesture having gone wrong. Writing the point first means
       * the first frame it is floating is the frame it is in the right place.
       */
      const box = size ?? ASSUMED_PANEL
      setFloats((previous) =>
        placeFloat(
          previous,
          panel,
          at ?? cascade(Object.keys(previous).length, viewport),
          box,
          viewport,
        ),
      )
      update((current) => movePanel(current, panel, 'float'))
    },

    dock: (panel) => {
      update((current) => movePanel(current, panel, zoneFor(panel)))
    },

    nudge: (panel, delta, from, size) => {
      setFloats((previous) =>
        nudgeFloat(previous, panel, delta, from, size, viewport),
      )
    },

    toggleCollapsed: (panel) => {
      setCollapsed((previous) =>
        previous.includes(panel)
          ? previous.filter((id) => id !== panel)
          : [...previous, panel],
      )
    },

    togglePane: (zone) => {
      setPanes((previous) => ({ ...previous, [zone]: !previous[zone] }))
    },

    setPane: (zone, open) => {
      setPanes((previous) => ({ ...previous, [zone]: open }))
    },

    reset: () => {
      setLayout(EMPTY_LAYOUT)
      setFloats(NO_FLOATS)
      setCollapsed([])
      setPanes(BOTH_OPEN)
    },
  } satisfies Workspace & { readonly layout: DockLayout }
}

/** Whether a panel is on screen at all — in a pane or floating, but not closed. */
export const isOpen = (layout: DockLayout, panel: string): boolean => {
  const zone = zoneOf(layout, panel)
  return zone !== null && zone !== 'hidden'
}
