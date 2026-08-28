import { useEffect, useRef, useState } from 'react'

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

/**
 * What a stored value has to prove before it is believed.
 *
 * Parsing was never the risk. `localStorage` outlives the code that wrote it,
 * so the values that survive a rename are the dangerous ones: a `dock.tab` of
 * `"nav"` from before the tabs were renamed parses perfectly and renders no
 * panel at all and no active tab, and the only way back is devtools. A stored
 * `camera.lens` whose focal length is `NaN` or zero reaches the projection
 * matrix. Every caller therefore says what it will accept, and an unrecognised
 * value is treated exactly like an absent one.
 */
export type Accept<T> = (value: unknown) => value is T

export const isBoolean: Accept<boolean> = (value): value is boolean =>
  typeof value === 'boolean'

/** Membership in a closed set — the tab name, the HDR preference, the AA level. */
export function oneOf<T extends string>(values: readonly T[]): Accept<T> {
  return (value): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
}

/**
 * A finite number inside a range.
 *
 * Rejects rather than clamps, deliberately: a stored 5000 is not a value
 * somebody nearly asked for, it is a value from a build that meant something
 * else, and the default is the honest answer to it.
 */
export function numberWithin(min: number, max: number): Accept<number> {
  return (value): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
}

/**
 * The sentinel `read` returns when there is nothing stored.
 *
 * A distinct object rather than `undefined`, because `undefined` is a value a
 * caller may legitimately store and `null` is one `JSON.parse` returns.
 */
const MISSING: unique symbol = Symbol('missing')

function read<T>(key: string, fallback: T, accept?: Accept<T>): T {
  try {
    const stored = window.localStorage.getItem(PREFIX + key)
    if (stored === null) return fallback
    const parsed: unknown = JSON.parse(stored)
    if (accept === undefined) return parsed as T
    return accept(parsed) ? parsed : fallback
  } catch {
    // Private windows, disabled storage and a value written by an older shape
    // of this panel all land here. An overlay that cannot remember which
    // section was open is fine; one that refuses to render is not.
    return fallback
  }
}

/**
 * A preference that outlives a reload.
 *
 * The setter is `useState`'s own, so it takes a value *or* an updater — and the
 * updater form is not a convenience, it is required for correctness anywhere a
 * value is derived from the one before it. The dock is the worked example: a
 * single pointer gesture can produce more than one drop, and two `movePanel`
 * calls composed against the same captured snapshot silently discard the first.
 * That failure is invisible in code review and presents as a panel that snaps
 * back to where it was.
 *
 * **The write is an effect on the committed value, not a side effect inside the
 * updater.** It was the latter, on the argument that the string on disk should
 * be derived from what React committed — but an updater is called during
 * render, must be pure, and is not the commit. StrictMode double-invokes it,
 * and React is free to render a value it then discards; the `setItem` for that
 * value has already landed, so the stored preference is one nobody chose. It
 * also made a slider a synchronous `setItem` per input event, on the pointer's
 * thread, for a value that changes forty times a second. An effect runs after
 * the commit, which is the moment the claim was about.
 */
/**
 * One stored preference, read once, without a hook.
 *
 * For a key that is being *migrated away from*: the value is wanted at the
 * moment a new key is found absent and never again, and a `usePersistentState`
 * for it would keep an obsolete key alive in the component's state and write it
 * back. `null` means absent or unbelievable, which the caller treats the same.
 */
export function readPreference<T>(key: string, accept: Accept<T>): T | null {
  const held = read<T | null>(key, null, (value): value is T | null =>
    value === null ? true : accept(value),
  )
  return held
}

export function usePersistentState<T>(
  key: string,
  initial: T,
  accept?: Accept<T>,
  /**
   * What to do when the key is absent but an older shape of it is not.
   *
   * A preference that changes shape has three possible behaviors and only one
   * of them is honest: silently reset (the player's choice is gone), read the
   * old key forever (the new one never becomes canonical), or read the old key
   * *once*, which is this. It runs inside the lazy initializer, so it happens
   * exactly at the moment the fallback would have been used, and the new key is
   * written the first time the value actually changes — which keeps "never
   * chose" meaning the default, as above.
   *
   * Returning `null` means there was nothing to migrate.
   */
  migrate?: () => T | null,
): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = read(key, MISSING as T, accept)
    if (stored !== (MISSING as T)) return stored
    return migrate?.() ?? initial
  })
  /*
   * What is already on disk, so an unchanged value is not rewritten.
   *
   * Seeded with the mount-time value rather than with nothing, and that is the
   * point rather than an optimization: writing on mount would turn "never
   * chose" into "chose the current default" for every visitor, and a later
   * change of default would then not reach any of them. An absent value means
   * the default, and it has to keep meaning that.
   *
   * Not a "run once" latch — see the invariant about those. It is reconciled
   * against on every run and holds the same answer `localStorage` would.
   */
  const persisted = useRef(value)
  useEffect(() => {
    if (Object.is(persisted.current, value)) return
    persisted.current = value
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      // See read(): the panel still works, it just forgets.
    }
  }, [key, value])
  return [value, setValue]
}
