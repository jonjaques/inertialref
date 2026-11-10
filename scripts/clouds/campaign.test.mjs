import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAMPAIGNS,
  INSTRUMENT_NAMES,
  captureTakesLever,
  child,
  eta,
  instrumentsText,
  minutesOf,
  notTaken,
  outcome,
  ours,
  owner,
  planText,
  resumeRefusal,
  resumed,
  stopper,
  strays,
  summarize,
} from './campaign.mjs'
import {
  FAILS,
  HELD,
  NoQuietStart,
  batchRuns,
  parseOptions,
  resumeFrom,
  withFailure,
} from './measure.mjs'
import { rateNote } from './page.mjs'

/*
 * What lets a batch outlast its watcher, without a browser: which runs a
 * continued document still owes and which documents it refuses, what a
 * stage's exit means, and when a campaign ends.
 */

const SIZES = ['1080p', 'retina']
const HEAD = 'a'.repeat(40)
const runs = batchRuns('ladders', SIZES)
const want = { batch: 'ladders', head: HEAD, sizes: SIZES, held: HELD, runs }
const row = (id, ok) => ({ id, scene: { settled: true }, quiet: { ok } })
const doc = (over = {}) => ({
  batch: 'ladders',
  identity: { head: HEAD },
  sizes: SIZES,
  held: HELD,
  rows: [],
  failures: [],
  ...over,
})

describe('a continued document', () => {
  it('owes every run it holds no quiet row of, in the batch’s order', () => {
    const [first, second, third] = runs.map((r) => r.id)
    const { runs: todo, refusal } = resumeFrom(
      doc({ rows: [row(first, true), row(second, false), row(third, true)] }),
      want,
    )
    expect(refusal).toBeNull()
    expect(todo.map((r) => r.id)).toEqual(
      runs.map((r) => r.id).filter((id) => id !== first && id !== third),
    )
    expect(resumeFrom(doc(), want).runs).toEqual(runs)
  })

  it('owes a run whose quiet row is refused, empty or taken on a scene still building', () => {
    const [first, second, third, fourth] = runs.map((r) => r.id)
    const captured = { name: '64 against 96', relative: 0.004, floor: 0.001 }
    const radiance = (id, over, differences = [captured]) => ({
      ...row(id, true),
      type: 'radiance',
      differences,
      ...over,
    })
    const rows = [
      radiance(first, {}),
      // `ir.cloudRadiance()` answered null for a side.
      radiance(second, {}, [{ ...captured, relative: null, floor: null }]),
      // drive.mjs's settle gave up at 30 s.
      radiance(third, { scene: { settled: false, ok: false } }),
      // Taken again, and it stands.
      radiance(fourth, { scene: { settled: false, ok: false } }),
      radiance(fourth, {}),
    ]
    const { runs: todo, refusal } = resumeFrom(doc({ rows }), want)
    expect(refusal).toBeNull()
    expect(todo.map((r) => r.id)).toEqual(
      runs.map((r) => r.id).filter((id) => id !== first && id !== fourth),
    )
  })

  it('refuses one of another batch, commit, list of sizes or held jitter', () => {
    for (const [over, says] of [
      [{ batch: 'targets' }, /of targets, not ladders/],
      [{ identity: { head: 'b'.repeat(40) } }, /measured at bbbbbbbbbbbb/],
      [{ identity: undefined }, /measured at no commit/],
      [{ sizes: ['retina'] }, /sizes retina, not 1080p,retina/],
      [{ sizes: undefined }, /nobody recorded/],
      [{ held: { jitterFrame: 5 } }, /jitter at 5, not 0/],
    ]) {
      const { runs: todo, refusal } = resumeFrom(doc(over), want)
      expect(refusal, JSON.stringify(over)).toMatch(says)
      expect(todo).toEqual([])
    }
  })

  it(`refuses once a run it owes has failed ${FAILS} times, naming the last error`, () => {
    const id = runs[1].id
    const failures = Array.from({ length: FAILS }, (_, i) => ({
      id,
      error: `hung ${i}`,
    }))
    expect(resumeFrom(doc({ failures }), want).refusal).toBe(
      `${id} has failed ${FAILS} times, last: hung ${FAILS - 1}`,
    )
    // Fewer, or failures of a run since measured quiet, refuse nothing.
    expect(
      resumeFrom(doc({ failures: failures.slice(1) }), want).refusal,
    ).toBeNull()
    expect(
      resumeFrom(doc({ failures, rows: [row(id, true)] }), want).refusal,
    ).toBeNull()
  })

  it('counts no failure against a run a busy machine never let begin', () => {
    const run = runs[1]
    // Three ten-minute waits through somebody's dev server, then a fourth.
    let held = doc()
    for (let i = 0; i < FAILS + 1; i += 1)
      held = withFailure(
        held,
        run,
        new NoQuietStart('no quiet start in ten minutes: vite (pid 1)'),
        `t${i}`,
      )
    expect(held.failures).toEqual([])
    expect(resumeFrom(held, want)).toEqual({ runs, refusal: null })
    // A run that began and failed still counts.
    expect(
      withFailure(held, run, new Error('drive.mjs exited 1'), 't').failures,
    ).toEqual([{ id: run.id, at: 't', error: 'drive.mjs exited 1' }])
  })

  it('is named on the command line, which keeps the sizes it was asked for', () => {
    const options = parseOptions([
      '--batch',
      'ladders',
      '--sizes',
      'retina',
      '--resume',
      '.data/clouds/images.json',
    ])
    expect(options.resume).toMatch(/^\/.*\/\.data\/clouds\/images\.json$/)
    expect(options.sizes).toEqual(['retina'])
    expect(parseOptions(['--batch', 'ladders']).resume).toBeNull()
  })
})

describe('a campaign', () => {
  const stage = (over) => ({
    kind: 'batch',
    attempts: 1,
    allowed: 3,
    minutes: 60,
    status: 'pending',
    done: 0,
    total: 10,
    ...over,
  })

  it('continues a stopped batch, stops on a refusal, and retries no further than allowed', () => {
    expect(outcome(stage({ done: 10 }), 0)).toBe('done')
    expect(outcome(stage(), 1)).toBe('retry')
    expect(outcome(stage(), 2)).toBe('stop')
    expect(outcome(stage({ attempts: 3 }), 1)).toBe('stop')
    // Any other command's 2 is a failure like another.
    expect(outcome(stage({ kind: 'command' }), 2)).toBe('retry')
  })

  it('continues a batch that exits 0 still owing runs it marked under load', () => {
    // Three rows ended under load on all three tries: 75 of 78 quiet.
    expect(outcome(stage({ done: 75, total: 78 }), 0)).toBe('retry')
    expect(outcome(stage({ done: 75, total: 78, attempts: 3 }), 0)).toBe('stop')
    expect(outcome(stage({ done: 78, total: 78 }), 0)).toBe('done')
    // A command's exit is all there is to read of it.
    expect(outcome(stage({ kind: 'command', total: null }), 0)).toBe('done')
  })

  it('writes its summary when a batch’s document does not parse', () => {
    // The runner rewrites a document whole and not atomically, and the
    // summary is written in `run`'s `finally`, after the measuring is over.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clouds-campaign-'))
    try {
      const torn = path.join(dir, 'targets.json')
      writeFileSync(torn, '{"batch": "targets", "rows": [{"id": "targ')
      const state = {
        name: 'landed',
        head: HEAD,
        status: 'done',
        reason: null,
        startedAt: '2026-11-10T09:05:32Z',
        finishedAt: '2026-11-10T10:21:00Z',
        summary: path.join(dir, 'landed.md'),
        stages: [
          {
            name: 'targets',
            kind: 'batch',
            status: 'done',
            attempts: 1,
            file: torn,
            done: 58,
            total: 58,
          },
        ],
      }
      summarize(state)
      expect(readFileSync(state.summary, 'utf8')).toMatch(
        /targets\.json` did not parse when this summary was written/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is resumed only at the commit it was of', () => {
    const was = { name: 'choices', head: HEAD }
    expect(resumeRefusal('choices', was, HEAD)).toBeNull()
    expect(resumeRefusal('choices', was, 'b'.repeat(40))).toBe(
      'campaign choices was of aaaaaaaaaaaa, and HEAD is bbbbbbbbbbbb; check out its commit to resume it',
    )
    expect(resumeRefusal('choices', null, HEAD)).toBe(
      'no campaign choices to resume',
    )
  })

  it('launches nothing once it has been told to stop', async () => {
    // SIGTERM while the loop awaited the preview's check: no child to kill.
    const ctx = { current: null, stop: new AbortController() }
    ctx.stop.abort()
    const launched = []
    const result = await child(['node', 'measure.mjs'], {}, ctx, (...a) => {
      launched.push(a)
      throw new Error('spawned after the stop')
    })
    expect(launched).toEqual([])
    expect(result.code).not.toBe(0)
    expect(ctx.current).toBeNull()
  })

  it('ends at the running batch’s own rate, then each later stage’s estimate', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    const running = stage({
      status: 'running',
      startedAt: '2026-11-09T11:00:00Z',
      from: 2,
      done: 6,
    })
    // Four rows in an hour, four to go; then 60 minutes, a quarter measured.
    expect(
      eta(
        [stage({ status: 'done' }), running, stage({ done: 4, total: 16 })],
        now,
      ) - now,
    ).toBe(60 * 60_000 + 45 * 60_000)
    // Before a row lands, a running stage is its estimate too.
    expect(eta([stage({ status: 'running', from: 0 })], now) - now).toBe(
      60 * 60_000,
    )
  })

  it('names only batches the runner has, in the order §7.2 runs them', () => {
    expect(
      Object.fromEntries(
        Object.entries(CAMPAIGNS).map(([name, c]) => [
          name,
          c.stages.map((s) => s.name),
        ]),
      ),
    ).toEqual({
      choices: [
        'pacing',
        'phase',
        'jitter',
        'handover',
        'clip',
        'transport',
        'casts',
        'instruments',
        'over',
        'reset',
        'sun',
        'sun-casts',
      ],
      landed: [
        'pacing',
        'ladders',
        'targets',
        'frame',
        'sequences',
        'warp',
        'hold',
        'pace',
        'memory',
        'error',
      ],
      'pace-study': ['study'],
    })
    for (const s of Object.values(CAMPAIGNS).flatMap((c) => c.stages))
      if (s.kind === 'batch')
        expect(batchRuns(s.name, SIZES).length).toBeGreaterThan(0)
  })

  it('checks its own pacing before its first batch measures anything', () => {
    for (const c of Object.values(CAMPAIGNS).filter((c) => c.stages.length > 1))
      expect(c.stages[0].name).toBe('pacing')
    // The hold's acceptance comes before the batch that needs it.
    const landed = CAMPAIGNS.landed.stages.map((s) => s.name)
    expect(landed.indexOf('hold')).toBeLessThan(landed.indexOf('pace'))
  })

  it('takes a stage only where it can be taken, and says why not', () => {
    const state = (over = {}) => ({
      name: 'choices',
      options: {},
      hold: null,
      ...over,
    })
    const tools = { lever: () => false, exists: () => true }
    const spec = (name, campaign = 'choices') =>
      CAMPAIGNS[campaign].stages.find((s) => s.name === name)
    expect(notTaken(spec('transport'), state(), tools)).toBe(
      'taken only when the campaign is started with --transport',
    )
    expect(
      notTaken(
        spec('transport'),
        state({ options: { transport: true } }),
        tools,
      ),
    ).toBeNull()
    // The casts need the capture to take a lever's value, which it does not yet.
    expect(notTaken(spec('casts'), state(), tools)).toMatch(/takes no --lever/)
    expect(
      notTaken(spec('casts'), state(), { ...tools, lever: () => true }),
    ).toBeNull()
    expect(
      captureTakesLever(() => {
        throw new Error("Unknown option '--lever'")
      }),
    ).toBe(false)
    expect(captureTakesLever(() => ({}))).toBe(true)
    // The instruments take the ones on disk, and are not taken with none.
    expect(
      notTaken(spec('instruments'), state(), { ...tools, exists: () => false }),
    ).toMatch(/none of cloudCumulus/)
    expect(notTaken(spec('instruments'), state(), tools)).toBeNull()
    // A batch that records at no hold is taken; one that requires it is not.
    expect(notTaken(spec('pace', 'landed'), state(), tools)).toBeNull()
    const requires = { name: 'casts', kind: 'command', hold: 'require' }
    const failed = {
      accepted: false,
      figures: ['118.2, 119.0, 118.7 Hz, held by none'],
    }
    expect(notTaken(requires, state({ hold: failed }), tools)).toBe(
      'the 60 Hz hold was not accepted: 118.2, 119.0, 118.7 Hz, held by none',
    )
    expect(
      notTaken(requires, state({ hold: { accepted: true } }), tools),
    ).toBeNull()
  })

  it('names the instruments it runs, and the packages that bring the rest', () => {
    const today = new Set([
      'cloudFarCompare',
      'cloudSunAccuracy',
      'cloudCompositeError',
    ])
    expect(
      instrumentsText(INSTRUMENT_NAMES, (file) =>
        today.has(path.basename(file, '.gpu.test.ts')),
      ),
    ).toBe(
      'runs cloudFarCompare, cloudSunAccuracy, cloudCompositeError; not in the tree yet: cloudCumulus (package N), cloudGlory (package M2), cloudHandover (package X), cloudPathTrace (package R2)',
    )
  })

  it('keeps every stage’s attempts across a resume', () => {
    const state = {
      stages: [
        { name: 'pacing', status: 'done', attempts: 1 },
        { name: 'ladders', status: 'failed', attempts: 8 },
        { name: 'targets', status: 'pending', attempts: 0 },
      ],
    }
    expect(resumed(state).stages).toEqual([
      { name: 'pacing', status: 'done', attempts: 1 },
      { name: 'ladders', status: 'pending', attempts: 8 },
      { name: 'targets', status: 'pending', attempts: 0 },
    ])
  })

  it('passes one stop to its stage, and lets a second wait for the first', () => {
    const killed = []
    const ctx = { current: { pid: 4242 }, stop: new AbortController() }
    const stop = stopper(ctx, (proc, signal) => killed.push([proc.pid, signal]))
    stop('SIGTERM')
    // The runner is closing its rigs and releasing the lock: a second
    // SIGTERM there would kill it mid-close and orphan Chrome with the lock.
    stop('SIGTERM')
    stop('SIGINT')
    expect(killed).toEqual([[4242, 'SIGTERM']])
    expect(ctx.stop.signal.aborted).toBe(true)
  })

  it('plans every batch of both campaigns and the study, a row with its seconds', () => {
    for (const name of ['choices', 'landed', 'pace-study']) {
      const text = planText(name)
      expect(text).toMatch(
        new RegExp(`campaign ${name}: about [\\d.]+ (min|h) before any resume`),
      )
      for (const stage of CAMPAIGNS[name].stages)
        expect(text, `${name} ${stage.name}`).toMatch(
          new RegExp(`## ${stage.name}: `),
        )
      // Every row prints its stance, lens and levers and what it costs.
      const rows = text.split('\n').filter((l) => /~\d+ s$/.test(l))
      expect(rows.length).toBeGreaterThan(0)
      const details = text.split('\n').filter((l) => l.startsWith('  stance '))
      expect(details).toHaveLength(rows.length)
      for (const line of details)
        expect(line).toMatch(/; lens .+; levers [0-9a-f]{8} /)
    }
    // A stage's minutes are its rows' seconds, not a guess.
    expect(minutesOf({ name: 'targets', kind: 'batch' })).toBeGreaterThan(30)
  })
})

describe('the preview a campaign serves', () => {
  // pnpm (100) runs cf (110, its own group) and workerd (111) under it;
  // another worktree's dev server (200) answers the same port.
  const table = [
    {
      pid: 100,
      ppid: 50,
      command: 'pnpm --filter @inertialref/server exec cf dev',
    },
    { pid: 110, ppid: 100, command: 'cf dev' },
    { pid: 111, ppid: 110, command: 'workerd serve' },
    { pid: 200, ppid: 60, command: 'node vite' },
  ]
  const cf = { pid: 110, group: 110 }
  const workerd = { pid: 111, group: 110 }
  const theirs = { pid: 200, group: 200 }

  it('is the listener that descends from the process it spawned, and no other', () => {
    expect(ours(table, [cf, workerd], 100)).toEqual([cf, workerd])
    expect(ours(table, [theirs], 100)).toEqual([])
    expect(ours(table, [theirs, cf], 100)).toEqual([cf])
    // A listener whose parent is gone is nobody's descendant.
    expect(ours([], [cf], 100)).toEqual([])
  })

  it('is measured only while every listener on the port is its own', () => {
    expect(owner(table, [], 100)).toEqual({ up: false })
    expect(owner(table, [cf, workerd], 100)).toMatchObject({ ours: true })
    // Another tree's server answered first, during the build or after ours died.
    expect(owner(table, [theirs], 100)).toMatchObject({
      up: true,
      ours: false,
      why: expect.stringMatching(/pid 200 .* not the preview/),
    })
    // One on IPv4 and one on IPv6: localhost may reach either.
    expect(owner(table, [cf, theirs], 100)).toMatchObject({ ours: false })
    // Orphaned by a stopped pnpm, ours by what serving saw.
    expect(owner([], [cf, workerd], 999, [cf])).toMatchObject({ ours: true })
  })

  it('is stopped by the groups it was seen to hold, and nothing else on the port is', () => {
    // pnpm gone, cf and workerd orphaned: still ours by what serving recorded.
    expect(strays([cf, workerd], [cf, workerd])).toEqual([110])
    // Ours gone, another tree's server on the port: not this campaign's.
    expect(strays([theirs], [cf, workerd])).toEqual([])
    expect(strays([theirs, workerd], [cf])).toEqual([110])
  })
})

describe('a batch’s presentation rates', () => {
  // Each row its own run unless an id is given: a retry is a row of one id.
  const at = (scenario, size, hz, id = `${scenario}/${size}/${hz}`) => ({
    id,
    scenario,
    size,
    operatingPoint: { presentHz: hz },
  })

  it('name each size’s range, and every scenario whose rows were taken at two rates', () => {
    // Retina's stances differ by their own load, which is one operating point.
    expect(
      rateNote([
        at('ground', '1080p', 117),
        at('ground', '1080p', 119),
        at('inside', 'retina', 65),
        at('orbit', 'retina', 78),
      ]),
    ).toBe('1080p: presented at 117–119 Hz.\nretina: presented at 65–78 Hz.')
    expect(
      rateNote([at('horizon', '1080p', 60), at('horizon', '1080p', 118)]),
    ).toBe(
      '1080p: presented at 60–118 Hz.\n1080p horizon: rows at 60–118 Hz are two operating points, not one.',
    )
    expect(rateNote([at('ground', '1080p', null)])).toBe(
      'No row recorded the rate it presented at.',
    )
  })

  it('read the attempt each table shows, not the ones it replaced', () => {
    // Measured at 60 Hz under load, then again quiet at 118: one run.
    const id = 'targets/landed/landed/horizon/1080p/steady'
    expect(
      rateNote([
        at('horizon', '1080p', 60, id),
        at('horizon', '1080p', 118, id),
      ]),
    ).toBe('1080p: presented at 118–118 Hz.')
  })
})
