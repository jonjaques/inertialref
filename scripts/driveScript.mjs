const AsyncFunction = (async () => {}).constructor

/**
 * Whether the payload parses as one expression, `await` included. Compiled
 * here, never run: an IIFE, a multi-line call and a bare expression with a
 * trailing comment are all expressions, and a text search for `;`, a newline
 * or `return` reads each of them as a function body.
 */
function isExpression(expression) {
  try {
    new AsyncFunction(`return (\n${expression}\n)`)
    return true
  } catch {
    return false
  }
}

/**
 * A bare expression is the common case and writing `return` around it on every
 * command line is noise, so one is added when the text is one expression.
 * Anything else is a function body, and answers only what it returns. The
 * newlines keep a trailing line comment from swallowing the closing paren.
 */
export function body(expression) {
  return isExpression(expression) ? `return (\n${expression}\n)` : expression
}

/**
 * What `evaluate` sends: the payload inside an async function, which is what
 * makes `await ir.selfTest()` work from the shell. The newlines keep a file
 * ending in a line comment from swallowing the closing brace.
 */
export function wrap(expression) {
  return `(async () => {\n${body(expression)}\n})()`
}

/**
 * The warning for a script that answered nothing because it never returned.
 * A payload that is not one expression is a function body, so a multi-line
 * file with no top-level `return` completes with `undefined` — read by the
 * shell as `null`, and indistinguishable from a probe that found nothing. The
 * `return` check is textual: a body whose only `return` is inside a nested
 * function, a string or a comment answers `undefined` without a warning.
 */
export function silentCompletion(expression, value) {
  if (value !== undefined) return null
  if (isExpression(expression)) return null
  if (/\breturn\b/.test(expression)) return null
  return (
    'warning: the script has a statement and no `return`, so it ran as a ' +
    'function body and answered null; return the value, or pass a bare ' +
    'expression'
  )
}
