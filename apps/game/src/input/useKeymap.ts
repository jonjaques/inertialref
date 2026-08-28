import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { type Chord, chordLabel } from './chord.ts'
import { findAction, type ActionId } from './keymap.ts'
import type {
  ActionEvent,
  ActionHandler,
  ContextClaim,
  KeymapStore,
} from './keymapStore.ts'

/*
 * How a mode reaches the dispatcher.
 *
 * Three verbs and nothing else: say which context you are, say what you do when
 * an action fires, and ask what an action is bound to so a tooltip can print it.
 * None of them mentions a key, which is the point — a key name in a component is
 * a binding the editor cannot move.
 *
 * A context rather than a module singleton, for the reason the star catalog is
 * passed as an argument: a hidden global is a version nobody can see. It also
 * means a test can build a store, drive it and throw it away.
 */

export const KeymapContext = createContext<KeymapStore | null>(null)

export function useKeymap(): KeymapStore {
  const store = useContext(KeymapContext)
  if (store === null) {
    throw new Error('useKeymap outside a KeymapProvider')
  }
  return store
}

/**
 * Do this when the action fires.
 *
 * The handler is read from a ref, so a component that re-renders eight times a
 * second does not deregister and re-register on every one of them — which for a
 * held axis would drop the key-up that stops the drive.
 */
export function useAction(id: ActionId, handler: ActionHandler): void {
  const store = useKeymap()
  const latest = useRef(handler)
  latest.current = handler
  useEffect(
    () => store.register(id, (event: ActionEvent) => latest.current(event)),
    [store, id],
  )
}

/**
 * Declare a context live for as long as this is mounted.
 *
 * The claim is rebuilt whenever the mutes change, and never otherwise: a claim
 * is identity in a Set, so a fresh object per render would leave one entry per
 * render in it and a mode's context live long after it left.
 */
export function useKeyContext(claim: ContextClaim): void {
  const store = useKeymap()
  const mutes = (claim.mutes ?? []).join(',')
  useEffect(
    () =>
      store.claim({
        context: claim.context,
        mutes: mutes === '' ? undefined : mutes.split(','),
      }),
    [store, claim.context, mutes],
  )
}

/** What an action is bound to right now, or null when it is unbound. */
export function useChord(id: ActionId): Chord | null {
  const store = useKeymap()
  return useSyncExternalStore(
    (onChange) => store.watch(onChange),
    () => store.bindings.get(id) ?? null,
    () => findAction(id)?.chord ?? null,
  )
}

/**
 * What to tell somebody to press for this action, or null.
 *
 * The one function a label calls. Every tooltip in the interface that names a
 * key goes through it, which is what makes "no key name is a string literal in
 * a label" a claim a grep can check rather than a habit.
 */
export function useKeyLabel(id: ActionId): string | null {
  const store = useKeymap()
  const bound = useChord(id)
  const layout = useSyncExternalStore(
    (onChange) => store.watch(onChange),
    () => store.layout,
    () => null,
  )
  return bound === null ? null : chordLabel(bound, layout)
}

/**
 * A title with the action's live chord appended, or the title alone.
 *
 * `Frame the subject · F`, and the separator is the interpunct the readouts
 * already use. An unbound action gets the title unchanged rather than a dangling
 * separator, because "this does nothing by keyboard" is not something a tooltip
 * should say in punctuation.
 */
export function useActionTitle(id: ActionId, title: string): string {
  const label = useKeyLabel(id)
  return label === null ? title : `${title} · ${label}`
}
