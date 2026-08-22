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
 * `camera.fov` of `NaN` or `5000` reaches `engine.fov` and the projection
 * matrix behind it. Every caller therefore says what it will accept, and an
 * unrecognised value is treated exactly like an absent one.
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
 * Rejects rather than clamps, deliberately: a stored 5000° field of view is not
 * a 110° field of view somebody nearly asked for, it is a value from a build
 * that meant something else, and the default is the honest answer to it.
 */
export function numberWithin(min: number, max: number): Accept<number> {
  return (value): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
}

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
export function usePersistentState<T>(
  key: string,
  initial: T,
  accept?: Accept<T>,
): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial, accept))
  /*
   * What is already on disk, so an unchanged value is not rewritten.
   *
   * Seeded with the mount-time value rather than with nothing, and that is the
   * point rather than an optimisation: writing on mount would turn "never
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
