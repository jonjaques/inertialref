import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { wrap } from '../driveScript.mjs'
import {
  ACCEPTANCE_ROWS,
  FRAME_FRAMES,
  STUDY,
  STUDY_WINDOWS,
  armRefusal,
  oneRate,
  screenLocked,
  studyArm,
} from './frame.mjs'
import {
  BATCHES,
  PORTS,
  PRESETS,
  TARGETS,
  batchRuns,
  buildRefusal,
  dryRun,
  parseOptions,
  session,
} from './measure.mjs'
import { figures, plan, unfit } from './page.mjs'

/*
 * The whole frame, the frame log and the pacing study without a browser or
 * a display: the steps run as the text drive.mjs sends, and the machine the
 * study sets is a fake that records what it was asked to do.
 */

const SIZES = ['1080p', 'retina']

function fakePage({ totals = [], profile = {} } = {}) {
  let frame = 0
  let at = 0
  const ir = {
    clouds: () => ({ settle: { pending: false }, leversHash: 'abcd1234' }),
    passes: async () => ({
      dropped: 0,
      passes: [{ label: 'scene', ms: totals[frame++ % totals.length] }],
    }),
    profile: async (ms) => {
      // Four rAF callbacks land while the profile waits.
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r))
      return {
        frames: 180,
        windowMs: ms,
        late: [{ startMs: 0, durationMs: 40 }],
        spans: [{ name: 'sensor', meanMs: 6.9 }],
        ...profile,
      }
    },
  }
  const context = vm.createContext({
    engine: {
      set clouds(_) {},
    },
    ir,
    requestAnimationFrame: (callback) =>
      setImmediate(() => callback((at += 1000 / 60))),
  })
  return { context }
}

async function send(page, run, tag) {
  const planned = plan(run, {})
  const install = planned.find((s) => s.tag === 'install:kind')
  vm.runInContext(wrap(install.args[1]), page.context)
  const step = planned.find((s) => s.tag === tag)
  return await vm.runInContext(wrap(step.args[1]), page.context)
}

describe('every run', () => {
  it('names its lens and carries its levers’ hash, in every batch', () => {
    for (const batch of Object.keys(BATCHES))
      for (const run of batchRuns(batch, SIZES)) {
        expect(run.leversHash, run.id).toMatch(/^[0-9a-f]{8}$/)
        expect(
          typeof run.lens === 'number' ||
            ['composition', 'rise'].includes(run.lens),
          run.id,
        ).toBe(true)
      }
  })

  it('is refused on a page that is not the tree’s build, by equality', () => {
    expect(buildRefusal('abed0719', 'abed0719')).toBeNull()
    // The capture's prefix test would take this; the tree it names is dirty.
    expect(buildRefusal('abed0719', 'abed0719-dirty')).toBe(
      "the page is build abed0719, and the tree is abed0719-dirty; serve this tree's build",
    )
    expect(buildRefusal(null, 'abed0719')).toMatch(/nobody named/)
  })
})

describe('the whole frame', () => {
  it('stands every target and every cornerstone, clouds off and on, at both sizes', () => {
    const runs = batchRuns('frame', SIZES)
    expect(runs).toHaveLength((TARGETS.length + PRESETS.length) * 2)
    expect(PRESETS).toEqual([
      'e1',
      'e2',
      'e3',
      'g1',
      'g2',
      'g3',
      'g4',
      'g5',
      'g6',
      'guard',
    ])
    const g4 = runs.find((r) => r.scenario === 'g4')
    expect(g4).toMatchObject({
      preset: 'weather-g4-over-deck',
      stance: { kind: 'preset' },
    })
    expect(g4.on).toMatchObject({ on: true, weather: 'stratocumulus' })
    // A station's picture serves the body it goes round.
    expect(runs.find((r) => r.scenario === 'guard').on.served).toBe(
      'g:milky-way/s:SOL/b:2',
    )
  })

  it('reads 180 frames a side, its median and its 95th percentile', async () => {
    const totals = Array.from({ length: 100 }, (_, i) =>
      i === 99 ? 20 : 10 + i / 100,
    )
    const run = batchRuns('frame', ['1080p'])[0]
    const side = await send(fakePage({ totals }), run, 'whole:on')
    expect(side.frames).toBe(FRAME_FRAMES)
    expect(side.median).toBeCloseTo(10.45, 6)
    expect(side.p95).toBeGreaterThan(10.9)
    expect(side.worst).toBe(20)
    expect(side.leversHash).toBe('abcd1234')
  })
})

describe('a frame log', () => {
  const run = batchRuns('hold', ['1080p'])[0]

  it('reads the presented rate from rAF and the drawn rate from the profile', async () => {
    const window = await send(fakePage(), run, 'window:off:0')
    expect(window.presentedHz).toBeCloseTo(60, 6)
    expect(window.intervalMs).toBeCloseTo(1000 / 60, 6)
    expect(window.drawnHz).toBe(60)
    expect(window).toMatchObject({ late: 1, sensorMs: 6.9, frames: 180 })
  })

  it('is one rate only within 2% of its median', () => {
    expect(oneRate([60, 60.5, 59.6])).toMatchObject({ median: 60, one: true })
    expect(oneRate([60, 60.5, 58.6])).toMatchObject({
      one: false,
      outside: [58.6],
    })
    expect(oneRate([null]).one).toBe(false)
  })

  it('stands a row with every window read, and an arm not taken as its reason', () => {
    const steps = plan(run, {})
    const read = {
      presentedHz: 60,
      drawnHz: 60,
      intervalMs: 16.7,
      late: 0,
      frames: 180,
      sensorMs: 7,
    }
    const out = {
      results: steps.map((s) =>
        s.tag === 'settle'
          ? { settled: true }
          : s.tag === 'stance'
            ? { value: { lens: { focalLength: run.lens } } }
            : { value: s.tag.startsWith('window:') ? read : null },
      ),
    }
    const row = { ...figures(run, steps, out), quiet: { ok: true } }
    expect(unfit(row)).toBeNull()
    expect(row.arms[0].rate).toMatchObject({ median: 60, one: true })
    const notTaken = figures(run, [], {
      results: [],
      notTaken: 'the session is locked',
    })
    expect(unfit({ ...notTaken, quiet: { ok: true } })).toBeNull()
  })
})

describe('the hold’s batches', () => {
  it('take the pacing check and three acceptance rows on horizon at 1080p alone', () => {
    expect(batchRuns('pacing', SIZES)).toHaveLength(1)
    const hold = batchRuns('hold', SIZES)
    expect(hold).toHaveLength(ACCEPTANCE_ROWS)
    for (const r of hold) {
      expect([r.scenario, r.size, r.arms[0].levers.on]).toEqual([
        'horizon',
        '1080p',
        false,
      ])
    }
  })

  it('pace B13 to B15’s rows by the means the command line names', () => {
    const pace = batchRuns('pace', SIZES)
    expect(pace).toHaveLength(3 + 2 + TARGETS.length + PRESETS.length)
    expect(pace.every((r) => r.size === '1080p' && r.paced)).toBe(true)
    const query = (hold) => {
      const run = parseOptions(['--batch', 'pace', '--hold', hold]).runs[0]
      const argv = session(run, {
        url: 'http://localhost:8787/',
        port: PORTS.cold,
        fresh: true,
      })
      return { run, queries: argv.filter((_, i) => argv[i - 1] === '--query') }
    }
    expect(query('page').queries).toContain('pace=60')
    expect(query('none').queries).not.toContain('pace=60')
    // The display's hold is an arm of the study's, and adds nothing to the page.
    expect(query('display').run.arm).toEqual({
      display: 'awake',
      window: 'occluded',
      presentation: 'occluded',
    })
    expect(query('display').queries).not.toContain('pace=60')
    expect(() => parseOptions(['--batch', 'pace', '--hold', 'vsync'])).toThrow(
      /--hold is one of/,
    )
  })

  it('take the placement’s cell at Retina, nine samples a side, chain without the overlay', () => {
    const over = batchRuns('over', SIZES)
    const cells = over.filter((r) => r.type === 'pace')
    expect(cells.map((r) => [r.scenario, r.size])).toEqual([
      ['inside', 'retina'],
      ['overlay', 'retina'],
    ])
    for (const r of cells) {
      expect(r.samples).toBe(9)
      expect(r.arms.map((a) => [a.name, a.levers.over, a.lit ?? null])).toEqual(
        [
          ['passes', 'passes', null],
          ['lean', 'lean', null],
          ['chain, nothing over', 'chain', false],
        ],
      )
    }
    const temporal = over.filter((r) => r.group === 'temporal')
    expect(temporal.map((r) => r.query)).toEqual([
      ['picture=temporal:quality'],
      ['picture=temporal:quality'],
    ])
    expect(over.filter((r) => r.group === 'form')).toHaveLength(20)
  })
})

describe('the pacing study', () => {
  const arms = batchRuns('study', SIZES)
  const machine = (over = {}) => {
    const did = []
    let asleep = over.asleep ?? true
    return {
      did,
      locked: () => over.locked ?? false,
      asleep: () => asleep,
      sleep: () => {
        did.push('sleep')
        asleep = true
      },
      wake: () => {
        did.push('wake')
        asleep = false
        return () => did.push('release')
      },
      front: async () => {
        did.push('front')
        return { left: 0, top: 0 }
      },
    }
  }
  const invoke = (calls) => async (steps) => {
    calls.push(steps.map((s) => s.tag))
    return { results: steps.map(() => ({ value: null })), operatingPoint: {} }
  }

  it('takes every arm, the display, the window and the page’s query, five windows each', () => {
    expect(arms).toHaveLength(
      STUDY.display.length * STUDY.window.length * STUDY.presentation.length,
    )
    for (const r of arms) {
      expect(r.samples).toBe(STUDY_WINDOWS)
      expect(r.arms[0].levers.on).toBe(false)
      expect([r.scenario, r.size]).toEqual(['horizon', '1080p'])
    }
  })

  it('records an arm the machine cannot give as not taken, and never unlocks', () => {
    expect(
      armRefusal(
        { display: 'asleep', window: 'occluded', presentation: 'presented' },
        machine(),
      ),
    ).toMatch(/presentation=occluded on every URL/)
    expect(
      armRefusal(
        { display: 'awake', window: 'occluded', presentation: 'occluded' },
        machine({ locked: true }),
      ),
    ).toMatch(/session is locked.* unlocks nothing/)
    expect(
      armRefusal(
        { display: 'awake', window: 'occluded', presentation: 'occluded' },
        machine({ locked: false }),
      ),
    ).toBeNull()
  })

  it('raises the window between two invocations, and leaves a dark display dark', async () => {
    const run = arms.find(
      (r) =>
        r.arm.display === 'awake' &&
        r.arm.window === 'front' &&
        r.arm.presentation === 'occluded',
    )
    const calls = []
    const m = machine({ locked: false, asleep: true })
    const { steps, out } = await studyArm(
      run,
      { port: PORTS.rig },
      invoke(calls),
      m,
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].at(-1)).toBe('wait')
    expect(calls[1].slice(0, 3)).toEqual(['install', 'install:kind', 'rate'])
    expect(m.did).toEqual(['wake', 'front', 'release', 'sleep'])
    expect(out.window).toEqual({ left: 0, top: 0 })
    expect(steps).toHaveLength(calls.flat().length)
    // A refused arm launches nothing and says why.
    const locked = await studyArm(
      run,
      { port: PORTS.rig },
      invoke([]),
      machine({ locked: true }),
    )
    expect(locked.out.notTaken).toMatch(/locked/)
    expect(locked.steps).toEqual([])
  })

  it('reads the lock off ioreg’s console session', () => {
    const plist = (locked) =>
      `<dict><key>CGSSessionScreenIsLocked</key>\n\t\t\t<${locked}/><key>kCGSSessionOnConsoleKey</key><true/></dict>`
    expect(screenLocked(plist('true'))).toBe(true)
    expect(screenLocked(plist('false'))).toBe(false)
    expect(screenLocked(null)).toBe(false)
  })

  it('plans each arm with its machine state, without touching the machine', () => {
    const text = dryRun({
      url: 'http://localhost:8787/',
      runs: arms.slice(0, 2),
    })
    expect(text).toMatch(
      /arm: display asleep, window occluded, presentation occluded\n/,
    )
    expect(text).toMatch(
      /arm: display asleep, window occluded, presentation presented; not taken now: drive\.mjs sets/,
    )
  })
})
