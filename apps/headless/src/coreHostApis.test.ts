import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * No file under `packages/` may name a host timing API.
 *
 * The rule is stated in prose in three places — `AGENTS.md`, `packages.md`,
 * `timing.ts`'s own header — and nothing currently fails when it is broken.
 * `pnpm graph` cannot see it: `performance` and `console` are globals rather
 * than imports, so a `performance.now()` in the core is not an edge in the
 * dependency graph at all. This is the half of the layering rule that only a
 * grep can hold.
 *
 * It matters beyond tidiness. `packages/*` runs unchanged in a browser, a
 * worker and Node, and Node's `console.timeStamp` is not Chrome's — a core that
 * called it directly would emit into a trace on one host and into nothing on
 * another, with no port for a test to substitute. `timing.ts` is the seam.
 *
 * **It lives here rather than in `packages/`,** because a test that reads the
 * source tree is a test that reads the filesystem, and the core may not touch
 * `node:fs` any more than it may touch `performance`. `moduleGraph.test.ts` is
 * here for the same shape of reason.
 *
 * **And it exempts comments and test files.** `harness.ts` names
 * `performance.now()` in a doc comment explaining why it does *not* call it,
 * and `metrics.test.ts` uses it as a test clock. A grep that went red on those
 * on day one is a grep somebody deletes on day two.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** What may not appear in core source, and the sentence that says why. */
const FORBIDDEN = [
  {
    pattern: /\bperformance\s*\./,
    why: 'the wall clock arrives as a port — `AttachOptions.now`, `PoolOptions.now`',
  },
  {
    pattern: /\bconsole\s*\.\s*timeStamp\b/,
    why: 'emit through a `Timer`; the browser sink is the only caller',
  },
] as const

/**
 * The source with its comments blanked out, line count preserved.
 *
 * Line count matters: the failure message names a line, and a reader who has to
 * hunt for it is a reader who mutes the test. Newlines inside a block comment
 * are kept and everything else in it becomes a space.
 *
 * Deliberately not a parser. A regex over `/*`, `//` and the three quote forms
 * is wrong on a comment marker inside a string literal, which is a shape this
 * repository does not contain and would not be made safer by a dependency.
 */
function withoutComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (match) =>
      match.startsWith('/') ? match.replace(/[^\n]/g, ' ') : ' '.repeat(2),
  )
}

describe('the portable core names no host timing API', () => {
  it('leaves `performance` and `console.timeStamp` to the host', () => {
    const files = globSync('packages/*/src/**/*.ts', { cwd: root })
      .filter((file) => !file.endsWith('.test.ts'))
      .sort()

    // A count, so a glob that silently matched nothing cannot pass as a clean
    // core. Under a tenth of the real total, which is what makes it a floor
    // rather than a second thing to maintain.
    expect(files.length).toBeGreaterThan(20)

    const found: string[] = []
    for (const file of files) {
      const source = withoutComments(
        readFileSync(path.join(root, file), 'utf8'),
      )
      for (const [index, line] of source.split('\n').entries()) {
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(line)) found.push(`${file}:${index + 1} — ${why}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
