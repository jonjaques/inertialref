import { describe, expect, it } from 'vitest'
import { CAMPAIGNS, eta, outcome } from './campaign.mjs'
import { FAILS, HELD, batchRuns, parseOptions, resumeFrom } from './measure.mjs'

/*
 * What lets a batch outlast its watcher, without a browser: which runs a
 * continued document still owes and which documents it refuses, what a
 * stage's exit means, and when a campaign ends.
 */

const SIZES = ['1080p', 'retina']
const HEAD = 'a'.repeat(40)
const runs = batchRuns('sweep', SIZES)
const want = { batch: 'sweep', head: HEAD, sizes: SIZES, held: HELD, runs }
const row = (id, ok) => ({ id, quiet: { ok } })
const doc = (over = {}) => ({
  batch: 'sweep',
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

  it('refuses one of another batch, commit, list of sizes or held jitter', () => {
    for (const [over, says] of [
      [{ batch: 'images' }, /of images, not sweep/],
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

  it('is named on the command line, which keeps the sizes it was asked for', () => {
    const options = parseOptions([
      '--batch',
      'sweep',
      '--sizes',
      'retina',
      '--resume',
      '.data/clouds/sweep.json',
    ])
    expect(options.resume).toMatch(/^\/.*\/\.data\/clouds\/sweep\.json$/)
    expect(options.sizes).toEqual(['retina'])
    expect(parseOptions(['--batch', 'sweep']).resume).toBeNull()
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
    expect(outcome(stage(), 0)).toBe('done')
    expect(outcome(stage(), 1)).toBe('retry')
    expect(outcome(stage(), 2)).toBe('stop')
    expect(outcome(stage({ attempts: 3 }), 1)).toBe('stop')
    // Any other command's 2 is a failure like another.
    expect(outcome(stage({ kind: 'command' }), 2)).toBe('retry')
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

  it('names only batches the runner has, in the order §8.8 runs them', () => {
    expect(
      Object.values(CAMPAIGNS).map((c) => c.stages.map((s) => s.name)),
    ).toEqual([
      ['sweep', 'images', 'instruments'],
      ['targets', 'memory', 'error'],
    ])
    for (const s of Object.values(CAMPAIGNS).flatMap((c) => c.stages))
      if (s.kind === 'batch')
        expect(batchRuns(s.name, SIZES).length).toBeGreaterThan(0)
  })
})
