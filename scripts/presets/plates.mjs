#!/usr/bin/env node
/*
 * Recapture every preset's thumbnail, through the renderer.
 *
 *     pnpm presets:plates              all of them
 *     pnpm presets:plates earthrise    one, by id
 *
 * A drawn diagram of a picture that exists is a worse thumbnail than the
 * picture. `ShotThumb` draws the sixteen *compositions* and is right to — a
 * composition is relative to whatever is under the camera, so there is nothing
 * particular to photograph — but a preset names an address, which means the
 * frame it produces is a specific thing the renderer can be asked for. So the
 * thumbnail is a plate: captured here, vendored, and committed.
 *
 * Vendored rather than generated at build time for the reason `og-plate.png`
 * is: a build that needed a GPU would not run in CI, on a fork, or on a machine
 * with no display, and the one thing a thumbnail may not do is be absent.
 *
 * The rig is `scripts/drive.mjs`, which launches its own Chrome on its own
 * profile and port — see `.claude/rules/browser.md` for why it is never the
 * extension. Every step of a capture goes through `window.ir`, which is the
 * whole reason `ir.preset` exists as a harness verb rather than as a panel
 * click handler: a plate has to be reproducible from a script.
 *
 * The capture is taken with the chrome cleared (`Shift+H` — here the harness
 * verb behind it) and the layers off, which is the state a plate is defined to
 * be in: what the camera does, with nothing drawn over it that the press does
 * not set.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PICTURES } from '../../packages/devtools/src/pictures.ts'
import { PLATES, plateName } from './check.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DRIVE = path.join(ROOT, 'scripts/drive.mjs')

/**
 * Where the capture happens.
 *
 * The planetarium, and it has to be: `ir.preset` moves the *observatory*, and
 * the observatory only produces a camera while a layer is holding it — which is
 * a stance the planetarium pushes on mount. Run from the menu, every verb
 * succeeds and every plate is a picture of the menu.
 */
const PAGE = 'http://localhost:5173/planetarium'

/** Where the per-picture step script goes. Removed on the way out. */
const STEP = path.join(ROOT, '.data/drive/preset-step.mjs')

/**
 * The plate's pixel size.
 *
 * A 3:2 frame, because that is what the panel's thumbnail grid draws and a
 * plate cropped by CSS is a composition nobody chose. 480 wide is twice the
 * widest a card is ever drawn at, which covers a 2× display and nothing more —
 * these are committed files and seven of them at 1600 px would be a megabyte of
 * repository for pixels no screen shows.
 */
const WIDTH = 480
const HEIGHT = 320

/**
 * How long the renderer is given to settle after a preset is taken.
 *
 * Textures stream in asynchronously and terrain patches arrive from a worker
 * pool, so a still taken on the frame the camera moved is a picture of a body
 * that has not loaded. Two seconds is what the drive skill's own recipe uses
 * for a body-scale frame, and a plate that is one texture short is worse than a
 * slow script.
 */
const SETTLE = 2500

const wanted = process.argv.slice(2)
const pictures =
  wanted.length === 0
    ? PICTURES
    : PICTURES.filter((one) => wanted.includes(one.id))

if (pictures.length === 0) {
  console.error(`no picture called ${wanted.join(', ')}`)
  process.exit(1)
}

const drive = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVE, ...args], {
      stdio: 'inherit',
      cwd: ROOT,
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`drive exited ${code ?? 'on a signal'}`)),
    )
  })

await mkdir(PLATES, { recursive: true })

for (const picture of pictures) {
  console.log(`${picture.id} — ${picture.why}`)
  /*
   * One call, because `ir.preset` fits the lens itself.
   *
   * That is the whole reason a picture is a harness verb rather than a panel
   * click handler: the frame it produces has to be reproducible from a script,
   * and a script that had to reassemble the picture out of three calls would be
   * a second definition of what the picture is.
   */
  /*
   * A file rather than `--js`, on the driver's own advice: a multi-statement
   * body needs an explicit `return`, and one written as an inline IIFE comes
   * back `null` through the shell's quoting.
   */
  await writeFile(
    STEP,
    [
      `ir.chrome(false)`,
      // Names and traces off as well, and they are a *different* claim from
      // the chrome: a thumbnail of a picture is a thumbnail of what the camera
      // does, and the layers are the viewer's, drawn over whatever it does. A
      // trace slashing across a plate promises a layer the press does not set.
      `ir.layers(false)`,
      `const p = ir.preset(${JSON.stringify(picture.id)})`,
      `return p.picture.label + ' at ' + Math.round(p.fovDeg) + '\u00b0'`,
    ].join('\n'),
  )
  await drive([
    '--url',
    PAGE,
    '--width',
    String(WIDTH),
    '--height',
    String(HEIGHT),
    '--max-px',
    '0',
    '--quiet',
    '--file',
    STEP,
    '--wait',
    String(SETTLE),
    '--shot',
    path.join(PLATES, plateName(picture.id)),
  ])
}

await rm(STEP, { force: true })

console.log(
  `\n${pictures.length} plate${pictures.length === 1 ? '' : 's'} in apps/game/public/presets. pnpm drive --down when finished.`,
)
