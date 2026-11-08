import fc from 'fast-check'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PICTURE, PICTURE_AA } from '../apps/game/src/render/picture.ts'
import { evaluate as evaluateOverSocket } from './cdp.mjs'
import {
  OPERATING_POINT,
  PRESETS,
  assertOperatingPoint,
  assertServedTree,
  compareIdentity,
  expectedBuffer,
  launchOptions,
  refuseForeignBrowser,
} from './driveLaunch.mjs'

/*
 * The evidence, trimmed from the Playwright spike's `.scratch/playwright-spike`
 * to the fields read here (design/plans/playwright.md, "What was measured"):
 *
 *   modes-chrome-headless.json        out/modes-chrome-headless.json — probe A,
 *                                     Chrome 157 new headless on Playwright's
 *                                     defaults, forced sRGB among them
 *   modes-chromium-new-headless.json  out/modes-chromium-new-headless.json —
 *                                     probe A, channel 'chromium': Chrome for
 *                                     Testing 151
 *   shell-adapter.json                out/shell-adapter.json — probe A's
 *                                     follow-up: the default headless shell's
 *                                     adapter under four sets of switches, and
 *                                     the backend the game took with none
 *   headless-1600.json                perf-feasibility/out/headless-1600.json —
 *                                     N1, Chrome 157 headless at 1600×900@1
 *   retina-probe.json                 perf-feasibility/out/retina-probe.json —
 *                                     N3, 1440×900@2
 *   ab-dpr.json                       perf-feasibility/out/ab-dpr.json — N4's
 *                                     first pair, 1600×900 at @1 and @1.05
 *   k-earthrise.json                  out/k-earthrise.txt, its `js:` line —
 *                                     probe K, drive.mjs's own headed window
 *                                     on the display profile
 *
 * No probe recorded every field the guard reads, so a page here is assembled
 * from two records of one launch mode and one context, and each assembly says
 * which. Every probe ran against the dev server at `http://localhost:5191`
 * (the spike's `lib.mjs`), with no `picture=` in the URL and empty storage, so
 * the picture is the default one; and no context set `hasTouch`, so the
 * pointer is fine.
 */
const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/driveLaunch/${name}.json`, import.meta.url),
      'utf8',
    ),
  )
const CHROME = fixture('modes-chrome-headless')
const TESTING = fixture('modes-chromium-new-headless')
const SHELL = fixture('shell-adapter')
const N1 = fixture('headless-1600')
const N3 = fixture('retina-probe')
const N4 = fixture('ab-dpr')
const K = fixture('k-earthrise')

const SOL = 'SOL'
// far-shore's system, `g:milky-way/s:P222_1_0_9/b:4`.
const FAR_SHORE = 'P222_1_0_9'

/*
 * Two checkouts of one clone, cut from one commit, so they share a build id:
 * the case the tree exists to tell apart. Neither path exists on any machine,
 * so they are compared by their spelling, which is what a tree reported by a
 * server on another host would be.
 */
const TREE = '/Users/agent/inertialref'
const SIBLING = '/Users/agent/inertialref/.claude/worktrees/sibling'
const BUILD = 'c8aa32e-dirty'
const NO_TREE =
  'driveLaunch: the served tree is compared with the tree under test, and none was given'

/**
 * A `GPUAdapterInfo` as Chrome hands it out: its fields are accessors on the
 * prototype, so the object itself serializes to `{}` and a probe that returns
 * it whole returns nothing.
 */
const adapterInfo = (fields) => Object.create(fields)

/**
 * A page as `OPERATING_POINT` reads it, and the `evaluate` port over it.
 *
 * The answer goes through JSON because both real ports answer by value —
 * `page.evaluate` serializes, and drive.mjs asks `Runtime.evaluate` for
 * `returnByValue` — so a field the probe forgot to copy arrives missing here
 * exactly as it would there.
 */
function page({
  description = CHROME.adapter.game,
  canvas = [1600, 900],
  device = null,
  offered = CHROME.adapter.adapter,
  viewport = [1600, 900],
  dpr = 1,
  coarse = false,
  picture = DEFAULT_PICTURE,
  system = SOL,
  search = '',
  requests = { count: 0 },
  // `ir.build()`, or null for a build older than the verb.
  build = () => ({ id: BUILD, tree: TREE }),
} = {}) {
  const engine =
    description === null
      ? undefined
      : {
          picture,
          gl: {
            description,
            renderer: {
              domElement:
                canvas === null
                  ? null
                  : { width: canvas[0], height: canvas[1] },
              backend:
                device === null
                  ? {}
                  : { device: { adapterInfo: adapterInfo(device) } },
            },
          },
        }
  const scope = {
    engine,
    ir:
      engine === undefined
        ? undefined
        : {
            observerStatus: () => ({ target: { system } }),
            ...(build === null ? {} : { build }),
          },
    navigator: {
      gpu: {
        requestAdapter: async () => {
          requests.count += 1
          return offered === null ? null : { info: adapterInfo(offered) }
        },
      },
    },
    location: { origin: 'http://localhost:5191', search },
    document: {
      querySelector: (selector) =>
        selector.includes('/@vite/client') ? {} : null,
    },
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    devicePixelRatio: dpr,
    matchMedia: (query) => ({
      matches: query === '(pointer: coarse)' ? coarse : false,
    }),
    URLSearchParams,
  }
  scope.window = scope
  const context = vm.createContext(scope)
  return async (expression) =>
    JSON.parse(JSON.stringify(await vm.runInContext(expression, context)))
}

/** A run of N1, N3 or N4 as a page: the context it asked for, the buffer the page reported. */
const fromRun = (run, extra = {}) =>
  page({
    viewport: [run.w, run.h],
    dpr: run.env.devicePixelRatio,
    canvas: run.env.canvas,
    system: run.id.includes('far-shore') ? FAR_SHORE : SOL,
    ...extra,
  })

const asserted = (evaluate, options = {}) =>
  assertOperatingPoint(evaluate, {
    browser: CHROME.version,
    tree: TREE,
    warn: () => {},
    ...options,
  })

describe('the launch presets', () => {
  it('are Chrome stable, headless on forced sRGB or headed on the display profile', () => {
    expect(PRESETS.sdr).toEqual({ channel: 'chrome', headless: true })
    expect(PRESETS.display).toMatchObject({
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--force-color-profile=srgb'],
    })
    expect(PRESETS.display.args).toContainEqual(
      expect.stringMatching(/^--window-position=/),
    )
  })

  it('hand out copies, so a caller adding a switch leaves the preset as it was', () => {
    const options = launchOptions('display', { args: ['--mute-audio'] })
    expect(options.args).toEqual([...PRESETS.display.args, '--mute-audio'])
    options.args.push('--enable-unsafe-webgpu')
    options.ignoreDefaultArgs.push('--hide-scrollbars')
    expect(PRESETS.display.args).not.toContain('--enable-unsafe-webgpu')
    expect(PRESETS.display.ignoreDefaultArgs).toEqual([
      '--force-color-profile=srgb',
    ])
  })

  it('adds a caller’s dropped defaults to the preset’s, so display keeps its color profile', () => {
    expect(
      launchOptions('display', { ignoreDefaultArgs: ['--hide-scrollbars'] })
        .ignoreDefaultArgs,
    ).toEqual(['--force-color-profile=srgb', '--hide-scrollbars'])
    expect(
      launchOptions('sdr', { ignoreDefaultArgs: ['--hide-scrollbars'] })
        .ignoreDefaultArgs,
    ).toEqual(['--hide-scrollbars'])
    expect(
      launchOptions('display', { ignoreDefaultArgs: true }).ignoreDefaultArgs,
    ).toBe(true)
  })

  it('refuses a preset that is not one, naming the two there are', () => {
    expect(() => launchOptions('hdr')).toThrow(/sdr, display/)
  })
})

describe('the browser check before launch', () => {
  // Probe A's launch options, as the spike's `lib.mjs` wrote them.
  it.each([
    ['headless-shell', { headless: true }, "Playwright's headless shell"],
    [
      'chromium-new-headless',
      { channel: 'chromium', headless: true },
      "Playwright's Chrome for Testing",
    ],
  ])('refuses probe A’s %s, naming it', (_, options, name) => {
    expect(() => refuseForeignBrowser(options)).toThrow(name)
  })

  it('refuses a preset whose channel is taken away or replaced', () => {
    expect(() => launchOptions('sdr', { channel: undefined })).toThrow(
      "refusing Playwright's headless shell",
    )
    expect(() => launchOptions('display', { channel: undefined })).toThrow(
      "refusing Playwright's Chrome for Testing",
    )
    expect(() => launchOptions('sdr', { channel: 'chromium' })).toThrow(
      "refusing Playwright's Chrome for Testing (channel 'chromium')",
    )
    expect(() => launchOptions('sdr', { channel: 'chrome-beta' })).toThrow(
      "refusing channel 'chrome-beta'",
    )
  })

  it('refuses Chrome for Testing 151 by executablePath, naming it', () => {
    // Revision 1234 is Playwright 1.62.1's Chrome for Testing 151.0.7922.34
    // and its headless shell, by the spike's `playwright-core/browsers.json`.
    const testing =
      '/Users/ci/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    const shell =
      '/Users/ci/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
    expect(() => launchOptions('sdr', { executablePath: testing })).toThrow(
      `refusing Chrome for Testing at ${testing}`,
    )
    expect(() => launchOptions('sdr', { executablePath: shell })).toThrow(
      `refusing Playwright's headless shell at ${shell}`,
    )
    // Chrome stable is a channel, not a file: a path pins whatever is there.
    expect(() =>
      launchOptions('sdr', {
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
    ).toThrow('refusing the executable at /Applications/Google Chrome.app')
  })

  it('passes both presets as they are', () => {
    expect(launchOptions('sdr')).toEqual({
      channel: 'chrome',
      headless: true,
      args: [],
    })
    expect(launchOptions('display').channel).toBe('chrome')
  })

  it('exempts a comparison probe from this check and from no other', async () => {
    const options = launchOptions('sdr', {
      channel: undefined,
      comparison: true,
    })
    expect(options).not.toHaveProperty('comparison')
    expect(options.channel).toBeUndefined()
    // The default shell it launches is refused after boot all the same.
    const shell = page({
      description: SHELL.gameFallback.description,
      offered: SHELL.variants[0].adapter,
    })
    await expect(
      asserted(shell, { browser: SHELL.variants[0].version }),
    ).rejects.toThrow('not a webgpu operating point')
  })
})

describe('the operating point after boot', () => {
  it('passes Chrome 157 new headless and records forced sRGB as no high dynamic range', async () => {
    // Probe A's adapter and description; N1's buffer, same mode and context.
    const point = await asserted(fromRun(N1.runs[0]))
    expect(point).toEqual({
      kind: 'webgpu',
      origin: 'http://localhost:5191',
      build: 'dev',
      browser: '157.0.8103.39',
      viewport: { width: 1600, height: 900 },
      dpr: 1,
      coarse: false,
      buffer: { width: 1600, height: 900 },
      adapter: {
        vendor: 'apple',
        architecture: 'metal-3',
        device: '',
        description: '',
        isFallbackAdapter: false,
        source: 'request',
      },
      backend: 'webgpu',
      dynamicRangeHigh: false,
      picture: DEFAULT_PICTURE,
      system: 'sol',
      identity: {
        verdict: 'match',
        id: BUILD,
        served: TREE,
        expected: TREE,
        reason: null,
      },
    })
  })

  it('records the display profile drive.mjs boots on as high dynamic range', async () => {
    const point = await asserted(page({ description: K.description }))
    expect(point.dynamicRangeHigh).toBe(true)
  })

  it('names the system, Sol at earthrise, generated at far-shore and catalog at a real star', async () => {
    const [earthrise, farShore] = N1.runs
    expect(earthrise.id).toMatch(/^earthrise/)
    expect(farShore.id).toMatch(/^far-shore/)
    expect((await asserted(fromRun(earthrise))).system).toBe('sol')
    expect((await asserted(fromRun(farShore))).system).toBe('generated')
    // A catalog star is neither: Alpha Centauri A by its Hipparcos number, a
    // red dwarf by Gliese's, and a population id beside the legacy one.
    for (const [system, kind] of [
      ['HIP71683', 'catalog'],
      ['GJ1061', 'catalog'],
      ['Q3_a_1_0_2', 'generated'],
    ])
      expect((await asserted(page({ system }))).system).toBe(kind)
    // With no harness to ask, the URL's `address`, as the spike's `lib.mjs`
    // wrote each point's.
    const unbooted = (search) =>
      asserted(page({ description: null, canvas: null, search }), {
        kind: 'shell',
      })
    expect((await unbooted('?address=s%3ASOL%2Fb%3A2.0')).system).toBe('sol')
    expect(
      (await unbooted('?address=g%3Amilky-way%2Fs%3AP222_1_0_9%2Fb%3A4'))
        .system,
    ).toBe('generated')
    expect((await unbooted('')).system).toBeNull()
  })

  it('passes Chrome for Testing 151 as well, which is why the refusal comes before launch', async () => {
    // Its adapter is Chrome 157's, Metal with no fallback flag; its far-shore
    // GPU time is 26.89 ms a frame against 14.13 (cft-gpu.json, sequential).
    // Probe A recorded no buffer for it, so the page's is the 1600×900@1
    // context's own.
    const point = await asserted(
      page({
        description: TESTING.adapter.game,
        offered: TESTING.adapter.adapter,
      }),
      { browser: TESTING.version },
    )
    expect(point.adapter).toMatchObject({
      vendor: 'apple',
      architecture: 'metal-3',
    })
  })

  it('refuses the default headless shell for kind webgpu and accepts it for kind shell', async () => {
    // No switches: no adapter, and the game on WebGL over SwiftShader.
    const [none] = SHELL.variants
    expect(none.args).toEqual([])
    const shell = () =>
      page({
        description: SHELL.gameFallback.description,
        offered: none.adapter,
      })
    const refusal = asserted(shell(), { browser: none.version })
    await expect(refusal).rejects.toThrow(
      'backend webgl where webgpu is required',
    )
    await expect(asserted(shell(), { browser: none.version })).rejects.toThrow(
      'navigator.gpu offered no adapter',
    )
    const point = await asserted(shell(), {
      browser: none.version,
      kind: 'shell',
    })
    expect(point).toMatchObject({
      kind: 'shell',
      backend: 'webgl',
      adapter: null,
    })
  })

  it('refuses SwiftShader’s fallback adapter, and a software one its flag misses', async () => {
    // The shell under `--enable-unsafe-webgpu` alone. Put beside Chrome 157's
    // WebGPU renderer so the adapter is the only thing refused.
    const [, unsafe] = SHELL.variants
    expect(unsafe.args).toEqual(['--enable-unsafe-webgpu'])
    await expect(asserted(page({ offered: unsafe.adapter }))).rejects.toThrow(
      'the adapter google/swiftshader is a fallback adapter',
    )
    // Not measured: a software adapter that does not set the flag, as a build
    // that reports `isFallbackAdapter` nowhere would. The name still refuses
    // it, by `gpuAdapter.mjs`'s pattern.
    for (const [vendor, architecture] of [
      ['google', 'swiftshader'],
      ['mesa', 'llvmpipe'],
      ['microsoft', 'warp'],
    ]) {
      await expect(
        asserted(page({ offered: { vendor, architecture } })),
      ).rejects.toThrow(
        `the adapter ${vendor}/${architecture} is a software rasterizer by name`,
      )
    }
  })

  it('accepts the WebGL fallback for kind fallback, and refuses WebGPU there', async () => {
    // Not recorded: the shell's buffer. The page's is its context's own.
    const point = await asserted(
      page({
        description: SHELL.gameFallback.description,
        offered: SHELL.variants[0].adapter,
      }),
      { kind: 'fallback' },
    )
    expect(point.backend).toBe('webgl')
    await expect(asserted(page(), { kind: 'fallback' })).rejects.toThrow(
      'backend webgpu where webgl is required',
    )
  })

  it('reads the adapter the engine’s device holds before asking for a fresh one', async () => {
    // A fresh request may answer differently from the device the renderer
    // runs on; this one offers SwiftShader beside a Metal device.
    const requests = { count: 0 }
    const point = await asserted(
      page({
        device: CHROME.adapter.adapter,
        offered: SHELL.variants[1].adapter,
        requests,
      }),
    )
    expect(point.adapter).toMatchObject({ vendor: 'apple', source: 'device' })
    expect(requests.count).toBe(0)
  })

  it('asks a page that built no renderer for no adapter', async () => {
    const requests = { count: 0 }
    const point = await asserted(
      page({ description: null, canvas: null, requests }),
      { kind: 'shell' },
    )
    expect(point).toMatchObject({ backend: null, adapter: null, buffer: null })
    expect(requests.count).toBe(0)
  })

  it('warns when Chrome changes, and never refuses on a version', async () => {
    const warn = vi.fn()
    await asserted(fromRun(N1.runs[0]), { recorded: TESTING.version, warn })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(
      `${TESTING.version} to ${CHROME.version}`,
    )
    warn.mockClear()
    await asserted(fromRun(N1.runs[0]), { recorded: CHROME.version, warn })
    await asserted(fromRun(N1.runs[0]), { recorded: null, warn })
    await asserted(fromRun(N1.runs[0]), { browser: '120.0.6099.71', warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses a page served from another tree, naming both', async () => {
    const run = asserted(page({ build: () => ({ id: BUILD, tree: SIBLING }) }))
    await expect(run).rejects.toThrow(`served from ${SIBLING}, not ${TREE}`)
  })

  it('needs the tree under test', async () => {
    await expect(asserted(page(), { tree: undefined })).rejects.toThrow(
      new TypeError(NO_TREE),
    )
  })

  it('needs the browser version it records', async () => {
    await expect(
      assertOperatingPoint(page(), { browser: undefined }),
    ).rejects.toThrow(TypeError)
  })

  it('refuses a kind that is not one', async () => {
    await expect(asserted(page(), { kind: 'gpu' })).rejects.toThrow(
      /webgpu, fallback, shell/,
    )
  })

  it('runs unchanged over drive.mjs’s socket', async () => {
    // `cdp.mjs` wraps the expression and asks for it by value; this `send`
    // runs what it was sent in the same page.
    const inPage = page()
    const send = async (method, { expression }) => {
      expect(method).toBe('Runtime.evaluate')
      return { result: { value: await inPage(expression) } }
    }
    const point = await asserted((expression) =>
      evaluateOverSocket(send, expression),
    )
    expect(point.backend).toBe('webgpu')
    expect(OPERATING_POINT.startsWith('(async () =>')).toBe(true)
  })
})

describe('the served tree', () => {
  /*
   * `/tmp` is a symlink to `/private/tmp` on macOS and is no symlink on CI's
   * Linux runner, so the realpath here is a table rather than the machine's.
   */
  const macOS = (tree) => tree.replace(/^\/tmp(?=\/|$)/, '/private/tmp')

  it('matches the tree the page reports, and carries its build id', () => {
    expect(compareIdentity({ id: BUILD, tree: TREE }, TREE)).toEqual({
      verdict: 'match',
      id: BUILD,
      served: TREE,
      expected: TREE,
      reason: null,
    })
  })

  it('refuses a sibling worktree on the same commit, naming both trees', async () => {
    const verdict = compareIdentity({ id: BUILD, tree: SIBLING }, TREE)
    expect(verdict).toMatchObject({ verdict: 'mismatch', id: BUILD })
    expect(verdict.reason).toContain(SIBLING)
    expect(verdict.reason).toContain(TREE)
    await expect(
      assertServedTree(
        page({ build: () => ({ id: BUILD, tree: SIBLING }) }),
        TREE,
      ),
    ).rejects.toThrow(`served from ${SIBLING}, not ${TREE}`)
  })

  /*
   * Unchecked rather than refused: a production build carries no filesystem
   * path, so every `--url` at `pnpm preview` on 8787 would be refused, and so
   * would every `presets:compare --base` at a commit older than the verb.
   */
  it('leaves a production build unchecked, and proceeds', async () => {
    for (const tree of [null, ''])
      expect(compareIdentity({ id: BUILD, tree }, TREE)).toMatchObject({
        verdict: 'unchecked',
        id: BUILD,
        reason: expect.stringContaining('production build'),
      })
    await expect(
      assertServedTree(
        page({ build: () => ({ id: BUILD, tree: null }) }),
        TREE,
      ),
    ).resolves.toMatchObject({ verdict: 'unchecked' })
  })

  it('leaves a build older than ir.build() unchecked, and proceeds', async () => {
    for (const served of [null, undefined])
      expect(compareIdentity(served, TREE)).toMatchObject({
        verdict: 'unchecked',
        id: null,
        reason: expect.stringContaining('ir.build()'),
      })
    await expect(
      assertServedTree(page({ build: null }), TREE),
    ).resolves.toMatchObject({ verdict: 'unchecked', id: null })
    // A document with the app's scripts off has no harness at all.
    await expect(
      assertServedTree(page({ description: null }), TREE),
    ).resolves.toMatchObject({ verdict: 'unchecked' })
  })

  it('reads /tmp and /private/tmp as one tree, and a trailing slash as none', () => {
    const realpath = (tree) => {
      const real = macOS(tree)
      if (!real.startsWith('/private/tmp')) throw new Error('ENOENT')
      return real
    }
    const served = { id: BUILD, tree: '/tmp/ir-wave2/' }
    for (const expected of [
      '/private/tmp/ir-wave2',
      '/tmp/ir-wave2',
      '/private/tmp/ir-wave2//',
    ])
      expect(compareIdentity(served, expected, { realpath }).verdict).toBe(
        'match',
      )
    expect(
      compareIdentity(served, '/private/tmp/ir-wave3', { realpath }).verdict,
    ).toBe('mismatch')
    // Spelling alone, where neither side exists: the slash still goes.
    expect(compareIdentity({ id: BUILD, tree: `${TREE}/` }, TREE).verdict).toBe(
      'match',
    )
  })

  it('follows a symlinked worktree to the checkout it names', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ir-identity-'))
    try {
      const tree = path.join(dir, 'checkout')
      const link = path.join(dir, 'linked')
      mkdirSync(tree)
      symlinkSync(tree, link)
      expect(compareIdentity({ id: BUILD, tree: link }, tree).verdict).toBe(
        'match',
      )
      expect(
        compareIdentity({ id: BUILD, tree: `${tree}/` }, `${link}/`).verdict,
      ).toBe('match')
      mkdirSync(path.join(dir, 'other'))
      expect(
        compareIdentity({ id: BUILD, tree: path.join(dir, 'other') }, link)
          .verdict,
      ).toBe('mismatch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('needs the tree under test', () => {
    for (const expected of [undefined, null, ''])
      expect(() =>
        compareIdentity({ id: BUILD, tree: TREE }, expected),
      ).toThrow(new TypeError(NO_TREE))
  })
})

describe('the drawing buffer', () => {
  it('passes 2880×1800 at 1440×900@2', async () => {
    for (const run of N3.runs) {
      expect(run.env.canvas).toEqual([2880, 1800])
      const point = await asserted(fromRun(run))
      expect(point.buffer).toEqual({ width: 2880, height: 1800 })
    }
  })

  it('fails a DPR-1 buffer under DPR 2', async () => {
    const [run] = N3.runs
    await expect(
      asserted(fromRun(run, { canvas: [1440, 900] })),
    ).rejects.toThrow('the drawing buffer is 1440×900, not 2880×1800')
  })

  it('floors as three does, at the ratio the page reports rather than the one asked for', async () => {
    // N4's B arm asked for 1.05 and Chrome reports 1.0499999523162842.
    const [, b] = N4.runs
    expect(b.dpr).toBe(1.05)
    expect(b.env.canvas).toEqual([1679, 944])
    await expect(asserted(fromRun(b))).resolves.toMatchObject({
      buffer: { width: 1679, height: 944 },
    })
    const at = (dpr) =>
      expectedBuffer({
        viewport: { width: 1600, height: 900 },
        dpr,
        coarse: false,
        picture: DEFAULT_PICTURE,
      })
    expect(at(b.env.devicePixelRatio)).toEqual({ width: 1679, height: 944 })
    // Rounding, or the requested 1.05, both say 1680×945.
    expect(Math.round(1600 * b.env.devicePixelRatio)).toBe(1680)
    expect(at(1.05)).toEqual({ width: 1680, height: 945 })
  })

  it('caps the ratio at the pointer’s ceiling, and doubles it for a supersampled picture', async () => {
    const supersample = { aa: 'supersample', scale: 'native', sharpness: 'off' }
    const cases = [
      [[390, 844], 3, false, DEFAULT_PICTURE, [780, 1688]],
      [[390, 844], 3, true, DEFAULT_PICTURE, [585, 1266]],
      [[1600, 900], 1, false, supersample, [3200, 1800]],
      [[1440, 900], 2, false, supersample, [5760, 3600]],
    ]
    for (const [[width, height], dpr, coarse, picture, [w, h]] of cases)
      expect(
        expectedBuffer({ viewport: { width, height }, dpr, coarse, picture }),
      ).toEqual({ width: w, height: h })
    await expect(
      asserted(page({ picture: supersample, canvas: [1600, 900] })),
    ).rejects.toThrow('the drawing buffer is 1600×900, not 3200×1800')
  })

  it('fails closed on a page that names no picture', async () => {
    await expect(asserted(page({ picture: null }))).rejects.toThrow(
      'the page names no picture',
    )
  })

  it('accepts exactly one buffer at any viewport and ratio', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3840 }),
        fc.integer({ min: 1, max: 2160 }),
        fc.constantFrom(1, 1.0499999523162842, 1.25, 1.5, 2, 2.625, 3),
        fc.boolean(),
        fc.constantFrom(...PICTURE_AA),
        fc.constantFrom([0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]),
        async (width, height, dpr, coarse, aa, [dw, dh]) => {
          const picture = { ...DEFAULT_PICTURE, aa }
          const buffer = expectedBuffer({
            viewport: { width, height },
            dpr,
            coarse,
            picture,
          })
          const run = asserted(
            page({
              viewport: [width, height],
              dpr,
              coarse,
              picture,
              canvas: [buffer.width + dw, buffer.height + dh],
            }),
          )
          if (dw === 0 && dh === 0) await expect(run).resolves.toBeTruthy()
          else await expect(run).rejects.toThrow('the drawing buffer is')
        },
      ),
      { numRuns: 200 },
    )
  })
})
