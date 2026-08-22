#!/usr/bin/env node
//
// Stop hook — AGENTS.md § "Definition of done", executed rather than described.
//
// The rule it enforces is the one already written down: a change is not finished
// because the browser renders something, it is finished when the layering holds, the
// types check and the tests pass. Enforcing it here rather than trusting a checklist
// costs about six seconds:
//
//     graph 0.19s -> lint 0.19s -> typecheck 3.27s -> test 2.16s
//
// `pnpm build` is deliberately not in that list, and not for the reason it looks like:
// its marginal cost is only the 1.7s of vite bundling, because `pnpm build` is
// `typecheck && vite build` and the typecheck is already above. It is out because what
// it adds is bundling, and a bundle proves nothing about the source that `typecheck`
// has not — the failures it does catch alone are resolution and asset ones, which are
// worth catching at the commit rather than on every turn. The full `pnpm check`
// including build belongs there, which is what .claude/skills/ship runs.
//
// Three properties matter more than the checks themselves:
//
//   * It only runs when a source file actually moved this turn. format-edited.sh
//     leaves the marker; a turn that answered a question or edited Markdown pays
//     nothing. A Stop hook has no other way to know what the turn did.
//   * It blocks at most MAX_BLOCKS times per user prompt. Exit 2 on Stop means "do not
//     stop, here is why", which is exactly the feedback loop wanted — and exactly the
//     shape of an infinite loop if the failure is something the agent cannot fix, such
//     as a red test that was already red. After the cap it reports and lets go.
//   * It runs in the session's own cwd, which inside a worktree is not
//     $CLAUDE_PROJECT_DIR. Running the gate against the main checkout while an agent
//     edits a worktree would test the wrong tree and pass for the wrong reason.
//
// Escape hatch: IR_SKIP_GATE=1.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const MAX_BLOCKS = 3
const MAX_REPORT_CHARS = 6000

/** graph and lint are near-free and catch the two failures that are structural rather
 *  than local, so they run first: a layering violation or a cycle makes every later
 *  stage's output noise. */
const STAGES = [
  { name: 'graph', args: ['graph'], why: 'layering or a cycle in packages/*' },
  { name: 'lint', args: ['lint'], why: 'oxlint' },
  {
    name: 'typecheck',
    args: ['typecheck'],
    why: 'one of the five tsconfig projects',
  },
  { name: 'test', args: ['test'], why: 'vitest' },
]

const stdin = readFileSync(0, 'utf8')
let input = {}
try {
  input = JSON.parse(stdin)
} catch {
  process.exit(0)
}

const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd()
const session = input.session_id ?? 'nosession'
const prompt = input.prompt_id ?? 'noprompt'
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd

if (process.env.IR_SKIP_GATE) process.exit(0)

const cache = join(projectDir, '.claude', '.cache')
const dirty = join(cache, `dirty-${session}`)
const counter = join(cache, `gate-${session}.json`)

// Nothing that `pnpm check` reads was touched this turn.
if (!existsSync(dirty)) process.exit(0)

// A checkout with no dependencies fails every stage for a reason that is not the
// agent's change. session-start.sh normally prevents this; if it did not, saying so is
// more useful than four identical "command not found" reports.
if (!existsSync(join(cwd, 'node_modules'))) {
  process.stderr.write(
    `Skipped the ${cwd} gate: no node_modules. Run \`pnpm install --frozen-lockfile\` there before trusting any result.\n`,
  )
  process.exit(0)
}

const failure = run()

if (!failure) {
  rmSync(dirty, { force: true })
  rmSync(counter, { force: true })
  process.exit(0)
}

// --- blocked -------------------------------------------------------------------------

let blocks = 0
try {
  const prior = JSON.parse(readFileSync(counter, 'utf8'))
  if (prior.prompt === prompt) blocks = prior.blocks ?? 0
} catch {
  /* first failure for this session, or the file was cleared by a passing run */
}

if (blocks >= MAX_BLOCKS) {
  process.stderr.write(
    `pnpm ${failure.name} is still failing after ${MAX_BLOCKS} attempts. Not blocking again — ` +
      `say plainly in your reply that the gate is red and what is failing, rather than reporting the task complete.\n`,
  )
  process.exit(0)
}

mkdirSync(cache, { recursive: true })
writeFileSync(counter, JSON.stringify({ prompt, blocks: blocks + 1 }))

process.stderr.write(
  `Definition of done not met: \`pnpm ${failure.name}\` failed (${failure.why}).\n\n` +
    `${failure.output}\n\n` +
    `Fix this before finishing. If the failure predates your change, say so instead of working around it. ` +
    `Set IR_SKIP_GATE=1 to suppress this gate.\n`,
)
process.exit(2)

// --- helpers -------------------------------------------------------------------------

function run() {
  for (const stage of STAGES) {
    try {
      execFileSync('pnpm', stage.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 240_000,
      })
    } catch (error) {
      // A stage's diagnostics are on stdout for tsc and vitest and on stderr for the
      // node scripts, and the tail is the part that names the file — a head-truncated
      // tsc dump is the summary line and nothing actionable.
      const raw = `${error.stdout ?? ''}${error.stderr ?? ''}`.trimEnd()
      const output =
        raw.length > MAX_REPORT_CHARS
          ? `…truncated…\n${raw.slice(-MAX_REPORT_CHARS)}`
          : raw || `(no output; exit ${error.status})`
      return { ...stage, output }
    }
  }
  return null
}
