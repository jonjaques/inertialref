import { useState, type ReactNode } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { TouchBackend } from 'react-dnd-touch-backend'
import { coarsePointer } from '../hud/viewport.ts'

/*
 * React DnD, with the backend the device can actually deliver.
 *
 * The two backends are not interchangeable and neither covers both cases.
 * `HTML5Backend` rides the native drag-and-drop events, which gives real drag
 * images, correct cursors and no scroll interference — and which touch devices
 * do not fire at all, so on a phone every panel is simply immovable.
 * `TouchBackend` synthesises drags from pointer movement, which works
 * everywhere but loses the native drag image and has to be told to listen for
 * mouse events at all.
 *
 * So: choose once, from what the pointer *is*. Deliberately once, in state
 * initialised from the media query rather than re-read: `DndProvider` builds
 * its manager from the backend and cannot be handed a different one, so a
 * change of backend is a remount of the whole subtree — every panel loses its
 * scroll position and any drag in flight is dropped. A user who has just
 * plugged in a mouse can reload; a user whose panels reset because they brushed
 * the trackpad cannot understand what happened.
 *
 * `coarsePointer()` asks `(pointer: coarse)` rather than
 * `'ontouchstart' in window`, because the touch property is true on every
 * laptop with a touchscreen and those want the HTML5 path — the question is
 * what the *primary* pointer is, and that is exactly what the media feature
 * answers.
 */

const TOUCH_OPTIONS = {
  // Mouse events too, so a desktop browser emulating a phone in devtools —
  // which reports a coarse pointer and sends mouse events — is still driveable.
  // Without it, testing the mobile layout on a laptop looks like a bug.
  enableMouseEvents: true,
  /*
   * Eight pixels before a touch counts as a drag.
   *
   * Zero — the default — makes every tap on a panel header the start of a drag,
   * so a finger that moves two pixels while pressing a header button loses the
   * press. Eight is under the platform's own scroll threshold and above the
   * jitter of a stationary finger.
   */
  touchSlop: 8,
  /*
   * A long-press to start a drag, not an immediate one.
   *
   * A panel header on a phone is inside a scrolling sheet. Without a delay the
   * first vertical movement is claimed as a drag and the sheet never scrolls,
   * which reads as the panel being stuck rather than as a docking gesture.
   */
  delayTouchStart: 180,
  // The long-press also raises the platform's own context menu on some
  // browsers; letting it through would cancel the drag it just started.
  ignoreContextMenu: true,
} as const

export function DockProvider({ children }: { children: ReactNode }) {
  const [touch] = useState(coarsePointer)
  return touch ? (
    <DndProvider backend={TouchBackend} options={TOUCH_OPTIONS}>
      {children}
    </DndProvider>
  ) : (
    <DndProvider backend={HTML5Backend}>{children}</DndProvider>
  )
}
