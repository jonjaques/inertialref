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
 * The plate is also the frame a reviewer last accepted for the picture.
 * `pnpm presets:compare` photographs the tree and differences it against these,
 * so recapturing one is how a change that moves a frame is accepted: the
 * rewritten file in the pull request is the claim under review. The capture
 * itself is `capture.mjs`, shared with that script so the two cannot disagree
 * about what a plate is taken in.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PICTURES } from '../../packages/devtools/src/pictures.ts'
import { PLATES } from './check.mjs'
import { capturePlates, serve } from './capture.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const { values, positionals: wanted } = parseArgs({
  options: {
    port: { type: 'string', default: '9333' },
    url: { type: 'string' },
    'tree-port': { type: 'string', default: '5183' },
    help: { type: 'boolean' },
  },
  allowPositionals: true,
})
if (values.help) {
  console.log(
    'Usage: pnpm presets:plates [--port 9341] [--url http://localhost:5180] [preset-id ...]\nCaptures standard SDR at DPR 1 using the selected driver profile. Serves this tree on --tree-port (5183) unless --url names a server already serving it. Recipe presets start from the default lens; camera presets restore their declared lens.',
  )
  process.exit(0)
}
if (
  !/^\d+$/.test(values.port) ||
  Number(values.port) < 1 ||
  Number(values.port) > 65535
)
  throw new Error('--port needs an integer from 1 to 65535.')

// Every name, not just one of them: a typo beside a real id would otherwise
// capture the real one and report the run complete.
const unknown = wanted.filter((id) => !PICTURES.some((one) => one.id === id))
if (unknown.length > 0) {
  console.error(
    `no picture called ${unknown.join(', ')}. Pictures: ${PICTURES.map((one) => one.id).join(', ')}`,
  )
  process.exit(1)
}

const pictures =
  wanted.length === 0
    ? PICTURES
    : PICTURES.filter((one) => wanted.includes(one.id))

let origin = values.url
let stop = null
if (origin === undefined) {
  stop = await serve(
    ROOT,
    values['tree-port'],
    path.join(ROOT, '.data/drive/plates-server.log'),
  )
  origin = `http://localhost:${values['tree-port']}`
}
try {
  await capturePlates({
    origin,
    port: values.port,
    out: PLATES,
    pictures,
    extension: 'jpg',
  })
} finally {
  stop?.()
}

console.log(
  `\n${pictures.length} plate${pictures.length === 1 ? '' : 's'} in ${path.relative(ROOT, PLATES)}. pnpm drive --down when finished.`,
)
