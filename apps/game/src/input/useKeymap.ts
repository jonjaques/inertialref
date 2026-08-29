import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { type Chord, chordLabel } from './chord.ts'
import {
  type ActionDefinition,
  type ActionId,
  ACTIONS,
  findAction,
  groupsOf,
  type KeyContext,
} from './keymap.ts'
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
 * The same, for a run of actions that share one handler.
 *
 * The flight axes are the caller: twelve ids feeding one control vector, where
 * twelve `useAction` calls would be a loop over a constant that every hook lint
 * has to be told about. The ids are joined into the dependency so a caller
 * passing a fresh array each render — which is every caller — does not
 * re-register on every render.
 */
export function useActions(
  ids: readonly ActionId[],
  handler: (id: ActionId, event: ActionEvent) => void,
  /**
   * Whether these are claimed right now.
   *
   * The same flag `useKeyContext` takes, and for the same reason: a hook cannot
   * be called conditionally, and a component that returns `null` has not
   * unmounted. `Workspace` is the caller — it draws nothing while the chrome is
   * cleared, but its keys stayed registered above the early return, so a digit
   * sent by a plate script rearranged and *persisted* a dock nobody could see.
   * Unregistered, the dispatcher declines a chord no handler claims and the key
   * goes back to the browser.
   */
  active = true,
): void {
  const store = useKeymap()
  const latest = useRef(handler)
  latest.current = handler
  const key = ids.join(',')
  useEffect(() => {
    if (!active) return
    const releases = key
      .split(',')
      .map((id) =>
        store.register(id, (event: ActionEvent) => latest.current(id, event)),
      )
    return () => {
      for (const release of releases) release()
    }
  }, [store, key, active])
}

/**
 * Declare a context live for as long as this is mounted.
 *
 * The claim is rebuilt whenever the mutes change, and never otherwise: a claim
 * is identity in a Set, so a fresh object per render would leave one entry per
 * render in it and a mode's context live long after it left.
 */
export function useKeyContext(
  claim: ContextClaim,
  /**
   * Whether the claim is live right now.
   *
   * A flag rather than a conditional call, because a hook cannot be called
   * conditionally and the alternative — claiming a harmless context instead —
   * is a lie in a Set that something will eventually read. `standing` is the
   * caller: it comes and goes inside the planetarium, and `PageUp` in orbit is
   * a binding with no effect.
   */
  active = true,
): void {
  const store = useKeymap()
  const mutes = (claim.mutes ?? []).join(',')
  useEffect(() => {
    if (!active) return
    return store.claim({
      context: claim.context,
      mutes: mutes === '' ? undefined : mutes.split(','),
    })
  }, [store, claim.context, mutes, active])
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

/** One line of a keys sheet: what it does, and what to press. */
export interface KeyRow {
  readonly action: ActionDefinition
  /** What to press, or null when the action is deliberately unbound. */
  readonly label: string | null
}

/** A run of rows under one heading. */
export interface KeyGroup {
  readonly group: string
  readonly rows: readonly KeyRow[]
}

/**
 * The keys sheet for a set of contexts, derived from the table.
 *
 * The replacement for two hand-maintained tables of prose — `CONTROL_HELP` and
 * `PLANETARIUM_HELP` — that named keys as string literals and were kept in step
 * by hand. Deriving them is what makes "no key name is a string literal in a
 * label" a claim a grep can check, and it is also the only way a *rebindable*
 * build can have a help sheet at all: the sheet has to say what the keys are
 * now, not what they shipped as.
 *
 * The layout is read here rather than per row, so a sheet of forty rows is one
 * subscription rather than forty.
 */
export function useKeyRows(
  contexts: readonly KeyContext[],
): readonly KeyGroup[] {
  const store = useKeymap()
  const bindings = useSyncExternalStore(
    (onChange) => store.watch(onChange),
    () => store.bindings,
    () => store.bindings,
  )
  const layout = useSyncExternalStore(
    (onChange) => store.watch(onChange),
    () => store.layout,
    () => null,
  )
  const actions = ACTIONS.filter((action) => contexts.includes(action.context))
  return groupsOf(actions).map((group) => ({
    group,
    rows: actions
      .filter((action) => action.group === group)
      .map((action) => {
        const bound = bindings.get(action.id) ?? null
        return {
          action,
          label: bound === null ? null : chordLabel(bound, layout),
        }
      }),
  }))
}
