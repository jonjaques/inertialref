import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLOUD_PLACEMENTS,
  isCloudLevers,
} from '../../apps/game/src/render/cloudLevers.ts'
import { wrap } from '../driveScript.mjs'
import { binEdge, difference, histogramStats, parseRmse } from './diff.mjs'
import {
  LADDERS,
  PORTS,
  SCENARIOS,
  batchRuns,
  busy,
  closeOurs,
  dryRun,
  freshProfile,
  identityRefusal,
  judge,
  parseOptions,
  parseProcesses,
  profileDir,
  programOf,
  session,
} from './measure.mjs'
import {
  AB_COLUMNS,
  PASS_LIMIT,
  RADIANCE_FRAMES,
  figures,
  fitSweep,
  hitch,
  median,
  memoryTable,
  plan,
  summarize,
  sweepTables,
  table,
  tables,
} from './page.mjs'

/*
 * The runner's pure parts, without a browser: what it would launch, what it
 * would refuse, and what it would print. Its page steps run here too, as the
 * very text drive.mjs sends, in a context that holds nothing but fakes of the
 * page's globals, so a step that reached into this module's scope would throw
 * here rather than in the rig two hours into a batch.
 */

const SIZES = ['1080p', 'retina']
const ALL = Object.fromEntries(
  ['stances', 'decisions', 'images', 'sweep', 'targets', 'memory', 'error'].map(
    (b) => [b, batchRuns(b, SIZES)],
  ),
)
const count = (runs, test) => runs.filter(test).length

describe('the batches', () => {
  it('names a whole lever set the contract accepts for every arm of every run', () => {
    for (const runs of Object.values(ALL))
      for (const run of runs)
        for (const set of [
          run.base,
          run.candidate,
          run.off,
          run.levers,
          run.identity,
          run.thin,
          ...(run.cells ?? []),
          ...(run.comparisons ?? []).flatMap((c) => [c.a, c.b]),
        ].filter((s) => s !== undefined))
          expect(isCloudLevers(set), `${run.id}: ${JSON.stringify(set)}`).toBe(
            true,
          )
  })

  it('gives every run an id of its own', () => {
    for (const runs of Object.values(ALL))
      expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length)
  })

  it('runs the decisions as the design counts them: 78 A/B runs', () => {
    const runs = ALL.decisions
    expect(runs).toHaveLength(78)
    const placement = runs.filter((r) => r.group === 'placement')
    expect(placement).toHaveLength(18)
    for (const r of placement) {
      expect(r.base.on).toBe(false)
      expect(r.candidate).toMatchObject({
        on: true,
        placement: r.label,
        force: 'none',
      })
      expect(r.pairs).toBe(5)
      // ir.profile(3000) for the two placements whose CPU the rule weighs.
      expect(r.profileMs).toBe(r.label === 'empty-split' ? 0 : 3000)
    }
    expect(new Set(placement.map((r) => r.label))).toEqual(
      new Set(CLOUD_PLACEMENTS),
    )
    const cache = runs.filter((r) => r.group === 'cache')
    expect(count(cache, (r) => r.kind === 'steady')).toBe(24)
    expect(count(cache, (r) => r.kind === 'fly')).toBe(16)
    expect(count(cache, (r) => r.kind === 'cut' || r.kind === 'scrub')).toBe(16)
    for (const r of cache) {
      const [cacheKind, sunDepth] = r.label.split('+')
      expect(r.candidate).toMatchObject({
        on: true,
        cache: cacheKind,
        sunDepth,
      })
      expect(r.pairs).toBe(r.kind === 'steady' ? 5 : 3)
      if (r.kind !== 'steady') expect(r.candidate.force).toBe(r.kind)
      if (r.kind === 'cut' || r.kind === 'scrub')
        expect(r.scenario).toBe('horizon')
    }
    const far = runs.filter((r) => r.group === 'far')
    expect(far).toHaveLength(4)
    for (const r of far) {
      expect(r.base).toMatchObject({
        on: true,
        far: 'atlas',
        cache: 'field',
        sunDepth: 'cascades',
      })
      expect(r.candidate).toMatchObject({ on: true, far: 'spheres' })
    }
  })

  it('prices Earth against its deck hidden, and the deck alone', () => {
    const earth = ALL.targets.filter((r) => r.scenario.startsWith('earth'))
    expect(earth).toHaveLength(12)
    for (const r of earth)
      expect(r.base).toMatchObject({ on: false, deck: 'hidden' })
    const deck = earth.filter((r) => r.group === 'deck')
    for (const r of deck)
      expect(r.candidate).toMatchObject({ on: false, deck: 'auto' })
    expect(count(earth, (r) => r.group === 'landed' && r.candidate.on)).toBe(8)
    expect(ALL.targets).toHaveLength(58)
  })

  it('sweeps 72 cells a size at constant work, and the five other read types', () => {
    for (const size of SIZES) {
      const runs = ALL.sweep.filter((r) => r.size === size)
      const cells = runs.flatMap((r) => r.cells)
      const grid = cells.filter((c) => c.sweepExtra === 'none')
      expect(
        runs.filter((r) => r.label !== 'marginals').flatMap((r) => r.cells),
      ).toHaveLength(72)
      expect(new Set(grid.map((c) => c.fixedSteps))).toEqual(
        new Set([32, 64, 128]),
      )
      expect(new Set(grid.map((c) => c.sweepReads))).toEqual(
        new Set([1, 2, 4, 6]),
      )
      const marginals = runs.find((r) => r.label === 'marginals').cells
      expect(marginals.map((c) => c.sweepExtra)).toEqual([
        'none',
        'clipmap',
        'profile',
        'detail',
        'curl',
        'level',
      ])
      for (const c of cells)
        expect(c).toMatchObject({
          on: true,
          scenario: 'overcast',
          cache: 'field',
        })
    }
  })

  it('takes the error batch twice a stance, Enhanced off and on, and twelve cold boots', () => {
    expect(ALL.error).toHaveLength(16)
    expect(count(ALL.error, (r) => r.mode === 'enhanced')).toBe(8)
    for (const r of ALL.error) {
      expect(r.levers.composite).toBe('residual')
      expect([r.identity.composite, r.thin.composite]).toEqual([
        'identity',
        'thin',
      ])
    }
    expect(ALL.memory).toHaveLength(12)
    expect(count(ALL.memory, (r) => r.flag)).toBe(6)
    expect(ALL.stances).toHaveLength(Object.keys(SCENARIOS).length)
    expect(new Set(ALL.stances.map((r) => r.size))).toEqual(new Set(['1080p']))
  })

  it('stands each scenario where the design puts it', () => {
    const at = (id) => SCENARIOS[id].stance
    expect(at('ground').options).toEqual({
      site: 'basin',
      height: 2,
      heading: 90,
      pitch: 10,
    })
    expect(at('inside').options.height).toBe(1200)
    expect(at('orbit').options).toMatchObject({
      latitude: 15,
      longitude: 34,
      height: 400_000,
      pitch: -40,
    })
    expect(at('pair-moon')).toMatchObject({
      kind: 'rise',
      address: 'g:milky-way/s:P222_1_0_9/b:4.0',
    })
    expect(SCENARIOS['pair-moon'].levers).toMatchObject({
      served: 'g:milky-way/s:P222_1_0_9/b:4.0',
      second: 'g:milky-way/s:P222_1_0_9/b:4',
    })
    expect(SCENARIOS['earth-orbit'].levers.flySpeed).toBe(7700)
    expect(at('sunset')).toMatchObject({ kind: 'raise', height: 1500 })
  })
})

describe('the images', () => {
  it('compare each volume combination with the field one of its sun depth, under 3%, where the cache gate reads it', () => {
    const gate = ALL.images.filter((r) => r.group === 'cache')
    expect(gate).toHaveLength(6)
    expect(new Set(gate.map((r) => r.scenario))).toEqual(
      new Set(['ground', 'horizon', 'inside']),
    )
    for (const r of gate) {
      expect(r.type).toBe('radiance')
      expect(r.comparisons).toHaveLength(2)
      for (const c of r.comparisons) {
        expect(c.threshold).toBe(0.03)
        expect(c.a).toMatchObject({ on: true, cache: 'field' })
        expect(c.b).toMatchObject({ on: true, cache: 'volume' })
        expect(c.b.sunDepth).toBe(c.a.sunDepth)
      }
    }
  })

  it('climb each quality lever’s ladder a value against the next, under 1%, in horizon and inside', () => {
    const ladders = ALL.images.filter((r) => r.group === 'ladder')
    expect(ladders).toHaveLength(Object.keys(LADDERS).length * 2 * 2)
    for (const r of ladders) {
      const values = LADDERS[r.label]
      expect(['horizon', 'inside']).toContain(r.scenario)
      expect(r.comparisons.map((c) => [c.a[r.label], c.b[r.label]])).toEqual(
        values.slice(0, -1).map((v, i) => [v, values[i + 1]]),
      )
      for (const c of r.comparisons) expect(c.threshold).toBe(0.01)
    }
  })
})

describe('the command line', () => {
  it('takes a batch, with the preview and both sizes by default', () => {
    const options = parseOptions(['--batch', 'decisions'])
    expect(options).toMatchObject({
      batch: 'decisions',
      url: 'http://localhost:8787/',
      gpuWait: 0,
      dryRun: false,
    })
    expect(options.runs).toHaveLength(78)
    expect(
      parseOptions(['--batch', 'memory', '--gpu-wait', '900']).gpuWait,
    ).toBe(900_000)
  })

  it('narrows to a size and to the runs whose id holds a text', () => {
    const options = parseOptions([
      '--batch',
      'decisions',
      '--sizes',
      'retina',
      '--runs',
      'placement/split',
    ])
    expect(options.runs.map((r) => r.id)).toEqual([
      'decisions/placement/split/horizon/retina/steady',
      'decisions/placement/split/inside/retina/steady',
      'decisions/placement/split/orbit/retina/steady',
    ])
  })

  it('refuses before touching anything', () => {
    for (const argv of [
      [],
      ['--batch', 'everything'],
      ['--batch', 'sweep', '--sizes', '4k'],
      ['--batch', 'sweep', '--gpu-wait', '5s'],
      ['--batch', 'sweep', '--max-load', '-1'],
      ['--batch', 'sweep', '--runs', 'nothing-is-called-this'],
      ['--batch', 'sweep', '--url', 'not a url'],
      ['--batch', 'sweep', '--port', '9333'],
    ])
      expect(() => parseOptions(argv), argv.join(' ')).toThrow()
    expect(parseOptions(['--help'])).toEqual({ help: true })
  })
})

const steps = (run, shots) => plan(run, shots)
const jsArgs = (planned) =>
  planned.flatMap((s) => (s.args[0] === '--js' ? [s.args[1]] : []))
const decision = (id) => ALL.decisions.find((r) => r.id === id)

describe('the invocations', () => {
  it('holds every run to its window, the preview and the flag', () => {
    const run = decision('decisions/placement/split/horizon/retina/steady')
    const argv = session(run, {
      url: 'http://localhost:8787/',
      port: PORTS.rig,
      fresh: true,
    })
    const flag = (name) => argv[argv.indexOf(name) + 1]
    expect([flag('--width'), flag('--height'), flag('--dpr')]).toEqual([
      '1440',
      '900',
      '2',
    ])
    expect(flag('--port')).toBe('9341')
    expect(flag('--preset')).toBe('far-shore')
    expect(argv).toContain('--no-serve')
    expect(argv).not.toContain('--keep-storage')
    expect(argv.filter((_, i) => argv[i - 1] === '--query')).toEqual([
      'clouds=1',
      'chrome=0',
      'layers=0',
      'output=standard',
    ])
    const warm = session(
      decision('decisions/placement/split/horizon/1080p/steady'),
      { url: 'http://localhost:8787/', port: PORTS.rig, fresh: false },
    )
    expect([
      warm[warm.indexOf('--width') + 1],
      warm[warm.indexOf('--dpr') + 1],
    ]).toEqual(['1920', '1'])
    expect(warm).toContain('--keep-storage')
    const earth = ALL.targets.find((r) => r.scenario === 'earth-ground')
    expect(
      session(earth, {
        url: 'http://localhost:8787/',
        port: PORTS.rig,
        fresh: true,
      }),
    ).toContain('blue-marble')
  })

  it('boots each cold run on its own port, with the flag only when it is one', () => {
    const [flagged, plain] = [
      ALL.memory.find((r) => r.flag),
      ALL.memory.find((r) => !r.flag),
    ]
    const queries = (run) => {
      const argv = session(run, {
        url: 'http://localhost:8787/',
        port: PORTS.cold,
        fresh: true,
      })
      return argv.filter((_, i) => argv[i - 1] === '--query')
    }
    expect(queries(flagged)).toEqual([
      'timing=full',
      'clouds=1',
      'chrome=0',
      'layers=0',
      'output=standard',
    ])
    expect(queries(plain)).toEqual([
      'timing=full',
      'chrome=0',
      'layers=0',
      'output=standard',
    ])
    expect(plan(flagged).map((s) => s.tag)).toEqual([
      'install',
      'boot',
      'on',
      'sample',
      'first',
    ])
    expect(plan(plain).map((s) => s.tag)).toEqual(['install', 'boot'])
    expect(
      dryRun({ url: 'http://localhost:8787/', runs: ALL.memory }),
    ).toContain('--port 9342')
  })

  it('interleaves the pairs in one invocation, then the timeline, the profiles and the report', () => {
    const run = decision('decisions/placement/passes/inside/1080p/steady')
    expect(plan(run).map((s) => s.tag)).toEqual([
      'install',
      'stance',
      'settle',
      'wait',
      ...[0, 1, 2, 3, 4].flatMap((p) => [`base:${p}`, `candidate:${p}`]),
      'timeline',
      'profile:candidate',
      'profile:base',
      'report',
    ])
  })

  it('sends drive.mjs one expression a step, as its wrapper compiles them', () => {
    const AsyncFunction = (async () => {}).constructor
    const shots = { identity: '/x/i.png', thin: '/x/t.png', still: '/x/s.jpg' }
    for (const runs of Object.values(ALL))
      for (const run of runs.slice(0, 3))
        for (const expression of jsArgs(steps(run, shots)))
          expect(
            () => new AsyncFunction(`return (\n${expression}\n)`),
          ).not.toThrow()
  })

  it('attaches to a booted page and boots a fresh one for a new window', () => {
    const text = dryRun({
      url: 'http://localhost:8787/',
      runs: ALL.decisions.slice(0, 2),
    })
    const [first, second] = text
      .split('\n')
      .filter((l) => l.startsWith('  node'))
    expect(first).not.toContain('--keep-storage')
    expect(second).toContain('--keep-storage')
  })
})

/**
 * The page, faked: `ir` and `engine` as far as the steps reach, in a context
 * of their own. `passes` answers `ir.passes(n)`; every call is recorded.
 */
function fakePage({
  perFrame = 35,
  dropped = 0,
  pending = false,
  gpu = [6, 5, 7],
} = {}) {
  const calls = { passes: [], gpu: [], levers: [] }
  let reads = 0
  const engine = {
    cloudsAvailable: true,
    exposure: { processing: 'enhanced' },
    set clouds(levers) {
      calls.levers.push(levers)
    },
  }
  const ir = {
    clouds: () => ({
      settle: { pending },
      extents: { trace: [480, 270] },
      steps: null,
      levers: {},
    }),
    gpu: async (n) => {
      calls.gpu.push(n)
      return { ms: gpu[reads++ % gpu.length], frames: n }
    },
    passes: async (n) => {
      calls.passes.push(n)
      return {
        frames: n,
        wallMs: 12,
        busyMs: 11,
        dropped,
        passes: [
          {
            label: 'scene',
            kind: 'render',
            count: perFrame - 1,
            ms: 8,
            latencyMs: 20,
          },
          {
            label: 'cloud trace',
            kind: 'compute',
            count: 1,
            ms: 1.2,
            latencyMs: 3,
          },
        ],
      }
    },
    // A capture whose every texel is cloud lit by the levers' step budget,
    // so two budgets differ by their ratio.
    cloudRadiance: async () => {
      calls.captures = (calls.captures ?? 0) + 1
      const lit = calls.levers.at(-1)?.maxSteps ?? 1
      return {
        width: 2,
        height: 1,
        luminance: Float32Array.from([lit, lit]),
        cloud: Uint8Array.from([1, 1]),
      }
    },
    cloudRadianceDifference: (a, b) => ({
      texels: a.cloud.length,
      relative: Math.abs(a.luminance[0] - b.luminance[0]) / a.luminance[0],
    }),
    light: () => ({ sun: 37.5, phase: null, lit: true }),
    visit: (address, options) => {
      calls.visit = { address, options }
    },
    observatory: {
      status: () => ({
        surface: {
          stance: {
            latitude: 0.25,
            longitude: 0.6,
            heading: 1.8,
            pitch: -0.13,
          },
        },
      }),
    },
  }
  const context = vm.createContext({
    engine,
    ir,
    requestAnimationFrame: (callback) => setImmediate(callback),
  })
  return { context, calls }
}

/** One planned step, sent the way drive.mjs sends it. */
async function send(page, run, tag) {
  const planned = plan(run, {})
  vm.runInContext(wrap(planned[0].args[1]), page.context)
  const step = planned.find((s) => s.tag === tag)
  return await vm.runInContext(wrap(step.args[1]), page.context)
}

describe('the page steps', () => {
  const run = decision('decisions/cache/field+cascades/horizon/retina/steady')

  it('install into a page that holds nothing of this module', () => {
    const page = fakePage()
    expect(vm.runInContext(plan(run)[0].args[1], page.context)).toBe('function')
  })

  it('read the best of three gpu reads once the clouds settle', async () => {
    const page = fakePage()
    const side = await send(page, run, 'candidate:0')
    expect(side.ms).toBe(5)
    expect(page.calls.gpu).toEqual([135, 135, 135])
    // Four frames first, so a report from before the levers moved is not read.
    expect(side.settled).toBe(5)
    expect(page.calls.levers.at(-1)).toMatchObject({
      on: true,
      cache: 'field',
      sunDepth: 'cascades',
    })
  })

  it('wait out the cap where the clouds never settle, as a forced path does', async () => {
    const page = fakePage({ pending: true })
    expect((await send(page, run, 'base:0')).settled).toBe(240)
  })

  it('size the timeline read from the frame’s own pass count', async () => {
    for (const [perFrame, frames] of [
      // A frame of today's passes and the winner's eight reads one far cycle.
      [35, 45],
      [82, 24],
      [2001, 1],
    ]) {
      const page = fakePage({ perFrame })
      const timeline = await send(page, run, 'timeline')
      expect(page.calls.passes, `${perFrame} passes a frame`).toEqual([
        1,
        frames,
      ])
      expect(timeline).toMatchObject({ perFrame, frames })
      expect(perFrame * frames).toBeLessThanOrEqual(
        Math.max(perFrame, PASS_LIMIT.passes),
      )
      expect(timeline.labels['cloud trace'].ms).toBe(1.2)
    }
  })

  it('capture each side of a comparison from a reset, then difference them', async () => {
    const ladder = ALL.images.find(
      (r) => r.id === 'images/ladder/maxSteps/horizon/1080p',
    )
    const page = fakePage()
    const step = await send(page, ladder, 'radiance:0')
    // Each side the mean of its captures, the first side's halves the floor.
    expect(page.calls.captures).toBe(2 * RADIANCE_FRAMES)
    expect(step.extent).toEqual([2, 1])
    // 64 against 96 steps: the fake lights a texel by its budget.
    expect(step.difference).toEqual({ texels: 2, relative: 0.5 })
    expect(step.floor).toEqual({ texels: 2, relative: 0 })
    // Each side: a reset frame under its levers, then the levers alone.
    const [a, b] = [ladder.comparisons[0].a, ladder.comparisons[0].b]
    expect(page.calls.levers).toEqual([
      { ...a, force: 'reset' },
      a,
      { ...b, force: 'reset' },
      b,
    ])
  })

  it('refuse a read that dropped passes, which reports every label low', async () => {
    await expect(
      send(fakePage({ dropped: 3 }), run, 'timeline'),
    ).rejects.toThrow(/dropped 3/)
  })

  it('raise the preset’s own stance rather than reset the fields a visit was not given', async () => {
    const sunset = ALL.error.find((r) => r.scenario === 'sunset')
    const page = fakePage()
    page.context.ir.preset = () => ({ picture: {} })
    await send(page, sunset, 'stance')
    expect(page.calls.visit.address).toBe('g:milky-way/s:P222_1_0_9/b:4')
    expect(page.calls.visit.options.height).toBe(1500)
    expect(page.calls.visit.options.heading).toBeCloseTo(
      (1.8 * 180) / Math.PI,
      12,
    )
    expect(page.calls.visit.options.pitch).toBeCloseTo(
      (-0.13 * 180) / Math.PI,
      12,
    )
  })

  it('refuse a page with no cloud system before standing anywhere', async () => {
    const page = fakePage()
    page.context.engine.cloudsAvailable = false
    await expect(send(page, run, 'stance')).rejects.toThrow(/no cloud system/)
    expect(page.calls.visit).toBeUndefined()
  })

  it('run every kind of step in a page that holds nothing of this module', async () => {
    const page = fakePage()
    const { ir, engine } = page.context
    const entry = (name, track, startMs, durationMs) => ({
      name,
      track,
      startMs,
      durationMs,
    })
    // The boot's spans, and a frame drawn before the levers moved.
    const entries = [
      entry('warm-up', 'Boot', 0, 4200),
      entry('warming the clouds', 'Boot', 100, 800),
      entry('sensor', 'Render', 50, 1),
    ]
    const report = {
      settle: { pending: false },
      extents: { trace: [480, 270] },
      steps: { mean: 64, max: 64, exhausted: 0 },
      levers: { stats: true },
      residual: {
        thin: { bins: [4], samples: 4 },
        light: { bins: [4], samples: 4 },
        total: { bins: [4], samples: 4 },
        classDisagreement: 2,
      },
      served: 'g:milky-way/s:P222_1_0_9/b:4',
      second: null,
      regime: 'converging',
      pipelines: { render: 30, compute: 14 },
      bytes: { total: 83_500_000 },
    }
    Object.assign(ir, {
      clouds: () => report,
      profile: async () => ({
        frames: 180,
        late: [{}, {}],
        spans: [{ track: 'Render', name: 'sensor', meanMs: 2.4 }],
      }),
      lens: () => ({ focalLength: 21 }),
      picture: () => ({ path: 'native' }),
      build: () => ({ id: 'b1' }),
      timing: {
        drain: () => entries.splice(0),
        // The mark, then the frame the levers drew.
        mark: (name) =>
          entries.push(
            entry(name, 'Boot', 200, 0),
            entry('sensor', 'Render', 210, 9.5),
          ),
      },
      preset: () => ({
        picture: {
          id: 'far-shore',
          label: 'The Far Shore',
          why: '',
          time: 100_331.95,
          address: 'x',
          framing: { kind: 'camera' },
          lens: { focalLength: 20.8 },
        },
      }),
      takePicture: (picture) => {
        page.calls.picture = picture
      },
    })
    engine.sensorSettings = { mode: 'enhanced', look: 'neutral' }
    engine.requestSensorSettings = (settings) => {
      page.calls.settings = settings
      engine.exposure = {
        processing: settings.mode === 'enhanced' ? 'enhanced' : 'photographic',
      }
    }

    const profiled = decision('decisions/placement/split/horizon/1080p/steady')
    expect(await send(page, profiled, 'profile:candidate')).toMatchObject({
      frames: 180,
      late: 2,
      sensor: { meanMs: 2.4 },
    })
    expect(await send(page, profiled, 'report')).toMatchObject({
      build: { id: 'b1' },
      lens: { focalLength: 21 },
    })

    const sweep = ALL.sweep.find((r) => r.label === 'scale-1')
    const cell = sweep.cells.findIndex((c) => c.fixedSteps === 64)
    expect(await send(page, sweep, `cell:${cell}`)).toMatchObject({
      accepted: true,
      trace: { ms: 1.2 },
      frames: 45,
    })

    const residual = ALL.error.find((r) => r.mode === 'automatic')
    expect(await send(page, residual, 'residual')).toMatchObject({
      processing: 'photographic',
      residual: { classDisagreement: 2 },
    })
    expect(page.calls.settings).toEqual({ mode: 'automatic', look: 'neutral' })
    expect(await send(page, residual, 'show:identity')).toMatchObject({
      settled: 5,
    })

    const cold = ALL.memory.find((r) => r.flag)
    expect(await send(page, cold, 'boot')).toMatchObject({
      warmUp: 4200,
      clouds: 800,
    })
    await send(page, cold, 'on')
    expect(await send(page, cold, 'first')).toMatchObject({
      sensorMs: 9.5,
      pipelines: { render: 30, compute: 14 },
    })

    // The moon's rise is far-shore's picture with its own address and no lens.
    const moon = ALL.stances.find((r) => r.scenario === 'pair-moon')
    await send(page, moon, 'stance')
    expect(page.calls.picture).toMatchObject({
      address: 'g:milky-way/s:P222_1_0_9/b:4.0',
      framing: { kind: 'rise' },
      time: 100_331.95,
    })
    expect(page.calls.picture.lens).toBeUndefined()
    expect(await send(page, moon, 'verify')).toMatchObject({
      served: 'g:milky-way/s:P222_1_0_9/b:4',
      labels: [
        ['scene', 34],
        ['cloud trace', 1],
      ],
    })
  })
})

describe('the figures', () => {
  const run = decision('decisions/placement/split/orbit/retina/steady')
  const planned = plan(run)
  const answer = (tag) => {
    const [arm, p] = tag.split(':')
    if (arm === 'base') return { ms: 10 + Number(p) * 0.01, settled: 5 }
    if (arm === 'candidate') return { ms: 10.4 + Number(p) * 0.02, settled: 5 }
    if (tag === 'timeline')
      return {
        perFrame: 35,
        labels: {
          'scene over clouds': { ms: 0.3 },
          'cloud trace': { ms: 1.1 },
          'cloud maps': { ms: 0.02 },
          'cloud far atlas': { ms: 0.03 },
        },
        clouds: { bytes: { total: 83_500_000 } },
      }
    if (arm === 'profile')
      return {
        frames: 180,
        late: tag.endsWith('candidate') ? 3 : 1,
        sensor: { meanMs: tag.endsWith('candidate') ? 2.5 : 2.1 },
      }
    return {}
  }
  const out = {
    results: planned.map((s) => ({ step: 'js', value: answer(s.tag) })),
    operatingPoint: { kind: 'webgpu' },
  }

  it('read each pair, the medians and the spread of the Δs', () => {
    const row = figures(run, planned, out)
    // Pair p is 10 + 0.01p against 10.4 + 0.02p: a Δ of 0.4 + 0.01p.
    row.pairs.forEach((pair, p) =>
      expect(pair.delta).toBeCloseTo(0.4 + 0.01 * p, 12),
    )
    expect(row.summary.delta).toBeCloseTo(0.42, 12)
    expect(row.summary.spread).toBeCloseTo(0.04, 12)
    expect(row).toMatchObject({
      sceneOver: 0.3,
      trace: 1.1,
      perFrame: 35,
      bytes: 83_500_000,
    })
    expect(row.bakes).toBeCloseTo(0.05, 12)
    expect(row.sensor).toBeCloseTo(0.4, 12)
    expect(row.late).toBe(2)
  })

  it('refuse a pair ir.gpu answered nothing for', () => {
    const broken = {
      ...out,
      results: out.results.map((r, i) =>
        planned[i].tag === 'candidate:2'
          ? { step: 'js', value: { ms: null } }
          : r,
      ),
    }
    expect(() => figures(run, planned, broken)).toThrow(/pair 2/)
  })

  it('refuse a residual drawn under the other processing', () => {
    const residual = ALL.error.find((r) => r.mode === 'automatic')
    const p = plan(residual, { identity: 'i.png', thin: 't.png' })
    const row = figures(residual, p, {
      results: p.map((s) => ({
        value:
          s.tag === 'residual'
            ? { processing: 'enhanced', residual: null }
            : null,
      })),
    })
    expect(row.refused).toBe(
      'drawn under enhanced processing, not photographic',
    )
  })

  it('print in the design’s columns, a missing figure as a dash', () => {
    const row = { ...figures(run, planned, out), quiet: { ok: true } }
    const text = table([row], AB_COLUMNS)
    const [header, rule, line] = text.split('\n')
    expect(header).toBe(
      '| Scenario | Size | Kind | Lever | Base ms | Candidate ms | Δ ms (spread) | scene over clouds | cloud trace | cloud history | cloud depth | bakes | passes/frame | bytes MB | sensor ms Δ | late Δ | quiet |',
    )
    expect(rule).toMatch(/^\| --- (\| --- )+\|$/)
    expect(line).toBe(
      '| orbit | retina | steady | split | 10.02 | 10.44 | 0.42 (0.04) | 0.30 | 1.10 | — | — | 0.05 | 35 | 83.50 | 0.40 | 2 | yes |',
    )
  })

  it('read a radiance run a comparison a row, and say which pass their threshold', () => {
    const gate = ALL.images.find(
      (r) => r.id === 'images/cache/volume/inside/retina',
    )
    const p = plan(gate)
    const values = [
      {
        difference: { relative: 0.021, texels: 900 },
        floor: { relative: 0.004 },
        settled: [17, 17],
      },
      {
        difference: { relative: 0.042, texels: 880 },
        floor: { relative: 0.005 },
        settled: [17, 20],
      },
    ]
    const row = {
      ...figures(gate, p, {
        results: p.map((s) => ({
          value: s.tag.startsWith('radiance:')
            ? values[Number(s.tag.split(':')[1])]
            : null,
        })),
      }),
      quiet: { ok: true },
    }
    expect(row.differences.map((d) => [d.relative, d.threshold])).toEqual([
      [0.021, 0.03],
      [0.042, 0.03],
    ])
    const lines = tables({ rows: [row] }).split('\n')
    expect(lines[0]).toBe(
      '| Scenario | Size | Group | Lever | Comparison | radiance RMSE | noise floor | under | passes | cloud texels | quiet |',
    )
    expect(lines[2]).toBe(
      '| inside | retina | cache | volume | volume against field, cascades | 2.1% | 0.4% | 3.0% | yes | 900 | yes |',
    )
    expect(lines[3]).toMatch(
      /\| 4\.2% \| 0\.5% \| 3\.0% \| no \| 880 \| yes \|$/,
    )
  })

  it('print the latest attempt of a run, which is the one a re-run left', () => {
    const row = { ...figures(run, planned, out), quiet: { ok: false } }
    const doc = { rows: [row, { ...row, quiet: { ok: true } }] }
    expect(tables(doc).split('\n')).toHaveLength(3)
    expect(tables(doc)).toMatch(/\| yes \|$/)
  })
})

describe('the arithmetic', () => {
  it('takes medians of odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
    expect(
      summarize([
        { base: 1, candidate: 2, delta: 1 },
        { base: 1, candidate: 1.5, delta: 0.5 },
      ]).spread,
    ).toBe(0.5)
  })

  it('reads a first-frame hitch against the steady frames after it', () => {
    const samples = [40, 18, 17, 16, 17, ...Array(55).fill(16.7)].map(
      (frameMs) => ({ frameMs }),
    )
    expect(hitch(samples)).toEqual({ first: 40, steady: 16.7 })
    expect(hitch(samples.slice(0, 30))).toBeNull()
  })

  it('recovers the per-ray, per-step and per-fetch costs a sweep is made of', () => {
    // α 2 ns a ray, β 0.9 ns a ray-step, γ 0.35 ns a fetch: a 480 × 270
    // trace at 64 steps and two reads costs 0.26 + 7.46 + 5.81 ms.
    const truth = { alpha: 2e-6, beta: 9e-7, gamma: 3.5e-7 }
    const cells = []
    for (const rays of [240 * 135, 480 * 270, 960 * 540])
      for (const steps of [32, 64, 128])
        for (const reads of [1, 2, 4, 6])
          cells.push({
            rays,
            steps,
            reads,
            ms:
              truth.alpha * rays +
              truth.beta * rays * steps +
              truth.gamma * rays * steps * reads,
          })
    const fit = fitSweep(cells)
    for (const key of ['alpha', 'beta', 'gamma'])
      expect(fit[key] / truth[key]).toBeCloseTo(1, 9)
    expect(fit.residual).toBeLessThan(1e-9)
    expect((fit.fetchesPerSecond * truth.gamma) / 1e3).toBeCloseTo(1, 9)
    // Noise of a known size leaves a residual of that size, not a wrong fit.
    const noisy = cells.map((c, i) => ({
      ...c,
      ms: c.ms + (i % 2 ? 0.01 : -0.01),
    }))
    expect(fitSweep(noisy).residual).toBeCloseTo(0.01, 2)
    expect(fitSweep(cells.slice(0, 2))).toBeNull()
    expect(
      fitSweep(cells.filter((c) => c.rays === 480 * 270 && c.steps === 64)),
    ).toBeNull()
  })

  it('prints the fit and the format beside the cells', () => {
    const cell = (run, format, extra, reads, ms) => ({
      size: '1080p',
      run,
      rays: 129_600,
      steps: 64,
      reads,
      format,
      extra,
      ms,
      fetchesPerSecond: 1e9,
      accepted: true,
    })
    const text = sweepTables([
      cell('scale-1', 'r8', 'none', 2, 10),
      cell('scale-1', 'rgba8', 'none', 2, 12),
      cell('marginals', 'r8', 'none', 1, 6),
      cell('marginals', 'r8', 'curl', 1, 6.5),
    ])
    // 2 ms more over 129,600 rays × 64 steps × 2 reads is 0.1206 ns a fetch.
    expect(text).toContain('| 1080p | rgba8 − r8 at 2 reads | 0.1206 |')
    // 0.5 ms over 129,600 × 64 ray-steps is 0.0603 ns each.
    expect(text).toContain('| 1080p | curl | 0.0603 |')
  })

  it('states what the flag adds to a boot, and says the OS cache may be warm', () => {
    const boot = (flag, warmUp) => ({
      size: 'retina',
      flag,
      boot: 1,
      spans: { warmUp, clouds: flag ? 800 : null },
      hitch: null,
      pipelines: null,
      bytes: null,
    })
    const text = memoryTable([
      boot(true, 4900),
      boot(true, 5100),
      boot(false, 4000),
    ])
    expect(text).toContain('retina: the flag adds 1000.00 ms to the warm-up')
    expect(text).toContain('the OS Metal cache may be warm')
  })
})

describe('the residual histograms', () => {
  const histogram = (counts) => {
    const bins = Array(64).fill(0)
    for (const [bin, n] of counts) bins[bin] = n
    return { bins, samples: bins.reduce((s, n) => s + n, 0) }
  }

  it('puts 1% on a bin edge and 2% and 5% inside bins', () => {
    expect(binEdge(32)).toBe(0.01)
    expect(binEdge(36)).toBeLessThan(0.02)
    expect(binEdge(37)).toBeGreaterThan(0.02)
    expect(binEdge(64)).toBe(1)
  })

  it('reads shares, the 95th percentile and the worst as upper bounds', () => {
    // 900 texels under 1%, 60 in the bin straddling 2%, 40 at about 7%.
    const stats = histogramStats(
      histogram([
        [20, 900],
        [36, 60],
        [45, 40],
      ]),
    )
    const share = (t) => stats.over.find(([x]) => x === t)[1]
    expect(share(0.01)).toBeCloseTo(0.1, 12)
    // The straddling bin counts whole: a bound, never an underestimate.
    expect(share(0.02)).toBeCloseTo(0.1, 12)
    expect(share(0.05)).toBeCloseTo(0.04, 12)
    expect(stats.p95).toBe(binEdge(37))
    expect(stats.worst).toBe(binEdge(46))
    expect(histogramStats(histogram([]))).toBeNull()
  })
})

describe('the quiet machine', () => {
  // The runner (100) under pnpm, its drive.mjs child; the preview's chain
  // over its listener (300); another worktree's gate; another rig.
  const TABLE = `
    1     0 /sbin/launchd
   50     1 /bin/zsh -l
   90    50 node /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs clouds:measure
  100    90 node scripts/clouds/measure.mjs --batch decisions
  101   100 node /repo/scripts/drive.mjs --port 9341 --json
  200    50 node /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs preview
  250   200 node /repo/node_modules/.pnpm/pnpm@12/node_modules/pnpm/bin/pnpm.cjs --filter @inertialref/server exec cf dev
  300   250 /repo/node_modules/.bin/workerd serve
  400     1 node /other/node_modules/vitest/vitest.mjs run
  401   400 node /other/node_modules/vitest/dist/workers/forks.js
  450    50 node /repo/node_modules/vitest/vitest.mjs run
  500     1 node /other/scripts/drive.mjs --port 9333 --js ir.status()
  600     1 /Users/me/.cache/tsgo -p tsconfig.json
  700     1 node /Users/me/notes/server.js
`
  const processes = parseProcesses(TABLE)

  it('parses a process table', () => {
    expect(processes).toHaveLength(14)
    expect(processes[3]).toEqual({
      pid: 100,
      ppid: 90,
      command: 'node scripts/clouds/measure.mjs --batch decisions',
    })
  })

  it('names the program a command runs, under node or not', () => {
    expect(programOf('node /x/pnpm/bin/pnpm.cjs check')).toBe('pnpm')
    expect(
      programOf('node --max-old-space-size=4096 /x/vitest/vitest.mjs run'),
    ).toBe('vitest')
    expect(programOf('/x/oxlint')).toBe('oxlint')
  })

  it('finds another job, and leaves out the runner’s family and the preview’s', () => {
    // 450 shares the runner's shell: a sibling, so it counts.
    expect(busy(processes, [100, 300])).toEqual([
      { pid: 400, program: 'vitest' },
      { pid: 450, program: 'vitest' },
      { pid: 500, program: 'drive.mjs (port 9333)' },
      { pid: 600, program: 'tsgo' },
    ])
    // Without the exemptions the preview's pnpm and the runner's own read busy.
    const all = busy(processes, []).map((p) => p.pid)
    expect(all).toEqual(expect.arrayContaining([90, 101, 200, 250]))
  })

  it('judges the load against half the cores unless told otherwise', () => {
    const quiet = {
      at: 'now',
      load: [4.9, 3, 2],
      cores: 10,
      processes: parseProcesses('  1 0 /sbin/launchd'),
      exempt: [],
      thermal: 0,
    }
    expect(judge(quiet).ok).toBe(true)
    expect(judge({ ...quiet, load: [5.1, 3, 2] }).ok).toBe(false)
    expect(judge(quiet, 2).ok).toBe(false)
    expect(judge({ ...quiet, processes }, 100).busy.length).toBeGreaterThan(0)
  })
})

describe('the rigs and their profiles', () => {
  let rig
  beforeEach(() => {
    rig = mkdtempSync(path.join(tmpdir(), 'ir-clouds-rig-'))
  })
  afterEach(() => rmSync(rig, { recursive: true, force: true }))

  const profile = () => {
    mkdirSync(path.join(profileDir(PORTS.cold, rig), 'GrShaderCache'), {
      recursive: true,
    })
    writeFileSync(
      path.join(profileDir(PORTS.cold, rig), 'GrShaderCache', 'data_0'),
      'x',
    )
  }
  const session = (port, token) =>
    writeFileSync(
      path.join(rig, `session-${port}.json`),
      JSON.stringify({ gpuToken: token, chromePid: null }),
    )
  const down = async () => false

  it('keeps each port’s profile where drive.mjs does', () => {
    expect(profileDir(9342, rig)).toBe(path.join(rig, 'profile-9342'))
  })

  it('deletes the cold port’s profile when no Chrome holds it and the session is this run’s', async () => {
    profile()
    session(PORTS.cold, 'ours')
    await freshProfile(PORTS.cold, { token: 'ours', rig, up: down })
    expect(existsSync(profileDir(PORTS.cold, rig))).toBe(false)
  })

  it('deletes no profile but the cold port’s, none under another session, and none in use', async () => {
    profile()
    await expect(
      freshProfile(PORTS.rig, { token: 'ours', rig, up: down }),
    ).rejects.toThrow(/not the cold-boot port/)
    session(PORTS.cold, 'theirs')
    await expect(
      freshProfile(PORTS.cold, { token: 'ours', rig, up: down }),
    ).rejects.toThrow(/not this run's/)
    rmSync(path.join(rig, `session-${PORTS.cold}.json`))
    await expect(
      freshProfile(PORTS.cold, { token: 'ours', rig, up: async () => true }),
    ).rejects.toThrow(/still answers/)
    expect(
      existsSync(
        path.join(profileDir(PORTS.cold, rig), 'GrShaderCache', 'data_0'),
      ),
    ).toBe(true)
  })

  it('closes no rig it did not start', () => {
    session(PORTS.rig, 'theirs')
    expect(closeOurs(PORTS.rig, 'ours', { rig })).toBe(false)
    expect(closeOurs(PORTS.cold, 'ours', { rig })).toBe(false)
    expect(closeOurs(PORTS.rig, null, { rig })).toBe(false)
  })

  it('ties a figure to a commit, and the preview to a build no older than it', () => {
    const id = { clean: true, committedAt: 2_000, builtAt: 3_000 }
    expect(identityRefusal(id)).toBeNull()
    expect(identityRefusal({ ...id, clean: false })).toMatch(/uncommitted/)
    expect(
      identityRefusal({ ...id, clean: false }, { allowDirty: true }),
    ).toBeNull()
    expect(identityRefusal({ ...id, builtAt: null })).toMatch(/does not exist/)
    expect(identityRefusal({ ...id, builtAt: 1_000 })).toMatch(
      /older than HEAD/,
    )
  })
})

const hasMagick = spawnSync('magick', ['-version']).status === 0

describe('the display-referred difference', () => {
  it('reads the normalized RMSE magick prints', () => {
    expect(parseRmse('4633.67 (0.0707053)')).toBe(0.0707053)
    expect(parseRmse('0 (0)')).toBe(0)
    expect(() => parseRmse('compare: unable to open image')).toThrow(/no RMSE/)
  })

  it('refuses two sizes rather than score the crop', async () => {
    const run = async (args) =>
      args[0] === 'identify'
        ? {
            status: 0,
            stdout: args.at(-1) === 'a.png' ? '64 32' : '32 32',
            stderr: '',
          }
        : { status: 1, stdout: '', stderr: '32768 (0.500008)' }
    await expect(difference('a.png', 'b.png', { run })).rejects.toThrow(
      /64×32 and b.png is 32×32/,
    )
  })

  it.skipIf(!hasMagick)(
    'differences two frames, half of them 10% apart',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'ir-clouds-diff-'))
      try {
        const [a, b] = [path.join(dir, 'a.png'), path.join(dir, 'b.png')]
        spawnSync('magick', ['-size', '64x32', 'xc:gray(50%)', a])
        spawnSync('magick', [
          '-size',
          '64x32',
          'xc:gray(50%)',
          '-fill',
          'gray(60%)',
          '-draw',
          'rectangle 0,0 31,31',
          b,
        ])
        const d = await difference(a, b)
        // √(½ · 0.1²) = 0.0707 over the frame; half the pixels pass both levels.
        expect(d.rmse).toBeCloseTo(0.0707, 3)
        expect(d.over).toEqual({ '3%': 0.5, '8%': 0.5 })
        expect([d.width, d.height]).toEqual([64, 32])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
