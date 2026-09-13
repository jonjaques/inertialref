import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { EvaluationBudget } from './budget.mjs'
import {
  interpretTourRequest,
  DIRECTOR_PROMPT_VERSION,
} from '../../apps/server/src/tour/director.ts'
import {
  DIRECTOR_MODELS,
  GuideProviderError,
} from '../../apps/server/src/tour/openaiResponses.ts'
import {
  TOUR_EVAL_REQUESTS,
  evaluationContext,
  gradeDecision,
} from './fixtures.mjs'

const { values } = parseArgs({
  options: {
    'allow-spend': { type: 'boolean', default: false },
    model: { type: 'string', default: 'gpt-6-astra' },
    repetitions: { type: 'string', default: '3' },
    limit: { type: 'string', default: '60' },
    'max-cost-usd': { type: 'string', default: '6' },
    out: { type: 'string', default: '.scratch/tour-evaluation' },
    'env-file': { type: 'string', default: '.env.local' },
    help: { type: 'boolean', default: false },
  },
})
if (values.help) {
  console.log(
    'node scripts/tour/evaluate.mjs --allow-spend --model=gpt-6-astra --repetitions=3 --max-cost-usd=6 --out=.scratch/tour-astra\nRuns paid director evaluations. Repeat unchanged with gpt-5.6-sol and gpt-5.6-terra. No scene actions execute. Every factual result still needs human review.',
  )
  process.exit(0)
}
if (!values['allow-spend'] || process.env.CI)
  throw new Error('Paid evaluation requires --allow-spend outside CI.')
if (!DIRECTOR_MODELS.includes(values.model))
  throw new Error(
    'Choose one of the three explicit director comparison models.',
  )
const repetitions = Number(values.repetitions)
const limit = Number(values.limit)
const budget = new EvaluationBudget(
  Number(values['max-cost-usd']),
  limit * repetitions * 2,
)
if (
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 3 ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 60
)
  throw new Error('Repetitions must be 1–3 and request limit 1–60.')
try {
  process.loadEnvFile(values['env-file'])
} catch (error) {
  if (error?.code !== 'ENOENT')
    throw new Error('Could not load the evaluation environment file.')
}
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('OPENAI_API_KEY is required on this machine.')
const directory = resolve(values.out)
await mkdir(directory, { recursive: true })
const context = evaluationContext()
const records = []
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
let budgetStopped = false
let providerRounds = []
const budgetedFetch = async (url, init) => {
  const request = JSON.parse(String(init.body))
  let ticket
  try {
    ticket = budget.reserve(request.model)
  } catch (error) {
    budgetStopped = true
    throw error
  }
  const started = process.hrtime.bigint()
  const round = {
    status: null,
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    proposal: null,
  }
  try {
    const response = await fetch(url, init)
    round.status = response.status
    if (response.ok) {
      try {
        const body = await response.clone().json()
        round.inputTokens = body.usage?.input_tokens ?? null
        round.outputTokens = body.usage?.output_tokens ?? null
        const text = (body.output ?? [])
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content ?? [])
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text)
          .join('')
        try {
          round.proposal = JSON.parse(text)
        } catch {}
      } catch {}
    }
    return response
  } finally {
    round.durationMs = Number(process.hrtime.bigint() - started) / 1e6
    ticket.settle(
      round.inputTokens === null || round.outputTokens === null
        ? null
        : { inputTokens: round.inputTokens, outputTokens: round.outputTokens },
    )
    providerRounds.push(round)
  }
}

for (
  let repetition = 1;
  repetition <= repetitions && !controller.signal.aborted && !budgetStopped;
  repetition++
) {
  for (const fixture of TOUR_EVAL_REQUESTS.slice(0, limit)) {
    if (controller.signal.aborted || budgetStopped) break
    providerRounds = []
    const started = process.hrtime.bigint()
    let record
    try {
      const decision = await interpretTourRequest({
        apiKey,
        text: fixture.text,
        context,
        priorGoal: fixture.priorGoal,
        signal: controller.signal,
        model: values.model,
        fetch: budgetedFetch,
      })
      record = {
        id: fixture.id,
        repetition,
        decision,
        grading: gradeDecision(fixture, decision, context),
        error: null,
      }
    } catch (error) {
      record = {
        id: fixture.id,
        repetition,
        decision: null,
        grading: null,
        error: budgetStopped
          ? 'budget-limit'
          : error instanceof GuideProviderError
            ? error.code
            : 'evaluation-error',
      }
    }
    record.providerRounds = providerRounds
    record.durationMs = Number(process.hrtime.bigint() - started) / 1e6
    records.push(record)
    await writeFile(
      resolve(directory, 'results.json'),
      JSON.stringify(
        {
          model: values.model,
          promptVersion: DIRECTOR_PROMPT_VERSION,
          fixtures: TOUR_EVAL_REQUESTS.slice(0, limit),
          context,
          records,
          budget: budget.snapshot(),
        },
        null,
        2,
      ),
    )
    console.log(
      `${fixture.id} repetition ${repetition}: ${record.error ?? (record.grading.intendedTask ? 'machine checks passed; human review pending' : record.grading.failures.join(', '))}`,
    )
  }
}
const completed = records.filter((record) => record.decision !== null)
const intended = records.filter((record) => record.grading?.intendedTask).length
const summary = {
  model: values.model,
  promptVersion: DIRECTOR_PROMPT_VERSION,
  requestedRuns: limit * repetitions,
  completedRuns: records.length,
  providerSuccesses: completed.length,
  intendedTaskSuccesses: intended,
  intendedTaskRate: records.length ? intended / records.length : 0,
  inputTokens: completed.reduce(
    (sum, record) => sum + record.decision.usage.inputTokens,
    0,
  ),
  outputTokens: completed.reduce(
    (sum, record) => sum + record.decision.usage.outputTokens,
    0,
  ),
  budget: budget.snapshot(),
  stopped: budgetStopped
    ? 'budget-limit'
    : controller.signal.aborted
      ? 'interrupted'
      : null,
  failedCallUsage:
    'Provider-round records retain reported usage even when semantic validation fails. Calls without final usage retain their full reservation in the budget estimate.',
  failures: records
    .filter((record) => record.error || !record.grading?.intendedTask)
    .map((record) => ({
      id: record.id,
      repetition: record.repetition,
      error: record.error,
      failures: record.grading?.failures ?? [],
    })),
  factualReview: 'pending',
  executedOperations: 0,
  releaseGate:
    'Not established until all runs finish, intended-task success is at least 95%, every factual result is reviewed, and coordinator/browser stale-operation tests pass.',
}
await writeFile(
  resolve(directory, 'summary.json'),
  JSON.stringify(summary, null, 2),
)
console.log(
  `Wrote ${records.length}/${limit * repetitions} runs to ${directory}. Factual review remains pending.`,
)
