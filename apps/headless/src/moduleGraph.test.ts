import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Every module in `packages/universe` has to be importable on its own.
 *
 * This exists because of a bug that shipped and that nothing in the repository
 * could see. `system.ts` imports `solar/system.ts`, which imports
 * `solar/smallBodies.ts`, whose exported array is built at module scope — so a
 * *value* imported back from `system.ts` there is dereferenced before
 * `system.ts`'s own body has run. `import('system.ts')` threw
 * `ReferenceError: Cannot access 'ROUNDING_RADIUS' before initialization`. The
 * game never saw it, because `index.ts` happens to name `solar/system.ts`
 * before `system.ts` and that order primes the cycle from the safe side; one
 * re-sort of an alphabetical export list would have taken the package down.
 *
 * Three reasons it lives here and looks like this.
 *
 * **`pnpm graph` structurally cannot catch it.** It checks for cycles *between*
 * packages and discards every intra-package edge before it starts.
 *
 * **Nor can a vitest test.** Vitest evaluates modules through its own runner,
 * which resolves this graph without the temporal dead zone Node's ESM linker
 * enforces. Written as an ordinary `import()` inside a test file, the check
 * passed with the bug deliberately reintroduced — which would have been worse
 * than no test at all.
 *
 * **So it spawns Node.** One process per entry point, each importing exactly
 * one module and nothing else, which is the only way to make each of them the
 * *first* module in its own graph. It belongs in `apps/headless` because
 * `packages/*` may not spawn a process any more than it may read a file.
 */

const run = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * The modules that sit on the `system.ts` ↔ `solar/system.ts` cycle, plus the
 * one the application actually enters through.
 *
 * Deliberately not every file in the package. Each entry is a Node process that
 * type-strips the whole graph, and `pnpm check` runs sixty-four test files
 * across every core at once — a first version with ten of these, fanned out by
 * `it.each`, starved the rest of the suite badly enough to time out four
 * unrelated tests that had nothing to do with this change. These six are the
 * ones that can close the cycle; a seventh would cost a second and catch
 * nothing.
 *
 * `rounding.ts` is in the list because it is the *fix* — a leaf with no imports
 * of its own — and an edit that gave it one is how this comes back.
 */
const ENTRY_POINTS = [
  'packages/universe/src/index.ts',
  'packages/universe/src/system.ts',
  'packages/universe/src/rounding.ts',
  'packages/universe/src/solar/system.ts',
  'packages/universe/src/solar/smallBodies.ts',
  'packages/universe/src/solar/minorMoons.ts',
]

describe('the universe package imports cleanly', () => {
  // One `it`, and the spawns are serial inside it: six Node processes started
  // at once is a load spike, and this is not a test that needs to be fast.
  it('lets every module on the cycle be the first in its own graph', async () => {
    for (const entry of ENTRY_POINTS) {
      const result = await run(
        process.execPath,
        ['-e', `import(${JSON.stringify(`./${entry}`)}).then(() => {})`],
        { cwd: root },
      ).catch((cause: unknown) => ({
        stderr: cause instanceof Error ? cause.message : String(cause),
        stdout: '',
      }))
      // Named in the assertion rather than checked as an exit code, because
      // the message is the whole diagnosis: a TDZ error says which binding and
      // therefore which edge closed the cycle.
      expect(`${entry}: ${result.stderr.trim()}`).toBe(`${entry}: `)
    }
  }, 60_000)
})
