/*
 * The browser a measurement runs in: two launch presets, a refusal of every
 * other browser before launch, and a guard on the page after boot.
 *
 * Playwright's defaults pick browsers no player runs, and each fails without
 * saying so (design/plans/playwright.md, probes A–D):
 *
 *  - no `channel`, headless, is its headless shell: no WebGPU adapter, so the
 *    game boots on WebGL over SwiftShader, in 67 s, at about 1 fps;
 *  - `channel: 'chromium'` is its Chrome for Testing 151, which reaches the
 *    same Metal adapter as Chrome 157 and spent 26.89 ms of GPU a frame at
 *    far-shore against Chrome 157's 14.13, measured one after the other;
 *  - its default `--force-color-profile=srgb` makes `(dynamic-range: high)`
 *    false, and the extended-output path goes with it.
 *
 * The check is in two places because neither can see what the other does.
 * Chrome for Testing has Chrome's adapter, so nothing in its page tells it
 * apart: `launchOptions` refuses it by name, before a page opens. A preset
 * cannot see what the page built: `assertOperatingPoint` reads the renderer,
 * the adapter and the drawing buffer after boot, through an `evaluate` port
 * that takes one expression and answers by value. `page.evaluate` is that
 * port, and so is `cdp.mjs`'s `evaluate` over drive.mjs's socket.
 */
import { readFileSync } from 'node:fs'
import { dprCeiling } from '../apps/game/src/render/output.ts'
import { pictureDprFactor } from '../apps/game/src/render/picture.ts'

/*
 * `gpuAdapter.mjs`'s names for a software rasterizer, read from its source
 * rather than imported or restated. That script asks Dawn for an adapter and
 * exits the process at its top level, so importing it for one constant runs a
 * GPU probe inside every caller of this module; a second copy of the pattern
 * is the one that stops matching.
 */
const SOFTWARE = (() => {
  const source = readFileSync(
    new URL('./gpuAdapter.mjs', import.meta.url),
    'utf8',
  )
  const declared = /^const SOFTWARE = \/(.+)\/([dgimsuvy]*)$/m.exec(source)
  if (declared === null)
    throw new Error(
      'driveLaunch: scripts/gpuAdapter.mjs declares no `const SOFTWARE = /…/`',
    )
  return new RegExp(declared[1], declared[2])
})()

/** The measured launches, as `chromium.launch` options. */
export const PRESETS = Object.freeze({
  /*
   * New headless Chrome stable on Playwright's forced sRGB, so a plate is the
   * build's alone rather than the display's: AE 0 across launches (probe C),
   * the Metal adapter and a 60 fps screencast (probes A, F).
   */
  sdr: Object.freeze({ channel: 'chrome', headless: true }),
  /*
   * A real window on the attached display's color profile, for what only a
   * compositor shows. drive.mjs's own window reads `(dynamic-range: high)` true
   * on it (probe K); a Playwright window with the switch dropped has not been
   * measured. The position is drive.mjs's: off the desktop to the right, where
   * the window takes no click from the person at the machine.
   */
  display: Object.freeze({
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: Object.freeze(['--force-color-profile=srgb']),
    args: Object.freeze(['--window-position=2400,60']),
  }),
})

const named = (file) =>
  /chrome-headless-shell/i.test(file)
    ? `Playwright's headless shell at ${file}`
    : /Chrome for Testing/.test(file)
      ? `Chrome for Testing at ${file}`
      : `the executable at ${file}`

/**
 * The browser these launch options open when it is not Chrome stable, or null.
 *
 * Any `executablePath` is refused, Chrome's own included: a path pins whatever
 * build is at it, and only the `chrome` channel is the release that updates
 * itself the way a player's does.
 */
function foreignBrowser({ channel, executablePath, headless }) {
  if (executablePath !== undefined) return named(executablePath)
  if (channel === 'chrome') return null
  if (channel === 'chromium')
    return "Playwright's Chrome for Testing (channel 'chromium')"
  if (channel !== undefined) return `channel '${channel}'`
  return headless === false
    ? "Playwright's Chrome for Testing (no channel, headed)"
    : "Playwright's headless shell (no channel, headless)"
}

/** Throws, naming the browser, unless `options` launch Chrome stable. */
export function refuseForeignBrowser(options) {
  const browser = foreignBrowser(options)
  if (browser === null) return
  throw new Error(
    `driveLaunch: refusing ${browser}. A measurement runs in Chrome stable, ` +
      "channel 'chrome'; a spec that compares browsers declares { comparison: true }.",
  )
}

/**
 * A preset's launch options with the caller's over them, refused before launch
 * unless they are Chrome stable. `comparison: true` declares a probe that
 * compares browsers, and exempts it from that refusal and nothing else: its
 * page still meets `assertOperatingPoint`.
 */
export function launchOptions(
  preset,
  { comparison = false, ...overrides } = {},
) {
  const base = PRESETS[preset]
  if (base === undefined)
    throw new Error(
      `driveLaunch: no preset '${preset}'; the presets are ${Object.keys(PRESETS).join(', ')}`,
    )
  const options = { ...base, ...overrides }
  // Fresh arrays, because Playwright is handed these and the presets are frozen.
  options.args = [...(base.args ?? []), ...(overrides.args ?? [])]
  // Both lists add up. Replacing the preset's would let a caller dropping one
  // more default put back the forced sRGB `display` exists to drop, and
  // nothing after boot refuses a page without the extended range. A boolean
  // from the caller is a whole answer and stands.
  if (
    Array.isArray(base.ignoreDefaultArgs) &&
    Array.isArray(overrides.ignoreDefaultArgs)
  )
    options.ignoreDefaultArgs = [
      ...base.ignoreDefaultArgs,
      ...overrides.ignoreDefaultArgs,
    ]
  else if (Array.isArray(options.ignoreDefaultArgs))
    options.ignoreDefaultArgs = [...options.ignoreDefaultArgs]
  if (!comparison) refuseForeignBrowser(options)
  return options
}

/**
 * What the page says about its operating point: one expression, answered by
 * value.
 *
 * The adapter is the engine's own device's where it has one. A fresh
 * `requestAdapter` can answer differently from the device the renderer holds,
 * and three keeps no adapter, so `device.adapterInfo` is the only reading of
 * the one in use. Its fields are copied one by one: `GPUAdapterInfo` keeps them
 * as prototype accessors, so the object itself arrives as `{}`. A page that
 * built no renderer is asked for no adapter at all, so a GPU-free page stays
 * that way.
 *
 * `build` is `dev` when the document loads Vite's client, which the dev server
 * injects and a production build has no copy of.
 */
export const OPERATING_POINT = `(async () => {
  const engine = window.engine ?? null
  const gl = engine?.gl ?? null
  const canvas = gl?.renderer?.domElement ?? null
  const copy = (info, source) =>
    info
      ? {
          vendor: info.vendor ?? '',
          architecture: info.architecture ?? '',
          device: info.device ?? '',
          description: info.description ?? '',
          isFallbackAdapter: info.isFallbackAdapter ?? null,
          source,
        }
      : null
  let adapter = copy(gl?.renderer?.backend?.device?.adapterInfo, 'device')
  if (adapter === null && gl !== null && navigator.gpu) {
    const offered = await navigator.gpu
      .requestAdapter({ powerPreference: 'high-performance' })
      .catch(() => null)
    adapter = copy(offered?.info, 'request')
  }
  const address = new URLSearchParams(location.search).get('address') ?? ''
  return {
    origin: location.origin,
    build: document.querySelector('script[src*="/@vite/client"]') ? 'dev' : 'production',
    viewport: { width: innerWidth, height: innerHeight },
    dpr: devicePixelRatio,
    coarse: matchMedia('(pointer: coarse)').matches,
    buffer: canvas ? { width: canvas.width, height: canvas.height } : null,
    adapter,
    backend: gl?.description?.backend ?? null,
    dynamicRangeHigh:
      gl?.description?.capability?.dynamicRangeHigh ??
      matchMedia('(dynamic-range: high)').matches,
    picture: engine?.picture ?? null,
    system:
      window.ir?.observerStatus?.()?.target?.system ??
      /(?:^|\\/)s:([^/]+)/.exec(address)?.[1] ??
      null,
  }
})()`

/**
 * The drawing buffer the renderer builds for a page.
 *
 * `App.tsx` hands `<Canvas>` `min(devicePixelRatio, dprCeiling(coarse)) ×
 * pictureDprFactor(picture)`, R3F passes a number through untouched, and
 * three's `CanvasTarget.setSize` floors the CSS size times it. The floor is
 * visible: Chrome reports a requested 1.05 as 1.0499999523162842, and 1600 CSS
 * pixels at that are 1679 buffer pixels (N4), where rounding says 1680. So the
 * ratio is the page's own, never the one the context asked for.
 */
export function expectedBuffer({ viewport, dpr, coarse, picture }) {
  const ratio = Math.min(dpr, dprCeiling(coarse)) * pictureDprFactor(picture)
  return {
    width: Math.floor(viewport.width * ratio),
    height: Math.floor(viewport.height * ratio),
  }
}

/*
 * What each kind of run requires. `webgpu` is every performance figure and
 * plate. `fallback` is the WebGL 2 backend the game takes without an adapter,
 * whatever rasterizer the browser offers it, which is the point of that run.
 * `shell` is the DOM with the runtime refused, where the GPU is not the
 * question.
 */
const KINDS = Object.freeze({
  webgpu: { backend: 'webgpu', adapter: true, buffer: true },
  fallback: { backend: 'webgl', adapter: false, buffer: true },
  shell: { backend: null, adapter: false, buffer: false },
})

function adapterRefusal(adapter) {
  if (adapter === null) return 'navigator.gpu offered no adapter'
  const name = `${adapter.vendor}/${adapter.architecture}`
  if (adapter.isFallbackAdapter === true)
    return `the adapter ${name} is a fallback adapter`
  const words = `${adapter.vendor} ${adapter.architecture} ${adapter.device} ${adapter.description}`
  if (SOFTWARE.test(words))
    return `the adapter ${name} is a software rasterizer by name`
  return null
}

function bufferRefusal(reading) {
  if (reading.buffer === null) return 'the page has no drawing buffer'
  if (reading.picture === null)
    return 'the page names no picture, so its drawing buffer cannot be checked'
  const { width, height } = expectedBuffer(reading)
  if (reading.buffer.width === width && reading.buffer.height === height)
    return null
  return (
    `the drawing buffer is ${reading.buffer.width}×${reading.buffer.height}, not ${width}×${height} ` +
    `(${reading.viewport.width}×${reading.viewport.height} at min(DPR ${reading.dpr}, ` +
    `ceiling ${dprCeiling(reading.coarse)}) × ${pictureDprFactor(reading.picture)})`
  )
}

function refusals(reading, expects) {
  const found = []
  if (expects.backend !== null && reading.backend !== expects.backend)
    found.push(
      `backend ${reading.backend ?? 'none'} where ${expects.backend} is required`,
    )
  if (expects.adapter) found.push(adapterRefusal(reading.adapter))
  if (expects.buffer) found.push(bufferRefusal(reading))
  // The served build and tree against the tree under test (X3) belong here.
  // Nothing in the page names the tree it was built from, so there is no
  // reading to hold them against.
  return found.filter((refusal) => refusal !== null)
}

/**
 * Reads the page's operating point through `evaluate`, refuses one that is not
 * `kind`, and returns it as a record for the test's annotations.
 *
 * `browser` is the version the caller launched — `browser.version()`, or
 * `Browser.getVersion` over CDP — and `recorded` the one it recorded last, or
 * null on a first run. A change is a warning through `warn`, never a refusal:
 * Chrome stable updates itself, and a version floor would refuse the browser
 * players run on the day it updates. Probe D is why it is worth the warning:
 * Chrome for Testing 151, another version and another build, spent 1.9× Chrome
 * 157's GPU time a frame at far-shore and 5.1× at earthrise, measured one after
 * the other.
 */
export async function assertOperatingPoint(
  evaluate,
  { kind = 'webgpu', browser, recorded = null, warn = console.warn } = {},
) {
  const expects = KINDS[kind]
  if (expects === undefined)
    throw new Error(
      `driveLaunch: no kind '${kind}'; the kinds are ${Object.keys(KINDS).join(', ')}`,
    )
  if (typeof browser !== 'string' || browser === '')
    throw new TypeError(
      'driveLaunch: assertOperatingPoint records the browser version, and none was given',
    )
  const reading = await evaluate(OPERATING_POINT)
  if (recorded !== null && recorded !== browser)
    warn(
      `driveLaunch: Chrome changed from ${recorded} to ${browser} since the last recorded run; ` +
        'a figure from one does not compare with a figure from the other',
    )
  const found = refusals(reading, expects)
  if (found.length > 0)
    throw new Error(
      `driveLaunch: not a ${kind} operating point: ${found.join('; ')}`,
    )
  return {
    kind,
    origin: reading.origin,
    build: reading.build,
    browser,
    viewport: reading.viewport,
    dpr: reading.dpr,
    coarse: reading.coarse,
    buffer: reading.buffer,
    adapter: reading.adapter,
    backend: reading.backend,
    dynamicRangeHigh: reading.dynamicRangeHigh,
    picture: reading.picture,
    system: systemKind(reading.system),
  }
}

/*
 * Sol, a catalog star, or a generated system, by the id's own shape. A
 * generated id is `P` or `Q` and base-36 fields joined by underscores
 * (`galaxy.ts`, `galaxy/population.ts`); a catalog id is `HIP…`, `GJ…`, `HD…`,
 * `HR…` or `HYG…`, upper case and alphanumeric (`catalog/identity.ts`), so it
 * never carries one. A plate at Alpha Centauri is a real star's, not a seed's.
 */
function systemKind(system) {
  if (system === null) return null
  if (system === 'SOL') return 'sol'
  return /^[PQ][0-9a-z]*_/.test(system) ? 'generated' : 'catalog'
}
