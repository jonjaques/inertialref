import type { Callout } from './controllerLayout.ts'
import { type KeyContext, padActions, type PadBindings } from './keymap.ts'
import {
  isPadStick,
  PAD_BUTTONS,
  type PadControl,
  type PadStick,
} from './pad.ts'

/*
 * What the controller picture says beside each control, for one mode.
 *
 * Asked of `padActions` — the dispatcher's own resolution — for the mode's
 * live set, so the picture shows what a press would actually do, shadows and
 * all: on the ground the left stick says "Fly", because `standing` takes it
 * from the planetarium's look, and a picture that said "Look" there would be
 * describing a binding the dispatcher never reaches.
 */

/** The modes the controls page draws, each as the contexts live in it. */
export const PAD_VIEWS = [
  {
    id: 'flight',
    title: 'Flight',
    live: ['global', 'flight', 'character-entry'],
    rows: ['flight', 'flight-look', 'character-entry'],
  },
  {
    id: 'planetarium',
    title: 'Planetarium',
    live: ['global', 'planetarium'],
    rows: ['planetarium'],
  },
  {
    id: 'standing',
    title: 'Standing',
    live: ['global', 'planetarium', 'standing'],
    rows: ['standing'],
  },
  {
    id: 'character',
    title: 'On foot',
    live: ['global', 'character', 'character-entry'],
    rows: ['character'],
  },
  {
    id: 'cinema',
    title: 'Cinema',
    live: ['global', 'cinema'],
    rows: ['cinema', 'cutscene', 'dialog'],
  },
  {
    id: 'global',
    title: 'Everywhere',
    live: ['global'],
    rows: ['global'],
  },
] as const satisfies readonly {
  readonly id: string
  readonly title: string
  readonly live: readonly KeyContext[]
  readonly rows: readonly KeyContext[]
}[]

export type PadView = (typeof PAD_VIEWS)[number]['id']

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const

/**
 * The words for a stick, from its four directions' labels.
 *
 * The first word of each, once: "Thrust Ahead", "Thrust Astern", "Translate
 * Left" and "Translate Right" are "Thrust · Translate", and four "Look"s are
 * "Look". It holds because the table names a run of actions by verb and
 * direction, which is how a reader names them too.
 */
export function stickSummary(
  labels: readonly (string | null)[],
): string | null {
  const words: string[] = []
  for (const label of labels) {
    if (label === null) continue
    const word = label.split(' ')[0] ?? label
    if (!words.includes(word)) words.push(word)
  }
  return words.length === 0 ? null : words.join(' · ')
}

export function calloutLabels(
  bindings: PadBindings,
  live: readonly KeyContext[],
): ReadonlyMap<Callout, string | null> {
  const resolved = padActions(bindings, live)
  const found = new Map<Callout, string | null>()
  for (const button of PAD_BUTTONS)
    found.set(button, resolved.get(button)?.label ?? null)
  for (const side of ['ls', 'rs'] as const)
    found.set(
      side,
      stickSummary(
        DIRECTIONS.map(
          (direction) =>
            resolved.get(`${side}.${direction}` as PadStick)?.label ?? null,
        ),
      ),
    )
  return found
}

/** A stick's half-axis is one callout on the picture: its stick. */
export const calloutOf = (control: PadControl): Callout =>
  isPadStick(control) ? (control.startsWith('ls') ? 'ls' : 'rs') : control
