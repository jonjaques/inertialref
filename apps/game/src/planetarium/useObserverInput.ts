import { useEffect, useRef, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useActions, useKeyContext } from '../input/useKeymap.ts'
import type { ActionId } from '../input/keymap.ts'
import {
  centroid,
  GESTURE_START,
  type GesturePhase,
  gestureStep,
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
 * The gesture arithmetic itself is in `gestures.ts` and tested there; the keys
 * are `input/keymap.ts` and dispatched from one listener the whole app shares.
 * What is here is the bookkeeping that only a browser has: which pointers are
 * down, what the previous sample was, and whether a press that never moved
 * should be treated as a click.
 *
 * **Two ways to look, because there are two kinds of hand.** The secondary
 * button drags the look and suppresses its own context menu — only its own; a
 * sky has no menu, and taking the menu off the whole document to do it would be
 * the interface reaching outside itself. The toggle is the other way, and it is
 * the *only* way on a phone and with a keyboard alone: with it on, the primary
 * drag and the arrow keys look instead of orbiting.
 */

/** Movement under this, in pixels, and the press was a click rather than a drag. */
const CLICK_SLOP = 5

/** How far one arrow-key press moves the camera, in the pixels a drag speaks. */
const KEY_STEP_PIXELS = 24

/** What the four arrow actions do, as a pixel delta. */
const ARROWS: Readonly<Record<string, Point>> = {
  'observe.left': { x: -1, y: 0 },
  'observe.right': { x: 1, y: 0 },
  'observe.up': { x: 0, y: -1 },
  'observe.down': { x: 0, y: 1 },
}

const ARROW_IDS = Object.keys(ARROWS) as readonly ActionId[]

export interface ObserverInputOptions {
  /** Off in every other mode; the surface listeners are not attached at all. */
  readonly enabled: boolean
  /**
   * A click that was not a drag, in **client** pixels.
   *
   * Client rather than element-relative, and the distinction is load-bearing
   * because the surface carries `hud-bleed`: its own box starts at
   * `-safe-area-inset-left`, so an element-relative point is 44 px out on a
   * landscape iPhone. The only consumer projects the scene into
   * `window.innerWidth`/`innerHeight`, which is client space, so this is the
   * space the two have to agree in.
   */
  readonly onPick: (point: Point) => void
  /** `F` — frame the current target. */
  readonly onFrame: () => void
  /** `Home` — back to where the session opened. */
  readonly onReset: () => void
  /** Whether the observatory is standing, so `standing` is a live context. */
  readonly standing: boolean
  /** Whether the primary drag and the arrows look instead of orbiting. */
  readonly freeLook: boolean
  readonly onFreeLook: (on: boolean) => void
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

  useKeyContext({ context: 'planetarium' })
  // Only while the camera is actually on the ground: `PageUp` and `Backspace`
  // mean nothing in orbit, and a binding that fired there would be a control
  // with a null effect.
  useKeyContext({ context: 'standing' }, options.standing)

  useActions(ARROW_IDS, (id, event) => {
    if (event.phase !== 'down') return
    const step = ARROWS[id]
    if (step === undefined) return
    // Shift is a magnitude, not a second binding: fine control near a surface
    // and coarse control between stars are the same two gestures.
    const scale = KEY_STEP_PIXELS * (event.shift ? 4 : 1)
    const dx = step.x * scale
    const dy = step.y * scale
    const observatory = engine.harness.observatory
    if (latest.current.freeLook || observatory.standing) {
      observatory.turn(dx, dy)
      return
    }
    observatory.drag(dx, dy, observatory.dragSensitivity())
  })

  useActions(['observe.in'], () => engine.harness.observatory.zoomNotches(-1))
  useActions(['observe.out'], () => engine.harness.observatory.zoomNotches(1))
  useActions(['observe.frame'], () => latest.current.onFrame())
  useActions(['observe.home'], () => latest.current.onReset())
  useActions(['observe.freeLook'], () =>
    latest.current.onFreeLook(!latest.current.freeLook),
  )

  useActions(['stand.leave'], () => engine.harness.observatory.leaveSurface())
  useActions(['stand.up', 'stand.down'], (id, event) => {
    if (event.phase !== 'down') return
    const observatory = engine.harness.observatory
    const status = observatory.status()
    const scrub = status.surface?.scrub
    if (scrub === undefined) return
    // A tenth of the travel per press, which on Earth's six decades is about
    // four times the height each time — the same ratio the scrub slider spends
    // its logarithm on.
    observatory.setStanceScrub(scrub + (id === 'stand.up' ? 0.1 : -0.1))
  })

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
    let phase: GesturePhase = GESTURE_START
    let travelled = 0
    let pressedAt: Point | null = null
    /** Whether the gesture in flight is a look rather than an orbit. */
    let looking = false

    /*
     * The surface's rectangle, read when a gesture starts and not again.
     *
     * `getBoundingClientRect` forces the browser to flush layout, and this used
     * to run inside `local()` on every `pointermove` — which on a phone is once
     * per finger per frame, so a two-finger pinch at 120 Hz cost 240 synchronous
     * layouts a second on top of a scene that was already the reason the pinch
     * felt bad. The surface is stretched to the viewport and the viewport cannot
     * scroll, so it cannot move under a gesture in progress; re-reading it was
     * paying for a change that cannot happen.
     */
    let rect = node.getBoundingClientRect()

    const local = (event: PointerEvent): Point => ({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })

    const onPointerDown = (event: PointerEvent): void => {
      /*
       * The primary button orbits and the secondary looks; the middle one is
       * the browser's autoscroll and stays the browser's.
       *
       * The secondary button used to be declined outright, on the argument that
       * claiming it takes a platform gesture to do something a drag already
       * does. That was true while there was only one thing a drag could do.
       */
      if (
        event.pointerType === 'mouse' &&
        event.button !== 0 &&
        event.button !== 2
      )
        return
      // Re-measured only when a gesture begins from nothing: a rotation or a
      // browser-chrome change between gestures does move the surface.
      if (down.size === 0) rect = node.getBoundingClientRect()
      node.setPointerCapture(event.pointerId)
      down.set(event.pointerId, local(event))
      const points = [...down.values()]
      phase = { centre: centroid(points), spread: spread(points) }
      if (down.size === 1) {
        travelled = 0
        looking =
          event.button === 2 || latest.current.freeLook || observatory.standing
        // Client coordinates, not `phase.centre`. The gesture arithmetic only
        // ever reads *differences*, so the element's own offset cancels out of
        // it; a pick is an absolute position and the projection it is tested
        // against is in client space. See `onPick`.
        pressedAt = { x: event.clientX, y: event.clientY }
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
      // Which of the two the camera gets is `gestureStep`'s decision, tested in
      // Node beside the rest of the gesture arithmetic. What is here is the
      // bookkeeping only a browser has.
      const step = gestureStep(phase, [...down.values()])
      travelled += step.travelled
      if (step.orbit.x !== 0 || step.orbit.y !== 0) {
        // The sensitivity is the lens's own pixel angle, so the ground under
        // the pointer follows the pointer at any focal length. A constant
        // radians-per-pixel swings the frame through forty field-widths at 8×.
        if (looking) observatory.turn(step.orbit.x, step.orbit.y)
        else
          observatory.drag(
            step.orbit.x,
            step.orbit.y,
            observatory.dragSensitivity(),
          )
      }
      if (step.zoom !== 1) observatory.zoom(step.zoom)
      phase = step
    }

    const release = (event: PointerEvent): void => {
      if (!down.has(event.pointerId)) return
      down.delete(event.pointerId)
      if (node.hasPointerCapture(event.pointerId))
        node.releasePointerCapture(event.pointerId)

      if (down.size === 0) {
        // A press that never traveled is a click. Checked on release rather
        // than on down, because on a touch screen there is no way to know at
        // press time which one it will turn out to be. Only the primary
        // button's — a right-click that did not move is a menu somebody asked
        // for and did not get, not a pick.
        if (
          pressedAt !== null &&
          travelled < CLICK_SLOP &&
          event.type === 'pointerup' &&
          event.button !== 2
        ) {
          latest.current.onPick(pressedAt)
        }
        phase = GESTURE_START
        pressedAt = null
        looking = false
        return
      }
      // A finger lifted from a multi-touch gesture: the centroid and spread
      // both jump, and re-seeding them is what stops the camera lurching.
      const points = [...down.values()]
      phase = { centre: centroid(points), spread: spread(points) }
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

    /*
     * The context menu, on this surface and nowhere else.
     *
     * The secondary button drags the look, and a menu opening on release would
     * make the gesture unusable. Bound to the node rather than the document so
     * every other right-click in the interface — a panel, a link, an address to
     * copy — still gets the menu the platform provides.
     */
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
  }, [engine, surface, options.enabled])

  return setSurface
}
