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
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
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
 * `cf`, from the app that declares it, run against the account rather than the
 * local simulator — `cf r2 objects` is remote unless `--local` is passed.
 *
 * `into` names a file for stdout. `cf r2 objects get` has no `--file`; it
 * writes the object's bytes to stdout, so a pull streams them to a `.part`
 * beside the destination and renames it only once `cf` exits 0. A failed or
 * timed-out pull therefore leaves nothing behind, rather than a truncated
 * track that `pull` would count as present on the next build.
 */
function cf(args, { into } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@inertialref/server', 'exec', 'cf', ...args],
      {
        cwd: there('.'),
        /*
         * Piped, not inherited, and that is load-bearing twice over. It is what
         * lets a failure be reported as one indented block instead of raw CLI
         * noise in the middle of a build log — and with stdin closed and no TTY
         * an unauthenticated `cf` fails with a sentence naming
         * CLOUDFLARE_API_TOKEN rather than trying to open a browser.
         */
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const part = into === undefined ? undefined : `${into}.part`
    const sink = part === undefined ? undefined : createWriteStream(part)
    let output = ''
    let settled = false
    /*
     * Every failure here has to become `{ ok: false }`, never a throw: `done`
     * runs from event handlers nobody awaits, so a rejected rename would be an
     * unhandled rejection that fails the build this script must not fail.
     */
    const done = async (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (sink !== undefined) {
        /*
         * Unpiped and drained, not merely ended. `pnpm` is the child; `cf` is
         * its child and holds the same pipe. After a timeout it can outlive
         * the SIGTERM, and a pipe nobody reads fills and blocks its writes —
         * with the stdout handle keeping this process alive, that is the hung
         * deploy the timeout exists to prevent.
         */
        child.stdout.unpipe(sink)
        child.stdout.resume()
        await new Promise((closed) => sink.end(closed))
        try {
          if (result.ok) await rename(part, into)
          else await rm(part, { force: true })
        } catch (cause) {
          await rm(part, { force: true }).catch(() => {})
          result = { ok: false, output: `${result.output}\n${cause.message}` }
        }
      }
      resolve(result)
    }
    // A full disk or an unwritable directory, reported like any other failure.
    sink?.on('error', (cause) => {
      child.kill('SIGTERM')
      done({ ok: false, output: `${output}\n${cause.message}` })
    })
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
    if (sink !== undefined) child.stdout.pipe(sink, { end: false })
    else child.stdout.on('data', (chunk) => (output += chunk))
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
    const result = await cf(
      ['r2', 'objects', 'get', item.key, '--bucket-name', MEDIA_BUCKET],
      { into: file },
    )
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
     * error — an unauthenticated `cf` — is not a problem for anyone
     * building a fork, and the consequence is the only thing they would
     * otherwise have to guess at from a silent cutscene.
     */
    console.warn(
      '\nmedia: continuing without it. The site builds and runs; the cutscene\n' +
        '       plays silent. Run `cf auth login` (or set CLOUDFLARE_API_TOKEN\n' +
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
    const result = await cf([
      'r2',
      'objects',
      'put',
      item.key,
      '--bucket-name',
      MEDIA_BUCKET,
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
