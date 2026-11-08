/*
 * The browser a measurement runs in: two launch presets, a refusal of every
 * other browser before launch, and a guard on the page after boot.
 *
 * Playwright's defaults pick browsers no player runs, and each fails without
 * saying so (ADR-0062, and the probes in CONTEXT.md's 7 Nov 2026 entry
 * "Headless Chrome presents"):
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
 *
 * The same port answers which checkout the page is served from, because a
 * server on the expected port is not evidence of the expected tree: a sibling
 * worktree's Vite on 5173 boots the same app and is photographed in its
 * place. `compareIdentity` holds `ir.build()` against the tree under test.
 */
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
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
 * What the page says about the checkout behind it: `ir.build()`, a build id
 * and the tree the dev server serves, or null on a page with no such verb.
 */
export const BUILD_IDENTITY = 'window.ir?.build?.() ?? null'

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
 * injects and a production build has no copy of. `identity` is `ir.build()`,
 * which `compareIdentity` reads.
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
    identity: ${BUILD_IDENTITY},
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

/*
 * The buffer the renderer builds for the page, or null where the page is older
 * than the field that says. `engine.picture` landed a month before `ir.build()`,
 * so a page that answers neither is a build from before both — the baseline
 * `presets:compare --base` serves from an older commit, driven by this tree's
 * driver — and refusing it refuses every such baseline. A page that answers
 * `ir.build()` and names no picture has lost the field, and is refused.
 */
const ruled = (reading) =>
  reading.picture === null ? null : expectedBuffer(reading)

function bufferRefusal(reading) {
  if (reading.buffer === null) return 'the page has no drawing buffer'
  if (reading.picture === null)
    return reading.identity === null
      ? null
      : 'the page names no picture, so its drawing buffer cannot be checked'
  const { width, height } = expectedBuffer(reading)
  if (reading.buffer.width === width && reading.buffer.height === height)
    return null
  return (
    `the drawing buffer is ${reading.buffer.width}×${reading.buffer.height}, not ${width}×${height} ` +
    `(${reading.viewport.width}×${reading.viewport.height} at min(DPR ${reading.dpr}, ` +
    `ceiling ${dprCeiling(reading.coarse)}) × ${pictureDprFactor(reading.picture)})`
  )
}

/*
 * The page's own window and ratio against the ones the caller emulated. The
 * buffer rule holds the canvas to the window the page reports, and a page
 * whose emulation another session cleared or replaced reports that window
 * just as faithfully: 1600×933 at DPR 2 on the Mac mini's display, which an
 * app whose ratio follows draws at 3200×1866 and the buffer rule passes.
 * Compared as float32, because Chrome keeps the ratio as one: an asked-for
 * 1.05 reads back as 1.0499999523162842.
 */
function metricsRefusal(reading, metrics) {
  if (metrics == null) return null
  const { width, height } = reading.viewport
  if (
    width === metrics.width &&
    height === metrics.height &&
    Math.fround(reading.dpr) === Math.fround(metrics.dpr)
  )
    return null
  return (
    `the page's window is ${width}×${height} at DPR ${reading.dpr}, ` +
    `not the ${metrics.width}×${metrics.height} at DPR ${metrics.dpr} the rig set`
  )
}

const NO_TREE =
  'driveLaunch: the served tree is compared with the tree under test, and none was given'

/*
 * One spelling per checkout. git answers `--show-toplevel` with the physical
 * path, a caller's `--tree` is whatever it typed, and on macOS `/tmp` and
 * `/var` are symlinks into `/private`, so compared as strings a rig refuses
 * the tree it serves. A path this machine cannot resolve is compared as
 * spelled, less its trailing slashes.
 */
function canonicalTree(tree, realpath) {
  const resolved = path.resolve(tree)
  try {
    return realpath(resolved)
  } catch {
    return resolved
  }
}

/**
 * The page's `ir.build()` against the checkout the caller means to measure.
 *
 * The build id alone cannot tell two checkouts apart: sibling worktrees cut
 * from one `origin/main` describe the same commit, and both read `-dirty` once
 * anything is edited. The tree is what differs, and only the dev server
 * reports it, because a shipped bundle carries no filesystem path. A page that
 * names no tree is unchecked rather than refused: refusing a production build
 * refuses every `--url` at `pnpm preview` on 8787, and refusing a page with no
 * `ir.build()` refuses every `presets:compare --base` at a commit older than
 * the verb. Unchecked is said, so the caller can print it.
 *
 * @returns {{verdict: 'match' | 'mismatch' | 'unchecked', id: string | null,
 *   served: string | null, expected: string, reason: string | null}}
 */
export function compareIdentity(
  served,
  expected,
  { realpath = realpathSync } = {},
) {
  if (typeof expected !== 'string' || expected === '')
    throw new TypeError(NO_TREE)
  const id = typeof served?.id === 'string' ? served.id : null
  const tree =
    typeof served?.tree === 'string' && served.tree !== '' ? served.tree : null
  const verdict = (name, reason) => ({
    verdict: name,
    id,
    served: tree,
    expected,
    reason,
  })
  if (served === null || typeof served !== 'object')
    return verdict(
      'unchecked',
      'the page answers no ir.build(): a build older than the check, or a page without the app',
    )
  if (tree === null)
    return verdict(
      'unchecked',
      'the page names no tree: a production build carries no filesystem path',
    )
  if (canonicalTree(tree, realpath) === canonicalTree(expected, realpath))
    return verdict('match', null)
  return verdict('mismatch', `the page is served from ${tree}, not ${expected}`)
}

/**
 * `ir.build()` read through `evaluate`, refused when another checkout serves
 * the page and returned as the verdict otherwise. drive.mjs runs it after
 * every boot and attach, before the first step.
 *
 * The refusal leads with a port of the tree's own, because the usual cause is
 * a sibling's Vite on 5173: drive.mjs starts no server while the port answers,
 * and `pnpm dev` refuses a taken one. `--tree` is spelled with a placeholder,
 * never the served path: pasted, that path gets past the refusal and drives
 * the sibling as the tree under test.
 */
export async function assertServedTree(evaluate, tree, options) {
  const verdict = compareIdentity(await evaluate(BUILD_IDENTITY), tree, options)
  if (verdict.verdict === 'mismatch')
    throw new Error(
      `driveLaunch: ${verdict.reason}, the tree under test. ` +
        `Serve the tree under test on a port of its own, \`pnpm dev:client --port <n>\` in ${verdict.expected}, ` +
        'and drive it with `--url http://localhost:<n>/ --no-serve`. ' +
        '`--tree <path>` is for driving another checkout on purpose.',
    )
  return verdict
}

function refusals(reading, expects, identity, metrics) {
  const found = []
  if (expects.backend !== null && reading.backend !== expects.backend)
    found.push(
      `backend ${reading.backend ?? 'none'} where ${expects.backend} is required`,
    )
  if (expects.adapter) found.push(adapterRefusal(reading.adapter))
  // Every kind: a DOM check at a window nobody asked for is at another point.
  found.push(metricsRefusal(reading, metrics))
  if (expects.buffer) found.push(bufferRefusal(reading))
  // Every kind, `shell` included: a DOM check against another checkout's
  // markup is as wrong as a plate of it.
  if (identity.verdict === 'mismatch') found.push(identity.reason)
  return found.filter((refusal) => refusal !== null)
}

/**
 * Reads the page's operating point through `evaluate`, refuses one that is not
 * `kind` or is served from a checkout other than `tree`, and returns it as a
 * record for the test's annotations.
 *
 * `tree` is the checkout under test, which `compareIdentity` holds the page
 * against. `metrics`, when given, is the window and ratio the caller emulated
 * — drive.mjs's `--width`, `--height` and `--dpr`, or a context's viewport and
 * `deviceScaleFactor` — and the page must report them. `browser` is the
 * version the caller launched — `browser.version()`, or
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
  {
    kind = 'webgpu',
    browser,
    tree,
    metrics = null,
    recorded = null,
    warn = console.warn,
  } = {},
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
  if (typeof tree !== 'string' || tree === '') throw new TypeError(NO_TREE)
  const reading = await evaluate(OPERATING_POINT)
  if (recorded !== null && recorded !== browser)
    warn(
      `driveLaunch: Chrome changed from ${recorded} to ${browser} since the last recorded run; ` +
        'a figure from one does not compare with a figure from the other',
    )
  const identity = compareIdentity(reading.identity, tree)
  const found = refusals(reading, expects, identity, metrics)
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
    // What the buffer was held against; null is a page too old to say.
    expectedBuffer: ruled(reading),
    adapter: reading.adapter,
    backend: reading.backend,
    dynamicRangeHigh: reading.dynamicRangeHigh,
    picture: reading.picture,
    system: systemKind(reading.system),
    identity,
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
