#!/usr/bin/env node
// Codex sends patch text; the shared formatter takes one file. Keep that translation
// here so Claude and Cursor keep the same hook protocol and the same gate recipe.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
const cwd = realpathSync(input.cwd || process.cwd())
const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()
const payload = { ...input, cwd: root, prompt_id: input.turn_id }
const cache = join(root, '.claude/.cache')

function invoke(binary, file, data) {
  const result = spawnSync(binary, [join(root, '.claude/hooks', file)], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify(data),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  return result.status ?? 1
}

if (input.hook_event_name === 'SessionStart') {
  process.exit(invoke('bash', 'session-start.sh', payload))
}
if (input.hook_event_name === 'Stop') {
  // A Stop continuation gets a new turn id. Retain the original prompt's budget
  // or three failed attempts become an unlimited sequence of first attempts.
  if (input.stop_hook_active && /^[\w-]+$/.test(input.session_id ?? '')) {
    try {
      payload.prompt_id = JSON.parse(
        readFileSync(join(cache, `gate-${input.session_id}.json`), 'utf8'),
      ).prompt
    } catch {
      /* No preceding failure to carry forward. */
    }
  }
  process.exit(invoke(process.execPath, 'gate.mjs', payload))
}
if (input.hook_event_name !== 'PostToolUse') process.exit(0)

const paths = new Set()
if (input.tool_name === 'apply_patch') {
  const patch =
    typeof input.tool_input === 'string'
      ? input.tool_input
      : input.tool_input?.command
  if (typeof patch === 'string') {
    for (const match of patch.matchAll(
      /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
    ))
      paths.add(match[1])
  }
} else if (input.tool_input?.file_path) paths.add(input.tool_input.file_path)

for (const path of paths) {
  const file = resolve(cwd, path)
  const local = relative(root, file)
  if (local === '..' || local.startsWith('../') || isAbsolute(local)) continue
  // A deletion still changes the source graph, although there is no file to format.
  if (/\.(ts|tsx|mjs|json)$/.test(file)) {
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'dirty-source'), '', { flag: 'a' })
  }
  if (existsSync(file))
    invoke('bash', 'format-edited.sh', {
      ...payload,
      tool_input: { file_path: file },
    })
}
