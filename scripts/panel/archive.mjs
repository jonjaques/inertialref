/*
 * Freeze a round of the picture panel: its packets, briefs, keys, answers
 * and the orchestrator's entries, with a hash of every file (weather rubric
 * §3.5, phase 1 design §8.6).
 *
 *   node scripts/panel/archive.mjs <round dir> [--root <panel dir>]
 *
 * The archive goes to the main checkout's `.data/weather/panel/<round>/`,
 * found from the clone's common git directory as the capture's plates are,
 * so a round archived from any worktree lands in one place and a removed
 * worktree takes none with it. `archive.json` there lists every file with
 * its SHA-256, and the ledger reads a round only through it: a round's row
 * is written only after its archive, and a file changed since is refused.
 *
 * A round is archived once. Archiving it again, or another round under its
 * name, is refused rather than overwritten: every round that is run stays
 * in the record as it was run.
 *
 * `index.json` beside the rounds lists each one with its kind, its seed,
 * the capture records its plates came from and the hash of its
 * `archive.json`, which is what the weather record cites.
 */
import { existsSync } from 'node:fs'
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { dataRoot } from '../weather/capture.mjs'
import { sha256 } from './packet.mjs'

/** What a round holds before it can be archived. */
const REQUIRED = ['round.json', 'entries.json', 'keys', 'packets']

/** Every file under `dir`, relative to it, in a fixed order. */
async function filesOf(dir, under = '') {
  const out = []
  const entries = await readdir(path.join(dir, under), { withFileTypes: true })
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = path.join(under, entry.name)
    if (entry.isDirectory()) out.push(...(await filesOf(dir, rel)))
    else out.push(rel)
  }
  return out
}

/** Copy a round into `root/<round>/`, hash it, and index it. */
export async function archiveRound(roundDir, root) {
  for (const name of REQUIRED)
    if (!existsSync(path.join(roundDir, name)))
      throw new Error(`${roundDir} has no ${name}: a round is archived whole`)
  const round = JSON.parse(
    await readFile(path.join(roundDir, 'round.json'), 'utf8'),
  )
  const target = path.join(root, round.round)
  if (existsSync(target))
    throw new Error(`${target} exists: round ${round.round} is archived once`)
  await cp(roundDir, target, { recursive: true, errorOnExist: true })
  const files = {}
  for (const file of await filesOf(target))
    files[file] = sha256(await readFile(path.join(target, file)))
  const archive = {
    format: 'inertialref/panel-archive',
    version: 1,
    round: round.round,
    files,
  }
  const body = `${JSON.stringify(archive, null, 2)}\n`
  await writeFile(path.join(target, 'archive.json'), body)
  const indexFile = path.join(root, 'index.json')
  const index = existsSync(indexFile)
    ? JSON.parse(await readFile(indexFile, 'utf8'))
    : { format: 'inertialref/panel-index', version: 1, rounds: [] }
  index.rounds.push({
    round: round.round,
    kind: round.kind,
    seed: round.seed,
    dir: round.round,
    archive: sha256(body),
    records: round.records.map(({ file, sha256: hash }) => ({
      file,
      sha256: hash,
    })),
  })
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`)
  return { target, archive }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string' } },
  })
  if (positionals.length !== 1) {
    console.error(
      'node scripts/panel/archive.mjs <round dir> [--root <panel dir>]',
    )
    process.exit(1)
  }
  const root = values.root ?? path.join(dataRoot(), 'panel')
  try {
    const { target, archive } = await archiveRound(
      path.resolve(positionals[0]),
      path.resolve(root),
    )
    console.log(
      `${Object.keys(archive.files).length} files of round ${archive.round} in ${target}`,
    )
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
