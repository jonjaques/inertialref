import { sessionHeaders } from '../account/token.ts'
import { setVoice } from '../audio/voice.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GuideExecutor } from './executor.ts'
import { LiveConnection } from './media.ts'
import { textureSetReady } from '../render/planetTextures.ts'
import { CAMERA_LENS, subscribe } from '../state/preferences.ts'
import { subjectView, ViewReadiness } from './readiness.ts'
import { type GuideActivity, GuideRuntime } from './runtime.ts'
import type { GuideAccessOwner } from './verdict.ts'

/**
 * The session states in which the visitor is listening to the guide, or about
 * to: the soundtrack ducks for these. Not `paused`, which is the visitor
 * taking time to look, and not `offline`.
 */
const VOICED: ReadonlySet<GuideActivity['state']> = new Set([
  'connecting',
  'reconnecting',
  'listening',
  'speaking',
  'thinking',
  'searching',
  'moving',
  'visitor-camera',
  'ending',
])

/** Host clocks and media begin only after an explicit guide action. */
export function createGuideRuntime(
  engine: GameEngine,
  access: GuideAccessOwner,
): GuideRuntime {
  const runtime = new GuideRuntime({
    access: () => access.current(),
    now: () => Date.now(),
    localTime: () =>
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    /*
     * Every request carries the account's session token, fetched per request
     * because Clerk mints a fresh one near expiry. The Worker decides from it
     * whether this account has the guide (`apps/server/src/tour/access.ts`);
     * without one it answers as it would for anybody signed out.
     */
    request: async (path, body, signal) => {
      const headers = await sessionHeaders()
      if (body !== undefined) headers.set('Content-Type', 'application/json')
      return fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    },
    executor: ({ onArrival, onArrivalFailed, onTakeover }) => {
      const readiness = new ViewReadiness()
      const executor = new GuideExecutor(engine.harness, {
        now: () => Date.now(),
        onArrival,
        onArrivalFailed,
        onTakeover,
        // The mode's own claim on the guide, not the presence of a subject: a
        // Milky Way view clears the observatory's target, and a guide gated on
        // one answers "not active in this mode" to the `go_to` that would end
        // the empty sky. `mountGuide` sets this while the Planetarium is
        // mounted and clears it on the way out.
        active: () => engine.guide !== null,
        lens: () => engine.framingLens(),
        aspect: () =>
          window.innerHeight > 0
            ? window.innerWidth / window.innerHeight
            : 16 / 9,
        // What the scene's point tier is measured against, so the guide
        // lists a station exactly where the frame draws one.
        viewport: () => engine.lensView()?.viewport ?? null,
        ready: () => {
          const renderer = engine.gl?.renderer
          const scene = engine.scene()
          const target = engine.harness.observatory.target
          if (
            !renderer ||
            !scene ||
            !target ||
            !engine.present ||
            document.visibilityState !== 'visible'
          )
            return false
          return readiness.ready({
            renderer,
            revision: engine.harness.observatory.mutationRevision,
            frame: renderer.info.frame,
            ...subjectView(
              scene,
              target,
              (body) =>
                textureSetReady(body.appearance.texture) &&
                textureSetReady(body.rings?.texture ?? null),
              engine.stationsDrawn,
            ),
          })
        },
      })
      // A lens change is the visitor's, and it reframes everything on screen
      // without touching the observatory's revision, so the executor is told
      // rather than left to notice: a pending move would otherwise land and
      // be narrated over the view the visitor chose.
      const unsubscribe = subscribe(CAMERA_LENS, () => executor.takeover())
      return {
        get viewRevision() {
          return executor.viewRevision
        },
        get pending() {
          return executor.pending
        },
        get pendingSubject() {
          return executor.pendingSubject
        },
        get searching() {
          return executor.searching
        },
        view: () => executor.view(),
        facts: () => executor.facts(),
        execute: (call) => executor.execute(call),
        poll: () => executor.poll(),
        cancel: () => executor.cancel(),
        takeover: () => executor.takeover(),
        dispose: () => {
          unsubscribe()
          executor.dispose()
        },
      }
    },
    live: (event, failure, notice) =>
      new LiveConnection(undefined, event, failure, notice),
    poll: (run) => {
      const timer = setInterval(run, 100)
      return () => clearInterval(timer)
    },
    visibility: (changed) => {
      const visibility = () => changed(document.visibilityState === 'visible')
      document.addEventListener('visibilitychange', visibility)
      return () => document.removeEventListener('visibilitychange', visibility)
    },
    leaving: (handler) => {
      window.addEventListener('pagehide', handler)
      return () => window.removeEventListener('pagehide', handler)
    },
  })
  /*
   * For the runtime's lifetime, which is the page's: the soundtrack ducks
   * while a session is live (`audio/voice.ts`), and the subscription is the
   * one place that knows both what the guide is doing and what that means
   * for the music.
   */
  runtime.subscribe(() =>
    setVoice('guide', VOICED.has(runtime.getSnapshot().activity.state)),
  )
  return runtime
}
