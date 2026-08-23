/*
 * Turning input events into the three numbers the observatory understands.
 *
 * All of it is arithmetic over plain records rather than over `WheelEvent` and
 * `TouchList`, because every one of these has a wrong version that works on the
 * machine it was written on: a wheel normalization tuned on a mouse makes a
 * trackpad useless, a pinch that reads the first two touches breaks when a
 * third finger lands, and a drag that subtracts raw client coordinates jumps a
 * hundred pixels the moment a second finger lifts. Those are testable in Node
 * and only in Node — no browser reproduces a Firefox line-mode wheel event and
 * a Safari pinch in the same run.
 */

/** A pointer, reduced to what any of this needs. */
export interface Point {
  readonly x: number
  readonly y: number
}

/* ------------------------------------------------------------------------- */
/* The wheel                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * `WheelEvent.deltaMode`, named. The values are the DOM's own.
 *
 * The mode is the whole problem: the same physical scroll arrives as ~100
 * pixels in Chrome, 3 lines in Firefox, and single-digit pixels from a
 * trackpad — so a handler that treats `deltaY` as a distance zooms about
 * thirty times faster on one browser than another.
 */
export const DELTA_PIXEL = 0
export const DELTA_LINE = 1
export const DELTA_PAGE = 2

/** Pixels a line-mode wheel step stands for. The de-facto value everywhere. */
const PIXELS_PER_LINE = 16
/** ...and a page-mode one, which only Firefox with a modifier held emits. */
const PIXELS_PER_PAGE = 400

/**
 * One "notch" of a mouse wheel, in pixels.
 *
 * 100 because that is what a detented wheel actually reports in every
 * Chromium-derived browser. A trackpad's continuous scroll therefore arrives as
 * a fraction of a notch, which is exactly right: the zoom is multiplicative, so
 * ten small notches and one large one land in the same place.
 */
const PIXELS_PER_NOTCH = 100

/**
 * How many wheel notches an event represents.
 *
 * Sign follows the DOM's: positive `deltaY` is scrolling *down*, which retreats.
 * Clamped, because a page-mode event with a large delta would otherwise cross
 * the whole distance range in one flick — and the clamp is on the notches
 * rather than on the resulting distance so that the *feel* is bounded rather
 * than the outcome.
 */
export function wheelNotches(
  delta: number,
  mode: number = DELTA_PIXEL,
): number {
  if (!Number.isFinite(delta)) return 0
  const pixels =
    mode === DELTA_LINE
      ? delta * PIXELS_PER_LINE
      : mode === DELTA_PAGE
        ? delta * PIXELS_PER_PAGE
        : delta
  const notches = pixels / PIXELS_PER_NOTCH
  return Math.max(-4, Math.min(4, notches))
}

/* ------------------------------------------------------------------------- */
/* Touch                                                                      */
/* ------------------------------------------------------------------------- */

/** The mean of the live touches — what a one- or two-finger drag orbits by. */
export function centroid(points: readonly Point[]): Point | null {
  if (points.length === 0) return null
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  return { x: x / points.length, y: y / points.length }
}

/**
 * The spread of a pinch: the mean distance from the centroid.
 *
 * Mean-from-centroid rather than the distance between touches 0 and 1, which is
 * the version everybody writes first. With exactly two fingers they agree to a
 * factor of two; with three they do not, and the two-finger version jumps
 * discontinuously the instant a third finger lands or the first one lifts —
 * the zoom leaps by whatever the ratio happened to be. This one degrades
 * smoothly because it is defined for any number of touches.
 */
export function spread(points: readonly Point[]): number {
  const centre = centroid(points)
  if (centre === null || points.length < 2) return 0
  let total = 0
  for (const point of points) {
    total += Math.hypot(point.x - centre.x, point.y - centre.y)
  }
  return total / points.length
}

/**
 * The zoom ratio between two pinch spreads.
 *
 * Fingers moving apart means the subject grows, which means the camera comes
 * *in* — so the factor is inverted relative to the spread. Returns 1 (no
 * change) whenever either measurement is degenerate, which covers the first
 * frame of a pinch and the frame a finger lifts on.
 */
export function pinchFactor(previous: number, current: number): number {
  if (previous <= 1 || current <= 1) return 1
  const ratio = previous / current
  // Bounded, for the same reason the wheel is: a spread measured across a
  // frame in which a finger was recognized late produces an enormous ratio,
  // and one such frame would otherwise cross the entire distance range.
  return Math.max(0.5, Math.min(2, ratio))
}

/* ------------------------------------------------------------------------- */
/* Drag                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The displacement between two pointer samples, or zero when there is no pair.
 *
 * A helper rather than a subtraction at the call site because the null case is
 * the interesting one: a drag whose previous sample is missing — the first move
 * of a gesture, or the move after a finger count changed — must contribute
 * *nothing*, and the version that treats a missing sample as the origin swings
 * the camera by the pointer's absolute screen position.
 */
export function delta(previous: Point | null, current: Point | null): Point {
  if (previous === null || current === null) return { x: 0, y: 0 }
  return { x: current.x - previous.x, y: current.y - previous.y }
}

/* ------------------------------------------------------------------------- */
/* Keys                                                                       */
/* ------------------------------------------------------------------------- */

/** What a key does to the camera. `null` for anything the planetarium ignores. */
export type ObserverKeyAction =
  | { readonly kind: 'orbit'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'zoom'; readonly notches: number }
  | { readonly kind: 'frame' }
  | { readonly kind: 'reset' }

/** How far one arrow-key press orbits, in the same pixels a drag speaks. */
const KEY_STEP_PIXELS = 24

/**
 * The keyboard's share of the camera.
 *
 * Arrow keys orbit, `+`/`-` zoom, `F` frames the target, `Home` resets. Its own
 * function so the bindings are a table rather than a switch inside an event
 * handler — which is what makes them assertable, and what will make them
 * rebindable when `docs/design/ux.md`'s "everything is rebindable" arrives.
 *
 * Deliberately returns `null` for a modified key: `Cmd`-left is the browser's
 * back gesture and `Ctrl`-`+` is the page zoom, and a planetarium that
 * swallowed either would be breaking the platform to pan a camera.
 */
export function keyAction(event: {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}): ObserverKeyAction | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true)
    return null
  // Shift is a magnitude modifier rather than a different action: fine control
  // near a surface and coarse control between stars are the same two gestures.
  // It applies to the arrows and not to the zoom keys — see `'+'` below.
  const step = event.shiftKey === true ? KEY_STEP_PIXELS * 4 : KEY_STEP_PIXELS
  switch (event.key) {
    case 'ArrowLeft':
      return { kind: 'orbit', dx: -step, dy: 0 }
    case 'ArrowRight':
      return { kind: 'orbit', dx: step, dy: 0 }
    case 'ArrowUp':
      return { kind: 'orbit', dx: 0, dy: -step }
    case 'ArrowDown':
      return { kind: 'orbit', dx: 0, dy: step }
    /*
     * One notch each way, and `shiftKey` deliberately unread.
     *
     * `+` *is* Shift-`=` on every layout this ships to, so the modifier is set
     * whenever the key is `+` and clear whenever it is `=` — it carries no
     * information here. Read as a magnitude modifier it made the two keys the
     * help text names, `+` and `−`, differ by a factor of four: pressing one
     * and then the other did not return the camera to where it started, which
     * is the one thing a zoom pair has to do.
     */
    case '+':
    case '=':
      return { kind: 'zoom', notches: -1 }
    case '-':
    case '_':
      return { kind: 'zoom', notches: 1 }
    case 'f':
    case 'F':
      return { kind: 'frame' }
    case 'Home':
      return { kind: 'reset' }
    default:
      return null
  }
}
