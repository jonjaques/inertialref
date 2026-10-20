#!/usr/bin/env node
/**
 * The per-file coverage figures a pull request body quotes.
 *
 *   pnpm test:coverage
 *   node scripts/coverageFiles.mjs packages/devtools/src/harness.ts …
 *
 * `text-summary` prints the tree's three percentages and nothing per file, and
 * the `text` reporter prints every one of 626 files, which is a figure nobody
 * reads. A change touches a handful, and what its body needs for each is the
 * statement, function and branch counts and the names of the functions no test
 * enters — the last is what says whether a percentage moved because a test was
 * written or because a file was split. This reads them out of
 * `coverage/coverage-final.json`, the istanbul map the `json` reporter writes,
 * so every body quotes the same arithmetic.
 *
 * A path the map does not hold is printed as absent rather than as zero: the
 * `include` globs in `vitest.config.ts` put every source file in the map at 0%
 * whether or not a test loads it, so a missing path is a file outside those
 * globs, or a run that did not happen.
 */
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MAP = resolve(ROOT, 'coverage/coverage-final.json')

const paths = process.argv.slice(2)
if (paths.length === 0 || paths.includes('--help')) {
  console.log('usage: node scripts/coverageFiles.mjs <source path>…')
  console.log(
    'reads coverage/coverage-final.json; run pnpm test:coverage first',
  )
  process.exit(paths.length === 0 ? 1 : 0)
}
if (!existsSync(MAP)) {
  console.error(`${relative(ROOT, MAP)} is missing — run pnpm test:coverage`)
  process.exit(1)
}

const map = JSON.parse(readFileSync(MAP, 'utf8'))

const percent = (hit, total) =>
  total === 0 ? '—' : `${((100 * hit) / total).toFixed(1)}%`

let absent = 0
for (const path of paths) {
  const file = map[resolve(ROOT, path)]
  if (file === undefined) {
    console.log(`${path}: absent from the coverage map`)
    absent += 1
    continue
  }
  const statements = Object.values(file.s)
  const functions = Object.values(file.f)
  // A branch is one arm of a branch point, which is how istanbul and the
  // `text-summary` line both count them.
  const branches = Object.values(file.b).flat()
  const hit = (counts) => counts.filter((n) => n > 0).length

  const unentered = Object.entries(file.f)
    .filter(([, n]) => n === 0)
    .map(([id]) => {
      const fn = file.fnMap[id]
      return `${fn.name}:${fn.loc.start.line}`
    })

  console.log(path)
  console.log(
    `  statements ${percent(hit(statements), statements.length)} (${hit(statements)} of ${statements.length})`,
  )
  console.log(
    `  functions  ${percent(hit(functions), functions.length)} (${hit(functions)} of ${functions.length})`,
  )
  console.log(
    `  branches   ${percent(hit(branches), branches.length)} (${hit(branches)} of ${branches.length})`,
  )
  if (unentered.length > 0)
    console.log(`  never entered: ${unentered.join(', ')}`)
}
process.exit(absent > 0 ? 1 : 0)
