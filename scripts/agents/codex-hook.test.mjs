import { afterEach, expect, test } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const fixtures = []
afterEach(() =>
  fixtures
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
)

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ir-hook-')))
  fixtures.push(root)
  execFileSync('git', ['init', '-q', root])
  mkdirSync(join(root, '.claude/hooks'), { recursive: true })
  mkdirSync(join(root, 'nested'))
  writeFileSync(
    join(root, '.claude/hooks/format-edited.sh'),
    'cat >> "$CLAUDE_PROJECT_DIR/edits"\nprintf "\\n" >> "$CLAUDE_PROJECT_DIR/edits"\n',
  )
  writeFileSync(
    join(root, '.claude/hooks/gate.mjs'),
    "import { readFileSync } from 'node:fs'; const p = JSON.parse(readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify(p)); process.exit(2)\n",
  )
  return root
}

function run(root, event) {
  return spawnSync(process.execPath, ['scripts/agents/codex-hook.mjs'], {
    input: JSON.stringify({
      cwd: join(root, 'nested'),
      session_id: 'test',
      ...event,
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/wrong-checkout' },
  })
}

test('a patch formats every surviving path and marks a source deletion in its own checkout', () => {
  const root = fixture()
  writeFileSync(join(root, 'nested/new name.md'), '# Title\n')
  const result = run(root, {
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command:
        '*** Begin Patch\n*** Delete File: gone.ts\n*** Update File: old.md\n*** Move to: new name.md\n@@\n-old\n+new\n*** End Patch',
    },
  })
  expect(result.status).toBe(0)
  const edit = JSON.parse(readFileSync(join(root, 'edits'), 'utf8').trim())
  expect(edit.cwd).toBe(root)
  expect(edit.tool_input.file_path).toBe(join(root, 'nested/new name.md'))
  expect(readFileSync(join(root, '.claude/.cache/dirty-source'), 'utf8')).toBe(
    '',
  )
})

test('the shared gate sees the repository root and retains the failure exit code', () => {
  const root = fixture()
  const result = run(root, { hook_event_name: 'Stop', turn_id: 'turn-1' })
  expect(result.status).toBe(2)
  expect(JSON.parse(result.stdout)).toMatchObject({
    cwd: root,
    prompt_id: 'turn-1',
  })
})

test('a stop continuation retains the original failure budget', () => {
  const root = fixture()
  mkdirSync(join(root, '.claude/.cache'), { recursive: true })
  writeFileSync(
    join(root, '.claude/.cache/gate-test.json'),
    JSON.stringify({ prompt: 'turn-1', blocks: 2 }),
  )
  const result = run(root, {
    hook_event_name: 'Stop',
    turn_id: 'turn-2',
    stop_hook_active: true,
  })
  expect(JSON.parse(result.stdout).prompt_id).toBe('turn-1')
})

test('patch paths outside the checkout do not reach the formatter', () => {
  const root = fixture()
  const result = run(root, {
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Delete File: ../../outside.ts' },
  })
  expect(result.status).toBe(0)
  expect(() =>
    readFileSync(join(root, '.claude/.cache/dirty-source')),
  ).toThrow()
})
