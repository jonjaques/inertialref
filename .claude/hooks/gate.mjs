#!/usr/bin/env node
//
// Stop hook — AGENTS.md § "Definition of done", executed rather than described.
//
// The rule it enforces is the one already written down: a change is not finished
// because the browser renders something, it is finished when the layering holds, the
// types check and the tests pass. Enforcing it here rather than trusting a checklist
// costs about half a minute: the `gate` group of `scripts/check.mjs`, which is
//
//     graph, lint, the six typecheck projects and the root test suite
//
// run as a graph under the machine's core budget, so the six `tsc` projects cost what
// the slowest one costs and the suite starts beside them. `pnpm test` is that cheap
// because the terrain descent lives in the slow suite — `gameEngine.descent.slow.test.ts`,
// which the full `pnpm check` and CI run and this never does: cold, it generates a
// landing's worth of ground through an inline worker in 96 s on one core. Every figure
// here moves whenever the field gets deeper; the runner prints the wall clock of each
// stage, so re-measure by reading that rather than a number off this comment, and quote
// the CPU percentage beside it, because a suite started while the last run's workers
// are still exiting reads twice its settled cost. `design/plans/test-speed.md` has the
// accounting.
//
// The runner stamps every stage that passes with a key made of the working tree's
// content, so a `/ship` minutes later on the same tree runs the rest of `pnpm check` and
// reuses these four. That is the whole reason this hook runs the same runner rather
// than its own list: the stamps are one file per stage in `.data/check/`, and two
// callers spelling the same stage differently would never share one.
//
// `pnpm build` is deliberately not in the group, and not for the reason it looks like:
// its marginal cost is the astro bundle, and a bundle proves nothing about the source
// that `typecheck` has not — the failures it does catch alone are resolution and asset
// ones, which are worth catching at the commit rather than on every turn. The full
// `pnpm check` including it belongs there, which is what .claude/skills/ship runs.
//
// Three properties matter more than the checks themselves:
//
//   * It only runs when a source file actually moved this turn. format-edited.sh
//     leaves the marker; a turn that answered a question or edited Markdown pays
//     nothing. A Stop hook has no other way to know what the turn did.
//   * It blocks at most MAX_BLOCKS times per user prompt. Claude uses exit 2; Cursor uses
//     a followup_message. Both mean "do not stop, here is why", which is exactly the
//     feedback loop wanted — and exactly the shape of an infinite loop if the failure is
//     something the agent cannot fix, such as a red test that was already red. After the
//     cap it reports and lets go.
//   * It runs in the session's own cwd, which inside a worktree is not
//     $CLAUDE_PROJECT_DIR — and it runs that checkout's own copy of the runner, which
//     keys its stamps to that tree. Running the gate against the main checkout while
//     an agent edits a worktree would test the wrong tree and pass for the wrong reason.
//
// The `timeout` on the Stop hook in .claude/settings.json has to stay above the budget
// below — 840 s, hence 900. Whichever of the two fires first decides what a stall looks
// like, and only one of them can say which stage stalled: a hook killed by the harness
// reports nothing at all. The runner's own per-stage timeouts fire first in practice
// and name the stage.
//
// Escape hatch: IR_SKIP_GATE=1.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const MAX_BLOCKS = 3
const MAX_REPORT_CHARS = 6000
/** The whole group. The runner kills a single hung stage well before this. */
const GATE_TIMEOUT = 840_000

const stdin = readFileSync(0, 'utf8')
let input = {}
try {
  input = JSON.parse(stdin)
} catch {
  process.exit(0)
}

const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd()
const cursorHook = typeof input.conversation_id === 'string'
const counterSession = input.session_id ?? input.conversation_id ?? 'nosession'
const prompt = input.prompt_id ?? input.generation_id ?? 'noprompt'
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd

const cache = join(projectDir, '.claude', '.cache')
const dirty = join(cache, 'dirty-source')
const active = join(cache, 'gate-source')
const counter = join(cache, `gate-${counterSession}.json`)
let markerClaimed = false

if (process.env.IR_SKIP_GATE) finish()

// Nothing that `pnpm check` reads was touched this turn.
if (!existsSync(dirty)) finish()

// Cursor can run its native hook and the imported Claude hook for the same event. Rename
// the shared marker before doing work: only one invocation can claim it, and an edit that
// arrives while the gate runs creates a fresh marker for the next stop.
try {
  renameSync(dirty, active)
  markerClaimed = true
} catch {
  finish()
}

// A checkout with no dependencies fails every stage for a reason that is not the
// agent's change. session-start.sh normally prevents this; if it did not, saying so is
// more useful than four identical "command not found" reports.
if (!existsSync(join(cwd, 'node_modules'))) {
  restoreMarker()
  process.stderr.write(
    `Skipped the ${cwd} gate: no node_modules. Run \`pnpm install --frozen-lockfile\` there before trusting any result.\n`,
  )
  finish()
}

const failure = run()

if (!failure) {
  rmSync(active, { force: true })
  markerClaimed = false
  rmSync(counter, { force: true })
  finish()
}

// --- blocked -------------------------------------------------------------------------

restoreMarker()

let blocks = 0
if (cursorHook) {
  blocks = input.loop_count ?? 0
} else {
  try {
    const prior = JSON.parse(readFileSync(counter, 'utf8'))
    if (prior.prompt === prompt) blocks = prior.blocks ?? 0
  } catch {
    /* first failure for this session, or the file was cleared by a passing run */
  }
}

if (blocks >= MAX_BLOCKS) {
  process.stderr.write(
    `${failure.command} is still failing after ${MAX_BLOCKS} attempts. Not blocking again — ` +
      `say plainly in your reply that the gate is red and what is failing, rather than reporting the task complete.\n`,
  )
  finish()
}

if (!cursorHook) {
  mkdirSync(cache, { recursive: true })
  writeFileSync(counter, JSON.stringify({ prompt, blocks: blocks + 1 }))
}

const report = failure.timedOut
  ? `\`${failure.command}\` did not finish: ${failure.why}, so the output below stops mid-run ` +
    `and names nothing.\n\n` +
    `${failure.output}\n\n` +
    `This is not a red stage. Either something hangs, or the stage has outgrown its budget in ` +
    `scripts/check.mjs — time \`${failure.command}\` by hand before assuming which. ` +
    `Set IR_SKIP_GATE=1 to suppress this gate.`
  : `Definition of done not met: \`${failure.command}\` failed (${failure.why}).\n\n` +
    `${failure.output}\n\n` +
    `Fix this before finishing. If the failure predates your change, say so instead of working around it. ` +
    `Set IR_SKIP_GATE=1 to suppress this gate.`

if (cursorHook) {
  finish({ followup_message: report })
}

process.stderr.write(`${report}\n`)
process.exit(2)

// --- helpers -------------------------------------------------------------------------

/**
 * The gate group through the runner, and the first red stage out of its report.
 *
 * `--json` puts one object on stdout whatever happened, and the runner exits 1 on a
 * failure, so the object is read off the thrown error's `stdout` in that case. A stage's
 * diagnostics are on stdout for tsc and vitest and on stderr for the node scripts; the
 * runner merges both, and the tail is the part that names the file — a head-truncated
 * tsc dump is the summary line and nothing actionable.
 */
function run() {
  const runner = join(cwd, 'scripts', 'check.mjs')
  let raw = ''
  let stderr = ''
  try {
    raw = execFileSync('node', [runner, '--only', 'gate', '--json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: GATE_TIMEOUT,
      maxBuffer: 1 << 26,
    })
  } catch (error) {
    raw = error.stdout ?? ''
    stderr = error.stderr ?? ''
    /*
     * A killed run is not a failed one, and everything downstream reads it as one
     * unless this says otherwise. `execFileSync` SIGTERMs at its `timeout` and throws
     * the same shape a non-zero exit throws — `status` null rather than a code, and
     * `stdout` holding whatever had been written when the axe fell.
     */
    if (error.code === 'ETIMEDOUT') {
      return {
        command: 'pnpm check --only gate',
        why: `killed after ${GATE_TIMEOUT / 1000}s`,
        timedOut: true,
        output: tail(`${raw}${stderr}`),
      }
    }
  }
  let result
  try {
    result = JSON.parse(raw.trim().split('\n').pop())
  } catch {
    return {
      command: 'pnpm check --only gate',
      why: 'the runner itself did not report',
      timedOut: false,
      output: tail(`${raw}${stderr}`) || '(no output)',
    }
  }
  if (result.ok) return null
  const red = result.stages.find(
    (stage) => stage.status === 'failed' || stage.status === 'timedOut',
  )
  return {
    command: `pnpm check --only ${red.name}`,
    why:
      red.status === 'timedOut'
        ? `killed after ${red.seconds.toFixed(0)}s`
        : red.why,
    timedOut: red.status === 'timedOut',
    output: tail(red.output ?? '') || `(no output)`,
  }
}

function tail(text) {
  const trimmed = text.trimEnd()
  return trimmed.length > MAX_REPORT_CHARS
    ? `…truncated…\n${trimmed.slice(-MAX_REPORT_CHARS)}`
    : trimmed
}

function finish(output = {}) {
  if (cursorHook) process.stdout.write(`${JSON.stringify(output)}\n`)
  process.exit(0)
}

function restoreMarker() {
  if (!markerClaimed) return
  if (existsSync(dirty)) {
    rmSync(active, { force: true })
  } else {
    renameSync(active, dirty)
  }
  markerClaimed = false
}
