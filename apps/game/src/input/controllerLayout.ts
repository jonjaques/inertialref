import type { PadControl } from './pad.ts'
import { isPlayStation, type PadFamily } from './padFamily.ts'

/*
 * Where each control is drawn on the controller picture.
 *
 * The silhouette is a generic two-grip pad drawn for this page, not a trace
 * of anybody's controller: the shapes of a manufacturer's hardware are its
 * trade dress, and a picture whose job is to say "this button, here" does not
 * need them. What it does need is the attached pad's *arrangement*, because a
 * diagram with the left stick in the wrong place sends a thumb to the d-pad —
 * so the sticks are symmetric and low for a PlayStation pad and offset for
 * everything else, which is the one layout difference every family has.
 *
 * Coordinates are in a design space (`DESIGN`) and placed into the drawing by
 * one transform, so the body and the leader lines to its callouts agree by
 * construction rather than by two sets of numbers kept in step.
 */

/**
 * The drawing's own box, in the units its text is set in.
 *
 * About one unit to the CSS pixel at the wide dialog's width, so the
 * callouts' 13-unit text is the interface's own label size rather than a
 * smaller copy of it — scaled to fit a narrow window, it shrinks with the
 * window, which is the right thing for a picture to do.
 */
export const VIEW = { width: 860, height: 300 } as const

/** Design space → drawing: scale about the body's center line. */
const SCALE = 0.72
const ORIGIN = { x: 430, y: 62 } as const

export const placeX = (x: number): number => ORIGIN.x + (x - 320) * SCALE
export const placeY = (y: number): number => ORIGIN.y + (y - 90) * SCALE
export const BODY_TRANSFORM = `translate(${ORIGIN.x - 320 * SCALE} ${ORIGIN.y - 90 * SCALE}) scale(${SCALE})`

/** The outline, in design space. Symmetric about x = 320. */
export const BODY_PATH = [
  'M200 90H440',
  'C505 90 545 102 565 135',
  'C592 180 616 270 612 326',
  'C609 366 578 384 552 374',
  'C528 365 508 338 486 312',
  'C470 294 448 290 425 290',
  'H215',
  'C192 290 170 294 154 312',
  'C132 338 112 365 88 374',
  'C62 384 31 366 28 326',
  'C24 270 48 180 75 135',
  'C95 102 135 90 200 90Z',
].join('')

export interface Point {
  readonly x: number
  readonly y: number
}

/** One family's arrangement, in design space. */
export interface Arrangement {
  readonly dpad: Point
  readonly face: Point
  readonly leftStick: Point
  readonly rightStick: Point
  readonly select: Point
  readonly start: Point
  readonly home: Point
  /** The touchpad's box on a PlayStation pad; a small button elsewhere. */
  readonly touchpad: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

const SYMMETRIC: Arrangement = {
  dpad: { x: 160, y: 175 },
  face: { x: 480, y: 175 },
  leftStick: { x: 248, y: 248 },
  rightStick: { x: 392, y: 248 },
  select: { x: 222, y: 122 },
  start: { x: 418, y: 122 },
  home: { x: 320, y: 208 },
  touchpad: { x: 248, y: 100, width: 144, height: 72 },
}

const OFFSET: Arrangement = {
  dpad: { x: 248, y: 248 },
  face: { x: 480, y: 175 },
  leftStick: { x: 160, y: 175 },
  rightStick: { x: 392, y: 248 },
  select: { x: 280, y: 168 },
  start: { x: 360, y: 168 },
  home: { x: 320, y: 120 },
  touchpad: { x: 308, y: 196, width: 24, height: 12 },
}

export const arrangementFor = (family: PadFamily): Arrangement =>
  isPlayStation(family) ? SYMMETRIC : OFFSET

/** How far a face button and a d-pad arm sit from their cluster's center. */
export const CLUSTER = 36
/** A stick's gate and cap radii, and how far the cap travels at full throw. */
export const STICK = { gate: 32, cap: 21, travel: 12 } as const

/** The design-space point a control's leader line starts from. */
export function anchorOf(control: PadControl, layout: Arrangement): Point {
  const { dpad, face, leftStick, rightStick } = layout
  switch (control) {
    case 'north':
      return { x: face.x, y: face.y - CLUSTER }
    case 'south':
      return { x: face.x, y: face.y + CLUSTER }
    case 'west':
      return { x: face.x - CLUSTER, y: face.y }
    case 'east':
      return { x: face.x + CLUSTER, y: face.y }
    case 'up':
      return { x: dpad.x, y: dpad.y - CLUSTER + 6 }
    case 'down':
      return { x: dpad.x, y: dpad.y + CLUSTER - 6 }
    case 'left':
      return { x: dpad.x - CLUSTER + 6, y: dpad.y }
    case 'right':
      return { x: dpad.x + CLUSTER - 6, y: dpad.y }
    case 'l1':
      return { x: 150, y: 75 }
    case 'r1':
      return { x: 490, y: 75 }
    case 'l2':
      return { x: 150, y: 42 }
    case 'r2':
      return { x: 490, y: 42 }
    case 'select':
      return layout.select
    case 'start':
      return layout.start
    case 'home':
      return layout.home
    case 'touchpad':
      return {
        x: layout.touchpad.x + layout.touchpad.width / 2,
        y: layout.touchpad.y + layout.touchpad.height / 2,
      }
    case 'l3':
      return { x: leftStick.x, y: leftStick.y + STICK.cap }
    case 'r3':
      return { x: rightStick.x, y: rightStick.y + STICK.cap }
    default:
      return control.startsWith('ls') ? leftStick : rightStick
  }
}

/**
 * The callouts, a column down each side, top to bottom in the order the
 * controls sit on the pad so the leader lines cross as little as they can.
 * A stick's four directions are one callout (`ls`, `rs`), summarized.
 */
export type Callout = PadControl | 'ls' | 'rs'

export function calloutsFor(family: PadFamily): {
  readonly left: readonly Callout[]
  readonly right: readonly Callout[]
} {
  const playstation = isPlayStation(family)
  return {
    left: playstation
      ? ['l2', 'l1', 'select', 'up', 'left', 'right', 'down', 'ls', 'l3']
      : ['l2', 'l1', 'ls', 'l3', 'select', 'up', 'left', 'right', 'down'],
    right: [
      'r2',
      'r1',
      'touchpad',
      'start',
      'north',
      'west',
      'east',
      'south',
      'rs',
      'r3',
    ],
  }
}

/** The y of the i-th of `count` callouts in a column. */
export function calloutY(index: number, count: number): number {
  const top = 22
  const bottom = VIEW.height - 14
  return count <= 1 ? top : top + ((bottom - top) * index) / (count - 1)
}

/** Where a callout's text column sits, and which way it reads. */
export const COLUMN = {
  left: { x: 196, anchor: 'end' },
  right: { x: 664, anchor: 'start' },
} as const
