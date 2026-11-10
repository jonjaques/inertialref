import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { wrap } from '../driveScript.mjs'
import { batchRuns } from './measure.mjs'
import { figures, plan, unfit } from './page.mjs'
import {
  CAPS,
  SEQUENCE_FRAMES,
  readSequence,
  sequenceTable,
} from './sequence.mjs'

/*
 * The `sequence` step without a browser: an event, the frames after it read
 * one `ir.passes(1)` at a time, and the frame the field is whole again.
 */

const SIZES = ['1080p', 'retina']

/**
 * A page whose frame costs 6 ms with the clouds off and 10 with them on, 18
 * on a frame forced to reset, and 12 for each frame after a reset until the
 * field is whole, `whole` frames later.
 */
function fakePage({ whole = 30 } = {}) {
  let levers = { on: false }
  let since = 1000
  const calls = { visits: [], levers: [] }
  const engine = {
    set clouds(next) {
      calls.levers.push(next)
      if (next.force !== 'none' && next.force !== undefined) since = -1
      else if (levers.weather !== undefined && next.weather !== levers.weather)
        since = -1
      levers = next
    },
  }
  const frameCost = () => {
    if (!levers.on) return 6
    if (since === 0) return 18
    return since < whole ? 12 : 10
  }
  const ir = {
    clouds: () => ({
      settle: { pending: levers.on && since < whole },
      regime: since === 0 ? 'immediate' : 'converging',
      sinceReset: since,
    }),
    passes: async () => {
      since += 1
      const total = frameCost()
      return {
        dropped: 0,
        passes: [
          { label: 'scene', ms: total - 2 },
          { label: 'cloud trace', ms: 2 },
        ],
      }
    },
    visit: (address, options) => {
      calls.visits.push(options.height)
      since = -1
    },
  }
  const context = vm.createContext({
    engine,
    ir,
    requestAnimationFrame: (callback) =>
      setImmediate(() => {
        since += 1
        callback()
      }),
  })
  return { context, calls }
}

async function send(page, run, tag) {
  const planned = plan(run, {})
  const install = planned.find((s) => s.tag === 'install:kind')
  vm.runInContext(wrap(install.args[1]), page.context)
  const step = planned.find((s) => s.tag === tag)
  return await vm.runInContext(wrap(step.args[1]), page.context)
}

describe('the reset batches', () => {
  it('take every pair of caps on horizon at both sizes, four events each', () => {
    const runs = batchRuns('reset', SIZES)
    expect(runs).toHaveLength(CAPS.sunSlices.length * CAPS.farBlocks.length * 2)
    for (const r of runs) {
      expect(r.scenario).toBe('horizon')
      expect(r.levers.sunRamp).toBe(16)
      expect(r.events.map((e) => e.kind)).toEqual([
        'cut',
        'scrub',
        'weather',
        'wake',
      ])
    }
    const wake = runs[0].events[3]
    expect([wake.from.height, wake.to.height]).toEqual([400_000, 2])
    // Landed: the four at the commit's own caps.
    expect(batchRuns('sequences', SIZES)).toHaveLength(2)
  })
})

describe('the sequence step', () => {
  const run = batchRuns('reset', ['1080p'])[0]

  it('reads a forced event’s frame, the frames after it, and the frame the field is whole', async () => {
    const page = fakePage({ whole: 30 })
    const read = readSequence(
      { kind: 'cut' },
      await send(page, run, 'sequence:cut'),
    )
    expect(read.frames).toHaveLength(SEQUENCE_FRAMES)
    // Off 6, steady 10: a steady Δ of 4; the event 18, so 8 over it.
    expect(read.steadyDelta).toBe(4)
    expect(read.eventOver).toBe(8)
    expect(read.laterOver).toBe(2)
    expect(read.wholeAt).toBe(30)
    // The force lasted the event's frame alone.
    const forced = page.calls.levers.filter((l) => l.force === 'cut')
    expect(forced).toHaveLength(1)
    expect(page.calls.levers.at(-1).force).toBe('none')
  })

  it('wakes from orbit over the stance and comes back in one frame', async () => {
    const page = fakePage()
    await send(page, run, 'sequence:wake')
    expect(page.calls.visits).toEqual([400_000, 2])
  })

  it('says the field was never whole where the last frame still owes it', () => {
    const value = {
      off: [{ total: 6 }],
      steady: [{ total: 10 }],
      after: [
        { total: 18, whole: false },
        { total: 12, whole: false },
      ],
    }
    expect(readSequence({ kind: 'scrub' }, value).wholeAt).toBeNull()
    expect(readSequence({ kind: 'scrub' }, null).frames).toBeNull()
  })

  it('stands a row only with every sequence read, and prints one line each', () => {
    const steps = plan(run, {})
    const after = Array.from({ length: SEQUENCE_FRAMES }, (_, i) => ({
      total: i === 0 ? 18 : 10,
      whole: i >= 20,
    }))
    const out = {
      results: steps.map((s) =>
        s.tag === 'settle'
          ? { settled: true }
          : s.tag === 'stance'
            ? { value: { lens: { focalLength: run.lens } } }
            : s.tag.startsWith('sequence:')
              ? {
                  value: {
                    off: [{ total: 6 }],
                    steady: [{ total: 10 }],
                    after,
                  },
                }
              : { value: null },
      ),
    }
    const row = { ...figures(run, steps, out), quiet: { ok: true } }
    expect(unfit(row)).toBeNull()
    expect(row.caps).toEqual({ sunSlices: 4, farBlocks: 1, sunRamp: 16 })
    const lines = sequenceTable([row]).split('\n')
    expect(lines).toHaveLength(2 + 4)
    expect(lines[2]).toMatch(
      /\| horizon \| 1080p \| 4 \| 1 \| 16 \| cut \| 4\.00 \| 8\.00 \| 0\.00 \| 20 \|/,
    )
    const empty = {
      ...row,
      sequences: [{ event: 'wake', frames: null }, ...row.sequences],
    }
    expect(unfit(empty)).toBe('no frames read for the wake')
  })
})
