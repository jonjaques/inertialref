/**
 * A bare expression is the common case and writing `return` around it on every
 * command line is noise, so one is added when the text has no statement in it.
 * The async wrapper in `evaluate` is what makes `await ir.selfTest()` work from
 * the shell.
 */
export function body(expression) {
  const bare = !/\breturn\b|;|\n/.test(expression)
  return bare ? `return (${expression})` : expression
}

/**
 * The warning for a script that answered nothing because it never returned.
 * A payload with a `;` or a newline is a function body, so an IIFE or a
 * multi-line file with no top-level `return` completes with `undefined` — read
 * by the shell as `null`, and indistinguishable from a probe that found
 * nothing. `undefined` here means no answer; a real `null` without a `return`
 * cannot be told apart from it, and is warned about too.
 */
export function silentCompletion(expression, value) {
  if (value !== undefined && value !== null) return null
  if (/\breturn\b/.test(expression)) return null
  if (!/;|\n/.test(expression)) return null
  return (
    'warning: the script has a statement and no `return`, so it ran as a ' +
    'function body and answered null; return the value, or pass a bare ' +
    'expression'
  )
}
