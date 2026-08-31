#!/usr/bin/env node
//
// Stop hook — AGENTS.md § "Definition of done", executed rather than described.
//
// The rule it enforces is the one already written down: a change is not finished
// because the browser renders something, it is finished when the layering holds, the
// types check and the tests pass. Enforcing it here rather than trusting a checklist
// costs about two minutes:
//
//     graph 0.21s -> lint 0.23s -> typecheck 4.89s -> test 103s
//
// Three of those four are free and the fourth is the whole cost. `pnpm test` is what it
// is because one test in `gameEngine.test.ts` generates a landing's worth of ground
// through an inline worker, and that figure moves whenever the field gets deeper — so
// treat it as measured rather than fixed, and re-measure before tightening any budget
// below rather than reading one off this comment.
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
//   * It blocks at most MAX_BLOCKS times per user prompt. Claude uses exit 2; Cursor uses
//     a followup_message. Both mean "do not stop, here is why", which is exactly the
//     feedback loop wanted — and exactly the shape of an infinite loop if the failure is
//     something the agent cannot fix, such as a red test that was already red. After the
//     cap it reports and lets go.
//   * It runs in the session's own cwd, which inside a worktree is not
//     $CLAUDE_PROJECT_DIR. Running the gate against the main checkout while an agent
//     edits a worktree would test the wrong tree and pass for the wrong reason.
//
// The `timeout` on the Stop hook in .claude/settings.json has to stay above the sum of
// every stage budget below — 840 s, hence 900. Whichever of the two fires first decides
// what a stall looks like, and only one of them can say which stage stalled: a hook
// killed by the harness reports nothing at all.
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

/** graph and lint are near-free and catch the two failures that are structural rather
 *  than local, so they run first: a layering violation or a cycle makes every later
 *  stage's output noise.
 *
 *  Each carries its own `timeout`, because one budget for all four has to be sized for
 *  the slowest and is then no guard at all on the other three. A stage that reaches its
 *  timeout is *hung* — the numbers in the header are the honest cost and every budget
 *  here is a large multiple of one. `test` gets ten minutes against a measured 103 s,
 *  because the suite's cost sits almost entirely in one terrain descent whose own
 *  runtime moves by a factor of two with how busy the machine is; a budget that is
 *  merely comfortable on an idle machine turns every parallel build into a false red. */
const STAGES = [
  {
    name: 'graph',
    args: ['graph'],
    why: 'layering or a cycle in packages/*',
    timeout: 60_000,
  },
  { name: 'lint', args: ['lint'], why: 'oxlint', timeout: 60_000 },
  {
    name: 'typecheck',
    args: ['typecheck'],
    why: 'one of the five tsconfig projects',
    timeout: 120_000,
  },
  { name: 'test', args: ['test'], why: 'vitest', timeout: 600_000 },
]

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
    `pnpm ${failure.name} is still failing after ${MAX_BLOCKS} attempts. Not blocking again — ` +
      `say plainly in your reply that the gate is red and what is failing, rather than reporting the task complete.\n`,
  )
  finish()
}

if (!cursorHook) {
  mkdirSync(cache, { recursive: true })
  writeFileSync(counter, JSON.stringify({ prompt, blocks: blocks + 1 }))
}

const report = failure.timedOut
  ? `\`pnpm ${failure.name}\` did not finish: ${failure.why}, so the output below stops mid-run ` +
    `and names nothing.\n\n` +
    `${failure.output}\n\n` +
    `This is not a red stage. Either something hangs, or the stage has outgrown its budget in ` +
    `.claude/hooks/gate.mjs — time \`pnpm ${failure.name}\` by hand before assuming which. ` +
    `Set IR_SKIP_GATE=1 to suppress this gate.`
  : `Definition of done not met: \`pnpm ${failure.name}\` failed (${failure.why}).\n\n` +
    `${failure.output}\n\n` +
    `Fix this before finishing. If the failure predates your change, say so instead of working around it. ` +
    `Set IR_SKIP_GATE=1 to suppress this gate.`

if (cursorHook) {
  finish({ followup_message: report })
}

process.stderr.write(`${report}\n`)
process.exit(2)

// --- helpers -------------------------------------------------------------------------

function run() {
  for (const stage of STAGES) {
    try {
      execFileSync('pnpm', stage.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: stage.timeout,
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

      /*
       * A killed stage is not a failed one, and everything downstream reads it as one
       * unless this says otherwise.
       *
       * `execFileSync` SIGTERMs at its `timeout` and throws the same shape a non-zero
       * exit throws — `status` is null rather than a code, and `stdout` holds whatever
       * had been written when the axe fell. Under the dot reporter that is a row of
       * dots naming nothing, so the report read "`pnpm test` failed (vitest)" over a
       * green suite that had simply not finished, and the only honest fix — a bigger
       * budget — was the one thing the message gave no reason to reach for.
       */
      if (error.code === 'ETIMEDOUT') {
        return {
          ...stage,
          timedOut: true,
          why: `killed after ${stage.timeout / 1000}s`,
          output,
        }
      }
      return { ...stage, output }
    }
  }
  return null
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
