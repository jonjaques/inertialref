#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const local = fileURLToPath(new URL('../../.env.local', import.meta.url))
const server = fileURLToPath(new URL('../../apps/server', import.meta.url))
/*
 * Only the Worker receives this file. Vite never inherits the provider secrets.
 * `cf dev` has no `--env-file`; it reads each declared secret from its own
 * environment. This process exists only to start it, so loading the file here
 * reaches the Worker and nothing else — `scripts/dev.mjs` starts Vite as a
 * sibling of this process, not a child. The bundler under `cf dev` consults the
 * environment only when `apps/server/.dev.vars` is absent; that file, if it
 * exists, shadows every key loaded here.
 */
if (existsSync(local)) process.loadEnvFile(local)
const args = [
  'exec',
  'cf',
  'dev',
  ...process.argv.slice(2).filter((argument) => argument !== '--'),
]
const child = spawn('pnpm', args, { cwd: server, stdio: 'inherit' })
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => child.kill(signal))
