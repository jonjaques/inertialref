import { describe, expect, it } from 'vitest'
import { body, silentCompletion } from './driveScript.mjs'

/** What `evaluate` sends, run here instead of in a page. */
const run = (expression) =>
  new Function(`return (async () => { ${body(expression)} })()`)()

describe('driver script payloads', () => {
  it('returns a bare expression without asking for a return', async () => {
    expect(await run('1 + 2')).toBe(3)
    expect(silentCompletion('1 + 2', 3)).toBeNull()
  })

  it('warns when an IIFE completes with nothing', async () => {
    const iife = '(() => { const x = 4; return x })()'
    const value = await run(iife)
    // The inner `return` is not the body's: the completion is undefined, and
    // the `return` in the text is what hides it from the check.
    expect(value).toBeUndefined()
    expect(silentCompletion(iife, value)).toBeNull()
    const statement = '(() => { const x = 4; x })();'
    expect(await run(statement)).toBeUndefined()
    expect(silentCompletion(statement, undefined)).toMatch(/no `return`/)
  })

  it('warns for a multi-line file with no top-level return', async () => {
    const file = 'const a = 1\nconst b = 2\na + b\n'
    expect(await run(file)).toBeUndefined()
    expect(silentCompletion(file, undefined)).toMatch(/no `return`/)
    expect(silentCompletion(file, null)).toMatch(/no `return`/)
  })

  it('stays quiet when the body returns, or answers a value', async () => {
    const file = 'const a = 1\nreturn a + 1\n'
    expect(await run(file)).toBe(2)
    expect(silentCompletion(file, 2)).toBeNull()
    expect(silentCompletion('const a = 1\nreturn null', null)).toBeNull()
    expect(silentCompletion('x;', 0)).toBeNull()
    expect(silentCompletion('a; b', false)).toBeNull()
  })

  it('stays quiet for a bare expression that answers null', () => {
    expect(silentCompletion('document.querySelector("#none")', null)).toBeNull()
  })
})
