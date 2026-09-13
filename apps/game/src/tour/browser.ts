import type { GameEngine } from '../engine/GameEngine.ts'
import { TourExecutor } from './executor.ts'
import { ControlledPlayback, LiveConnection } from './media.ts'
import { textureSetReady } from '../render/planetTextures.ts'
import { CAMERA_LENS, subscribe } from '../state/preferences.ts'
import { ViewReadiness } from './readiness.ts'
import { GuideRuntime } from './runtime.ts'

/** Host clocks and media begin only after an explicit guide action. */
export function createGuideRuntime(engine: GameEngine): GuideRuntime {
  return new GuideRuntime({
    now: () => Date.now(),
    presentationNow: () => engine.presentationTime * 1000,
    id: () => crypto.randomUUID(),
    request: (path, body, signal, keepalive = false) =>
      fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive,
        headers:
          body === undefined
            ? undefined
            : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
    socket: (sessionId, tabId) => {
      const url = new URL(
        `/api/tour/sessions/${encodeURIComponent(sessionId)}/events`,
        location.href,
      )
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('tabId', tabId)
      return new WebSocket(url)
    },
    executor: (sessionId, onReceipt, onTakeover) => {
      const readiness = new ViewReadiness()
      let executing = false
      const executor = new TourExecutor(engine.harness, {
        sessionId,
        now: () => Date.now(),
        onReceipt,
        onTakeover,
        active: () => engine.harness.observatory.target !== null,
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
      const unsubscribe = subscribe(CAMERA_LENS, () => {
        if (!executing) onTakeover()
      })
      return {
        get searchStatus() {
          return executor.searchStatus
        },
        get viewRevision() {
          return executor.viewRevision
        },
        context: (query) => executor.context(query),
        execute: (request) => {
          executing = true
          try {
            return executor.execute(request)
          } finally {
            executing = false
          }
        },
        poll: () => executor.poll(),
        supersede: (revision) => executor.supersede(revision),
        queueMotion: (kind, seconds) => executor.queueMotion(kind, seconds),
        startMotion: (kind, seconds) => executor.startMotion(kind, seconds),
        stopMotion: () => executor.stopMotion(),
        cancel: (reason) => executor.cancel(reason),
        dispose: () => {
          unsubscribe()
          executor.dispose()
        },
      }
    },
    live: (event, failure) => new LiveConnection(undefined, event, failure),
    playback: () => new ControlledPlayback(),
    poll: (run) => {
      const timer = setInterval(run, 100)
      return () => clearInterval(timer)
    },
    visibility: (changed) => {
      const visibility = () => changed(document.visibilityState === 'visible')
      document.addEventListener('visibilitychange', visibility)
      return () => document.removeEventListener('visibilitychange', visibility)
    },
  })
}
