import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  checkSteps,
  jsonReport,
  planSteps,
  runSteps,
  sampleFrames,
  settle,
} from './driveSteps.mjs'

/** The step options of `drive.mjs`'s `OPTIONS`, and one session flag. */
const OPTIONS = {
  serve: { type: 'boolean', default: true },
  js: { type: 'string', multiple: true },
  file: { type: 'string', multiple: true },
  wait: { type: 'string', multiple: true },
  settle: { type: 'string', multiple: true },
  shot: { type: 'string', multiple: true },
  sample: { type: 'string', multiple: true },
  cast: { type: 'string', multiple: true },
  trace: { type: 'string', multiple: true },
  logs: { type: 'boolean', multiple: true },
  reload: { type: 'boolean', multiple: true },
}

const plan = (...args) =>
  planSteps(
    parseArgs({ args, options: OPTIONS, tokens: true, allowNegative: true })
      .tokens,
  )

/** `ir.settled()` answers in order, then the last one forever, on a clock
 *  that only `sleep` advances. */
const scripted = (answers) => {
  let t = 0
  let i = 0
  return {
    read: async () => answers[Math.min(i++, answers.length - 1)],
    sleep: async (ms) => {
      t += ms
    },
    now: () => t,
    reads: () => i,
  }
}

const OK = { ok: true }
const PENDING = { ok: false, sky: 3 }

describe('planSteps', () => {
  it('keeps the interleaving the command line was written in', () => {
    expect(plan('--js', 'a', '--wait', '1', '--js', 'b')).toEqual([
      { step: 'js', arg: 'a' },
      { step: 'wait', arg: '1' },
      { step: 'js', arg: 'b' },
    ])
  })

  it('drops session flags and a negated step', () => {
    expect(plan('--no-serve', '--logs', '--no-reload', '--reload')).toEqual([
      { step: 'logs', arg: undefined },
      { step: 'reload', arg: undefined },
    ])
  })
})

describe('checkSteps', () => {
  const page = { userGesture: false, javascript: true }

  it('refuses a non-numeric or too-small argument before anything starts', () => {
    expect(() => checkSteps(plan('--wait', 'soon'), page)).toThrow(
      '--wait wants a number ≥ 0, not soon',
    )
    expect(() => checkSteps(plan('--sample', '0'), page)).toThrow(
      '--sample wants a number ≥ 1',
    )
    expect(() => checkSteps(plan('--trace', '99'), page)).toThrow(
      '--trace wants a number ≥ 100',
    )
    expect(() => checkSteps(plan('--settle', '8000'), page)).not.toThrow()
  })

  it('refuses a user gesture with no script step to give it to', () => {
    expect(() =>
      checkSteps(plan('--wait', '1'), { ...page, userGesture: true }),
    ).toThrow('--user-gesture needs a --js or --file step')
    expect(() =>
      checkSteps(plan('--file', 'a.js'), { ...page, userGesture: true }),
    ).not.toThrow()
  })

  it('refuses the in-page steps with scripts disabled', () => {
    for (const step of ['--settle', '--sample', '--cast'])
      expect(() =>
        checkSteps(plan(step, '10'), { ...page, javascript: false }),
      ).toThrow(`${step} needs page scripts`)
    expect(() =>
      checkSteps(plan('--js', 'document.title'), {
        ...page,
        javascript: false,
      }),
    ).not.toThrow()
  })
})

describe('settle', () => {
  it('converges on the first two consecutive ok answers', async () => {
    const rig = scripted([PENDING, OK, PENDING, OK, OK, PENDING])
    const out = await settle(10_000, rig)
    expect(out).toEqual({ ms: 1000, settled: true, report: OK })
    expect(rig.reads()).toBe(5)
  })

  it('does not converge on one ok', async () => {
    const rig = scripted([OK, PENDING])
    const out = await settle(1000, rig)
    expect(out.settled).toBe(false)
    expect(out.report).toEqual(PENDING)
  })

  it('reports settled: false and the last report when the budget runs out', async () => {
    const rig = scripted([PENDING])
    const out = await settle(1000, rig)
    expect(out).toEqual({ ms: 1000, settled: false, report: PENDING })
    // Read at 0, 250, 500, 750 and 1000 ms: the budget is checked after a read.
    expect(rig.reads()).toBe(5)
  })

  it('reads once and stops with a zero budget', async () => {
    const rig = scripted([OK])
    expect(await settle(0, rig)).toEqual({ ms: 0, settled: false, report: OK })
  })
})

/** A rig whose every member records its call and answers a fixed value. */
const fakeRig = (settled = [OK]) => {
  const calls = []
  const said = []
  const warned = []
  const clock = scripted(settled)
  return {
    calls,
    said,
    warned,
    userGesture: true,
    evaluate: async (expression, gesture) => {
      calls.push(['evaluate', expression, gesture])
      return expression === 'ir.settled()' ? clock.read() : 7
    },
    sleep: async (ms) => {
      calls.push(['sleep', ms])
      await clock.sleep(ms)
    },
    now: clock.now,
    read: async (file) => `return '${file}'`,
    capture: async (target) => ({ path: `.data/drive/${target}`, bytes: 2048 }),
    cast: async (n) => ({
      result: { dir: '.data/drive/cast', frames: n },
      lines: [`cast: ${n} frames`],
    }),
    trace: async (ms) => ({
      path: '.data/drive/trace.json',
      events: ms,
      bytes: 1 << 20,
    }),
    sample: async (n) => ({ frames: n, spans: { tiles: '1..4' }, samples: [] }),
    logs: () => ['log: hello'],
    reboot: async () => calls.push(['reboot']),
    say: (line) => said.push(line),
    warn: (line) => warned.push(line),
  }
}

describe('runSteps', () => {
  it('pushes one result per step, in order', async () => {
    const script = plan(
      '--js',
      'ir.status()',
      '--file',
      'probe.js',
      '--wait',
      '5',
      '--settle',
      '1000',
      '--shot',
      'a.jpg',
      '--cast',
      '3',
      '--trace',
      '200',
      '--sample',
      '4',
      '--logs',
      '--reload',
    )
    const rig = fakeRig([OK, OK])
    const results = await runSteps(script, rig)
    expect(results.map((r) => r.step)).toEqual(script.map((s) => s.step))
    expect(results).toEqual([
      { step: 'js', value: 7 },
      { step: 'file', value: 7 },
      { step: 'wait', ms: 5 },
      { step: 'settle', ms: 250, settled: true, ok: true },
      { step: 'shot', path: '.data/drive/a.jpg', bytes: 2048 },
      { step: 'cast', dir: '.data/drive/cast', frames: 3 },
      {
        step: 'trace',
        path: '.data/drive/trace.json',
        events: 200,
        bytes: 1 << 20,
      },
      { step: 'sample', frames: 4, spans: { tiles: '1..4' }, samples: [] },
      { step: 'logs', lines: ['log: hello'] },
      { step: 'reload' },
    ])
    expect(rig.said).toEqual([
      'js: 7',
      'js: 7',
      'settle: converged after 250ms',
      'shot: .data/drive/a.jpg (2 KB)',
      'cast: 3 frames',
      'trace: 200 events, 1.0 MB -> .data/drive/trace.json',
      '  read it: node scripts/timing.mjs',
      'sample: 4 frames — tiles 1..4',
      '  log: hello',
    ])
  })

  it('gives the user gesture to script steps only', async () => {
    const rig = fakeRig([OK, OK])
    await runSteps(plan('--js', 'a', '--file', 'b.js', '--settle', '9'), rig)
    const evaluations = rig.calls.filter(([kind]) => kind === 'evaluate')
    expect(evaluations[0]).toEqual(['evaluate', 'a', true])
    expect(evaluations[1]).toEqual(['evaluate', "return 'b.js'", true])
    expect(evaluations[2]).toEqual(['evaluate', 'ir.settled()', undefined])
  })

  it('says what was still arriving when a settle runs out', async () => {
    const rig = fakeRig([PENDING])
    const [result] = await runSteps(plan('--settle', '500'), rig)
    expect(result).toEqual({
      step: 'settle',
      ms: 500,
      settled: false,
      ...PENDING,
    })
    expect(rig.said).toEqual([
      `settle: still arriving after 500ms — ${JSON.stringify(PENDING)}`,
    ])
  })

  it('warns on a script whose completion value is silently lost', async () => {
    const rig = fakeRig()
    rig.evaluate = async () => undefined
    await runSteps(plan('--js', '(() => { 1 })();'), rig)
    expect(rig.warned).toHaveLength(1)
    expect(rig.said).toEqual(['js: null'])
  })

  it('refuses a malformed argument when the step is reached', async () => {
    await expect(runSteps(plan('--cast', '1'), fakeRig())).rejects.toThrow(
      '--cast wants a number ≥ 2, not 1',
    )
  })
})

describe('sampleFrames', () => {
  it('summarizes the numeric and boolean fields per frame', async () => {
    const evaluate = async (expression) => {
      expect(expression).toContain('out.push(ir.terrain())')
      expect(expression).toContain('out.length < 3')
      return [
        { tiles: 4, busy: true, name: 'a' },
        { tiles: 2, busy: false },
        null,
      ]
    }
    expect(await sampleFrames(evaluate, 3, 'ir.terrain()')).toEqual({
      frames: 3,
      spans: { tiles: '2..4', busy: '0..1' },
      samples: [
        { tiles: 4, busy: true, name: 'a' },
        { tiles: 2, busy: false },
        null,
      ],
    })
  })
})

describe('jsonReport', () => {
  it('is the results and the trailing errors, as one object', () => {
    const results = [{ step: 'wait', ms: 1 }]
    const errors = ['exception: boom']
    const text = jsonReport(results, errors)
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ results, errors })
  })
})
