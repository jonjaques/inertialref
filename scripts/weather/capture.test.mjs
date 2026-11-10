import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { wrap } from '../driveScript.mjs'
import {
  armsOf,
  castArgs,
  CAST_RATE,
  checkCast,
  checkStill,
  cutArgs,
  cutFrom,
  dataRoot,
  parseCapture,
  presentationRate,
  READ,
  STILLS,
  stillArgs,
  tagOf,
} from './capture.mjs'
import {
  castName,
  CASTS,
  descentFrames,
  INSTALL_PATH,
  startPath,
  stopPath,
} from './descent.mjs'
import { baseSource, buildSheets, mediaRows } from './sheet.mjs'

/*
 * The capture tool and its paths, held in Node: what each invocation asks
 * the driver for, what it refuses, and the page-side path run in a context
 * that holds nothing of these modules. Its first real run needs the machine
 * whole and is not here.
 */

const URL_ = 'http://localhost:8787/'

// `buildSheets` refuses without ImageMagick or ffmpeg rather than write half
// a sheet, and CI's Linux runner has neither, so the one test that draws a
// sheet runs where the capture itself can.
const hasSheetTools = ['magick', 'ffmpeg'].every(
  (tool) => spawnSync(tool, ['-version']).status === 0,
)

describe('the capture’s plan', () => {
  it('takes seven stills, E1 to E3 in two arms, and leaves G5 and G6 to their casts', () => {
    expect(STILLS.map(tagOf)).toEqual([
      'e1',
      'e2',
      'e3',
      'g1',
      'g2',
      'g3',
      'g4',
    ])
    expect(armsOf('weather-e2-limb-dusk')).toEqual(['volume', 'deck'])
    expect(armsOf('weather-g4-over-deck')).toEqual(['volume'])
  })

  it('reads its subset, its cut and its casts from the command line, and refuses what names nothing', () => {
    const all = parseCapture(['--phase', '1', '--url', URL_])
    expect(all.stills).toHaveLength(7)
    expect(all.casts).toHaveLength(6)
    const some = parseCapture([
      '--phase',
      '1',
      '--url',
      URL_,
      '--only',
      'e1,g6',
      '--cut',
      'e1',
      '--twice',
      '--gpu-wait',
      '1800',
    ])
    expect(some.stills).toEqual(['weather-e1-cumulus-orbit'])
    expect(some.casts.map((one) => `${one.id}/${one.speed}`)).toEqual([
      'weather-g6-descent/slow',
      'weather-g6-descent/fast',
      'weather-e1-cumulus-orbit/fly',
    ])
    expect(some.cuts).toEqual(['weather-e1-cumulus-orbit'])
    expect(some.twice).toBe(true)
    expect(some.gpuWaitMs).toBe(1_800_000)
    expect(
      parseCapture(['--phase', '1', '--url', URL_, '--no-casts']).casts,
    ).toEqual([])
    for (const argv of [
      ['--url', URL_],
      ['--phase', '1'],
      ['--phase', '1', '--url', URL_, '--only', 'e9'],
      ['--phase', '1', '--url', URL_, '--cut', 'g6'],
      ['--phase', '1', '--url', URL_, '--gpu-wait', '-1'],
    ])
      expect(() => parseCapture(argv), argv.join(' ')).toThrow()
  })

  it('asks for the flag in the volume arm alone, and settles before it reads and shoots', () => {
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

  it('cuts to a cornerstone from one on the other body, inside one boot', () => {
    expect(cutFrom('weather-e1-cumulus-orbit')).toMatch(/^weather-g/)
    expect(cutFrom('weather-g3-underlit-dusk')).toMatch(/^weather-e/)
    const args = cutArgs('weather-g1-fair', 'weather-e1-cumulus-orbit', 'c.png')
    expect(args.indexOf('--preset')).toBeLessThan(args.indexOf('--js'))
    expect(args.filter((one) => one === '--settle')).toHaveLength(2)
    expect(args).toContain(`ir.preset("weather-e1-cumulus-orbit").weather`)
  })

  it('records each cast past its path’s end, its control with the volume off', () => {
    const [slow] = CASTS
    const on = castArgs(slow, true)
    const off = castArgs(slow, false)
    expect(on[on.indexOf('--cast') + 1]).toBe(String(slow.frames + 90))
    expect(off.join(' ')).toContain('on: false')
    expect(on.join(' ')).not.toContain('on: false')
    // The last four evaluations are install, weather, start and stop, in
    // both, which is how the tool finds the weather it checks.
    for (const args of [on, off]) {
      const js = args.flatMap((one, i) => (one === '--js' ? [args[i + 1]] : []))
      expect(js.slice(-4)).toEqual([
        INSTALL_PATH,
        'engine.pictureWeather.outcome',
        startPath(slow.path),
        stopPath(),
      ])
    }
    expect(castName(slow, true)).toBe('weather-g6-descent-slow-on')
  })

  it('schedules the descents from 400 km to 2 m at the design’s frame counts', () => {
    // ln(2·10⁵)/−ln(0.988) is 1,011.03, so the ground is reached on frame
    // 1,012; the design's 1,010 divides by the rate's own logarithm rounded.
    expect(descentFrames(400_000, 0.012)).toBe(1012)
    expect(descentFrames(400_000, 0.04)).toBe(300)
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

describe('what the capture refuses', () => {
  const read = {
    mode: 'standard',
    chrome: false,
    settled: { ok: true },
    weather: 'drawn',
  }

  it('a still not settled, not in SDR, with the interface up, or not in its arm’s weather', () => {
    expect(checkStill('e1', 'volume', read)).toBe(read)
    expect(
      checkStill('e1', 'deck', { ...read, weather: 'unavailable' }),
    ).toBeTruthy()
    for (const bad of [
      undefined,
      { ...read, settled: { ok: false, clouds: { pending: true } } },
      { ...read, mode: 'extended' },
      { ...read, chrome: true },
      { ...read, weather: 'unavailable' },
      { ...read, weather: 'none' },
    ])
      expect(() => checkStill('e1', 'volume', bad)).toThrow(/refused/)
    expect(() => checkStill('e1', 'deck', read)).toThrow(/deck arm/)
  })

  const log = (hz, n = 120) =>
    Array.from({ length: n }, (_, k) => ({ k, at: 1e12 + (k * 1000) / hz }))

  it('keep a cast at the rate it was presented at until 60 Hz can be held, and take one the screencast subsampled again', () => {
    expect(CAST_RATE.held).toBe(false)
    expect(presentationRate(log(60))).toBeCloseTo(60, 3)
    const cast = { frames: 100 }
    expect(checkCast('c', log(60), 190, cast)).toMatchObject({
      retake: false,
      atSixty: true,
    })
    expect(checkCast('c', log(60), 70, cast).retake).toBe(true)
    expect(checkCast('c', log(59), 190, cast).hz).toBeCloseTo(59, 3)
    // The rig's own: the clouds-on descent at 2880 × 1800 on the M6.
    for (const hz of [42.6, 120, 72, 50, CAST_RATE.high + 0.5]) {
      const kept = checkCast('c', log(hz), 190, cast)
      // To 0.01 Hz: the log's instants are epoch milliseconds, where a
      // float64 holds a part in 10¹⁶ of 10¹², a tenth of a microsecond.
      expect(kept.hz).toBeCloseTo(hz, 2)
      expect(kept.atSixty).toBe(false)
    }
    expect(() => checkCast('c', [], 0, cast)).toThrow(/no measurable rate/)
  })

  it('refuse a cast outside 58 to 62 Hz once the rig can hold 60', () => {
    const cast = { frames: 100 }
    for (const hz of [42.6, 120, 72, 50, CAST_RATE.high + 0.5])
      expect(() => checkCast('c', log(hz), 190, cast, true)).toThrow(/60 Hz/)
    expect(checkCast('c', log(60), 190, cast, true).atSixty).toBe(true)
  })

  it('refuse a cast that dropped a frame anywhere on its path, at any rate', () => {
    const cast = { frames: 100 }
    for (const hz of [60, 42.6]) {
      // One frame not presented at frame 80, past the first thirty the
      // start's rate is read over: every later instant moves by a frame.
      const gap = log(hz)
      for (let k = 80; k < gap.length; k += 1) gap[k].at += 1000 / hz
      expect(() => checkCast('c', gap, 190, cast)).toThrow(/dropped/)
      // The refusal names the frame after the gap, for the record.
      try {
        checkCast('c', gap, 190, cast)
      } catch (error) {
        expect(error.dropped.map((one) => one.frame)).toEqual([80])
      }
      expect(() => checkCast('c', gap, 190, cast, true)).toThrow(
        hz === 60 ? /dropped/ : /dropped|60 Hz/,
      )
    }
    // The cadence a 120 Hz panel gives a 40 Hz page, 25 and 33.3 ms
    // intervals mixed, drops nothing.
    const mixed = Array.from({ length: 120 }, (_, k) => ({
      k,
      at: 1e12 + Math.floor(k / 2) * (25 + 1000 / 30) + (k % 2) * 25,
    }))
    expect(checkCast('c', mixed, 190, cast).hz).toBeGreaterThan(30)
    // A drop past the path's end and its tail is not the path's.
    const late = log(60, 400)
    for (let k = 300; k < late.length; k += 1) late[k].at += 1000 / 60
    expect(() => checkCast('c', late, 190, cast)).not.toThrow()
  })

  it('read each still’s cloud texel share from the page’s capture', async () => {
    const page = (capture) =>
      vm.runInNewContext(READ, {
        ir: {
          cloudRadiance: async () => capture,
          observatory: { time: 1 },
          light: () => null,
          settled: () => ({ ok: true }),
          clouds: () => null,
          build: () => null,
        },
        engine: {
          gl: { description: { mode: 'standard' } },
          chrome: false,
          lens: null,
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
    // No capture where nothing draws: the deck arm, or a failed readback.
    expect((await page(null)).cloud).toBeNull()
  })

  it('reads the rate past a hitch: the median, not the mean', () => {
    const hitched = log(60)
    for (let k = 10; k < hitched.length; k += 1) hitched[k].at += 50
    expect(presentationRate(hitched)).toBeCloseTo(60, 3)
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
  const calls = { height: [], pitch: [], moved: [], heading: [], lens: [] }
  let lens = { focalLength: 20, gauge: 24, zoom: 1 }
  const frames = []
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
      observatory: {
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
        moveTo: (at) => calls.moved.push(at),
      },
    },
  })
  /** Run the page's pending frames, `n` times over. */
  const step = (n) => {
    for (let i = 0; i < n; i += 1) {
      const pending = frames.splice(0)
      for (const callback of pending) callback()
    }
  }
  return { context, calls, step }
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
    const deg = Math.PI / 180
    expect(page.calls.pitch[0]).toBeCloseTo(-87.995 * deg, 9)
    expect(page.calls.pitch.at(-1)).toBeCloseTo(5 * deg, 9)
    // The log carries the clouds' regime and resets a frame.
    expect(log[3]).toMatchObject({ regime: 'converging', resets: 1 })
    // Stopped: no frame runs after it.
    page.step(10)
    expect(page.calls.height).toHaveLength(slow.frames + 6)
  })

  it('flies a fixed arc a frame along the heading and holds from its stop', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const ground = CASTS.find((one) => one.id === 'weather-g1-fair')
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

  it('zooms a fixed ratio of focal length a frame, from 60° to 11.4°', async () => {
    const page = fakePage()
    await send(page, INSTALL_PATH)
    const zoom = CASTS.find((one) => one.speed === 'zoom')
    await send(page, startPath(zoom.path))
    page.step(320)
    await send(page, stopPath())
    const f = (fov) => 12 / Math.tan((fov * Math.PI) / 360)
    const lens = page.calls.lens
    expect(lens[0]).toBeCloseTo(f(60), 9)
    expect(lens.at(-1)).toBeCloseTo(f(11.4), 9)
    const ratio = lens[51] / lens[50]
    expect(lens[201] / lens[200]).toBeCloseTo(ratio, 12)
  })

  it('refuses a page that stands on no surface, and a second start ends the first loop', async () => {
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
  const record = {
    phase: 1,
    stills: [
      {
        id: 'weather-e1-cumulus-orbit',
        arm: 'volume',
        file: 'weather-e1-cumulus-orbit-volume.png',
      },
      {
        id: 'weather-e1-cumulus-orbit',
        arm: 'deck',
        file: 'weather-e1-cumulus-orbit-deck.png',
      },
    ],
    casts: [
      {
        id: 'weather-g6-descent',
        speed: 'slow',
        clouds: true,
        clip: { file: 'weather-g6-descent-slow-on/cast.mp4' },
      },
      {
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
    expect(rows[3]).toContain('[slow on](weather-g6-descent-slow-on/cast.mp4)')
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

  it('find the base’s plate in its directory, or among its record’s URLs', () => {
    expect(baseSource(null, 'a.png')).toBeNull()
    expect(
      baseSource(
        { kind: 'record', urls: { 'a.png': 'https://x/a.png' } },
        'a.png',
      ),
    ).toBe('https://x/a.png')
    expect(baseSource({ kind: 'record', urls: {} }, 'a.png')).toBeNull()
    expect(baseSource({ kind: 'dir', dir: '/nowhere' }, 'a.png')).toBeNull()
  })

  it.skipIf(!hasSheetTools)(
    'lay the deck beside the volume at one scale, with a blank where no base exists',
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
      const casts = ['on', 'off'].map((arm) => ({
        name: `weather-g6-descent-slow-${arm}`,
        id: 'weather-g6-descent',
        speed: 'slow',
        clouds: arm === 'on',
        frames: 3,
        hz: arm === 'on' ? 42.57 : 63.3,
        atSixty: false,
        clip: null,
      }))
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
      // The still's sheet, and the cast's: clouds off beside clouds on.
      expect(sheets).toHaveLength(2)
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
    },
  )
})
