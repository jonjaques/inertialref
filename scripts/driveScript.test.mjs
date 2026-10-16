import { describe, expect, it } from 'vitest'
import { silentCompletion, wrap } from './driveScript.mjs'

/** What `evaluate` sends, run here instead of in a page. */
const run = (expression) => new Function(`return ${wrap(expression)}`)()

describe('driver script payloads', () => {
  it('returns a bare expression without asking for a return', async () => {
    expect(await run('1 + 2')).toBe(3)
    expect(await run('await Promise.resolve(5)')).toBe(5)
    expect(silentCompletion('1 + 2', 3)).toBeNull()
  })

  it('returns an IIFE and a multi-line expression as expressions', async () => {
    const iife = '(() => { const x = 4; return x })()'
    expect(await run(iife)).toBe(4)
    const call = 'Math.max(\n  1,\n  2,\n)\n'
    expect(await run(call)).toBe(2)
  })

  it('survives a payload that ends in a line comment', async () => {
    expect(await run('1 + 2 // three')).toBe(3)
    expect(await run('const a = 1\nreturn a // one')).toBe(1)
  })

  it('warns for a statement-terminated IIFE with no return', async () => {
    const statement = '(() => { const x = 4; x })();'
    expect(await run(statement)).toBeUndefined()
    expect(silentCompletion(statement, undefined)).toMatch(/no `return`/)
  })

  it('warns for a multi-line file with no top-level return', async () => {
    const file = 'const a = 1\nconst b = 2\na + b\n'
    expect(await run(file)).toBeUndefined()
    expect(silentCompletion(file, undefined)).toMatch(/no `return`/)
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
