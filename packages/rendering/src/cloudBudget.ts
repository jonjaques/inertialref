/*
 * The cloud passes' extents and their declared memory.
 *
 * The trace grid is a quarter of the scene target's axes wherever that is not
 * larger than a quarter of the display's, so the ray budget follows the
 * display and not the drawing buffer: at Retina the buffer is twice the CSS
 * axes and the trace is not. The history is twice the trace on each axis.
 */

export interface Extent {
  readonly width: number
  readonly height: number
}

export interface CloudExtents {
  /** The scene target. */
  readonly render: Extent
  /** Display pixels. */
  readonly css: Extent
  /** ceil(min(render, css) / 4) × traceScale, long edge ≤ 480 × traceScale. */
  readonly trace: Extent
  /** 2 × trace. */
  readonly history: Extent
}

export const CLOUD_TRACE_DIVISOR = 4
export const CLOUD_TRACE_LONG_EDGE = 480

export function cloudExtents(
  render: Extent,
  css: Extent,
  traceScale = 1,
): CloudExtents {
  const width = Math.ceil(
    Math.min(render.width, css.width) / CLOUD_TRACE_DIVISOR,
  )
  const height = Math.ceil(
    Math.min(render.height, css.height) / CLOUD_TRACE_DIVISOR,
  )
  // A display past 1920 CSS pixels wide keeps the 1080p budget rather than a
  // quarter of itself; both axes shrink together, so the aspect holds.
  const fit = Math.min(1, CLOUD_TRACE_LONG_EDGE / Math.max(width, height, 1))
  const cap = Math.floor(CLOUD_TRACE_LONG_EDGE * traceScale)
  const scaled = (axis: number): number =>
    Math.min(cap, Math.max(1, Math.round(axis * fit * traceScale)))
  const trace = { width: scaled(width), height: scaled(height) }
  return {
    render,
    css,
    trace,
    history: { width: 2 * trace.width, height: 2 * trace.height },
  }
}

/**
 * Declared bytes: what the "in memory" column is made of. `levels` defaults
 * to 1, which every cloud texture has; a further level halves the width and
 * the height, and `depth` counts layers or slices alike.
 */
export function textureBytes(
  width: number,
  height: number,
  depth: number,
  bytesPerTexel: number,
  levels = 1,
): number {
  let texels = 0
  for (let level = 0; level < levels; level += 1)
    texels += Math.max(1, width >> level) * Math.max(1, height >> level)
  return texels * depth * bytesPerTexel
}
