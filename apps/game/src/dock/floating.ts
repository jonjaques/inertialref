/*
 * Where a floating panel is, as arithmetic.
 *
 * The companion to `layout.ts`, and split from it on purpose. That module owns
 * the census — every known panel in exactly one zone, exactly once — and the
 * census must not be able to fail because a coordinate is missing. So a
 * position here is *optional by construction*: a panel in the `float` zone with
 * no entry in this map is not broken, it is a panel that has not been placed
 * yet, and `cascade` answers for it.
 *
 * The other half of the split is testability. A drag delta, a viewport resize
 * and a restored preference all reduce to the same question — given a point and
 * a box, where may the box actually be — and that question is a pure function
 * over four numbers, which is a Node test rather than a browser.
 */

export interface FloatPoint {
  readonly x: number
  readonly y: number
}

export interface FloatSize {
  readonly width: number
  readonly height: number
}

/** Panel id to its top-left corner, in viewport pixels. */
export type FloatPositions = Readonly<Record<string, FloatPoint>>

export const NO_FLOATS: FloatPositions = {}

/**
 * How close to the viewport edge a floating panel may sit.
 *
 * The same `0.75rem` inset the rest of the chrome uses, in pixels because this
 * is arithmetic over `getBoundingClientRect` and a rem here would have to be
 * resolved against a font size that is not this module's business.
 */
export const FLOAT_MARGIN = 12

/**
 * Keep a panel inside the frame.
 *
 * Strictly inside, rather than the "leave a grabbable sliver" rule most window
 * managers use, and the reason is that this is not a window manager: the thing
 * behind these panels is the subject, there is no taskbar to recover a lost
 * panel from, and a panel dragged 90% off the left edge is one the pane and the
 * menu both still claim is open. `hidden` is how a panel leaves the screen.
 *
 * A panel taller or wider than the viewport pins to the margin rather than
 * inverting its range — `Math.max` on the upper bound, which is the case a
 * phone in landscape actually produces.
 */
export function clampFloat(
  point: FloatPoint,
  size: FloatSize,
  viewport: FloatSize,
): FloatPoint {
  const maxX = Math.max(
    FLOAT_MARGIN,
    viewport.width - size.width - FLOAT_MARGIN,
  )
  const maxY = Math.max(
    FLOAT_MARGIN,
    viewport.height - size.height - FLOAT_MARGIN,
  )
  return {
    x: Math.round(Math.min(maxX, Math.max(FLOAT_MARGIN, point.x))),
    y: Math.round(Math.min(maxY, Math.max(FLOAT_MARGIN, point.y))),
  }
}

/** Place one panel, clamped. Absent ids are added; present ones are replaced. */
export function placeFloat(
  positions: FloatPositions,
  panel: string,
  point: FloatPoint,
  size: FloatSize,
  viewport: FloatSize,
): FloatPositions {
  return { ...positions, [panel]: clampFloat(point, size, viewport) }
}

/**
 * Move a panel by a delta — what a drag actually produces.
 *
 * React DnD reports a difference from where the gesture started, not an
 * absolute pointer position, which is the right signal: the panel should follow
 * the hand from wherever it was grabbed rather than snapping its corner to the
 * cursor.
 *
 * The base is `from` — where the panel was *drawn* — and deliberately not the
 * stored coordinate. The two disagree exactly when the store is stale: a
 * position written on a wide display and read back on a narrow one is clamped
 * for rendering but kept raw in the map, and a delta applied to the raw point
 * re-clamps to where the panel already is — a drag that visibly does nothing
 * until it has eaten the whole stale offset. `from` also answers for a panel
 * with no stored coordinate at all, which is rendering at its cascade point.
 */
export function nudgeFloat(
  positions: FloatPositions,
  panel: string,
  delta: FloatPoint,
  from: FloatPoint,
  size: FloatSize,
  viewport: FloatSize,
): FloatPositions {
  return placeFloat(
    positions,
    panel,
    { x: from.x + delta.x, y: from.y + delta.y },
    size,
    viewport,
  )
}

/**
 * Where the nth panel floated in a session goes when it has no remembered spot.
 *
 * Staggered rather than centered. Two panels floated one after the other and
 * placed at the same point look like one panel, and the top one has to be
 * dragged off the other before either can be read — which is a worse first
 * impression of the gesture than a slightly untidy cascade.
 *
 * Anchored clear of the left pane rather than to the viewport, and that is the
 * point of the constant rather than an aesthetic: a pane is 19rem plus its
 * 0.75rem gutter, so anything left of 316px opens *on top of* the catalog.
 * A panel that appeared underneath the thing it was just pulled out of reads
 * as the gesture having failed.
 */
export function cascade(index: number, viewport: FloatSize): FloatPoint {
  const step = 28
  const rung = index % 6
  return clampFloat(
    { x: 340 + rung * step, y: 96 + rung * step },
    { width: 320, height: 240 },
    viewport,
  )
}

/**
 * Drop coordinates for panels this build no longer has, and re-clamp the rest.
 *
 * The same argument `normalizeLayout` makes about ids, plus one this map has on
 * its own: a position is stored in viewport pixels, and the viewport a
 * preference was written against is not the one it is read back into. A panel
 * placed near the right edge of a 2560px display and reopened in a 1280px
 * window is off-screen with nothing to say so, which is exactly the "panel that
 * is open and cannot be seen" case `clampFloat` exists to make impossible.
 */
export function pruneFloats(
  positions: FloatPositions,
  known: readonly string[],
  size: FloatSize,
  viewport: FloatSize,
): FloatPositions {
  const next: Record<string, FloatPoint> = {}
  for (const id of known) {
    const point = positions[id]
    if (point === undefined) continue
    next[id] = clampFloat(point, size, viewport)
  }
  return next
}

/**
 * Whether a stored value is shaped like a position map.
 *
 * Structural only, like `isDockLayout`: whether the ids still mean anything is
 * `pruneFloats`' question, and a map written before a panel was renamed is
 * worth repairing rather than discarding whole.
 */
export function isFloatPositions(value: unknown): value is FloatPositions {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  return Object.values(value as Record<string, unknown>).every((point) => {
    if (typeof point !== 'object' || point === null) return false
    const { x, y } = point as Record<string, unknown>
    return (
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    )
  })
}
