import { DRAG_RADIANS_PER_PIXEL, pixelAngle } from '@inertialref/rendering'
import type { RenderHost } from './harness.ts'

/**
 * Radians of camera motion per pixel of pointer, over the reference rate.
 *
 * A drag moves the picture by the pixels dragged at any lens, which
 * `DRAG_RADIANS_PER_PIXEL` alone cannot do: it is a constant, so at 8× zoom
 * on the flight lens a 100 px drag swings the frame through three of its own
 * field-widths, and eleven at the telephoto end.
 *
 * **Two pixel counts, and they are not the same one.** `pixelAngle` is
 * radians per *display* pixel — the viewport keeps the device ratio, because
 * the terrain predicate and the circle of confusion are claims about physical
 * pixels — and a pointer delta arrives in CSS pixels. On a 2× display the
 * uncorrected answer moves the picture at half the rate of the hand, and on a
 * phone at two thirds, which is the case free look exists for.
 *
 * Shared by every camera a hand can drag, because it is a fact about the lens
 * and the display rather than about the camera: the observatory and the
 * flight camera read one number, and a drag that felt right in the
 * planetarium feels right beside the hull.
 *
 * 1 when there is no display to measure: headlessly the gesture is a number
 * in a script rather than a hand on a surface.
 */
export function dragSensitivityOf(render: RenderHost): number {
  const view = render.lensView()
  if (view === null) return 1
  /*
   * Whatever the host reports, floored only against nonsense.
   *
   * A headless host reports 1 through `renderHost`, so a clamp at 1 could
   * only ever fire on a ratio a host genuinely reported below one — which is
   * exactly what `devicePixelRatio` is with the browser zoomed out (0.8 at
   * 80%, 0.67 at 67%). The buffer really is that many device pixels per CSS
   * pixel there, so throwing the correction away moves the picture at 1.49×
   * the rate of the hand: the same defect as the 2× case, in the other
   * direction.
   */
  const ratio = render.pixelRatio()
  const usable = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  return (
    (pixelAngle(view.lens, view.viewport) * usable) / DRAG_RADIANS_PER_PIXEL
  )
}
