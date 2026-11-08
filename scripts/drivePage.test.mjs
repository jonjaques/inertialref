import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PICTURE } from '../apps/game/src/render/picture.ts'
import {
  boot,
  browserVersion,
  clearStorage,
  enter,
  enterSession,
  holdPage,
  pointLine,
  showing,
  statusPoint,
} from './drivePage.mjs'

const URL_ = 'http://localhost:5173/planetarium?at=earth&presentation=occluded'

/**
 * A scripted Chrome. `answer(kind)` names what the page says to each probe —
 * `ready`, `boot` (the cover phase), `here`, `blank`, `origin` — and the
 * commands it was sent are recorded in order.
 */
const chrome = (answer, { loaderId = 'L2', frameLoader = () => 'L2' } = {}) => {
  const sent = []
  const send = async (method, params = {}) => {
    sent.push(method)
    if (method === 'Page.navigate')
      return params.url === 'about:blank' ? {} : { loaderId }
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { loaderId: frameLoader() } } }
    if (method !== 'Runtime.evaluate') return {}
    const { expression } = params
    const kind = expression.includes('readyState')
      ? 'ready'
      : expression.includes("!== 'booting'")
        ? 'ready'
        : expression.includes('status.boot')
          ? 'boot'
          : expression.includes('location.pathname')
            ? 'here'
            : expression.includes('about:blank')
              ? 'blank'
              : 'origin'
    const value = answer(kind)
    if (value instanceof Error)
      return { result: {}, exceptionDetails: { text: value.message } }
    return { result: { value } }
  }
  return { send, sent }
}

/** A page whose clock only `sleep` advances, with the narration kept. */
const page = (document = false) => {
  let t = 0
  const notes = []
  return {
    url: URL_,
    document,
    note: (line) => notes.push(line),
    sleep: async (ms) => {
      t += ms
    },
    now: () => t,
    notes,
    elapsed: () => t,
  }
}

/** Answers that change with each read of a kind: the last one repeats. */
const ladder = (sequences) => {
  const reads = {}
  return (kind) => {
    const list = sequences[kind] ?? [null]
    const i = (reads[kind] = (reads[kind] ?? -1) + 1)
    return list[Math.min(i, list.length - 1)]
  }
}

describe('showing', () => {
  it('matches the path and the asked-for keys only', () => {
    expect(
      showing(URL_, '/planetarium?at=earth&presentation=occluded&t=4'),
    ).toBe(true)
    expect(showing(URL_, '/?at=earth&presentation=occluded')).toBe(false)
    expect(showing(URL_, '/planetarium?at=mars&presentation=occluded')).toBe(
      false,
    )
    expect(showing(URL_, '')).toBe(false)
  })
})

describe('boot', () => {
  const here = '/planetarium?at=earth&presentation=occluded'

  it('attaches to a booted page already showing the url', async () => {
    const { send, sent } = chrome(ladder({ ready: [true], here: [here] }))
    const p = page()
    await boot(send, { force: false }, p)
    expect(sent).not.toContain('Page.navigate')
    expect(p.notes).toEqual(['attached to a booted page'])
  })

  it('navigates when forced, or when the page shows something else', async () => {
    for (const [force, at] of [
      [true, here],
      [false, '/'],
    ]) {
      const { send, sent } = chrome(
        ladder({ ready: [true], here: [at], boot: ['booted'] }),
      )
      await boot(send, { force }, page())
      expect(sent).toContain('Page.navigate')
    }
  })

  it('climbs from booting through drawing to booted', async () => {
    const { send } = chrome(
      ladder({
        ready: [false, false, false, true],
        here: ['/'],
        boot: ['drawing', 'drawing', 'booted'],
      }),
    )
    const p = page()
    await boot(send, { force: false }, p)
    // Three polls of 500 ms to a renderer, then two to the cover.
    expect(p.elapsed()).toBe(2500)
    expect(p.notes).toEqual(['renderer ready in 2.5 s'])
  })

  it('gives the cover twelve seconds and then goes on', async () => {
    const { send, sent } = chrome(
      ladder({ ready: [false, true], here: ['/'], boot: ['drawing'] }),
    )
    const p = page()
    await boot(send, { force: false }, p)
    const covers = sent.filter((m) => m === 'Runtime.evaluate').length - 3
    expect(covers).toBe(24)
    expect(p.elapsed()).toBe(500 + 12_000)
    expect(p.notes).toEqual(['renderer ready in 12.5 s'])
  })

  it('reads a page whose cover probe throws as booted', async () => {
    const { send } = chrome(
      ladder({ ready: [false, true], here: ['/'], boot: [new Error('gone')] }),
    )
    const p = page()
    await boot(send, { force: false }, p)
    expect(p.elapsed()).toBe(500)
  })

  it('gives up when the renderer never appears', async () => {
    const { send } = chrome(ladder({ ready: [false], here: ['/'] }))
    const p = page()
    await expect(boot(send, { force: false }, p)).rejects.toThrow(
      'renderer never became ready',
    )
    expect(p.elapsed()).toBe(201 * 500)
  })

  it('throws the navigation’s own error', async () => {
    const send = async (method) =>
      method === 'Page.navigate'
        ? { errorText: 'net::ERR_CONNECTION_REFUSED' }
        : { result: { value: false } }
    await expect(boot(send, { force: true }, page())).rejects.toThrow(
      'net::ERR_CONNECTION_REFUSED',
    )
  })

  it('waits in document mode for the navigation’s own loader to commit', async () => {
    // The old document is complete until the new loader commits on the third read.
    let reads = 0
    const { send } = chrome(ladder({ ready: [true], here: ['/'] }), {
      frameLoader: () => (++reads < 3 ? 'L1' : 'L2'),
    })
    const p = page(true)
    await boot(send, { force: true }, p)
    expect(reads).toBe(3)
    expect(p.notes).toEqual(['document ready in 1.5 s'])
  })

  // Neither entry clears storage first, so the navigation leaves a booted page
  // rather than about:blank, and that page answers `booted` until it is gone.
  // `--reload`, and `--fresh` under `--keep-storage`, are a forced boot on a
  // page already showing the url; `--keep-storage` onto another url is the
  // unforced one.
  it.each([
    ['--reload', true, here],
    ['--keep-storage onto another url', false, '/'],
  ])(
    'waits in renderer mode for the navigation’s own loader: %s',
    async (_, force, at) => {
      // The old page is booted throughout. The frame tree reports its loader
      // for the first 600 ms, so the 500 ms poll reads it and the 1000 ms one
      // reads the navigation's.
      const p = page()
      const { send, sent } = chrome(
        ladder({ ready: [true], here: [at], boot: ['booted'] }),
        { frameLoader: () => (p.now() < 600 ? 'L1' : 'L2') },
      )
      await boot(send, { force }, p)
      expect(p.notes).toEqual(['renderer ready in 1.0 s'])
      expect(sent.filter((m) => m === 'Page.getFrameTree')).toHaveLength(2)
    },
  )

  it('takes a navigation that reports no loader as committed', async () => {
    const { send: scripted } = chrome(
      ladder({ ready: [true], here: ['/'], boot: ['booted'] }),
      { frameLoader: () => 'L1' },
    )
    const send = async (method, params) =>
      method === 'Page.navigate' ? {} : scripted(method, params)
    const p = page()
    await boot(send, { force: true }, p)
    expect(p.notes).toEqual(['renderer ready in 0.5 s'])
  })
})

const TREE = '/Users/agent/inertialref'
const SIBLING = '/Users/agent/inertialref/.claude/worktrees/sibling'
const BUILD = 'c8aa32e-dirty'
const CHROME = '157.0.8103.39'
const METAL = {
  vendor: 'apple',
  architecture: 'metal-3',
  device: '',
  description: '',
  isFallbackAdapter: false,
}

/**
 * The app as the guard reads it, run in a context of its own: a renderer
 * whose canvas is `canvas` pixels, in a `viewport` at `dpr`, served from
 * `tree`. `renderer: false` is a document the app has not booted in yet,
 * which is what a page reloading under the guard answers. `resize` is the
 * canvas the next animation frame leaves, as a window just given the rig's
 * metrics does. The adapter info is
 * a prototype's, as Chrome's is, so a probe that returned it whole would
 * return nothing.
 */
function app({
  canvas = [1600, 900],
  viewport = [1600, 900],
  dpr = 1,
  picture = DEFAULT_PICTURE,
  tree = TREE,
  renderer = true,
  dynamicRangeHigh = true,
  resize = null,
} = {}) {
  const domElement = { width: canvas[0], height: canvas[1] }
  const scope = {
    engine: renderer
      ? {
          picture,
          gl: {
            description: {
              backend: 'webgpu',
              capability: { dynamicRangeHigh },
            },
            renderer: {
              domElement,
              backend: { device: { adapterInfo: Object.create(METAL) } },
            },
          },
        }
      : undefined,
    ir: renderer
      ? {
          build: () => ({ id: BUILD, tree }),
          observerStatus: () => ({ target: { system: 'SOL' } }),
        }
      : undefined,
    navigator: {},
    location: {
      origin: 'http://localhost:5173',
      search: '?presentation=occluded',
    },
    document: { querySelector: () => ({}) },
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    devicePixelRatio: dpr,
    matchMedia: () => ({ matches: false }),
    URLSearchParams,
    setTimeout,
    requestAnimationFrame: (callback) => {
      if (resize !== null) [domElement.width, domElement.height] = resize
      setTimeout(callback, 0)
    },
  }
  scope.window = scope
  const context = vm.createContext(scope)
  // By value, as `returnByValue` answers; `undefined` arrives as no value.
  return async (expression) => {
    const value = await vm.runInContext(expression, context)
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  }
}

/**
 * A scripted Chrome whose boot probes answer from `ladder` and whose guard
 * reads answer from `pages`, one page per operating-point read: the guard's
 * expressions are the ones that ask for `ir.build()` or wait on a frame. The
 * last page repeats. `reads()` counts the operating-point reads, `frames()`
 * the waits.
 */
function rig(
  pages,
  answers = { ready: [true], here: ['/'], boot: ['booted'] },
) {
  const scripted = chrome(ladder(answers))
  let read = 0
  let frames = 0
  const send = async (method, params = {}) => {
    const { expression = '' } = params
    const guard =
      expression.includes('ir?.build?.()') ||
      expression.includes('requestAnimationFrame')
    if (method !== 'Runtime.evaluate' || !guard)
      return scripted.send(method, params)
    if (expression.includes('requestAnimationFrame')) frames += 1
    scripted.sent.push(method)
    const page = pages[Math.min(read, pages.length - 1)]
    // The operating point is the read that asks for the pixel ratio; the
    // identity read before it is answered by the same page.
    if (expression.includes('devicePixelRatio')) read += 1
    const value = await page(expression)
    return { result: { value } }
  }
  return {
    send,
    sent: scripted.sent,
    reads: () => read,
    frames: () => frames,
  }
}

const hold = (options = {}) => ({
  kind: 'webgpu',
  tree: TREE,
  browser: CHROME,
  recorded: CHROME,
  warn: () => {},
  ...options,
})

describe('enter', () => {
  it('holds the booted page to its operating point before returning, and says so in one line', async () => {
    const { send, sent } = rig([app()])
    const p = page()
    const point = await enter(send, { force: true }, p, hold())
    expect(sent).toContain('Page.navigate')
    expect(point).toMatchObject({
      kind: 'webgpu',
      browser: CHROME,
      backend: 'webgpu',
      buffer: { width: 1600, height: 900 },
      identity: { verdict: 'match', served: TREE, id: BUILD },
    })
    expect(p.notes.at(-1)).toBe(
      `operating point (webgpu): apple/metal-3 on webgpu, buffer 1600×900 for 1600×900 at DPR 1, ` +
        `dynamic range high, system sol, served from ${TREE} (build ${BUILD})`,
    )
  })

  it('holds an attached page as well as a booted one', async () => {
    const here = '/planetarium?at=earth&presentation=occluded'
    const { send, sent, reads } = rig([app()], {
      ready: [true],
      here: [here],
    })
    await enter(send, { force: false }, page(), hold())
    expect(sent).not.toContain('Page.navigate')
    expect(reads()).toBe(1)
  })

  /*
   * The presentation watchdog's remount (the drive skill's trap 5): the
   * canvas comes back at 3200×1800 for a rig asking for 1600×900 at DPR 1,
   * because the ratio the app holds does not follow the emulated one. Every
   * terrain figure taken over it is a retina figure under the default
   * window's label, which is what the guard is for.
   */
  it('refuses a buffer the rig did not ask for, naming both, before returning', async () => {
    const { send } = rig([app({ canvas: [3200, 1800] })])
    const p = page()
    await expect(enter(send, { force: true }, p, hold())).rejects.toThrow(
      'driveLaunch: not a webgpu operating point: the drawing buffer is 3200×1800, not 1600×900',
    )
    expect(p.notes.some((line) => line.startsWith('operating point'))).toBe(
      false,
    )
  })

  /*
   * Chrome drops an invocation's emulation when its socket closes, so between
   * invocations the page sits at the window's own size, 1600×933 on the Mac
   * mini, and a warm attach sets the rig's 1600×900 back. The canvas follows
   * on the next frame; read at once, it is refused mid-resize.
   */
  it('reads the buffer after the frames that apply the rig’s window, so a warm attach is not refused mid-resize', async () => {
    const here = '/planetarium?at=earth&presentation=occluded'
    const warm = rig([app({ canvas: [1600, 933], resize: [1600, 900] })], {
      ready: [true],
      here: [here],
    })
    await expect(
      enter(warm.send, { force: false }, page(), hold()),
    ).resolves.toMatchObject({ buffer: { width: 1600, height: 900 } })
    expect(warm.frames()).toBe(1)
  })

  it('waits on no frame for a document, whose scripts may be off', async () => {
    const document = rig([app({ renderer: false })])
    await enter(
      document.send,
      { force: true },
      page(true),
      hold({ kind: 'shell' }),
    )
    expect(document.frames()).toBe(0)
  })

  it('refuses a page another checkout serves with the way to serve this one', async () => {
    const { send } = rig([app({ tree: SIBLING })])
    await expect(enter(send, { force: true }, page(), hold())).rejects.toThrow(
      `the page is served from ${SIBLING}, not ${TREE}, the tree under test. Serve the tree under test on a port of its own`,
    )
  })

  /*
   * A fresh Vite reloads the page on its own once it has pre-bundled what the
   * first load discovered, about four seconds in. That lands inside the boot
   * ladder, whose cover probe reads a page it cannot evaluate as booted, so
   * the guard can read the next document before the app has booted in it.
   */
  it('boots once more when it reads a page with no renderer, and refuses the second time', async () => {
    const reloading = rig([app({ renderer: false }), app()])
    const p = page()
    await expect(
      enter(reloading.send, { force: true }, p, hold()),
    ).resolves.toMatchObject({ backend: 'webgpu' })
    expect(reloading.reads()).toBe(2)
    expect(p.notes).toContain(
      'the page has no renderer under the guard, so it is booted again',
    )
    const never = rig([app({ renderer: false })])
    await expect(
      enter(never.send, { force: true }, page(), hold()),
    ).rejects.toThrow('backend none where webgpu is required')
    expect(never.reads()).toBe(2)
  })

  it('refuses a page that does not report the window and ratio the rig set', async () => {
    const dropped = rig([
      app({ viewport: [1600, 933], dpr: 2, canvas: [3200, 1866] }),
    ])
    await expect(
      enter(
        dropped.send,
        { force: true },
        page(),
        hold({ metrics: { width: 1600, height: 900, dpr: 1 } }),
      ),
    ).rejects.toThrow(
      "the page's window is 1600×933 at DPR 2, not the 1600×900 at DPR 1 the rig set",
    )
  })

  it('does not boot again for a page that is booted and wrong', async () => {
    const wrong = rig([app({ canvas: [1600, 900], dpr: 2 })])
    await expect(
      enter(wrong.send, { force: true }, page(), hold()),
    ).rejects.toThrow('the drawing buffer is 1600×900, not 3200×1800')
    expect(wrong.reads()).toBe(1)
  })

  it('holds a document to the shell kind, where no renderer is asked for', async () => {
    const { send } = rig([app({ renderer: false })])
    const p = page(true)
    const point = await enter(send, { force: true }, p, hold({ kind: 'shell' }))
    expect(point).toMatchObject({ kind: 'shell', backend: null, buffer: null })
    expect(p.notes.at(-1)).toBe(
      'operating point (shell): no renderer, no drawing buffer, dynamic range standard, ' +
        'system none, identity unchecked: the page answers no ir.build(): a build older than the check, or a page without the app',
    )
  })

  it('warns when Chrome changed since the version the session recorded, and proceeds', async () => {
    const warn = vi.fn()
    const { send } = rig([app()])
    await enter(
      send,
      { force: true },
      page(),
      hold({ recorded: '156.0.7999.10', warn }),
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(`156.0.7999.10 to ${CHROME}`)
  })
})

/*
 * What `--status` holds the page to and what the next run is warned against
 * are the session's, so they are written only once a page passes. Written
 * before the guard, a refused `--tree` becomes what `--status` holds the
 * rig's own page to, and a Chrome version recorded by a run that fails before
 * the guard reads the page is one nobody is ever warned about.
 */
describe('enterSession', () => {
  const controls = { javascript: true, blockedUrls: [] }
  const metrics = { width: 1600, height: 900, dpr: 1 }

  it('records nothing for an entry the guard refuses, so the next run is still warned', async () => {
    const write = vi.fn()
    const warn = vi.fn()
    const sibling = rig([app({ tree: SIBLING })])
    await expect(
      enterSession(
        sibling.send,
        { force: true },
        page(),
        hold({ metrics, recorded: '156.0.7999.10', warn }),
        { controls, write },
      ),
    ).rejects.toThrow(`the page is served from ${SIBLING}`)
    const unready = chrome(ladder({ ready: [false], here: ['/'] }))
    await expect(
      enterSession(
        unready.send,
        { force: true },
        page(),
        hold({ metrics, recorded: '156.0.7999.10', warn }),
        { controls, write },
      ),
    ).rejects.toThrow('renderer never became ready')
    expect(write).not.toHaveBeenCalled()
    // Neither got as far as the read that warns.
    expect(warn).not.toHaveBeenCalled()
  })

  it('records the kind, the tree, the window, the controls and the version once the page passes', async () => {
    const write = vi.fn()
    const { send } = rig([app()])
    const point = await enterSession(
      send,
      { force: true },
      page(),
      hold({ metrics, recorded: '156.0.7999.10' }),
      { controls, write },
    )
    expect(point.backend).toBe('webgpu')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({
      javascript: true,
      blockedUrls: [],
      kind: 'webgpu',
      tree: TREE,
      browser: CHROME,
      width: 1600,
      height: 900,
      dpr: 1,
    })
  })
})

describe('holdPage', () => {
  it('reads the attached page fresh, without booting it', async () => {
    const { send, sent } = rig([app({ dynamicRangeHigh: false })])
    const point = await holdPage(send, hold())
    expect(sent).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Runtime.evaluate',
    ])
    expect(point.dynamicRangeHigh).toBe(false)
  })
})

/** `send`, with every command and its parameters kept in order. */
const recording = (send) => {
  const calls = []
  return {
    calls,
    send: async (method, params = {}) => {
      calls.push({ method, params })
      return await send(method, params)
    },
  }
}

describe('statusPoint', () => {
  const session = {
    kind: 'webgpu',
    tree: TREE,
    browser: CHROME,
    width: 1600,
    height: 900,
    dpr: 1,
  }
  const status = (open, options = {}) =>
    statusPoint(open, {
      state: session,
      fallback: { width: 1600, height: 900, dpr: 1 },
      tree: TREE,
      browser: CHROME,
      warn: () => {},
      driving: [],
      ...options,
    })
  /** The page's socket, as drive.mjs opens it, counting the opens and closes. */
  const socket = (send) => {
    const counts = { opened: 0, closed: 0 }
    const open = async () => {
      counts.opened += 1
      return { send, close: () => (counts.closed += 1) }
    }
    return { open, counts }
  }

  /*
   * A `--status` beside a live invocation on the port would set the session's
   * last window over that invocation's, and its socket's close then clears
   * the page's emulation for every session: a cast or a settle in progress
   * drops to the window's own 1600×933 at DPR 2 with nothing to put it back.
   */
  it('opens no socket on a page another invocation is driving', async () => {
    const { send, calls } = recording(rig([app()]).send)
    const { open, counts } = socket(send)
    const read = await status(open, {
      driving: [{ pid: 4242, start: 'Sat Nov  7 20:00:00 2026' }],
    })
    expect(read).toEqual({
      lines: ['not read: drive.mjs (pid 4242) is driving this page'],
    })
    expect(counts.opened).toBe(0)
    expect(calls).toEqual([])
  })

  it('sets focus emulation and the recorded window before it reads, and refuses a buffer the rig did not ask for', async () => {
    const { send, calls } = recording(rig([app({ canvas: [3200, 1800] })]).send)
    const { open, counts } = socket(send)
    const read = await status(open)
    expect(calls.slice(0, 2)).toEqual([
      {
        method: 'Emulation.setFocusEmulationEnabled',
        params: { enabled: true },
      },
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: 1600,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        },
      },
    ])
    expect(calls.slice(2).every((c) => c.method === 'Runtime.evaluate')).toBe(
      true,
    )
    expect(read.refused).toBe(true)
    expect(read.lines).toEqual([
      expect.stringMatching(
        /^refused: driveLaunch: not a webgpu operating point: the drawing buffer is 3200×1800, not 1600×900/,
      ),
    ])
    expect(counts).toEqual({ opened: 1, closed: 1 })
  })

  /*
   * A stalled renderer answers `setDeviceMetricsOverride` only once it applies
   * it, and the socket's own timeout is two minutes: the time someone runs
   * `--status` to see who holds the GPU is the time it would hang.
   */
  it('gives a page that does not answer a deadline, and closes its socket', async () => {
    const stalled = recording(() => new Promise(() => {}))
    const { open, counts } = socket(stalled.send)
    const started = performance.now()
    const read = await status(open, { ms: 50 })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(read).toEqual({
      lines: ['not read: the page did not answer within 0.05 s'],
    })
    expect(counts).toEqual({ opened: 1, closed: 1 })
    // The guard's read is held to the same deadline as the emulation.
    const reading = recording(async (method) =>
      method === 'Runtime.evaluate' ? new Promise(() => {}) : {},
    )
    const late = socket(reading.send)
    expect(await status(late.open, { ms: 50 })).toEqual({
      lines: ['not read: the page did not answer within 0.05 s'],
    })
    expect(late.counts.closed).toBe(1)
  })

  it('closes a socket that opens after the deadline', async () => {
    let close
    const closed = new Promise((resolve) => (close = resolve))
    const read = await status(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ send: async () => ({}), close }), 100),
        ),
      { ms: 20 },
    )
    expect(read.lines).toEqual([
      'not read: the page did not answer within 0.02 s',
    ])
    await closed
  })

  it('holds the page to the window it set', async () => {
    const { open } = socket(
      rig([app({ viewport: [1440, 900], dpr: 2, canvas: [2880, 1800] })]).send,
    )
    const read = await status(open)
    expect(read.refused).toBe(true)
    expect(read.lines[0]).toContain(
      "the page's window is 1440×900 at DPR 2, not the 1600×900 at DPR 1 the rig set",
    )
  })

  it('says why no page was read when the socket does not open', async () => {
    const read = await status(async () => {
      throw new Error('Chrome has no page open')
    })
    expect(read).toEqual({ lines: ['not read: Chrome has no page open'] })
  })

  it('prints the line and the full record of a page at its point, at the invocation’s window when the session recorded none', async () => {
    const { send, calls } = recording(
      rig([app({ canvas: [2880, 1800], viewport: [1440, 900], dpr: 2 })]).send,
    )
    const { open } = socket(send)
    const read = await status(open, {
      state: { tree: TREE },
      fallback: { width: 1440, height: 900, dpr: 2 },
    })
    expect(calls[1].params).toMatchObject({
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
    })
    expect(read.refused).toBeUndefined()
    expect(read.lines[0]).toMatch(
      /^operating point \(webgpu\): apple\/metal-3 on webgpu, buffer 2880×1800 for 1440×900 at DPR 2,/,
    )
    expect(JSON.parse(read.lines.slice(1).join('\n'))).toMatchObject({
      kind: 'webgpu',
      buffer: { width: 2880, height: 1800 },
      identity: { verdict: 'match' },
    })
  })
})

describe('pointLine', () => {
  const point = (extra) => ({
    kind: 'webgpu',
    adapter: METAL,
    backend: 'webgpu',
    viewport: { width: 1440, height: 900 },
    dpr: 2,
    coarse: false,
    buffer: { width: 2880, height: 1800 },
    expectedBuffer: { width: 2880, height: 1800 },
    picture: DEFAULT_PICTURE,
    dynamicRangeHigh: true,
    system: 'generated',
    identity: { verdict: 'match', served: TREE, id: BUILD },
    ...extra,
  })

  it('says the buffer against the window and the ratio that made it', () => {
    expect(pointLine(point())).toContain(
      'buffer 2880×1800 for 1440×900 at DPR 2, dynamic range high, system generated',
    )
    expect(
      pointLine(
        point({
          viewport: { width: 1600, height: 900 },
          dpr: 1,
          buffer: { width: 3200, height: 1800 },
          picture: { ...DEFAULT_PICTURE, aa: 'supersample' },
        }),
      ),
    ).toContain('buffer 3200×1800 for 1600×900 at DPR 1, supersampled ×2')
    expect(
      pointLine(
        point({
          viewport: { width: 390, height: 844 },
          dpr: 3,
          coarse: true,
          buffer: { width: 585, height: 1266 },
        }),
      ),
    ).toContain('buffer 585×1266 for 390×844 at DPR 3, capped at 1.5')
  })

  it('says what it could not check', () => {
    expect(pointLine(point({ expectedBuffer: null, picture: null }))).toContain(
      'buffer 2880×1800, unchecked: the page names no picture',
    )
    expect(
      pointLine(
        point({
          identity: {
            verdict: 'unchecked',
            reason:
              'the page names no tree: a production build carries no filesystem path',
          },
        }),
      ),
    ).toMatch(
      /, identity unchecked: the page names no tree: a production build carries no filesystem path$/,
    )
  })
})

describe('browserVersion', () => {
  it('is the version Playwright’s browser.version() reports, from /json/version', () => {
    expect(browserVersion('Chrome/157.0.8103.39')).toBe('157.0.8103.39')
    expect(browserVersion('HeadlessChrome/157.0.8103.39')).toBe('157.0.8103.39')
    expect(browserVersion(undefined)).toBe('unknown')
  })
})

describe('clearStorage', () => {
  it('leaves the page, then clears cookies and both origins', async () => {
    const calls = []
    const answer = ladder({
      origin: ['http://localhost:4173'],
      blank: [false, true],
    })
    const { send, sent } = chrome(answer)
    const recording = async (method, params) => {
      if (method === 'Storage.clearDataForOrigin') calls.push(params)
      return send(method, params)
    }
    const p = page()
    await clearStorage(recording, p)
    expect(sent.filter((m) => m === 'Page.navigate')).toHaveLength(1)
    expect(sent.indexOf('Network.clearBrowserCookies')).toBeGreaterThan(
      sent.indexOf('Page.navigate'),
    )
    expect(calls.map((c) => c.origin)).toEqual([
      'http://localhost:4173',
      'http://localhost:5173',
    ])
    expect(p.elapsed()).toBe(50)
    expect(p.notes).toEqual(['cleared local, session storage and cookies'])
  })

  it('skips an opaque origin', async () => {
    const calls = []
    const { send } = chrome(
      ladder({ origin: [new Error('no context')], blank: [true] }),
    )
    const recording = async (method, params) => {
      if (method === 'Storage.clearDataForOrigin') calls.push(params.origin)
      return send(method, params)
    }
    await clearStorage(recording, page())
    expect(calls).toEqual(['http://localhost:5173'])
  })

  it('refuses a page that never leaves', async () => {
    const { send } = chrome(
      ladder({ origin: [new Error('no context')], blank: [false] }),
    )
    await expect(clearStorage(send, page())).rejects.toThrow(
      'page did not leave before clearing storage',
    )
  })
})
