/*
 * The steps `scripts/drive.mjs` runs, as a plan and an interpreter over a rig.
 *
 * `planSteps` turns `parseArgs`'s tokens into the ordered list; `runSteps`
 * walks it against a `rig` of `{ evaluate, sleep, now, read, capture, cast,
 * trace, sample, logs, reboot, say, warn }`. Chrome, the file system and the
 * clock all live in the rig, so `driveSteps.test.mjs` runs every step with a
 * fake one.
 */
import { silentCompletion } from './driveScript.mjs'

export const STEPS = new Set([
  'js',
  'file',
  'wait',
  'settle',
  'shot',
  'cast',
  'trace',
  'sample',
  'logs',
  'reload',
])

/*
 * `parseArgs` returns values as a map, which loses the interleaving — and the
 * interleaving is the whole point of a step list. `tokens: true` gives them
 * back in source order.
 *
 * The `--no-` filter is not defensive tidying. `allowNegative` is on for
 * `--no-serve`, but it applies to every boolean in `OPTIONS`, and two of the
 * steps are booleans: `--no-reload` parses to a token named `reload` and would
 * otherwise re-boot the page — the negation running the very step it denies.
 */
export const planSteps = (tokens) =>
  tokens
    .filter(
      (t) =>
        t.kind === 'option' &&
        STEPS.has(t.name) &&
        !String(t.rawName).startsWith('--no-'),
    )
    .map((t) => ({ step: t.name, arg: t.value }))

/** A step argument that has to be a number. `Number('soon')` is `NaN`, and a
 *  `NaN` reaches `setTimeout` as 0 — a `--wait` that silently does not wait. */
export const count = (arg, flag, least) => {
  const n = Number(arg)
  if (!Number.isFinite(n) || n < least)
    throw new Error(`--${flag} wants a number ≥ ${least}, not ${String(arg)}`)
  return n
}

/** The least argument each numeric step accepts. */
const LEAST = { wait: 0, settle: 0, sample: 1, trace: 100 }
const SCRIPTED = new Set(['sample', 'cast', 'settle'])

/** Every numeric step argument, checked before the dev server, Chrome and an
 *  six-second boot: a typo'd `--wait` should cost a line of output, not the
 *  whole start-up it sits behind. */
export function checkSteps(script, { userGesture, javascript }) {
  if (
    userGesture &&
    !script.some(({ step }) => step === 'js' || step === 'file')
  )
    throw new Error('--user-gesture needs a --js or --file step')
  for (const { step, arg } of script) {
    if (!javascript && SCRIPTED.has(step))
      throw new Error(`--${step} needs page scripts; omit --no-javascript`)
    if (step in LEAST) count(arg, step, LEAST[step])
  }
}

/**
 * Wait until `read` (an `ir.settled()` answer) is `ok` twice in a row, or the
 * budget runs out.
 *
 * Two quiet reads in a row, not one: the sky publishes its cubes tile by tile
 * and the streamer asks for another ring as the last one lands, so a single
 * `ok` can sit in the gap between two bursts. The budget is a guard against a
 * scene that never converges, and running out is reported rather than hidden —
 * a plate taken then is a plate of something still arriving, and the report
 * says which.
 */
export async function settle(budget, { read, sleep, now }) {
  const began = now()
  let quiet = 0
  let report = null
  for (;;) {
    report = await read()
    quiet = report?.ok ? quiet + 1 : 0
    if (quiet >= 2 || now() - began >= budget) break
    await sleep(250)
  }
  return { ms: Math.round(now() - began), settled: quiet >= 2, report }
}

const kb = (bytes) => (bytes / 1024).toFixed(0)
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)

/** One handler per step kind; each pushes one result and says what it found. */
const RUN = {
  async js({ step, arg }, rig) {
    const expression = step === 'file' ? await rig.read(arg) : String(arg)
    const value = await rig.evaluate(expression, rig.userGesture)
    const warning = silentCompletion(expression, value)
    if (warning !== null) rig.warn(warning)
    rig.say(`js: ${JSON.stringify(value ?? null)}`)
    return { step, value }
  },
  async wait({ step, arg }, rig) {
    const ms = count(arg, 'wait', 0)
    await rig.sleep(ms)
    return { step, ms }
  },
  async settle({ step, arg }, rig) {
    const { ms, settled, report } = await settle(count(arg, 'settle', 0), {
      read: () => rig.evaluate('ir.settled()'),
      sleep: rig.sleep,
      now: rig.now,
    })
    rig.say(
      settled
        ? `settle: converged after ${ms}ms`
        : `settle: still arriving after ${ms}ms — ${JSON.stringify(report)}`,
    )
    return { step, ms, settled, ...(report ?? {}) }
  },
  async reload({ step }, rig) {
    await rig.reboot()
    return { step }
  },
  async shot({ step, arg }, rig) {
    const shot = await rig.capture(String(arg))
    rig.say(`shot: ${shot.path} (${kb(shot.bytes)} KB)`)
    return { step, ...shot }
  },
  async cast({ step, arg }, rig) {
    const { result, lines } = await rig.cast(count(arg, 'cast', 2))
    for (const line of lines) rig.say(line)
    return { step, ...result }
  },
  async trace({ step, arg }, rig) {
    const trace = await rig.trace(count(arg, 'trace', 100))
    rig.say(
      `trace: ${trace.events} events, ${mb(trace.bytes)} MB -> ${trace.path}`,
    )
    rig.say(`  read it: node scripts/timing.mjs`)
    return { step, ...trace }
  },
  async sample({ step, arg }, rig) {
    const out = await rig.sample(count(arg, 'sample', 1))
    const spans = Object.entries(out.spans).map(([k, v]) => `${k} ${v}`)
    rig.say(`sample: ${out.frames} frames — ${spans.join(' | ')}`)
    return { step, ...out }
  },
  async logs({ step }, rig) {
    const lines = rig.logs()
    for (const line of lines) rig.say(`  ${line}`)
    return { step, lines }
  },
}
RUN.file = RUN.js

/** Every step in order, one result each. */
export async function runSteps(script, rig) {
  const results = []
  for (const entry of script) results.push(await RUN[entry.step](entry, rig))
  return results
}

/**
 * One reading per rAF from inside the page, and a per-field `min..max` over
 * the numeric and boolean fields. A `--js` call per frame would be a round
 * trip per frame, and the round trip is longer than the frame.
 */
export async function sampleFrames(evaluate, count, expression) {
  const samples = await evaluate(
    `const out = []
     await new Promise((done) => {
       const tick = () => {
         out.push(${expression})
         if (out.length < ${count}) requestAnimationFrame(tick)
         else done()
       }
       requestAnimationFrame(tick)
     })
     return out`,
  )
  const numeric = {}
  for (const s of samples)
    if (s !== null && typeof s === 'object')
      for (const [k, v] of Object.entries(s))
        if (typeof v === 'number' || typeof v === 'boolean')
          (numeric[k] ??= []).push(Number(v))
  const spans = Object.fromEntries(
    Object.entries(numeric).map(([k, v]) => [
      k,
      `${Math.min(...v)}..${Math.max(...v)}`,
    ]),
  )
  return { frames: samples.length, spans, samples }
}

/** What `--json` prints: every step result, and the page errors after them. */
export const jsonReport = (results, errors) =>
  `${JSON.stringify({ results, errors }, null, 2)}\n`
