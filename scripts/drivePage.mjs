/*
 * The page under `scripts/drive.mjs`: clearing what a previous invocation left
 * in it, and the readiness ladder that decides when a boot is finished.
 *
 * Both take `send` and a `page` of `{ url, document, note, sleep, now }`, so
 * `drivePage.test.mjs` runs the ladder against a scripted Chrome.
 */
import { evaluate } from './cdp.mjs'

/**
 * `ir.status().boot`, or `booting` until the harness is there to ask.
 *
 * A build without the field — the baseline `presets:compare --base` serves
 * from an older commit, driven by this tree's driver — reads `drawing` once it
 * has a renderer, never `booted`: reading `booting` would wait out the
 * renderer timeout on every plate, and `booted` would photograph the cover.
 * The cover wait gives up after its twelve seconds there, by which time the
 * cover has lifted.
 */
const BOOT = `const status = window.ir?.status?.()
  if (status === undefined) return 'booting'
  return status.boot ?? (window.engine?.gl ? 'drawing' : 'booting')`

const ready = (document) =>
  document
    ? "return document.readyState !== 'loading'"
    : `return (() => { ${BOOT} })() !== 'booting'`

/** Polls for a committed renderer or document before giving up. */
const COMMIT_POLLS = 200
/** Polls for the cover to lift — twelve seconds at the 500 ms interval. */
const COVER_POLLS = 24

/** Clear this rig's cookies and local storage before the app can read them.
 * Navigating away first also discards in-memory preferences from a warm page.
 * IndexedDB saves, asset caches and service workers are outside this reset. */
export async function clearStorage(send, { url, note, sleep }) {
  // Guarded like every probe in `boot`: a page mid-navigation, or one whose
  // renderer died since the last invocation, answers `Runtime.evaluate` with
  // "Cannot find context with specified id" — and the origin is only used to
  // widen the clear beyond the one this call is about to boot.
  const current = await evaluate(send, 'location.origin').catch(() => 'null')
  await send('Page.navigate', { url: 'about:blank' })
  // Page.navigate acknowledges the navigation before the new document is
  // necessarily committed. Wait until the old app can no longer write back.
  for (let i = 0; ; i++) {
    const blank = await evaluate(send, "location.href === 'about:blank'").catch(
      () => false,
    )
    if (blank) break
    if (i === 100) throw new Error('page did not leave before clearing storage')
    await sleep(50)
  }
  await send('Network.clearBrowserCookies')
  for (const origin of new Set([current, new URL(url).origin])) {
    if (origin === 'null') continue
    // Session storage too: Chrome restores it with the tab after `--down`,
    // and the app keeps its graphics-session strikes there. A rig whose every
    // launch is a session that ended without `pagehide` would otherwise be
    // refused the renderer on its second launch, with nothing on this side
    // saying why. See `apps/game/src/graphicsSession.ts`.
    await send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'local_storage,session_storage',
    })
  }
  note('cleared local, session storage and cookies')
}

/**
 * Whether the page at `here` (a path and search) shows what `url` asks for.
 *
 * The mode is a function of the path, so a booted page on `/` is not a
 * booted page on `/planetarium` — attaching to it regardless captions a
 * screenshot of the home poster as the planetarium. The query is
 * half of that contract and carries the same weight: `?at=` is the body the
 * planetarium opens on, `?t=` the cutscene frame, `?seed=` the universe.
 *
 * Asked-for keys only, never the whole search string. The app writes those
 * same keys back as it plays — `CinemaPlayer` replaces `t` on every frame,
 * `PlanetariumMode` replaces `at` on every target — so an exact comparison
 * would miss on a page that is already showing exactly what was asked for,
 * and turn every warm attach into a six-second re-boot.
 */
export function showing(url, here) {
  const wanted = new URL(url)
  const at = new URL(here, wanted.origin)
  return (
    at.pathname === wanted.pathname &&
    [...wanted.searchParams].every(
      ([key, value]) => at.searchParams.get(key) === value,
    )
  )
}

/** Attach to the page when it already shows `url` and is ready; otherwise
 *  navigate there and climb the ladder: committed, ready, then the cover. */
export async function boot(send, { force }, page) {
  const { url, document, note, sleep, now } = page
  const READY = ready(document)
  const isReady = await evaluate(send, READY).catch(() => false)
  const here = await evaluate(
    send,
    'return location.pathname + location.search',
  ).catch(() => '')
  if (isReady && !force && showing(url, here)) {
    note(
      document ? 'attached to a ready document' : 'attached to a booted page',
    )
    return
  }
  // Always a full navigate, never HMR: a WebGPURenderer does not survive a
  // dozen hot reloads, and a tab that has had them draws its HUD with
  // no renderer under it — which reads as a rendering bug and is not one.
  const navigation = await send('Page.navigate', { url })
  if (navigation.errorText) throw new Error(navigation.errorText)
  const started = now()
  for (let i = 0; ; i += 1) {
    await sleep(500)
    // navigate acknowledges before the new document commits. The old page's
    // readyState can still be complete, so match the navigation's loader first.
    const committed =
      !document ||
      navigation.loaderId === undefined ||
      (await send('Page.getFrameTree')).frameTree.frame.loaderId ===
        navigation.loaderId
    if (committed && (await evaluate(send, READY).catch(() => false))) break
    if (i === COMMIT_POLLS)
      throw new Error(
        `${document ? 'document' : 'renderer'} never became ready`,
      )
  }
  const seconds = () => ((now() - started) / 1000).toFixed(1)
  if (document) {
    note(`document ready in ${seconds()} s`)
    return
  }
  // The boot cover lifts on the presentation watchdog, which needs a frame
  // after the renderer appears. Poll for `booted` rather than sleeping a
  // guessed interval, and give up rather than block: the scene underneath is
  // already rendering, so a stuck cover is a HUD question, not a render one.
  for (let i = 0; i < COVER_POLLS; i += 1) {
    const phase = await evaluate(send, BOOT).catch(() => 'booted')
    if (phase === 'booted') break
    await sleep(500)
  }
  note(`renderer ready in ${seconds()} s`)
}
