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
import { figures, plan, tables, unfit } from './page.mjs'
import { sameBuild } from '../weather/sheet.mjs'

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
    // A tree measured dirty on purpose (`--allow-dirty`) is served by the
    // same test: its build's id ends `-dirty` as the tree's does.
    expect(buildRefusal('abed0719-dirty', 'abed0719-dirty')).toBeNull()
    // One equality for the runner and the capture.
    for (const [page, tree] of [
      ['abed0719', 'abed0719'],
      ['abed0719-dirty', 'abed0719-dirty'],
      ['abed0719', 'abed0719-dirty'],
      [null, 'abed0719'],
    ])
      expect(buildRefusal(page, tree) === null, `${page} ${tree}`).toBe(
        sameBuild(page, tree),
      )
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
    expect(over).toHaveLength(19)
  })

  it('take package Y’s six rows, each in a group of its own', () => {
    const over = batchRuns('over', SIZES).filter((r) => r.type === 'ab')
    const rows = (group) =>
      over
        .filter((r) => r.group === group)
        .map((r) => [
          r.scenario,
          r.size,
          r.base.over ?? 'off',
          r.candidate.over,
        ])
    // 1. The chain rule's: chain against passes, and B10's, chain against
    // the clouds off, on orbit and horizon at both sizes.
    expect(rows('chain')).toEqual([
      ['orbit', '1080p', 'passes', 'chain'],
      ['horizon', '1080p', 'passes', 'chain'],
      ['orbit', 'retina', 'passes', 'chain'],
      ['horizon', 'retina', 'passes', 'chain'],
    ])
    for (const r of over.filter((r) => r.group === 'clouds')) {
      expect(r.base.on).toBe(false)
      expect(r.candidate).toMatchObject({ on: true, over: 'chain' })
    }
    // 2. lean on the overlay at Retina; 3. chain on the overlay, lit.
    expect(rows('lean')).toEqual([['overlay', 'retina', 'passes', 'lean']])
    expect(rows('overlay').map(([, size]) => size)).toEqual(['1080p', 'retina'])
    for (const r of over.filter((r) => r.scenario === 'overlay'))
      expect(r.lit).toBe(true)
    // 5. The guard's stance, its own picture: an opaque station in front of
    // the deck and nothing marked, both forms at both sizes.
    const guard = over.filter((r) => r.group === 'guard')
    expect(guard.map((r) => [r.size, r.label])).toEqual([
      ['1080p', 'chain'],
      ['1080p', 'lean'],
      ['retina', 'chain'],
      ['retina', 'lean'],
    ])
    expect(guard[0]).toMatchObject({
      preset: 'weather-guard-station',
      stance: { kind: 'preset' },
      lit: false,
    })
    // 6. The temporal picture, both forms, at 1080p.
    expect(rows('temporal')).toEqual([
      ['horizon', '1080p', 'passes', 'chain'],
      ['horizon', '1080p', 'passes', 'lean'],
    ])
    // Every form row reads both sides' passes; every row its hash and lens.
    for (const r of over.filter((r) => r.group !== 'clouds'))
      expect(r.timelineBase, r.id).toBe(true)
    for (const r of over) {
      expect(r.leversHash).toMatch(/^[0-9a-f]{8}$/)
      expect(r.lens).toBeDefined()
    }
    expect(
      plan(over[0])
        .map((s) => s.tag)
        .slice(-3),
    ).toEqual(['timeline', 'timeline:base', 'report'])
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

  it('records an arm the machine cannot give as not taken, and the one thing a person would do', () => {
    const arm = (display, window, presentation) => ({
      display,
      window,
      presentation,
    })
    expect(
      armRefusal(arm('asleep', 'occluded', 'presented'), machine()),
    ).toEqual({
      why: expect.stringMatching(/presentation=occluded on every URL/),
      ask: expect.stringMatching(
        /^nothing at the machine: drive\.mjs needs a flag/,
      ),
    })
    expect(
      armRefusal(
        arm('awake', 'occluded', 'occluded'),
        machine({ locked: true }),
      ),
    ).toEqual({
      why: expect.stringMatching(/session is locked.* unlocks nothing/),
      ask: 'unlock the session and leave it unlocked for the arm; the runner wakes the display itself',
    })
    // Nothing comes in front of a lock screen, a dark display or not.
    expect(
      armRefusal(arm('asleep', 'front', 'occluded'), machine({ locked: true }))
        ?.ask,
    ).toBe('unlock the session; the runner brings the window forward itself')
    for (const display of ['asleep', 'awake'])
      for (const window of ['occluded', 'front'])
        expect(
          armRefusal(
            arm(display, window, 'occluded'),
            machine({ locked: false }),
          ),
        ).toBeNull()
    // On a locked machine one arm of the eight is taken: asleep, occluded.
    const taken = arms.filter(
      (r) => armRefusal(r.arm, machine({ locked: true })) === null,
    )
    expect(taken.map((r) => r.id.split('/').slice(-3).join(' '))).toEqual([
      'asleep occluded occluded',
    ])
  })

  it('says, under its table, what a person would do for every arm not taken', async () => {
    const rows = []
    for (const run of arms) {
      const { out } = await studyArm(
        run,
        { port: PORTS.rig },
        invoke([]),
        machine({ locked: true }),
      )
      if (out.notTaken !== undefined)
        rows.push({ ...figures(run, [], out), quiet: { ok: true } })
    }
    expect(rows).toHaveLength(7)
    const text = tables({ rows })
    expect(text).toMatch(
      /What a person at the machine would do for the arms not taken:\n- nothing at the machine: .*: 4 arms \(/,
    )
    expect(text).toMatch(
      /- unlock the session and leave it unlocked for the arm; the runner wakes the display itself: 2 arms \(awake occluded occluded; awake front occluded\)/,
    )
    expect(text).toMatch(
      /- unlock the session; the runner brings the window forward itself: 1 arm \(asleep front occluded\)/,
    )
    expect(text).toMatch(
      /- for each other refresh mode the display offers: set it in System Settings › Displays/,
    )
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
      /arm: display asleep, window occluded, presentation presented; not taken now: drive\.mjs sets.*; to take it: nothing at the machine/,
    )
  })
})
