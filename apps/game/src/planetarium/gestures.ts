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
/* One step of a gesture                                                      */
/* ------------------------------------------------------------------------- */

/** What the live pointers were doing last time this was asked. */
export interface GesturePhase {
  /** The previous centroid, or null at the start of a gesture. */
  readonly centre: Point | null
  /** The previous spread. Zero at the start, and with fewer than two pointers. */
  readonly spread: number
}

export const GESTURE_START: GesturePhase = { centre: null, spread: 0 }

/** What one move of the live pointers does to the camera. */
export interface GestureStep extends GesturePhase {
  /** Pixels of orbit. Always zero while more than one pointer is down. */
  readonly orbit: Point
  /** Multiplier on distance. Always 1 with fewer than two pointers. */
  readonly zoom: number
  /** Pixels the centroid moved, for the caller's click-versus-drag decision. */
  readonly travelled: number
}

/**
 * One finger orbits. Two or more zoom, and *only* zoom.
 *
 * The exclusion is the part worth stating. The centroid used to drive the orbit
 * whatever the finger count was, which is right for a symmetric pinch — both
 * fingers moving apart equally leaves the centroid where it was — and wrong for
 * the pinch people actually make, which anchors one finger and moves the other.
 * That moves the centroid by half the pinch travel, so a 200 px pinch also swung
 * the camera through half a radian at `DRAG_RADIANS_PER_PIXEL`: the zoom you
 * asked for arrived with a spin you did not.
 *
 * Nothing is lost by dropping it. This camera orbits a target it cannot pan
 * away from, so a two-finger drag never meant anything a one-finger drag did
 * not already mean — unlike a map, where two-finger pan and pinch are genuinely
 * different gestures.
 *
 * `travelled` is reported for any finger count, because the caller's click test
 * needs a distance and the answer "you moved" is true however many fingers did
 * it.
 */
export function gestureStep(
  previous: GesturePhase,
  points: readonly Point[],
): GestureStep {
  const centre = centroid(points)
  const currentSpread = spread(points)
  const moved = delta(previous.centre, centre)
  const travelled = Math.hypot(moved.x, moved.y)
  const pinching = points.length >= 2
  return {
    orbit: pinching ? { x: 0, y: 0 } : moved,
    zoom: pinching ? pinchFactor(previous.spread, currentSpread) : 1,
    centre,
    spread: currentSpread,
    travelled,
  }
}
