import { sessionHeaders } from '../account/token.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GuideExecutor } from './executor.ts'
import { LiveConnection } from './media.ts'
import { textureSetReady } from '../render/planetTextures.ts'
import { CAMERA_LENS, subscribe } from '../state/preferences.ts'
import { ViewReadiness } from './readiness.ts'
import { GuideRuntime } from './runtime.ts'
import type { GuideAccessOwner } from './verdict.ts'

/** Host clocks and media begin only after an explicit guide action. */
export function createGuideRuntime(
  engine: GameEngine,
  access: GuideAccessOwner,
): GuideRuntime {
  return new GuideRuntime({
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
    executor: ({ onArrival, onTakeover }) => {
      const readiness = new ViewReadiness()
      const executor = new GuideExecutor(engine.harness, {
        now: () => Date.now(),
        onArrival,
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
          const body = scene.bodies.find(
            (candidate) => candidate.address === target.address,
          )
          const star = scene.stars.some(
            (candidate) => candidate.system === target.system,
          )
          return readiness.ready({
            renderer,
            revision: engine.harness.observatory.mutationRevision,
            frame: renderer.info.frame,
            present: body !== undefined || (target.kind === 'star' && star),
            assets:
              body === undefined ||
              (textureSetReady(body.appearance.texture) &&
                textureSetReady(body.rings?.texture ?? null)),
          })
        },
      })
      // A lens change is the visitor's, and it reframes everything on screen
      // without touching the observatory's revision.
      const unsubscribe = subscribe(CAMERA_LENS, () => onTakeover())
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
        dispose: () => {
          unsubscribe()
          executor.dispose()
        },
      }
    },
    live: (event, failure) => new LiveConnection(undefined, event, failure),
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
}
