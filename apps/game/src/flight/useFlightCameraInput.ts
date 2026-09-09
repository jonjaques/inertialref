import { useEffect, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useActions } from '../input/useKeymap.ts'
import {
  centroid,
  GESTURE_START,
  type GesturePhase,
  gestureStep,
  type Point,
  spread,
  wheelNotches,
} from '../planetarium/gestures.ts'

/*
 * Hands on the flight camera.
 *
 * The planetarium's `useObserverInput`, cut down to what a ship's camera has:
 * no pick, no stance, no first-visit preference. The same pointer events for
 * every kind of hand and the same gesture arithmetic, because a drag beside
 * the hull should feel like a drag beside a planet — one grab metaphor, one
 * pinch, one wheel.
 *
 * What a drag *does* is the flight camera's decision, not this hook's: in
 * the orbit view it orbits, in the chase it turns the head, and the
 * secondary button turns the head in either. The keys are the same shape —
 * `flight.view` cycles the view and `flight.recentre` levels the head — and
 * they are ids, so the hint that names them reads the live chord.
 */

export function useFlightCameraInput(
  engine: GameEngine,
): (node: HTMLElement | null) => void {
  // State rather than a ref, for the reason `useObserverInput` gives: a ref
  // callback does not re-run the effect that attaches the listeners.
  const [surface, setSurface] = useState<HTMLElement | null>(null)

  useActions(['flight.view'], () => {
    engine.harness.flightCamera.cycleView()
  })
  useActions(['flight.recentre'], () => {
    engine.harness.flightCamera.recentre()
  })

  useEffect(() => {
    const node = surface
    if (node === null) return
    const flightCamera = engine.harness.flightCamera

    const down = new Map<number, Point>()
    let phase: GesturePhase = GESTURE_START
    /** Whether the gesture in flight turns the head rather than the orbit. */
    let looking = false
    // Read when a gesture starts and not again — the surface cannot move
    // under a drag, and `getBoundingClientRect` on every move flushes layout.
    let rect = node.getBoundingClientRect()

    const local = (event: PointerEvent): Point => ({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })

    const onPointerDown = (event: PointerEvent): void => {
      // The primary button and the secondary; the middle one stays the
      // browser's autoscroll.
      if (
        event.pointerType === 'mouse' &&
        event.button !== 0 &&
        event.button !== 2
      )
        return
      if (down.size === 0) rect = node.getBoundingClientRect()
      node.setPointerCapture(event.pointerId)
      down.set(event.pointerId, local(event))
      const points = [...down.values()]
      phase = { centre: centroid(points), spread: spread(points) }
      if (down.size === 1) looking = event.button === 2
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!down.has(event.pointerId)) return
      down.set(event.pointerId, local(event))
      const step = gestureStep(phase, [...down.values()])
      if (step.orbit.x !== 0 || step.orbit.y !== 0) {
        if (looking) flightCamera.turn(step.orbit.x, step.orbit.y)
        else flightCamera.drag(step.orbit.x, step.orbit.y)
      }
      if (step.zoom !== 1) flightCamera.zoom(step.zoom)
      phase = step
    }

    const release = (event: PointerEvent): void => {
      if (!down.has(event.pointerId)) return
      down.delete(event.pointerId)
      if (node.hasPointerCapture(event.pointerId))
        node.releasePointerCapture(event.pointerId)
      if (down.size === 0) {
        phase = GESTURE_START
        looking = false
        return
      }
      // A finger lifted from a pinch: re-seed, or the camera lurches.
      const points = [...down.values()]
      phase = { centre: centroid(points), spread: spread(points) }
    }

    const onWheel = (event: WheelEvent): void => {
      // Not passive: a page that scrolled under a dolly would be unusable on
      // a trackpad, and `preventDefault` on a passive listener is a warning.
      event.preventDefault()
      const notches = wheelNotches(event.deltaY, event.deltaMode)
      if (notches !== 0) flightCamera.zoomNotches(notches)
    }

    // The secondary button drags the look, so the menu it would open on
    // release is declined — on this surface and nowhere else.
    const onContextMenu = (event: MouseEvent): void => event.preventDefault()

    node.addEventListener('pointerdown', onPointerDown)
    node.addEventListener('pointermove', onPointerMove)
    node.addEventListener('pointerup', release)
    node.addEventListener('pointercancel', release)
    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('contextmenu', onContextMenu)
    return () => {
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', release)
      node.removeEventListener('pointercancel', release)
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('contextmenu', onContextMenu)
    }
  }, [engine, surface])

  return setSurface
}
