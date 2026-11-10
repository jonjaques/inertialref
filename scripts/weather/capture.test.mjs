import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import ledger from '../../apps/headless/src/cornerstoneLedger.json' with { type: 'json' }
import { wrap } from '../driveScript.mjs'
import {
  armsOf,
  castArgs,
  castReads,
  checkBuild,
  CAST_DROPS,
  CAST_RATE,
  checkCast,
  checkStill,
  cutFrom,
  dataRoot,
  freshPlate,
  keepShot,
  markCloudsOnly,
  parseCapture,
  planOf,
  planTable,
  presentationRate,
  READ,
  rmseOf,
  roleOf,
  sampleArgs,
  servedAddress,
  STATE,
  STILLS,
  stillArgs,
  takeOf,
  tagOf,
} from './capture.mjs'
import {
  armsOfCast,
  castByKey,
  castName,
  castPath,
  CASTS,
  descentFrames,
  EVENT_AT,
  HELD,
  INSTALL_PATH,
  SAMPLES,
  seekPath,
  setLevers,
  spansReduction,
  startPath,
  stopPath,
} from './descent.mjs'
import {
  baseSource,
  buildSheets,
  checkRecord,
  checkTake,
  keptClip,
  leverHash,
  mediaRows,
  readBase,
  provenance,
  shotOf,
  RECORD_FIELDS,
  role,
  ROLES,
  sunInFrame,
} from './sheet.mjs'

/*
 * The capture tool and its paths, held in Node: what each invocation asks
 * the driver for, what it refuses, what its record carries, and the
 * page-side path run in a context that holds nothing of these modules. Its
 * first real run needs the machine whole and is not here.
 */

const URL_ = 'http://localhost:8787/'
const DEG = Math.PI / 180

// `buildSheets` refuses without ImageMagick or ffmpeg rather than write half
// a sheet, and CI's Linux runner has neither, so the tests that draw a sheet
// or measure a plate run where the capture itself can.
const hasSheetTools = ['magick', 'ffmpeg'].every(
  (tool) => spawnSync(tool, ['-version']).status === 0,
)

/** The `--js` expressions of an invocation, in order. */
const jsOf = (args) =>
  args.flatMap((one, i) => (one === '--js' ? [args[i + 1]] : []))

describe('the capture’s plan', () => {
  it('takes eight stills, E1 to E3 and the guard in two arms, and leaves G5 and G6 to their casts', () => {
    expect(STILLS.map(tagOf)).toEqual([
      'e1',
      'e2',
      'e3',
      'g1',
      'g2',
      'g3',
      'g4',
      'guard',
    ])
    expect(armsOf('weather-e2-limb-dusk')).toEqual(['volume', 'deck'])
    expect(armsOf('weather-g4-over-deck')).toEqual(['volume'])
    // The overlay guard: a deck beside a guard pair.
    expect(armsOf('weather-guard-station')).toEqual(['volume', 'deck'])
    expect(roleOf('weather-guard-station', 'volume')).toBe('guard-pair')
    expect(roleOf('weather-e1-cumulus-orbit', 'deck')).toBe('deck')
    expect(roleOf('weather-g1-fair', 'volume', 'low-anchor')).toBe('low-anchor')
  })

  it('takes every cast a check names and the held casts, and leaves K’s two retired ones to --baseline-casts', () => {
    const all = parseCapture(['--phase', '1', '--url', URL_])
    expect(all.stills).toHaveLength(8)
    const names = all.casts.map((one) => `${tagOf(one.id)}/${one.speed}`)
    expect(names).toEqual([
      'g6/slow',
      'g6/fast',
      'g6/climate',
      'g6/injected',
      'g6/zoom',
      'g5/fly',
      'g1/fly',
      'e1/clock-1x',
      'e1/clock-100x',
      'e1/clock-1000x',
      'g1/clock-1x',
      'e1/cut',
      'e1/scrub',
      'g6/held',
      'g6/held-zoom',
      'g5/held',
      'g1/held-2m',
      'g1/held',
      'e1/held',
    ])
    expect(names).not.toContain('g4/zoom')
    expect(names).not.toContain('e1/fly')
    expect(
      parseCapture(['--phase', '1', '--url', URL_, '--baseline-casts'])
        .casts.map((one) => `${tagOf(one.id)}/${one.speed}`)
        .filter((one) => ['g4/zoom', 'e1/fly'].includes(one)),
    ).toHaveLength(2)
    // Every check of the rubric's continuity table that phase 1 reads, and
    // the detector's controls (§4), has a cast.
    const checks = new Set(all.casts.flatMap((one) => one.checks))
    for (const check of ['C1', 'C2', 'C3', 'C4', 'C6', 'C7', 'C8', 'C9', '§4'])
      expect(checks.has(check), check).toBe(true)
  })

  it('reads its subset, its pairs, its cut and its samples from the command line, and refuses what names nothing', () => {
    const some = parseCapture([
      '--phase',
      '1',
      '--url',
      URL_,
      '--only',
      'e1,g6',
      '--cut',
      'g3',
      '--pairs',
      '5',
      '--samples',
      'weather-g6-descent-slow:400..402',
      '--gpu-wait',
      '1800',
    ])
    expect(some.stills).toEqual(['weather-e1-cumulus-orbit'])
    expect(some.pairs).toBe(5)
    expect(some.gpuWaitMs).toBe(1_800_000)
    // A cut to G3 comes from the other body, and keeps its frames as a cast.
    const cut = some.casts.find((one) => one.id === 'weather-g3-underlit-dusk')
    expect(cut).toMatchObject({ speed: 'cut', boot: cutFrom(cut.id) })
    expect(cutFrom('weather-g3-underlit-dusk')).toMatch(/^weather-e/)
    // E1's cut is in the set already; asking for it adds none.
    const twice = parseCapture(['--phase', '1', '--url', URL_, '--cut', 'e1'])
    expect(twice.casts.filter((one) => one.speed === 'cut')).toHaveLength(1)
    expect(some.samples.at(-1).frames).toEqual([400, 401, 402])
    expect(
      parseCapture(['--phase', '1', '--url', URL_, '--no-casts']).casts,
    ).toEqual([])
    // A dry run needs no preview.
    expect(parseCapture(['--phase', '1', '--dry-run']).dryRun).toBe(true)
    for (const argv of [
      ['--url', URL_],
      ['--phase', '1'],
      ['--phase', '1', '--url', URL_, '--only', 'e9'],
      ['--phase', '1', '--url', URL_, '--cut', 'g6'],
      ['--phase', '1', '--url', URL_, '--gpu-wait', '-1'],
      ['--phase', '1', '--url', URL_, '--pairs', '2.5'],
      ['--phase', '1', '--url', URL_, '--role', 'deck'],
      ['--phase', '1', '--url', URL_, '--samples', 'nothing:1..2'],
      [
        '--phase',
        '1',
        '--url',
        URL_,
        '--samples',
        'weather-g6-descent-fast:9..2',
      ],
    ])
      expect(() => parseCapture(argv), argv.join(' ')).toThrow()
  })

  it('plans each take with its preset, role, arm and frames, and the noise floor as ten boots a still', () => {
    const plan = planOf(parseCapture(['--phase', '1', '--dry-run']))
    expect(plan.filter((one) => one.kind === 'still')).toHaveLength(12)
    expect(
      plan
        .filter((one) => one.preset === 'weather-guard-station')
        .map((one) => [one.arm, one.role]),
    ).toEqual([
      ['volume', 'guard-pair'],
      ['deck', 'deck'],
    ])
    const injected = plan.find((one) => one.preset.includes('injected'))
    expect(injected).toMatchObject({ role: 'injected-defect', arm: 'on' })
    expect(plan.filter((one) => one.role === 'clouds-off').length).toBe(9)
    const entry = plan.find((one) =>
      one.preset.startsWith('weather-g5-inside-fly'),
    )
    expect(entry).toMatchObject({
      kind: 'samples',
      role: 'settled-sample',
      frames: 600,
    })
    const pairs = planOf(
      parseCapture([
        '--phase',
        '1',
        '--dry-run',
        '--pairs',
        '5',
        '--no-casts',
        '--no-default-samples',
      ]),
    )
    expect(pairs).toHaveLength(12)
    for (const one of pairs)
      expect(one).toMatchObject({
        kind: 'pairs',
        role: 'reference-run',
        frames: 10,
      })
    expect(planTable(pairs)).toMatch(
      /12 takes, 120 frames, about [\d.]+ h \(planned, not measured\)$/,
    )
  })

  it('asks for the flag in the volume arm alone, and settles and waits before it reads and shoots', () => {
    const volume = stillArgs('weather-e1-cumulus-orbit', 'volume', 'a.png')
    const deck = stillArgs('weather-e1-cumulus-orbit', 'deck', 'b.png')
    expect(volume).toContain('clouds=1')
    expect(deck).not.toContain('clouds=1')
    for (const args of [volume, deck]) {
      for (const query of ['chrome=0', 'layers=0', 'output=standard'])
        expect(args).toContain(query)
      const order = ['--settle', '--wait', '--js', '--shot'].map((flag) =>
        args.indexOf(flag),
      )
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    }
  })

  it('starts every cast from its first path frame, settled and quiet, and only then casts', () => {
    for (const cast of [...CASTS, ...HELD])
      for (const clouds of armsOfCast(cast).map((arm) => arm === 'on')) {
        const args = castArgs(cast, clouds, 'plate.png')
        const seek = args.indexOf(seekPath(castPath(cast), 0))
        const start = args.indexOf(startPath(castPath(cast)))
        const between = args.slice(seek, start)
        // Seek frame 0, settle, a second's quiet, read the state, start.
        expect(seek, castName(cast, clouds)).toBeGreaterThan(
          args.indexOf(INSTALL_PATH),
        )
        expect(between).toContain('--settle')
        expect(between).toContain('--wait')
        expect(between.indexOf('--settle')).toBeLessThan(
          between.indexOf('--wait'),
        )
        expect(args[start - 2]).toBe(STATE)
        expect(args.indexOf('--cast')).toBe(start + 1)
        expect(args[args.indexOf('--cast') + 1]).toBe(String(cast.frames + 90))
      }
  })

  it('takes a control with the volume off, a lever where a cast names one, and finds each answer by place', () => {
    const [slow] = CASTS
    const off = castArgs(slow, false)
    expect(off.join(' ')).toContain('on: false')
    expect(castArgs(slow, true).join(' ')).not.toContain('on: false')
    const injected = castByKey('weather-g6-descent-injected')
    const args = castArgs(injected, true)
    expect(jsOf(args)[0]).toBe(setLevers({ handoverBand: 1, maxSteps: 24 }))
    // The answers come back in the `--js` order; a cut's settled read last.
    const answer = (values) => ({
      results: values.map((value) => ({ step: 'js', value })),
    })
    const values = jsOf(args).map((_, i) => i)
    const reads = castReads(injected, true, answer(values))
    expect(reads.levers).toBe(0)
    expect(jsOf(args)[reads.state]).toBe(STATE)
    expect(jsOf(args)[reads.stop]).toBe(stopPath())
    const cut = castByKey('weather-e1-cumulus-orbit-cut')
    const cutJs = jsOf(castArgs(cut, true, 'p.png'))
    const cutReads = castReads(cut, true, answer(cutJs.map((_, i) => i)))
    expect(cutJs[cutReads.stop]).toBe(stopPath())
    expect(cutJs[cutReads.read]).toBe(READ)
    expect(cutJs[cutReads.state]).toBe(STATE)
    expect(
      castReads(slow, false, answer(jsOf(off).map((_, i) => i))).levers,
    ).toBe('set')
  })

  it('schedules the descents from 400 km to 2 m at the design’s frame counts, and G5 over the ledger’s path', () => {
    // ln(2·10⁵)/−ln(0.988) is 1,011.03, so the ground is reached on frame
    // 1,012; the design's 1,010 divides by the rate's own logarithm rounded.
    expect(descentFrames(400_000, 0.012)).toBe(1012)
    expect(descentFrames(400_000, 0.04)).toBe(300)
    const g5 = castByKey('weather-g5-inside-fly')
    expect(g5.frames).toBe(ledger.g5.frames)
    expect(g5.path.metersAFrame).toBe(ledger.g5.metersAFrame)
    // The continuous entry is a contiguous stretch of that path.
    const entry = SAMPLES.find((one) => one.cast === 'weather-g5-inside-fly')
    expect(entry.frames).toEqual(Array.from({ length: 600 }, (_, k) => k))
    // C1's zoom stands at G6's start, pitched to −45°.
    expect(castByKey('weather-g6-descent-zoom').path.stancePitch).toBe(-45)
  })

  it('places each clock cast across a reduction, and a scrub on its picture’s instant', () => {
    const clock = castByKey('weather-e1-cumulus-orbit-clock-100x')
    const { start } = castPath(clock)
    // At 60 Hz the cast's middle frame is the reduction.
    const reduction = Math.ceil(17_424.925169385428 / 3600) * 3600
    expect(start + (150 / 60) * 100).toBeCloseTo(reduction, 9)
    const log = Array.from({ length: 300 }, (_, k) => ({
      k,
      time: start + (k / 45) * 100,
    }))
    expect(spansReduction(clock, log)).toMatchObject({
      reduction,
      inside: true,
    })
    expect(spansReduction(clock, log).seconds).toBeCloseTo((299 / 45) * 100, 6)
    expect(spansReduction(clock, log.slice(0, 2)).inside).toBe(false)
    expect(spansReduction(CASTS[0], log)).toBeNull()
    const scrub = castByKey('weather-e1-cumulus-orbit-scrub')
    expect(castPath(scrub)).toMatchObject({
      kind: 'scrub',
      time: 17_424.925169385428,
      at: EVENT_AT,
    })
    expect(castArgs(scrub, true, 'p.png').join(' ')).toContain(
      `ir.observatory.setTime(${17_424.925169385428 - 10_800})`,
    )
  })

  it('takes settled stills along a path by seeking each frame, settling and shooting', () => {
    const fast = castByKey('weather-g6-descent-fast')
    const args = sampleArgs(fast, [75, 150], ['a.png', 'b.png'])
    const js = jsOf(args)
    expect(js).toEqual([
      INSTALL_PATH,
      seekPath(fast.path, 75),
      READ,
      seekPath(fast.path, 150),
      READ,
    ])
    expect(args.filter((one) => one === '--shot')).toHaveLength(2)
    expect(args.indexOf('--shot')).toBeGreaterThan(args.indexOf(READ))
  })

  it('writes to the main checkout’s .data, whichever worktree it runs in', () => {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim()
    expect(dataRoot()).toBe(
      path.join(path.dirname(path.resolve(common)), '.data/weather'),
    )
  })
})

/*
 * A page log at a rate, each instant read late or early by up to `jitter`
 * ms, as a callback reads `performance.now()`, with a frame missed before
 * each path frame in `missed`. Instants are epoch milliseconds, where a
 * float64 steps by 1.2 × 10⁻⁴ ms, as the page's are.
 */
function jitteredLog({ intervals, jitter, missed, slot }) {
  const at = [1.7628e12]
  for (let k = 1; k < intervals.length; k += 1)
    at.push(at[k - 1] + intervals[k] + (missed.includes(k) ? slot(k) : 0))
  return at.map((t, k) => ({ k, at: t + jitter[k] }))
}

describe('the drop rule, over rates and jitter', () => {
  const missedAt = fc
    .uniqueArray(fc.integer({ min: 20, max: 360 }), { maxLength: 6 })
    .map((ks) => ks.sort((a, b) => a - b))
    // Apart: two adjacent misses are a run, which a second property holds.
    .filter((ks) => ks.every((k, i) => i === 0 || k - ks[i - 1] > 3))
  const jitter = fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
    minLength: 390,
    maxLength: 390,
  })

  it('finds each single missed frame at a steady rate from 40 to 70 Hz, with a millisecond of jitter, and no other', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 40, max: 70, noNaN: true }),
        jitter,
        missedAt,
        (hz, wobble, missed) => {
          const period = 1000 / hz
          const log = jitteredLog({
            intervals: Array.from({ length: 390 }, () => period),
            jitter: wobble,
            missed,
            slot: () => period,
          })
          const kept = checkCast('c', log, null, { frames: 300 })
          expect(kept.dropped.map((one) => one.frame)).toEqual(missed)
          for (const one of kept.dropped) expect(one.missed).toBe(1)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('finds each missed slot in the 25 and 33.3 ms cadence a 120 Hz panel gives a 40 Hz page, and reads the cadence itself as none', () => {
    const vsync = 1000 / 120
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(3, 4), { minLength: 390, maxLength: 390 }),
        jitter,
        missedAt,
        (slots, wobble, missed) => {
          const log = jitteredLog({
            intervals: slots.map((n) => n * vsync),
            jitter: wobble,
            missed,
            slot: () => 3 * vsync,
          })
          const kept = checkCast('c', log, null, { frames: 300 })
          expect(kept.dropped.map((one) => one.frame)).toEqual(missed)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('what the capture refuses', () => {
  const read = {
    mode: 'standard',
    chrome: false,
    settled: { ok: true },
    weather: 'drawn',
    clouds: { on: true, served: 'g:milky-way/s:SOL/b:2' },
    cloud: { texels: 81_000, share: 0.4 },
  }
  const E1 = 'weather-e1-cumulus-orbit'

  it('a still not settled, not in SDR, with the interface up, not in its arm’s weather, or not drawing its own body’s volume', () => {
    expect(checkStill(E1, 'volume', read)).toBe(read)
    expect(
      checkStill(E1, 'deck', {
        ...read,
        weather: 'unavailable',
        clouds: null,
      }),
    ).toBeTruthy()
    for (const bad of [
      undefined,
      { ...read, settled: { ok: false, clouds: { pending: true } } },
      { ...read, mode: 'extended' },
      { ...read, chrome: true },
      { ...read, weather: 'unavailable' },
      { ...read, weather: 'none' },
      // The levers said drawn, and the frame served nothing: a forced
      // address no body has, and the plate is the deck.
      { ...read, clouds: { on: false, served: null } },
      { ...read, clouds: { on: true, served: null } },
      // Another body served: the volume drawn is not the picture's.
      { ...read, clouds: { on: true, served: 'g:milky-way/s:SOL/b:21' } },
      // Drawn, and nothing read back from the trace.
      { ...read, cloud: null },
    ])
      expect(() => checkStill(E1, 'volume', bad)).toThrow(/refused/)
    expect(() => checkStill(E1, 'deck', read)).toThrow(/deck arm/)
    // The guard's clouds are Earth's, the body its station goes round.
    expect(servedAddress('weather-guard-station')).toBe('g:milky-way/s:SOL/b:2')
    expect(checkStill('weather-guard-station', 'volume', read)).toBe(read)
    expect(servedAddress('weather-g1-fair')).toBe(
      'g:milky-way/s:P222_3_2_k/b:3',
    )
  })

  it('a take whose page was built from another commit, or from an edited tree', () => {
    const commit = 'abcdef1234567890abcdef1234567890abcdef12'
    const at = (id) => ({ build: { id, tree: null } })
    expect(checkBuild('e1', at('abcdef12'), commit)).toBe('abcdef12')
    // A tag's describe, and CI's branch form, both name the commit.
    expect(checkBuild('e1', at('v1.0-3-gabcdef12'), commit)).toBeTruthy()
    expect(checkBuild('e1', at('weather-p1-u@abcdef12'), commit)).toBeTruthy()
    for (const bad of [
      at('abcdef12-dirty'),
      // The baseline's own case: plates of 23f173bc, recorded at ab301957.
      at('23f173bc'),
      {},
      undefined,
    ])
      expect(() => checkBuild('e1', bad, commit)).toThrow(/refused/)
  })

  const log = (hz, n = 120) =>
    Array.from({ length: n }, (_, k) => ({ k, at: 1e12 + (k * 1000) / hz }))
  /** Hold `missed` frames back before path frame `k`: one gap. */
  const gap = (entries, k, missed, hz) => {
    for (let i = k; i < entries.length; i += 1)
      entries[i].at += (missed * 1000) / hz
    return entries
  }

  it('keep a cast at the rate it was presented at until 60 Hz can be held, and take one the screencast subsampled again', () => {
    expect(CAST_RATE.held).toBe(false)
    expect(presentationRate(log(60))).toBeCloseTo(60, 3)
    const cast = { frames: 100 }
    expect(checkCast('c', log(60), null, cast)).toMatchObject({
      retake: false,
      atSixty: true,
      dropped: [],
    })
    // The screencast's instants: every frame of the path, or a third of it.
    const shots = (entries, every = 1) =>
      entries.filter((_, k) => k % every === 0).map((one) => one.at / 1000)
    const full = checkCast('c', log(60), shots(log(60)), cast)
    expect(full.coverage).toBeCloseTo(1, 9)
    expect(full.retake).toBe(false)
    // Chrome encoding at 20 fps behind a 60 Hz page: the clip holds every
    // third path frame, however many frames the screencast was asked for.
    const thinned = checkCast('c', log(60, 2070), shots(log(60, 2070), 3), {
      frames: 600,
    })
    expect(thinned.coverage).toBeCloseTo(1 / 3, 2)
    expect(thinned.retake).toBe(true)
    // No instants, no figure: the record says so rather than guessing.
    expect(checkCast('c', log(60), null, cast)).toMatchObject({
      coverage: null,
      retake: false,
    })
    // The rig's own: the clouds-on descent at 2880 × 1800 on the M6.
    for (const hz of [42.6, 120, 72, 50, CAST_RATE.high + 0.5]) {
      const kept = checkCast('c', log(hz), null, cast)
      // To 0.01 Hz: the log's instants are epoch milliseconds, where a
      // float64 holds a part in 10¹⁶ of 10¹², a tenth of a microsecond.
      expect(kept.hz).toBeCloseTo(hz, 2)
      expect(kept.atSixty).toBe(false)
    }
    expect(() => checkCast('c', [], null, cast)).toThrow(/no measurable rate/)
  })

  it('refuse a cast outside 58 to 62 Hz once the rig can hold 60', () => {
    const cast = { frames: 100 }
    for (const hz of [42.6, 120, 72, 50, CAST_RATE.high + 0.5])
      expect(() => checkCast('c', log(hz), null, cast, true)).toThrow(/60 Hz/)
    expect(checkCast('c', log(60), null, cast, true).atSixty).toBe(true)
  })

  it('keep a cast that dropped a few frames, each listed by path frame, height and distance', () => {
    const fly = { frames: 300, path: { kind: 'fly', metersAFrame: 2.5 } }
    for (const hz of [60, 42.6]) {
      const entries = log(hz, 390).map((one) => ({ ...one, height: 1487 }))
      gap(entries, 80, 1, hz)
      gap(entries, 200, 2, hz)
      const kept = checkCast('c', entries, null, fly)
      expect(kept.dropped.map((one) => [one.frame, one.missed])).toEqual([
        [80, 1],
        [200, 2],
      ])
      expect(kept.dropped[1]).toMatchObject({ height: 1487, distance: 500 })
    }
    // The cadence a 120 Hz panel gives a 40 Hz page, 25 and 33.3 ms
    // intervals mixed, drops nothing.
    const mixed = Array.from({ length: 120 }, (_, k) => ({
      k,
      at: 1e12 + Math.floor(k / 2) * (25 + 1000 / 30) + (k % 2) * 25,
    }))
    expect(checkCast('c', mixed, null, { frames: 100 }).dropped).toEqual([])
    // A drop past the path's end and its tail is not the path's.
    const late = gap(log(60, 400), 300, 5, 60)
    expect(checkCast('c', late, null, { frames: 100 }).dropped).toEqual([])
  })

  it('refuse a cast past 3% of its frames, or three missed in a row, with where they fell', () => {
    const cast = { frames: 300 }
    const many = log(60, 390)
    // Twelve single drops, two of them adjacent: 12 of 390 is past 3%.
    for (const k of [20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 221])
      gap(many, k, 1, 60)
    expect(12 / 390).toBeGreaterThan(CAST_DROPS.share)
    expect(() => checkCast('c', many, null, cast)).toThrow(/3% or 3 in a row/)
    try {
      checkCast('c', many, null, cast)
    } catch (error) {
      expect(error.dropped.map((one) => one.frame)).toContain(221)
    }
    // Three in one gap is three in a row, however few frames that is.
    expect(() =>
      checkCast('c', gap(log(60, 390), 50, 3, 60), null, cast),
    ).toThrow(/3 in a row/)
    // Two gaps on adjacent frames add: 2 and 1 is three in a row.
    const adjacent = gap(gap(log(60, 390), 50, 2, 60), 51, 1, 60)
    expect(() => checkCast('c', adjacent, null, cast)).toThrow(/3 in a row/)
    // Two in a row, and under 3%: kept.
    expect(
      checkCast('c', gap(log(60, 390), 50, 2, 60), null, cast).dropped,
    ).toHaveLength(1)
  })

  it('refuse a cast whose path stopped early, or whose descent never reached the ground', () => {
    // The page's loop threw at frame 200 of a 1,012-frame descent; the
    // screencast went on, and the 200 intervals it logged are clean.
    const stopped = log(60, 200).map((one) => ({ ...one, height: 1e5 }))
    expect(() =>
      checkCast('c', stopped, null, { frames: 1012, path: CASTS[0].path }),
    ).toThrow(/stopped at frame 200 of 1012/)
    try {
      checkCast('c', stopped, null, { frames: 1012, path: CASTS[0].path })
    } catch (error) {
      // Retaken, as a run of drops is, and recorded with why.
      expect(error.dropped).toEqual([])
    }
    const descent = log(60, 1102).map((one) => ({
      ...one,
      height: Math.max(400_000 * 0.988 ** one.k, 2),
    }))
    expect(
      checkCast('c', descent, null, { frames: 1012, path: CASTS[0].path })
        .dropped,
    ).toEqual([])
    descent[1012].height = 3
    expect(() =>
      checkCast('c', descent, null, { frames: 1012, path: CASTS[0].path }),
    ).toThrow(/3 m at its last frame/)
  })

  it('mark a clouds-on drop the clouds’ own where its control dropped nothing within ten path frames', () => {
    const on = [{ frame: 100 }, { frame: 300 }, { frame: 500 }]
    const off = [{ frame: 90 }, { frame: 311 }]
    expect(markCloudsOnly(on, off).map((one) => one.cloudsOnly)).toEqual([
      false,
      true,
      true,
    ])
    expect(
      markCloudsOnly(on, null).every((one) => one.cloudsOnly === null),
    ).toBe(true)
  })

  it('read each still’s cloud texel share and its sun from the page', async () => {
    const page = (capture) =>
      vm.runInNewContext(READ, {
        Math,
        ir: {
          cloudRadiance: async () => capture,
          observatory: {
            time: 1,
            status: () => ({
              target: { address: 'g:milky-way/s:P/b:3' },
              state: {},
              look: { yaw: 0, pitch: 0 },
              surface: {
                stance: { latitude: 0.1, longitude: 0.2, heading: 0, pitch: 0 },
              },
            }),
          },
          sun: (address, place) => ({ address, place }),
          light: () => null,
          settled: () => ({ ok: true }),
          clouds: () => null,
          build: () => null,
        },
        engine: {
          gl: { description: { mode: 'standard' } },
          chrome: false,
          lens: null,
          sensorSettings: { mode: 'enhanced' },
          pictureWeather: { outcome: 'drawn' },
        },
      })
    const read = await page({
      width: 2,
      height: 2,
      luminance: Float32Array.from([1, 3, 0.5, 0.5]),
      cloud: Uint8Array.from([1, 1, 0, 0]),
    })
    expect(read.cloud).toEqual({
      texels: 4,
      share: 0.5,
      meanCloud: 2,
      meanClear: 0.5,
    })
    expect(read.weather).toBe('drawn')
    expect(read.processing).toBe('enhanced')
    expect(read.sun.place.latitude).toBeCloseTo(0.1 / DEG, 9)
    // No capture where nothing draws: the deck arm, or a failed readback.
    expect((await page(null)).cloud).toBeNull()
  })

  it('put the antisolar point where the glory is: G4’s at the plate’s center', () => {
    const lens = { focalLength: 17.137776080905375, gauge: 24, zoom: 1 }
    const at = (heading, pitch, sun) =>
      sunInFrame({
        stance: {
          surface: { heading: heading * DEG, pitch: pitch * DEG },
          look: { yaw: 0, pitch: 0 },
        },
        sun,
        lens,
      })
    const g4 = at(300, -35, { elevation: 35, azimuth: 120 })
    expect(g4.antisolar.x).toBeCloseTo(1440, 6)
    expect(g4.antisolar.y).toBeCloseTo(900, 6)
    expect(g4.sunInCamera[2]).toBeCloseTo(-1, 9)
    // Five degrees left of the antisolar point puts it right of center.
    expect(
      at(295, -35, { elevation: 35, azimuth: 120 }).antisolar.x,
    ).toBeGreaterThan(1440)
    // Facing the sun, the antisolar point is behind the camera.
    expect(at(120, 35, { elevation: 35, azimuth: 120 })).toMatchObject({
      antisolar: null,
      inFrame: false,
    })
    expect(
      sunInFrame({ stance: { surface: null }, sun: null, lens }),
    ).toBeNull()
  })

  it('reads the rate past a hitch: the median, not the mean', () => {
    const hitched = log(60)
    for (let k = 10; k < hitched.length; k += 1) hitched[k].at += 50
    expect(presentationRate(hitched)).toBeCloseTo(60, 3)
  })

  it.skipIf(!hasSheetTools)(
    'measure two boots’ RMSE as a share of full scale',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'weather-rmse-'))
      const [a, b] = ['a.png', 'b.png'].map((one) => path.join(dir, one))
      execFileSync('magick', ['-size', '8x8', 'xc:gray(50%)', a])
      execFileSync('magick', ['-size', '8x8', 'xc:gray(50%)', b])
      expect(await rmseOf(a, b)).toBe(0)
      execFileSync('magick', ['-size', '8x8', 'xc:gray(60%)', b])
      expect(await rmseOf(a, b)).toBeCloseTo(0.1, 2)
    },
  )
})

describe('the files a run keeps', () => {
  it('keep a shot under its name only once it passes, and leave the last good plate when it does not', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weather-shot-'))
    const file = path.join(dir, 'weather-e1-cumulus-orbit-volume.png')
    const take = takeOf(file)
    expect(take).toBe(
      path.join(dir, 'weather-e1-cumulus-orbit-volume.take.png'),
    )
    await writeFile(file, 'last good')
    await writeFile(take, 'refused')
    await expect(
      keepShot(take, file, () => {
        throw new Error('not settled; refused')
      }),
    ).rejects.toThrow(/refused/)
    expect(await readFile(file, 'utf8')).toBe('last good')
    expect(existsSync(take)).toBe(false)
    await writeFile(take, 'this run')
    expect(await keepShot(take, file, () => 'read')).toBe('read')
    expect(await readFile(file, 'utf8')).toBe('this run')
    expect(existsSync(take)).toBe(false)
  })

  it('compare a cut with this run’s fresh plate alone', () => {
    const record = {
      stills: [
        {
          id: 'weather-e1-cumulus-orbit',
          arm: 'deck',
          file: 'e1-deck.png',
          role: { name: 'deck' },
        },
        {
          id: 'weather-e1-cumulus-orbit',
          arm: 'volume',
          file: 'e1-volume.png',
          role: { name: 'candidate' },
        },
      ],
    }
    expect(freshPlate(record, 'weather-e1-cumulus-orbit')).toBe('e1-volume.png')
    // `--only g1 --cut e1` took no E1 plate: nothing to compare with.
    expect(freshPlate({ stills: [] }, 'weather-e1-cumulus-orbit')).toBeNull()
  })
})

describe('the record', () => {
  const run = {
    commit: 'abc',
    clean: true,
    fixtures: { references: 'r', cornerstones: 'c' },
  }
  const read = {
    stance: { address: 'g:x', state: {}, look: {}, surface: null },
    lens: { focalLength: 20 },
    time: 5,
    processing: 'enhanced',
    clouds: {
      levers: { on: true, scenario: 'fair-cumulus' },
      extents: { render: [2880, 1800] },
    },
  }

  it('carries each take’s provenance and role, and a cast its rate', () => {
    const take = provenance(
      run,
      'weather-e1-cumulus-orbit',
      read,
      role('candidate'),
    )
    for (const field of RECORD_FIELDS) expect(take, field).toHaveProperty(field)
    expect(take.stance).toMatchObject({
      id: 'weather-e1-cumulus-orbit',
      address: 'g:x',
      time: 5,
    })
    expect(take.processing).toBe('enhanced')
    expect(checkTake(take)).toBe(take)
    expect(() => checkTake(take, true)).toThrow(/no rate/)
    expect(
      checkTake({ ...take, rate: { hz: 42.6, held: false } }, true),
    ).toBeTruthy()
    expect(role('clouds-off', ['x']).differences).toEqual([
      ...ROLES['clouds-off'],
      'x',
    ])
  })

  it('hashes the levers whatever order the page wrote them in, and names a page without them', () => {
    const a = leverHash({
      levers: { on: true, maxSteps: 192 },
      extents: { render: [1, 2] },
    })
    const b = leverHash({
      levers: { maxSteps: 192, on: true },
      extents: { render: [1, 2] },
    })
    expect(a.hash).toBe(b.hash)
    expect(a.size).toEqual([1, 2])
    expect(
      leverHash({
        levers: { on: true, maxSteps: 24 },
        extents: { render: [1, 2] },
      }).hash,
    ).not.toBe(a.hash)
    expect(leverHash(null)).toMatchObject({ size: null })
    expect(typeof leverHash(null).hash).toBe('string')
  })

  it('is refused by its readers when a take lacks any field', () => {
    const take = provenance(
      run,
      'weather-e1-cumulus-orbit',
      read,
      role('candidate'),
    )
    for (const field of RECORD_FIELDS) {
      const { [field]: _, ...without } = take
      expect(() => checkRecord({ stills: [without] }), field).toThrow(
        /the record is refused/,
      )
    }
    expect(() =>
      checkTake({ ...take, role: { name: 'hero', differences: [] } }),
    ).toThrow(/role/)
    expect(() => checkTake({ ...take, fixtures: { references: 'r' } })).toThrow(
      /cornerstones/,
    )
    expect(() => checkRecord({ casts: [take] })).toThrow(/rate/)
    expect(
      checkRecord({ stills: [take], casts: [], samples: [take] }),
    ).toBeTruthy()
  })
})

/** A page with an observatory standing somewhere, and nothing of these modules. */
function fakePage({ surface = true } = {}) {
  const stance = {
    latitude: 0.1,
    longitude: 0.2,
    height: 400_000,
    heading: Math.PI / 2,
    pitch: -1.5,
  }
  const calls = {
    height: [],
    pitch: [],
    moved: [],
    heading: [],
    lens: [],
    clock: [],
    preset: [],
    time: [],
  }
  let lens = { focalLength: 20, gauge: 24, zoom: 1 }
  const frames = []
  const observatory = {
    time: 1000,
    status: () => ({
      surface: surface
        ? {
            stance,
            radius: 6_371_000 + 300 + stance.height,
            groundElevation: 300,
          }
        : null,
    }),
    setStanceHeight: (h) => {
      stance.height = h
      calls.height.push(h)
    },
    setPitch: (p) => calls.pitch.push(p),
    setHeading: (h) => calls.heading.push(h),
    moveTo: (at) => {
      stance.latitude = at.latitude
      stance.longitude = at.longitude
      calls.moved.push(at)
    },
    setTime: (t) => {
      observatory.time = t
      calls.time.push(t)
    },
    setTimePaused: (paused) => calls.clock.push(['paused', paused]),
  }
  const context = vm.createContext({
    performance: { timeOrigin: 1e12, now: () => frames.length * (1000 / 60) },
    requestAnimationFrame: (callback) => {
      frames.push(callback)
    },
    engine: {
      framingLens: () => lens,
      requestLens: (next) => {
        lens = next
        calls.lens.push(next.focalLength)
      },
    },
    ir: {
      clouds: () => ({ regime: 'converging', resets: 1 }),
      runClock: (start, warp) => calls.clock.push(['run', start, warp]),
      preset: (id) => calls.preset.push(id),
      observatory,
    },
  })
  /** Run the page's pending frames, `n` times over. */
  const step = (n) => {
    for (let i = 0; i < n; i += 1) {
      const pending = frames.splice(0)
      for (const callback of pending) callback()
    }
  }
  return { context, calls, step, stance }
}

const send = (page, expression) =>
  vm.runInContext(wrap(expression), page.context)

describe('the page-side path', () => {
  it('installs into a page that holds nothing of its module', async () => {
    const page = fakePage()
    expect(await send(page, INSTALL_PATH)).toBe('function')
  })

  it('descends by the frame, not the clock, to 2 m, pitching up between 20 and 2 km', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const [slow] = CASTS
    await send(page, startPath(slow.path))
    page.step(slow.frames + 5)
    const { log, frames } = await send(page, stopPath())
    expect(frames).toBe(slow.frames + 5)
    // h_k = max(400 km · 0.988ᵏ, 2), every frame.
    for (const k of [0, 1, 100, 500])
      expect(log[k].height).toBeCloseTo(Math.max(400_000 * 0.988 ** k, 2), 6)
    expect(log.at(-1).height).toBe(2)
    expect(log.map((one) => one.k)).toEqual(log.map((_, k) => k))
    expect(page.calls.pitch[0]).toBeCloseTo(-87.995 * DEG, 9)
    expect(page.calls.pitch.at(-1)).toBeCloseTo(5 * DEG, 9)
    // The log carries the clouds' regime and resets, and the eye's place
    // and instant, a frame.
    expect(log[3]).toMatchObject({
      regime: 'converging',
      resets: 1,
      latitude: 0.1,
      longitude: 0.2,
      time: 1000,
    })
    // Stopped: no frame runs after it.
    page.step(10)
    expect(page.calls.height).toHaveLength(slow.frames + 6)
  })

  it('seeks a frame of a path from its own origin, however often it is asked', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const [slow] = CASTS
    const first = await send(page, seekPath(slow.path, 100))
    const again = await send(page, seekPath(slow.path, 200))
    // Each from 400 km, not from where the last seek left the eye.
    expect(first.height).toBeCloseTo(400_000 * 0.988 ** 100, 6)
    expect(again.height).toBeCloseTo(400_000 * 0.988 ** 200, 6)
    // No loop runs after a seek.
    page.step(5)
    expect(page.calls.height).toHaveLength(2)
    // A start after a seek of frame 0 runs from the same origin.
    await send(page, seekPath(slow.path, 0))
    await send(page, startPath(slow.path))
    page.step(2)
    const { log } = await send(page, stopPath())
    expect(log[0].height).toBeCloseTo(400_000, 6)
  })

  it('flies a fixed arc a frame along the heading and holds from its stop', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const ground = castByKey('weather-g1-fair-fly')
    await send(page, startPath(ground.path))
    expect(page.calls.height).toEqual([2])
    page.step(300)
    const { stopAt } = await send(page, stopPath())
    expect(stopAt).toBe(200)
    const moved = page.calls.moved
    const radius = 6_371_000
    const arc = (a, b) =>
      radius *
      Math.acos(
        Math.sin(a.latitude) * Math.sin(b.latitude) +
          Math.cos(a.latitude) *
            Math.cos(b.latitude) *
            Math.cos(a.longitude - b.longitude),
      )
    expect(arc(moved[10], moved[11])).toBeCloseTo(4.2, 3)
    expect(arc(moved[0], moved[200])).toBeCloseTo(200 * 4.2, 1)
    // From frame 200 the eye holds still: the trail measure's stop.
    expect(moved[250]).toEqual(moved[200])
    // East, the heading the stance had: latitude barely moves, longitude grows.
    expect(moved[200].longitude).toBeGreaterThan(moved[0].longitude)
  })

  it('zooms a fixed ratio of focal length a frame, from 60° to 11.4°, at the pitch the cast stands at', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const zoom = castByKey('weather-g6-descent-zoom')
    await send(page, startPath(zoom.path))
    expect(page.calls.pitch[0]).toBeCloseTo(-45 * DEG, 12)
    page.step(320)
    await send(page, stopPath())
    const f = (fov) => 12 / Math.tan((fov * Math.PI) / 360)
    const lens = page.calls.lens
    expect(lens[0]).toBeCloseTo(f(60), 9)
    expect(lens.at(-1)).toBeCloseTo(f(11.4), 9)
    const ratio = lens[51] / lens[50]
    expect(lens[201] / lens[200]).toBeCloseTo(ratio, 12)
  })

  it('holds a clock cast at its start when seeking, runs it on start, and pauses it on stop', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const clock = castPath(castByKey('weather-e1-cumulus-orbit-clock-100x'))
    await send(page, seekPath(clock, 0))
    expect(page.calls.time).toEqual([clock.start])
    expect(page.calls.clock).toEqual([])
    await send(page, startPath(clock))
    page.step(3)
    expect(page.calls.clock).toEqual([['run', clock.start, 100]])
    await send(page, stopPath())
    expect(page.calls.clock.at(-1)).toEqual(['paused', true])
    // The camera never moved.
    expect(page.calls.moved).toEqual([])
  })

  it('cuts and scrubs at the event’s frame, not before the screencast is running', async () => {
    const cut = fakePage()
    await send(cut, INSTALL_PATH)
    await send(cut, startPath(castByKey('weather-e1-cumulus-orbit-cut').path))
    cut.step(EVENT_AT - 1)
    expect(cut.calls.preset).toEqual([])
    cut.step(3)
    expect(cut.calls.preset).toEqual(['weather-e1-cumulus-orbit'])
    const scrub = fakePage()
    await send(scrub, INSTALL_PATH)
    await send(scrub, startPath({ kind: 'scrub', at: EVENT_AT, time: 42 }))
    scrub.step(EVENT_AT + 5)
    expect(scrub.calls.time).toEqual([42])
    // A cut needs no surface: it may start from any picture.
    const still = fakePage({ surface: false })
    await send(still, INSTALL_PATH)
    await expect(
      send(still, startPath({ kind: 'cut', preset: 'x', at: EVENT_AT })),
    ).resolves.toBeTruthy()
  })

  it('refuses a moving path on a page that stands on no surface, and a second start ends the first loop', async () => {
    const still = fakePage({ surface: false })
    await send(still, INSTALL_PATH)
    await expect(send(still, startPath(CASTS[0].path))).rejects.toThrow(
      /no surface/,
    )
    const page = fakePage()
    await send(page, INSTALL_PATH)
    await send(page, startPath(CASTS[0].path))
    page.step(3)
    await send(page, startPath(CASTS[0].path))
    page.step(3)
    // One loop's frames, not two: three frames each start.
    expect((await send(page, stopPath())).frames).toBe(3)
  })
})

describe('the sheets', () => {
  const take = provenance(
    {
      commit: 'abc',
      clean: true,
      fixtures: { references: 'r', cornerstones: 'c' },
    },
    'weather-e1-cumulus-orbit',
    { stance: { address: 'g:x' }, processing: 'enhanced', clouds: null },
    role('candidate'),
  )
  const rate = { hz: 42.57, held: false, atSixty: false }
  const record = {
    phase: 1,
    stills: [
      {
        ...take,
        id: 'weather-e1-cumulus-orbit',
        arm: 'volume',
        file: 'weather-e1-cumulus-orbit-volume.png',
      },
      {
        ...take,
        role: role('deck'),
        id: 'weather-e1-cumulus-orbit',
        arm: 'deck',
        file: 'weather-e1-cumulus-orbit-deck.png',
      },
    ],
    casts: [
      {
        ...take,
        rate,
        id: 'weather-g6-descent',
        speed: 'slow',
        clouds: true,
        dropped: [
          { frame: 10, cloudsOnly: true },
          { frame: 600, cloudsOnly: false },
        ],
        clip: { file: 'weather-g6-descent-slow-on/cast.mp4' },
      },
      {
        ...take,
        rate,
        role: role('clouds-off'),
        id: 'weather-g6-descent',
        speed: 'slow',
        clouds: false,
        hz: 42.57,
        atSixty: false,
        clip: { file: 'weather-g6-descent-slow-off/cast.mp4' },
      },
    ],
  }

  it('write a row a cornerstone, naming its sheet, its plates and its casts', () => {
    const rows = mediaRows(
      record,
      [
        {
          id: 'weather-e1-cumulus-orbit',
          file: 'sheets/weather-e1-cumulus-orbit.png',
        },
      ],
      [],
    ).split('\n')
    expect(rows).toHaveLength(4)
    expect(rows[2]).toContain('[sheet](sheets/weather-e1-cumulus-orbit.png)')
    expect(rows[2]).toContain('[deck](weather-e1-cumulus-orbit-deck.png)')
    // A cast's drops travel with it, and how many the clouds caused.
    expect(rows[3]).toContain(
      '[slow on, 2 dropped, 1 the clouds’](weather-g6-descent-slow-on/cast.mp4)',
    )
    // A cast refused at every boot is named, with its drops and its rate.
    const refusedRows = mediaRows(
      {
        ...record,
        refused: [
          {
            id: 'weather-g5-inside',
            speed: 'fly',
            clouds: true,
            attempts: [
              { hz: 42.4, dropped: [{}, {}] },
              { hz: 42.6, dropped: [{}] },
            ],
          },
        ],
      },
      [],
      [],
    ).split('\n')
    expect(refusedRows.at(-1)).toContain(
      'fly on refused: drops 2, 1 at 42.6 Hz',
    )
    // A cast's rate travels with it until 60 Hz can be held.
    expect(rows[3]).toContain(
      '[slow off, 42.6 Hz, not held at 60](weather-g6-descent-slow-off/cast.mp4)',
    )
  })

  it('show a cast halfway along its path, by the screencast’s instants rather than its index', () => {
    // A page at 60 Hz and a stream at 20: path frame 300 is shot 100.
    const log = Array.from({ length: 900 }, (_, k) => ({
      k,
      at: 1e12 + (k * 1000) / 60,
    }))
    const instants = log
      .filter((_, k) => k % 3 === 0)
      .map((one) => one.at / 1000)
    expect(shotOf(instants, log, 300)).toBe(100)
    expect(shotOf([], log, 300)).toBeNull()
  })

  it('find the base’s plate in its directory, or among its record’s URLs', () => {
    expect(baseSource(null, 'a.png')).toBeNull()
    expect(
      baseSource(
        { kind: 'record', urls: { 'a.png': 'https://x/a.png' } },
        'a.png',
      ),
    ).toBe('https://x/a.png')
    expect(baseSource({ kind: 'record', urls: {} }, 'a.png')).toBeNull()
    expect(
      baseSource(
        { kind: 'dir', dir: '/nowhere', files: new Set(['a.png']) },
        'a.png',
      ),
    ).toBeNull()
  })

  it('answer only what a record kept: a base’s listed plates, and this run’s clips', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weather-base-'))
    for (const file of ['kept-volume.png', 'refused-volume.png'])
      await writeFile(path.join(dir, file), 'plate')
    await writeFile(
      path.join(dir, 'record.json'),
      JSON.stringify({
        phase: 1,
        stills: [{ id: 'kept', file: 'kept-volume.png' }],
        casts: [{ name: 'g5-fly-on', clip: { file: 'g5-fly-on/cast.mp4' } }],
      }),
    )
    const base = await readBase(dir)
    expect(baseSource(base, 'kept-volume.png')).toBe(
      path.join(dir, 'kept-volume.png'),
    )
    // On disk and not kept: a refused take, or another run's file.
    expect(baseSource(base, 'refused-volume.png')).toBeNull()
    // A directory with no record answers nothing.
    await rm(path.join(dir, 'record.json'))
    expect(baseSource(await readBase(dir), 'kept-volume.png')).toBeNull()
    // A cast refused in this run pairs no clip, whatever is on disk.
    const run = {
      casts: [{ name: 'a-on', clip: { file: 'a-on/cast.mp4' } }],
      refused: [{ name: 'b-on' }],
    }
    expect(keptClip(run, 'a-on')).toBe('a-on/cast.mp4')
    expect(keptClip(run, 'b-on')).toBeNull()
  })

  it.skipIf(!hasSheetTools)(
    'lay the deck beside the volume at one scale, with a blank where no base exists, and refuse a record without provenance',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'weather-sheet-'))
      for (const [file, color] of [
        ['weather-e1-cumulus-orbit-volume.png', 'navy'],
        ['weather-e1-cumulus-orbit-deck.png', 'white'],
      ])
        execFileSync('magick', [
          '-size',
          '2880x1800',
          `xc:${color}`,
          path.join(dir, file),
        ])
      // A cast's two arms, three frames each, as the capture copies them.
      const casts = [
        ...['on', 'off'].map((arm) => ({
          ...take,
          rate,
          name: `weather-g6-descent-slow-${arm}`,
          id: 'weather-g6-descent',
          speed: 'slow',
          clouds: arm === 'on',
          frames: 3,
          hz: arm === 'on' ? 42.57 : 63.3,
          atSixty: false,
          clip: null,
        })),
        // A cast taken in one arm, read against slow's control.
        {
          ...take,
          rate,
          name: 'weather-g6-descent-injected-on',
          id: 'weather-g6-descent',
          speed: 'injected',
          clouds: true,
          frames: 3,
          hz: 42.57,
          atSixty: false,
          clip: null,
        },
      ]
      for (const one of casts) {
        await mkdir(path.join(dir, one.name))
        for (let i = 0; i < one.frames; i += 1)
          execFileSync('magick', [
            '-size',
            '1440x900',
            'xc:gray',
            path.join(dir, one.name, `${String(i).padStart(4, '0')}.jpg`),
          ])
      }
      await writeFile(
        path.join(dir, 'record.json'),
        JSON.stringify({ ...record, casts }),
      )
      const { sheets, media } = await buildSheets({ dir })
      // The still's sheet, and each cast's: clouds off beside clouds on,
      // and a one-arm cast beside a blank naming its control.
      expect(sheets).toHaveLength(3)
      expect(sheets[2]).toMatchObject({ speed: 'injected' })
      expect(sheets[1]).toMatchObject({
        id: 'weather-g6-descent',
        speed: 'slow',
      })
      expect(
        execFileSync(
          'magick',
          ['identify', '-format', '%w', path.join(dir, sheets[1].file)],
          { encoding: 'utf8' },
        ),
      ).toBe(`${2 * 720}`)
      expect(media).toContain(`[slow sheet](${sheets[1].file})`)
      const size = execFileSync(
        'magick',
        ['identify', '-format', '%w %h', path.join(dir, sheets[0].file)],
        { encoding: 'utf8' },
      )
      // Three tiles of 720 across, each with its 36-pixel label.
      expect(size).toBe(`${3 * 720} ${450 + 36}`)
      expect(await readFile(path.join(dir, 'media.md'), 'utf8')).toBe(media)
      // The same record with a plate's levers gone is refused, not drawn.
      const { levers: _, ...bare } = record.stills[0]
      await writeFile(
        path.join(dir, 'record.json'),
        JSON.stringify({ ...record, stills: [bare], casts }),
      )
      await expect(buildSheets({ dir })).rejects.toThrow(/no levers/)
    },
  )
})
