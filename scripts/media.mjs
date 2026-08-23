#!/usr/bin/env node
/*
 * The media the repository deliberately does not carry.
 *
 *     pnpm media:pull            fetch what is missing (part of `pnpm build`)
 *     pnpm media:pull --force    fetch it again even if it is already here
 *     pnpm media:push            upload the local copy back to R2
 *
 * **Why any of this exists.** The cutscene is cut against a piece of music, and
 * the music is somebody else's. Its use here is a fair-use claim the project is
 * comfortable making and is not comfortable making *in a git history*, which is
 * permanent, mirrored by every fork and indexed. So the track lives in the
 * site's own R2 bucket, the build pulls it into `public/` alongside the rest of
 * the client, and the deployed site serves it as an ordinary static asset.
 *
 * **Why a build-time pull rather than an R2 binding on the Worker.** A static
 * asset request never wakes the script and is not billed; a Worker streaming
 * 2.7 MB is billed on every play, has to implement `Range` by hand for the
 * `<audio>` element to seek, and is a second thing that can be down. The cost
 * of the pull is that a build without credentials produces a site without the
 * track — which is exactly what a fork should get, and the overlay already
 * handles: it probes for the file and plays the scene silent when it is absent.
 *
 * **So this must not fail a build.** `--optional` is what `pnpm build` passes.
 * Without credentials it says so once and exits 0.
 */
import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEDIA, MEDIA_BUCKET } from '../apps/server/src/media.ts'

const ROOT = new URL('../', import.meta.url)

const TIMEOUT_MS = 120_000

/**
 * Where a pulled object lands, which is `public/` and therefore `dist/`.
 *
 * The Worker prefers the bundled copy and falls back to the bucket, so this is
 * the fast path rather than the only one — `apps/server/src/media.ts` is the
 * single list of what exists and where, and it is imported rather than repeated
 * so a build tool and a Worker cannot disagree about either.
 */
const localPath = (object) => `apps/game/public/media/${object.name}`

const there = (path) => fileURLToPath(new URL(path, ROOT))

/**
 * Wrangler, from the app that owns `wrangler.jsonc`.
 *
 * Run from anywhere else it has no account to talk to. `--remote` is not
 * optional either: `r2 object` defaults to the local simulator in Wrangler 4,
 * so without it a pull silently succeeds against an empty local bucket.
 */
function wrangler(args) {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@inertialref/server', 'exec', 'wrangler', ...args],
      {
        cwd: there('.'),
        /*
         * Piped, not inherited, and that is load-bearing twice over. It is what
         * lets a failure be reported as one indented block instead of raw
         * Wrangler noise in the middle of a build log — and Wrangler decides
         * whether it may prompt for an interactive login by looking at whether
         * stdout is a TTY. With a pipe it is not, so an unauthenticated pull
         * fails with a sentence rather than trying to open a browser.
         */
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    const done = (result) => {
      clearTimeout(timer)
      resolve(result)
    }
    /*
     * A ceiling, because this runs inside `pnpm build` and therefore inside a
     * deploy. Nothing here is worth more than two minutes, and a hung transfer
     * with no bound is a deploy that never finishes and never says why — which
     * is a worse outcome than shipping the site without the audio, the case
     * this whole script is already designed to survive.
     */
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      done({
        ok: false,
        output: `${output}\ntimed out after ${TIMEOUT_MS / 1000}s`,
      })
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (cause) =>
      done({ ok: false, output: `${output}${cause.message}` }),
    )
    child.on('close', (code) => done({ ok: code === 0, output }))
  })
}

const bytes = async (path) => (await stat(path).catch(() => null))?.size ?? 0

async function pull({ force, optional }) {
  const missing = []
  for (const item of MEDIA) {
    const file = there(localPath(item))
    const size = await bytes(file)
    if (size > 0 && !force) {
      console.log(`media: ${localPath(item)} is already here (${size} bytes)`)
      continue
    }
    await mkdir(dirname(file), { recursive: true })
    console.log(
      `media: fetching ${item.what} from r2://${MEDIA_BUCKET}/${item.key}`,
    )
    const result = await wrangler([
      'r2',
      'object',
      'get',
      `${MEDIA_BUCKET}/${item.key}`,
      '--remote',
      '--file',
      file,
    ])
    if (result.ok && (await bytes(file)) > 0) {
      console.log(`media: ${localPath(item)} (${await bytes(file)} bytes)`)
      continue
    }
    missing.push({ item, output: result.output.trim() })
  }

  if (missing.length === 0) return

  for (const { item, output } of missing) {
    console.warn(`\nmedia: could not fetch ${item.key}`)
    if (output !== '') console.warn(output.replace(/^/gm, '  '))
  }
  if (optional) {
    /*
     * The line that has to be readable a month later, in a build log nobody is
     * watching. It names the consequence rather than the error, because the
     * error — an unauthenticated wrangler — is not a problem for anyone
     * building a fork, and the consequence is the only thing they would
     * otherwise have to guess at from a silent cutscene.
     */
    console.warn(
      '\nmedia: continuing without it. The site builds and runs; the cutscene\n' +
        '       plays silent. Run `wrangler login` (or set CLOUDFLARE_API_TOKEN\n' +
        '       with R2 read) if the audio is meant to ship.',
    )
    return
  }
  process.exitCode = 1
}

async function push() {
  for (const item of MEDIA) {
    const file = there(localPath(item))
    if ((await bytes(file)) === 0) {
      console.error(`media: nothing at ${localPath(item)} to upload`)
      process.exitCode = 1
      return
    }
    console.log(
      `media: uploading ${localPath(item)} to r2://${MEDIA_BUCKET}/${item.key}`,
    )
    const result = await wrangler([
      'r2',
      'object',
      'put',
      `${MEDIA_BUCKET}/${item.key}`,
      '--remote',
      '--file',
      file,
      '--content-type',
      item.type,
    ])
    console.log(result.output.trim())
    if (!result.ok) {
      process.exitCode = 1
      return
    }
  }
}

const command = process.argv[2] ?? 'pull'
if (command === 'pull') {
  await pull({
    force: process.argv.includes('--force'),
    optional: process.argv.includes('--optional'),
  })
} else if (command === 'push') {
  await push()
} else {
  console.error(
    `media: unknown command "${command}" — expected pull or push.\n` +
      MEDIA.map((item) => `  ${localPath(item)}  ${item.what}`).join('\n'),
  )
  process.exitCode = 1
}
