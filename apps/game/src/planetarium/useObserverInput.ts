import { useEffect, useRef, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  centroid,
  delta,
  keyAction,
  pinchFactor,
  type Point,
  spread,
  wheelNotches,
} from './gestures.ts'

/*
 * Hands on the camera.
 *
 * Pointer events for everything — mouse, pen and every finger — rather than
 * mouse events plus a touch branch. One code path means a pinch on a trackpad,
 * a drag with a stylus and two fingers on a phone all arrive as the same
 * bookkeeping, and it removes the class of bug where a device fires both
 * families and the camera moves twice per gesture.
 *
 * The gesture arithmetic itself is in `gestures.ts` and tested there. What is
 * here is the bookkeeping that only a browser has: which pointers are down,
 * what the previous sample was, and whether a press that never moved should be
 * treated as a click.
 */

/** Movement under this, in pixels, and the press was a click rather than a drag. */
const CLICK_SLOP = 5

export interface ObserverInputOptions {
  /** Off in every other mode; the listeners are not attached at all. */
  readonly enabled: boolean
  /** A click that was not a drag, in element-relative pixels. */
  readonly onPick: (point: Point) => void
  /** `F` — frame the current target. */
  readonly onFrame: () => void
  /** `Home` — back to where the session opened. */
  readonly onReset: () => void
}

export function useObserverInput(
  engine: GameEngine,
  options: ObserverInputOptions,
): (node: HTMLElement | null) => void {
  /*
   * State rather than a ref for the element, and that is not a style choice: a
   * ref assigned by a ref callback does not re-run the effect that reads it, so
   * the listeners would be attached only if the node happened to exist before
   * the first effect — which it does not on the first mount. This is the one
   * place where "the DOM node is state" is literally true.
   */
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  // The callbacks are read from a ref inside long-lived native listeners, so a
  // re-render with new ones does not tear down and rebuild every listener —
  // which on a touch device drops any gesture in flight.
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const node = surface
    if (node === null || !options.enabled) return
    const observatory = engine.harness.observatory

    /*
     * Every pointer currently down, by id.
     *
     * A Map rather than a count, because the centroid and the spread both need
     * the actual positions, and because a pointer that is canceled (a system
     * gesture claiming it, a phone call arriving) has to be removed by id
     * rather than by decrementing something.
     */
    const down = new Map<number, Point>()
    let previousCentre: Point | null = null
    let previousSpread = 0
    let travelled = 0
    let pressedAt: Point | null = null

    const local = (event: PointerEvent): Point => {
      const rect = node.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onPointerDown = (event: PointerEvent): void => {
      // Only the primary button orbits. The secondary one is the context menu
      // and the middle one is the browser's autoscroll; claiming either would
      // be taking a platform gesture to do something a drag already does.
      if (event.pointerType === 'mouse' && event.button !== 0) return
      node.setPointerCapture(event.pointerId)
      down.set(event.pointerId, local(event))
      previousCentre = centroid([...down.values()])
      previousSpread = spread([...down.values()])
      if (down.size === 1) {
        travelled = 0
        pressedAt = previousCentre
      } else {
        // A second finger landing means this is not a click any more, and the
        // centroid has just jumped to the midpoint — so the next move must not
        // be read as a drag of that distance.
        pressedAt = null
      }
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!down.has(event.pointerId)) return
      down.set(event.pointerId, local(event))
      const points = [...down.values()]
      const centre = centroid(points)
      const currentSpread = spread(points)

      const moved = delta(previousCentre, centre)
      travelled += Math.hypot(moved.x, moved.y)
      if (moved.x !== 0 || moved.y !== 0) observatory.drag(moved.x, moved.y)
      if (points.length >= 2) {
        observatory.zoom(pinchFactor(previousSpread, currentSpread))
      }

      previousCentre = centre
      previousSpread = currentSpread
    }

    const release = (event: PointerEvent): void => {
      if (!down.has(event.pointerId)) return
      down.delete(event.pointerId)
      if (node.hasPointerCapture(event.pointerId))
        node.releasePointerCapture(event.pointerId)

      if (down.size === 0) {
        // A press that never traveled is a click. Checked on release rather
        // than on down, because on a touch screen there is no way to know at
        // press time which one it will turn out to be.
        if (
          pressedAt !== null &&
          travelled < CLICK_SLOP &&
          event.type === 'pointerup'
        ) {
          latest.current.onPick(pressedAt)
        }
        previousCentre = null
        previousSpread = 0
        pressedAt = null
        return
      }
      // A finger lifted from a multi-touch gesture: the centroid and spread
      // both jump, and re-seeding them is what stops the camera lurching.
      const points = [...down.values()]
      previousCentre = centroid(points)
      previousSpread = spread(points)
      pressedAt = null
    }

    const onWheel = (event: WheelEvent): void => {
      // Not passive: a planetarium that let the page scroll under a zoom would
      // be unusable on a trackpad, and `preventDefault` on a passive listener
      // is a console warning and nothing else.
      event.preventDefault()
      const notches = wheelNotches(event.deltaY, event.deltaMode)
      if (notches !== 0) observatory.zoomNotches(notches)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // A key typed into the search box is not a camera command. The focus
      // check is here rather than in `keyAction` because "is something else
      // listening" is a fact about the document, not about the key.
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      )
        return

      const action = keyAction(event)
      if (action === null) return
      event.preventDefault()
      switch (action.kind) {
        case 'orbit':
          observatory.drag(action.dx, action.dy)
          break
        case 'zoom':
          observatory.zoomNotches(action.notches)
          break
        case 'frame':
          latest.current.onFrame()
          break
        case 'reset':
          latest.current.onReset()
          break
      }
    }

    node.addEventListener('pointerdown', onPointerDown)
    node.addEventListener('pointermove', onPointerMove)
    node.addEventListener('pointerup', release)
    node.addEventListener('pointercancel', release)
    node.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', release)
      node.removeEventListener('pointercancel', release)
      node.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [engine, surface, options.enabled])

  return setSurface
}
