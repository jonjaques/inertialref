#!/usr/bin/env node
/*
 * Every picture has a plate, and every plate has a picture.
 *
 *     pnpm presets:check
 *
 * The same claim `brand:check` makes about the mark, applied to the seven
 * fixtures the geology review is judged from. A preset is a *button*, and the
 * two ways one rots are both silent: the composition it names gets renamed and
 * the button throws out of an onClick, or the plate under it is never captured
 * and the panel draws an empty rectangle where the picture should be. Neither
 * shows up in a type check, and the phase that depends on them is a review — so
 * a picture that has gone missing has to be a red gate rather than a discovery
 * on review day.
 *
 * What this does *not* check is that the plate still looks like the picture.
 * Nothing can: the whole point of a plate is that it is what the renderer
 * produced, and comparing it to what the renderer produces now is the review
 * itself. `pnpm presets:plates` recaptures them, and a diff in `git status` is
 * the honest signal that something moved.
 *
 * The catalog half — that each address still names a body this build ships —
 * needs a world, so it is `observatory.test.ts`. Splitting them by what they
 * need rather than by what they are about keeps this script free of a session.
 */
import { readdir } from 'node:fs/promises'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PICTURES,
  PLATE_WIDTH,
  PLATE_HEIGHT,
  plateName,
  unresolvedCompositions,
} from '../../packages/devtools/src/pictures.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const PLATES = path.join(ROOT, 'apps/game/public/presets')

/*
 * `plateName` comes from `pictures.ts` rather than being written here, because
 * the panel that requests the file over HTTP cannot import a `.mjs` and would
 * otherwise carry a third copy of the convention — one this gate could not see
 * go stale.
 */
export { plateName }

async function main() {
  const problems = [...unresolvedCompositions()]

  let files = []
  try {
    files = await readdir(PLATES)
  } catch {
    problems.push(
      `no plates at all — apps/game/public/presets is missing. Run pnpm presets:plates`,
    )
  }

  for (const picture of PICTURES) {
    const name = plateName(picture.id)
    if (!files.includes(name)) {
      problems.push(`${picture.id} has no plate (${name})`)
      continue
    }
    try {
      const plate = sharp(path.join(PLATES, name), { failOn: 'warning' })
      const metadata = await plate.metadata()
      if (
        metadata.format !== 'jpeg' ||
        metadata.width !== PLATE_WIDTH ||
        metadata.height !== PLATE_HEIGHT
      )
        problems.push(
          `${picture.id}'s plate must be a ${PLATE_WIDTH}×${PLATE_HEIGHT} JPEG`,
        )
      // Sparse eclipse plates compress below 4 KB. Decode the pixels rather
      // than inferring a completed capture from its file size.
      await plate.raw().toBuffer()
    } catch (cause) {
      problems.push(`${picture.id}'s plate cannot be decoded: ${String(cause)}`)
    }
  }

  // The other direction, because a plate for a picture nobody lists is a file
  // that will be committed forever and never drawn.
  const known = new Set(PICTURES.map((one) => plateName(one.id)))
  for (const file of files) {
    if (file.startsWith('.')) continue
    if (!known.has(file)) problems.push(`${file} belongs to no picture`)
  }

  if (problems.length > 0) {
    console.error('presets:check failed')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('\n  pnpm presets:plates recaptures them.')
    process.exitCode = 1
    return
  }
  console.log(
    `${PICTURES.length} pictures, ${PICTURES.length} plates, every composition resolves`,
  )
}

/*
 * Run only when this file is the command.
 *
 * `plates.mjs` imports `PLATES` and `plateName` from here so the naming
 * convention has one owner, and a bare `await main()` would make that import
 * run the whole check: seven `stat` calls and a success line before Chrome is
 * launched, and — on the one run that matters, a capture of a picture whose
 * plate does not exist yet — `process.exitCode = 1` left behind for a capture
 * that then succeeds.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
