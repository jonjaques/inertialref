import { useState } from 'react'

/*
 * HUD layout that outlives a reload.
 *
 * Which sections are open, which tab is showing and whether the dock is
 * expanded are preferences, not state — losing them on every reload of a dev
 * build is a small tax paid dozens of times an hour. They are deliberately kept
 * out of the save file: a save is a reference to a universe, and where somebody
 * put their debug panel is not part of the universe.
 */

const PREFIX = 'ir.hud.'

function read<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(PREFIX + key)
    return stored === null ? fallback : (JSON.parse(stored) as T)
  } catch {
    // Private windows, disabled storage and a value written by an older shape
    // of this panel all land here. An overlay that cannot remember which
    // section was open is fine; one that refuses to render is not.
    return fallback
  }
}

export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial))
  const update = (next: T): void => {
    setValue(next)
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(next))
    } catch {
      // See read(): the panel still works, it just forgets.
    }
  }
  return [value, update]
}
