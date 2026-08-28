import { type ReactNode, useEffect, useState } from 'react'
import { keyboardLayout } from './chord.ts'
import { resolveBindings } from './keymap.ts'
import { KeymapStore } from './keymapStore.ts'
import { KeymapContext } from './useKeymap.ts'
import { CONTROLS_KEYMAP, usePersistentState } from '../state/preferences.ts'

/**
 * The keyboard, for the life of the session.
 *
 * Above the router and inside nothing, because the store outlives every mode
 * and the one window listener has to survive a navigation: rebuilding it per
 * route would drop a held axis at the moment the mode changed, and a `keyup`
 * that lands on no listener leaves the drive burning.
 *
 * The store is created in a `useState` factory and *started* from an effect,
 * which is the split StrictMode requires: an initializer is a factory, not a
 * constructor, so registering the listener inside it would leak one of every
 * pair with only the survivor able to clean up after itself.
 */
export function KeymapProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new KeymapStore())
  const [overrides] = usePersistentState(CONTROLS_KEYMAP)

  useEffect(() => store.attach(window), [store])

  // The editor writes the preference; this is the only thing that reads it into
  // the dispatcher, so a rebind is live in the same commit that stores it.
  useEffect(() => {
    store.setBindings(resolveBindings(overrides))
  }, [store, overrides])

  /*
   * What the attached keyboard actually types, asked once.
   *
   * A promise, and Chromium is the only family that answers it — so this is a
   * label improvement rather than a dependency: `chordLabel` falls back to the
   * US table, which is the right guess and is wrong for somebody. Nothing waits
   * on it and a rejection is the same as an absence.
   */
  useEffect(() => {
    let live = true
    void keyboardLayout().then((layout) => {
      if (live) store.setLayout(layout)
    })
    return () => {
      live = false
    }
  }, [store])

  return <KeymapContext value={store}>{children}</KeymapContext>
}
