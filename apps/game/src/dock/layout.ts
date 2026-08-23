/*
 * Where the panels are, as arithmetic.
 *
 * React DnD is the *input device* for docking and nothing more. What a drop
 * means — which zone, which slot, what happens to the panel that used to be
 * there — is here, as pure functions over a plain object, because that is the
 * part with the bugs in it and the part a Node test can reach. A layout is also
 * a persisted preference, so it has to survive a build that renames a panel,
 * which is `normalizeLayout`'s whole job.
 *
 * The invariant, and every function below preserves it:
 *
 *   **every known panel appears in exactly one zone, exactly once.**
 *
 * A panel that is in two zones renders twice and its state diverges. A panel
 * in none is unreachable and there is no UI for getting it back. Both were real
 * in the first version, which moved panels by splicing arrays at call sites.
 */

/**
 * The four places a panel can be.
 *
 * `hidden` is a zone rather than an absence, which is what makes the invariant
 * expressible at all — "closed" is somewhere a panel *is*, so closing one and
 * reopening it is a move rather than a deletion followed by an invention.
 *
 * `float` is the same trick pointed the other way. A panel pulled out of a pane
 * is not *outside* the layout; it is in the one zone whose arrangement happens
 * to be two coordinates rather than an order. Those coordinates live in
 * `floating.ts` and deliberately not here: a position is a decoration that can
 * be lost without anything breaking, and the census this file guards must never
 * depend on one existing.
 */
export const DOCK_ZONES = ['left', 'right', 'float', 'hidden'] as const
export type DockZone = (typeof DOCK_ZONES)[number]

/**
 * The two panes: the zones that are an ordered stack with a drop target.
 *
 * There is no `bottom`. It existed while the dock was three edges and a rail;
 * the workspace is two panes and a menu, and a horizontal band of panels along
 * the bottom is exactly the strip the menu now occupies.
 */
export const PANE_ZONES = ['left', 'right'] as const
export type PaneZone = (typeof PANE_ZONES)[number]

/** Whether a zone is one of the two ordered stacks. */
export const isPane = (zone: DockZone): zone is PaneZone =>
  zone === 'left' || zone === 'right'

/**
 * The zones a drag can drop *into a slot of*.
 *
 * `hidden` is reached by closing and `float` by releasing over the scene, which
 * is a drop with no stack to insert into — so neither has a `DockZoneView` and
 * neither belongs here.
 */
export const DROP_ZONES = PANE_ZONES

export type DockLayout = {
  readonly [Z in DockZone]: readonly string[]
}

export const EMPTY_LAYOUT: DockLayout = {
  left: [],
  right: [],
  float: [],
  hidden: [],
}

/** Which zone a panel is in, or `null` if this layout has never heard of it. */
export function zoneOf(layout: DockLayout, panel: string): DockZone | null {
  for (const zone of DOCK_ZONES) {
    if (layout[zone].includes(panel)) return zone
  }
  return null
}

/**
 * Move a panel to a zone, at an index.
 *
 * Removing before inserting matters, and only within the same zone: dragging
 * the second of three panels to index 2 of its own zone means "one further
 * down", and inserting into the *original* array would put it back where it
 * started. Removing first makes the index mean the same thing in both cases,
 * which is the behavior a hand expects and the one a test can state.
 *
 * An index past the end appends; a negative one prepends. A drop is a pointer
 * position turned into a number and clamping here is cheaper than clamping at
 * three call sites.
 */
export function movePanel(
  layout: DockLayout,
  panel: string,
  zone: DockZone,
  index = Number.POSITIVE_INFINITY,
): DockLayout {
  const stripped: Record<DockZone, string[]> = {
    left: layout.left.filter((id) => id !== panel),
    right: layout.right.filter((id) => id !== panel),
    float: layout.float.filter((id) => id !== panel),
    hidden: layout.hidden.filter((id) => id !== panel),
  }
  const target = stripped[zone]
  const at = Math.max(0, Math.min(target.length, Math.trunc(index)))
  target.splice(at, 0, panel)
  return stripped
}

/**
 * The `movePanel` index for a drop measured against the panels *on screen*.
 *
 * Two different lists, and they differ by exactly one element. The dragged
 * panel is deliberately left in the DOM at 40% opacity so the stack does not
 * reflow mid-gesture — see `Dock.tsx` — so `insertionIndex` counts against a
 * list that still contains it, while `movePanel` reads its index against the
 * list with it already removed. Dragging *downwards* inside one zone, those
 * two disagree: in `[A,B,C,D]`, grabbing A and hovering between B and C draws
 * the line at index 2 and lands the panel at `[B,C,A,D]` — one slot past the
 * indicator. Upward drags were always right, because removing an element after
 * the insertion point does not shift it.
 *
 * Here rather than at the call site because it is arithmetic over a layout,
 * which is what this module is for, and because "where the indicator said" is
 * a property a test can state. `movePanel`'s own "one further down" semantics
 * are deliberate and unchanged; this is the translation into them.
 */
export function dropIndex(
  layout: DockLayout,
  panel: string,
  zone: DockZone,
  index: number,
): number {
  const from = layout[zone].indexOf(panel)
  return from >= 0 && from < index ? index - 1 : index
}

/** Close a panel: a move to `hidden`, so it can be reopened where it lands. */
export const hidePanel = (layout: DockLayout, panel: string): DockLayout =>
  movePanel(layout, panel, 'hidden')

/**
 * Every panel that is on screen, in zone order, as the definitions themselves.
 *
 * The compact arrangement's whole census: on a phone the zones stop being read,
 * so what is left of a layout is *which panels are open and in what order*.
 * Pure, and here rather than inside `CompactDock`, for the reason every other
 * function in this file is here — it is the claim worth testing ("nothing is
 * stranded in a zone the compact layout no longer draws") and testing it
 * through a component means first getting a sheet open, which a static render
 * cannot do.
 *
 * A layout naming a panel that no longer exists is dropped rather than left as
 * a hole: `normalizeLayout` is the guard against stored ids going stale, and
 * this must not disagree with it.
 */
export function openPanels<T extends { readonly id: string }>(
  panels: readonly T[],
  layout: DockLayout,
): readonly T[] {
  return DOCK_ZONES.filter((zone) => zone !== 'hidden')
    .flatMap((zone) => [...layout[zone]])
    .map((id) => panels.find((panel) => panel.id === id))
    .filter((panel): panel is T => panel !== undefined)
}

/**
 * Show a panel again, in a zone that suits it.
 *
 * The zone a panel *prefers* is the panel's own business — a catalog belongs
 * on the left and the thing you are looking at belongs on the right — so the
 * caller passes it. Reopening always appends rather than restoring a remembered
 * slot: the
 * slot it left is very likely occupied, and a panel appearing in the middle of
 * a stack the user arranged is more surprising than one appearing at the end.
 */
export const showPanel = (
  layout: DockLayout,
  panel: string,
  zone: DockZone,
): DockLayout =>
  zoneOf(layout, panel) === zone ? layout : movePanel(layout, panel, zone)

/** Open a hidden panel, or hide an open one. */
export const togglePanel = (
  layout: DockLayout,
  panel: string,
  zone: DockZone,
): DockLayout =>
  zoneOf(layout, panel) === 'hidden' || zoneOf(layout, panel) === null
    ? showPanel(layout, panel, zone)
    : hidePanel(layout, panel)

/**
 * The full-zone index for a slot measured among the panels *on screen*.
 *
 * The two lists are not the same, and not only by the dragged panel:
 * a guarded group's panels are suppressed at render time while staying
 * resident in their zones — that is `visiblePanels`' contract, and the whole
 * point of suppression is that the arrangement survives the disclosure. So an
 * insertion index counted against the rendered stack cannot be spliced into
 * `layout[zone]` directly; with a suppressed panel above the drop point the
 * drop landed one slot above the line the indicator had just drawn, and some
 * same-pane drags were silent no-ops.
 *
 * The translation anchors on the *panel* rather than the number: inserting at
 * visible slot `n` means inserting before the nth rendered panel, wherever
 * that panel actually sits in the full list. Past the end — or with an anchor
 * the layout no longer holds, which a composed gesture can produce — it
 * appends, which is `movePanel`'s own out-of-range behavior.
 */
export function slotIndex(
  zoneList: readonly string[],
  visible: readonly string[],
  visibleIndex: number,
): number {
  const anchor = visible[visibleIndex]
  if (anchor === undefined) return zoneList.length
  const at = zoneList.indexOf(anchor)
  return at >= 0 ? at : zoneList.length
}

/**
 * Reconcile a stored layout with the panels this build actually has.
 *
 * `localStorage` outlives the code that wrote it, which `hud/panelState.ts`
 * already learned the hard way with a tab name. A layout is worse than a tab
 * name: a renamed panel leaves a dead string sitting in a zone forever, taking
 * up a slot and rendering nothing, and a *new* panel appears in no zone at all
 * and is unreachable — with no error anywhere, because an unknown id in an
 * array is a perfectly valid array.
 *
 * So unknown ids are dropped and unseen ones are placed where they say they
 * belong. The result is a fixpoint: normalizing twice changes nothing, which is
 * the property the test asserts because it is the one that makes this safe to
 * run on every render.
 */
export function normalizeLayout(
  layout: DockLayout,
  known: readonly { readonly id: string; readonly zone: DockZone }[],
): DockLayout {
  const byId = new Map(known.map((panel) => [panel.id, panel]))
  const placed = new Set<string>()
  const next: Record<DockZone, string[]> = {
    left: [],
    right: [],
    float: [],
    hidden: [],
  }

  for (const zone of DOCK_ZONES) {
    for (const id of layout[zone]) {
      if (!byId.has(id) || placed.has(id)) continue
      placed.add(id)
      next[zone].push(id)
    }
  }
  for (const panel of known) {
    if (placed.has(panel.id)) continue
    next[panel.zone].push(panel.id)
  }
  return next
}

/** The default arrangement: every panel where its own definition says. */
export const defaultLayout = (
  known: readonly { readonly id: string; readonly zone: DockZone }[],
): DockLayout => normalizeLayout(EMPTY_LAYOUT, known)

/**
 * Whether a stored value is shaped like a layout at all.
 *
 * The `Accept` guard `usePersistentState` takes. Deliberately structural only —
 * whether the *ids* mean anything is `normalizeLayout`'s question, and asking
 * it here would mean a layout stored before a panel was added is thrown away
 * whole rather than repaired.
 */
export function isDockLayout(value: unknown): value is DockLayout {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return DOCK_ZONES.every((zone) => {
    const list = record[zone]
    return Array.isArray(list) && list.every((id) => typeof id === 'string')
  })
}

/**
 * Where a pointer inside a stack of panels means to insert.
 *
 * Zone-relative rather than element-relative: the drop target is the whole
 * stack, and asking each panel whether the pointer is in its top or bottom half
 * needs a `useDrop` per panel and a hover handler that fires forty times a
 * second. One measurement of the stack and the panel bounds inside it answers
 * the same question, and it answers it the same way on touch — where there is
 * no hover at all and the only signal is where the finger lifted.
 *
 * `bounds` are the panels' extents along the stack's axis, in the same
 * coordinate space as `position`, in render order.
 */
export function insertionIndex(
  position: number,
  bounds: readonly { readonly start: number; readonly end: number }[],
): number {
  for (let i = 0; i < bounds.length; i += 1) {
    const panel = bounds[i]
    if (panel === undefined) continue
    // The midpoint, not the leading edge: a pointer in the top half of a panel
    // means "before this one", and using the edge instead makes the last
    // quarter of the stack impossible to hit.
    if (position < (panel.start + panel.end) / 2) return i
  }
  return bounds.length
}
