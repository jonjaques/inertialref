#!/usr/bin/env node
/*
 * Did the change move a picture?
 *
 *     pnpm presets:compare                        every picture, against the committed plates
 *     pnpm presets:compare far-shore earthrise    two of them
 *     pnpm presets:compare --base origin/main     against a baseline served from that commit
 *     pnpm presets:compare --twice                the tree against itself — the rig's own noise
 *
 * A preset is an address, a framing, a lens and a held instant, so it is the
 * one frame this repository can ask the renderer for twice and expect back the
 * same. That makes the thirteen a regression fixture: photograph them from the
 * tree as it stands, difference each against the frame last accepted for it,
 * and what moved is a table with a number in it rather than an opinion about a
 * screenshot. Eight are in Sol and five stand on generated ground outside it,
 * which is where terrain, the projected record and the detail floor live.
 *
 * Both trees are served by this script on ports of its own — never whatever
 * answers on 5173, which is any project's dev server — unless `--url` names a
 * server already serving this tree.
 *
 * The reference is the committed plate unless `--base` names a commit. The
 * plates are the frames a reviewer last accepted — `pnpm presets:plates`
 * rewrites one on purpose, and the rewritten file in the pull request is the
 * claim under review — so a plate that moved is either a regression or a
 * recapture somebody owes. `--base` builds and serves the named commit in a
 * worktree of its own and photographs it through the same rig, for the case
 * where the plates are known to be behind or an exact same-machine control is
 * wanted; `--twice` photographs the tree a second time and measures the rig
 * against itself, which is where the floor below comes from.
 *
 * Differencing is ImageMagick, because that is how every picture here is
 * compared by hand and a number from this table can be re-run by pasting the
 * command: the count of pixels whose gray difference exceeds a per-pixel
 * level — 3% against a PNG this rig captured, 8% against a committed JPEG
 * plate, whose own encoding error is the only thing between it and the frame.
 * `--threshold` is the count a plate may drift by before it is called moved;
 * the default is measured, with room. `<id>.pair.png` beside each result is
 * reference, tree and the auto-leveled difference side by side — the artifact
 * a pull request wants.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import {
  PICTURES,
  PLATE_HEIGHT,
  PLATE_WIDTH,
} from '../../packages/devtools/src/pictures.ts'
import { PLATES, plateName } from './check.mjs'
import { capturePlates, serve } from './capture.mjs'
import ledger from '../../apps/headless/src/pictureLedger.json' with { type: 'json' }

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = path.join(ROOT, '.data/presets/compare')
const run = promisify(execFile)

/**
 * Pixels a plate may drift by before it is called moved.
 *
 * Measured on 19 September 2026 at `2e314c52` with the capture settled and
 * the seven lit pictures: two captures of the tree differ by 0 px at the 3%
 * level on every one, and a capture against a plate written minutes earlier
 * differs by at most 25 px at the 8% level — the JPEG's own error, which
 * peaks at 28 of 255 on Earth's clouds. Two hundred is eight times that, so
 * an encoder on another machine has room, and a genuine move is thousands:
 * the drained rivers of ADR-0043 read 21,715 px on `far-shore` at 12%.
 */
const NOISE_FLOOR = 200

/**
 * Per-pixel difference below which two pixels are the same pixel.
 *
 * 3% — about 8 of 255 — when the reference is a PNG this rig captured, which
 * is exact. 8% — about 20 — when it is a committed plate, because the plate
 * is a JPEG at quality 88 and its ringing on a textured face reaches 28 of
 * 255 while a real change reaches far past it. The header names which.
 */
const SAME = { png: '3%', jpg: '8%' }

/**
 * How much of a plate has to be lit for it to be compared by default.
 *
 * The fraction of its pixels above 12% of full gray, measured on the
 * committed plates on 19 September 2026: a full-face Earth is 31%, Saturn
 * from high over the rings 22%, raking light along Mars 32%, and Jupiter with
 * its moons strung out beside it 15% — a small lit disk in a frame of sky.
 * A frame that is mostly sky compares its star field, which differs between
 * two captures of one build by thousands of pixels while a lit face differs
 * by none, so the floor sits between the last two. The ledger's own verdict —
 * a sun over three degrees up on the ground, a phase under a hundred from
 * orbit — is the other half: it is what excludes the night side and the
 * crescents, which the fraction alone cannot, since a galaxy band lights a
 * frame without lighting its subject. Both have to hold; `--all` compares
 * every picture regardless.
 */
const LIT_FLOOR = 0.2

const { values, positionals: wanted } = parseArgs({
  options: {
    base: { type: 'string' },
    url: { type: 'string' },
    port: { type: 'string', default: '9333' },
    'tree-port': { type: 'string', default: '5183' },
    'base-port': { type: 'string', default: '5184' },
    threshold: { type: 'string', default: String(NOISE_FLOOR) },
    all: { type: 'boolean', default: false },
    twice: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (values.help) {
  console.log(
    [
      'pnpm presets:compare [preset-id ...] [--base <ref>]',
      '',
      '  --base <ref>       photograph a baseline served from this commit instead of using the committed plates',
      '  --url <origin>     a server already serving this tree; without it one is started on --tree-port',
      '  --port <n>         the driver CDP port, which keys its Chrome profile; default 9333',
      '  --tree-port <n>    the port this tree is served on; default 5183',
      '  --base-port <n>    the port the baseline is served on; default 5184',
      `  --threshold <px>   changed pixels a plate may drift by; default ${NOISE_FLOOR}`,
      `  --all              the dark pictures too; by default only the lit ones are compared`,
      `  --twice            photograph the tree a second time and compare the two: the rig's own noise`,
      '  --keep             keep the baseline worktree and its server log',
      '  --json             one JSON object instead of the table',
    ].join('\n'),
  )
  process.exit(0)
}

const threshold = Number(values.threshold)
if (!Number.isFinite(threshold) || threshold < 0)
  throw new Error('--threshold needs a pixel count.')

const say = (line) => {
  if (!values.json) console.log(line)
}

/** The fraction of a plate's pixels above 12% of full gray. */
async function litFraction(file) {
  return Number(
    await magick([
      file,
      '-colorspace',
      'Gray',
      '-threshold',
      '12%',
      '-format',
      '%[fx:mean]',
      'info:',
    ]),
  )
}

const named =
  wanted.length === 0
    ? PICTURES
    : PICTURES.filter((one) => wanted.includes(one.id))
if (named.length === 0) {
  console.error(`no picture called ${wanted.join(', ')}`)
  process.exit(1)
}

/*
 * Which pictures to photograph: the lit ones, unless named or `--all`.
 *
 * Judged from the committed plate's pixels and the ledger's geometry, both of
 * which exist before a browser starts — so a dark picture is skipped rather
 * than captured, differenced, and then explained.
 */
const light = new Map(ledger.pictures.map((one) => [one.id, one.light]))
const dark = []
const pictures = []
for (const one of named) {
  const plate = path.join(PLATES, plateName(one.id))
  const lit = existsSync(plate) ? await litFraction(plate) : null
  const verdict = light.get(one.id)?.lit ?? true
  const include =
    values.all || wanted.length > 0 || (verdict && (lit ?? 1) >= LIT_FLOOR)
  ;(include ? pictures : dark).push({ ...one, lit, verdict })
}
if (dark.length > 0)
  say(
    `skipping ${dark.length} dark picture${dark.length === 1 ? '' : 's'} (--all compares them): ` +
      dark
        .map(
          (one) =>
            `${one.id} (${one.lit === null ? 'no plate' : `${(one.lit * 100).toFixed(0)}% lit`}${one.verdict ? '' : ', in shadow'})`,
        )
        .join(', '),
  )
if (pictures.length === 0) {
  console.error('nothing lit to compare; --all compares the dark pictures')
  process.exit(1)
}

// --- the baseline -------------------------------------------------------------------

const git = (args, cwd = ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/**
 * A worktree of the commit, installed.
 *
 * Its own `node_modules`, because a worktree is a fresh checkout and pnpm
 * hardlinks one into place in about three seconds.
 */
async function checkoutBase(ref) {
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`])
  const tree = path.join(ROOT, '.data/presets/base', sha.slice(0, 12))
  if (!existsSync(tree)) {
    say(`baseline ${sha.slice(0, 12)} → ${path.relative(ROOT, tree)}`)
    git(['worktree', 'add', '--detach', tree, sha])
  }
  execFileSync(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline', '--silent'],
    { cwd: tree, stdio: 'inherit' },
  )
  return { sha, tree }
}

// --- differencing --------------------------------------------------------------------

async function magick(args) {
  try {
    const { stdout } = await run('magick', args, { maxBuffer: 1 << 24 })
    return stdout.trim()
  } catch (cause) {
    throw new Error(
      `ImageMagick failed — is \`magick\` on PATH? (${String(cause)})`,
    )
  }
}

const gray = (a, b) => [
  a,
  b,
  '-compose',
  'difference',
  '-composite',
  '-colorspace',
  'Gray',
]

/** Pixels that differ by more than `level`, and the largest single difference of 255. */
async function difference(a, b, level) {
  const changed = Number(
    await magick([
      ...gray(a, b),
      '-threshold',
      level,
      '-format',
      '%[fx:int(mean*w*h+0.5)]',
      'info:',
    ]),
  )
  const peak = Number(
    await magick([
      ...gray(a, b),
      '-format',
      '%[fx:int(maxima*255+0.5)]',
      'info:',
    ]),
  )
  return { changed, peak }
}

async function pair(a, b, id) {
  const diff = path.join(OUT, `${id}.diff.png`)
  const side = path.join(OUT, `${id}.pair.png`)
  await magick([...gray(a, b), '-auto-level', diff])
  await magick([a, b, diff, '+append', side])
  return { diff, side }
}

// --- the run ------------------------------------------------------------------------

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

let reference
let referenceLabel
let stopBase = null
let stopTree = null
let base = null
if (values.base !== undefined) {
  base = await checkoutBase(values.base)
  stopBase = await serve(
    base.tree,
    values['base-port'],
    path.join(OUT, 'base-server.log'),
  )
  referenceLabel = `${values.base} (${base.sha.slice(0, 12)})`
}
let origin = values.url
if (origin === undefined) {
  stopTree = await serve(
    ROOT,
    values['tree-port'],
    path.join(OUT, 'tree-server.log'),
  )
  origin = `http://localhost:${values['tree-port']}`
}

try {
  if (base !== null) {
    say(`\nphotographing ${referenceLabel} on :${values['base-port']}`)
    reference = await capturePlates({
      origin: `http://localhost:${values['base-port']}`,
      port: values.port,
      out: path.join(OUT, 'base'),
      pictures,
      extension: 'png',
      say,
    })
  } else if (values.twice) {
    referenceLabel = 'the same tree, photographed first'
    say(`\nphotographing the tree at ${origin}, the first time`)
    reference = await capturePlates({
      origin,
      port: values.port,
      out: path.join(OUT, 'base'),
      pictures,
      extension: 'png',
      say,
    })
  } else {
    referenceLabel = 'the committed plates'
    reference = new Map(
      pictures.map((one) => [one.id, path.join(PLATES, plateName(one.id))]),
    )
    for (const one of pictures)
      if (!existsSync(reference.get(one.id)))
        throw new Error(
          `${one.id} has no committed plate; pnpm presets:plates ${one.id} captures one`,
        )
  }

  say(`\nphotographing the tree at ${origin}`)
  const head = await capturePlates({
    origin,
    port: values.port,
    out: path.join(OUT, 'head'),
    pictures,
    extension: 'png',
    say,
  })

  const level = base === null && !values.twice ? SAME.jpg : SAME.png
  const rows = []
  for (const one of pictures) {
    const a = reference.get(one.id).file ?? reference.get(one.id)
    const taken = head.get(one.id)
    const b = taken.file
    const { changed, peak } = await difference(a, b, level)
    const moved = changed > threshold
    const files = await pair(a, b, one.id)
    rows.push({
      id: one.id,
      lit: one.lit,
      light: taken.light,
      settled: taken.settled,
      changed,
      fraction: changed / (PLATE_WIDTH * PLATE_HEIGHT),
      peak,
      moved,
      pair: path.relative(ROOT, files.side),
      diff: path.relative(ROOT, files.diff),
    })
  }

  const moved = rows.filter((row) => row.moved)
  const report = {
    reference: referenceLabel,
    level,
    threshold,
    viewport: { width: PLATE_WIDTH, height: PLATE_HEIGHT },
    pictures: rows,
  }
  await writeFile(
    path.join(OUT, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )

  if (values.json) {
    console.log(JSON.stringify(report))
  } else {
    console.log(
      `\n${'picture'.padEnd(22)} ${'lit'.padStart(4)} ${'light'.padStart(9)} ${'changed px'.padStart(10)} ${'of plate'.padStart(9)} ${'peak'.padStart(5)}  against ${referenceLabel}, over ${level} a pixel`,
    )
    for (const row of rows) {
      const shine =
        row.light.sun !== null
          ? `sun ${row.light.sun.toFixed(0)}°`
          : row.light.phase !== null
            ? `phase ${row.light.phase.toFixed(0)}°`
            : 'star'
      console.log(
        `${row.id.padEnd(22)} ${`${Math.round((row.lit ?? 0) * 100)}%`.padStart(4)} ${shine.padStart(9)} ${String(row.changed).padStart(10)} ${`${(row.fraction * 100).toFixed(2)}%`.padStart(9)} ${String(row.peak).padStart(5)}  ${row.moved ? `moved  ${row.pair}` : 'same'}${row.settled ? '' : '  (never settled)'}`,
      )
    }
    console.log(
      moved.length === 0
        ? `\n${rows.length} plates within ${threshold} px of ${referenceLabel}.`
        : `\n${moved.length} of ${rows.length} plates moved beyond ${threshold} px. Pairs are reference | tree | difference; ` +
            `pnpm presets:plates <id> accepts a move on purpose.`,
    )
  }
  if (moved.length > 0) process.exitCode = 1
} finally {
  stopTree?.()
  stopBase?.()
  if (base !== null && !values.keep) {
    try {
      git(['worktree', 'remove', '--force', base.tree])
    } catch (cause) {
      say(`could not remove ${base.tree}: ${String(cause)}`)
    }
  }
}
