#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const local = fileURLToPath(new URL('../../.env.local', import.meta.url))
const server = fileURLToPath(new URL('../../apps/server', import.meta.url))
const args = [
  'exec',
  'wrangler',
  'dev',
  ...(existsSync(local) ? ['--env-file', local] : []),
  ...process.argv.slice(2),
]
// Only the Worker receives this file. Vite never inherits the provider secrets.
const child = spawn('pnpm', args, { cwd: server, stdio: 'inherit' })
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => child.kill(signal))
