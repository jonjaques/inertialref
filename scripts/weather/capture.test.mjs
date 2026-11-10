import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

  it('a cast presented outside 58 to 62 Hz, and one the screencast subsampled is taken again', () => {
    expect(presentationRate(log(60))).toBeCloseTo(60, 3)
    const cast = { frames: 100 }
    expect(checkCast('c', log(60), 190, cast)).toMatchObject({ retake: false })
    expect(checkCast('c', log(60), 70, cast).retake).toBe(true)
    expect(checkCast('c', log(59), 190, cast).hz).toBeCloseTo(59, 3)
    for (const hz of [120, 72, 50, CAST_RATE.high + 0.5])
      expect(() => checkCast('c', log(hz), 190, cast)).toThrow(/60 Hz/)
    expect(() => checkCast('c', [], 0, cast)).toThrow(/no measurable rate/)
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

  it('lay the deck beside the volume at one scale, with a blank where no base exists', async () => {
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
    await writeFile(
      path.join(dir, 'record.json'),
      JSON.stringify({ ...record, casts: [] }),
    )
    const { sheets, media } = await buildSheets({ dir })
    expect(sheets).toHaveLength(1)
    const size = execFileSync(
      'magick',
      ['identify', '-format', '%w %h', path.join(dir, sheets[0].file)],
      { encoding: 'utf8' },
    )
    // Three tiles of 720 across, each with its 36-pixel label.
    expect(size).toBe(`${3 * 720} ${450 + 36}`)
    expect(await readFile(path.join(dir, 'media.md'), 'utf8')).toBe(media)
  })
})
