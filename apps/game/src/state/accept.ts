/*
 * What a stored value has to prove before it is believed.
 *
 * Its own module, below the registry that spends it, and the split is
 * load-bearing rather than tidy: `preferences.ts` declares every key, which
 * means importing the modules that own the closed sets those keys range over —
 * `planetarium/layers.ts`, `planetarium/kinds.ts` — and those modules need a
 * validator. With the vocabulary in the registry that is a cycle; here it is a
 * leaf nothing imports back.
 *
 * Parsing was never the risk. `localStorage` outlives the code that wrote it,
 * so the values that survive a rename are the dangerous ones: a `dock.tab` of
 * `"nav"` from before the tabs were renamed parses perfectly and renders no
 * panel at all and no active tab, and the only way back is devtools. A stored
 * `camera.lens` whose focal length is `NaN` or zero reaches the projection
 * matrix. Every key therefore says what it will accept, and an unrecognised
 * value is treated exactly like an absent one.
 */

export type Accept<T> = (value: unknown) => value is T

export const isBoolean: Accept<boolean> = (value): value is boolean =>
  typeof value === 'boolean'

export const isString: Accept<string> = (value): value is string =>
  typeof value === 'string'

/** Membership in a closed set — a tab name, the HDR preference, the AA level. */
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

/** An array whose every member is in a closed set. */
export function arrayOf<T>(member: Accept<T>): Accept<readonly T[]> {
  return (value): value is readonly T[] =>
    Array.isArray(value) && value.every((one) => member(one))
}

/** A record whose values all pass one guard. Keys are unconstrained strings. */
export function recordOf<T>(
  member: Accept<T>,
): Accept<Readonly<Record<string, T>>> {
  return (value): value is Readonly<Record<string, T>> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((one) => member(one))
}
