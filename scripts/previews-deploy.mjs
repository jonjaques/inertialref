#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * `cf previews deploy`, plus the line Workers Builds reads a preview's URL from.
 *
 * Workers Builds learns what a deploy command produced from an output file —
 * one JSON record per line, at `WRANGLER_OUTPUT_FILE_PATH` or in a new file
 * under `WRANGLER_OUTPUT_FILE_DIRECTORY` — and never from the log. `cf deploy`
 * writes its record there, and so does `wrangler preview`. `cf previews deploy`
 * (1.0.0-beta.5) builds the same `preview` record and only prints it, so a
 * preview that deployed and answers at its URL reaches the pull request as "No
 * Preview URL", beside a link to a Preview URLs toggle that is already on.
 * This writes the record `cf` printed, in the shape `wrangler preview` writes,
 * and passes everything else through untouched.
 *
 * A record that cannot be found is a warning and not a failure: the preview is
 * up, and only the comment is missing its link.
 */

const server = fileURLToPath(new URL('../apps/server', import.meta.url))
const ANSI = /\x1b\[[0-9;]*m/g

/**
 * The record `cf previews deploy` printed, completed the way `wrangler preview`
 * writes it, or `null` when the output holds none. `cf` prints the record as
 * indented JSON after its build steps, so it is the last `{` … `}` block that
 * starts and ends at the left margin; color is stripped first, because `cf`
 * colors keys even into a pipe.
 */
export function previewRecord(stdout, workerName, now) {
  const lines = stdout.replace(ANSI, '').split('\n')
  const open = lines.lastIndexOf('{')
  const close = lines.lastIndexOf('}')
  if (open === -1 || close < open) return null
  let printed
  try {
    printed = JSON.parse(lines.slice(open, close + 1).join('\n'))
  } catch {
    return null
  }
  if (printed?.type !== 'preview') return null
  const { type, version, ...preview } = printed
  return {
    type,
    version,
    worker_name: workerName,
    ...preview,
    timestamp: now.toISOString(),
  }
}

/**
 * Where Wrangler would append a record: the named file, or a fresh one in the
 * named directory with Wrangler's own file name, or nowhere outside a build.
 */
export function outputFile(env, now) {
  if (env.WRANGLER_OUTPUT_FILE_PATH) return env.WRANGLER_OUTPUT_FILE_PATH
  const directory = env.WRANGLER_OUTPUT_FILE_DIRECTORY
  if (!directory) return null
  const stamp = now
    .toISOString()
    .replaceAll(':', '-')
    .replace('.', '_')
    .replace('T', '_')
    .replace('Z', '')
  const suffix = randomBytes(3).toString('hex')
  return resolve(directory, `wrangler-output-${stamp}-${suffix}.json`)
}

async function main() {
  const args = ['exec', 'cf', 'previews', 'deploy']
  args.push(...process.argv.slice(2).filter((argument) => argument !== '--'))
  const child = spawn('pnpm', args, {
    cwd: server,
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    process.stdout.write(chunk)
  })
  const code = await new Promise((settle) =>
    child.on('close', (status) => settle(status ?? 1)),
  )
  process.exitCode = code
  if (code !== 0) return

  const now = new Date()
  const file = outputFile(process.env, now)
  if (file === null) return
  const { default: config } =
    await import('../apps/server/cloudflare.config.ts')
  const record = previewRecord(
    stdout,
    config({ isPreview: true }).worker.name,
    now,
  )
  if (record === null) {
    console.warn(
      'previews:deploy: cf printed no preview record, so the pull request will show no preview URL',
    )
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`)
  console.log(
    `previews:deploy: recorded ${record.preview_urls.join(', ')} for Workers Builds`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
