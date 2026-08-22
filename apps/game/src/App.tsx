import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessStatus } from '@inertialref/devtools'
import type { StarCatalog } from '@inertialref/universe'
import { DEFAULT_FOV, GameEngine } from './engine/GameEngine.ts'
import { CutsceneOverlay } from './hud/CutsceneOverlay.tsx'
import { ErrorBoundary } from './hud/ErrorBoundary.tsx'
import { FlightStrip } from './hud/FlightStrip.tsx'
import { HudDock, type HudCommands } from './hud/HudDock.tsx'
import {
  isBoolean,
  numberWithin,
  oneOf,
  usePersistentState,
} from './hud/panelState.ts'
import { type HudTab, TABS } from './hud/tabs.ts'
import { nextWarp } from './hud/warp.ts'
import { useShipControls } from './hud/useShipControls.ts'
import {
  type Connection,
  ConnectionMonitor,
  DISCONNECTED,
} from './net/health.ts'
import { EXTENDED_RANGE_QUERY, watchDynamicRange } from './render/capability.ts'
import { watchPresentation } from './render/presentationWatchdog.ts'
import {
  commitToneCurve,
  createRenderer,
  type RendererHandle,
} from './render/createRenderer.ts'
import {
  AA_LEVELS,
  type AaLevel,
  aaAntialias,
  aaDprFactor,
  type OutputPreference,
  type RendererDescription,
} from './render/output.ts'
import { SceneView } from './scene/SceneView.tsx'

/*
 * The application shell.
 *
 * React owns the UI and nothing else. The engine is created once, outside the
 * component tree's data flow, and lives in a ref-like module singleton; the
 * component subscribes to it at a human-readable rate rather than re-rendering
 * per simulated tick. Canonical state never enters component state — the panel
 * receives a snapshot description, and if this component unmounted the universe
 * would carry on unchanged.
 *
 * Every command below exists exactly once and is bound to both a key and a
 * button. Two implementations of "time warp" that drift by one step is a bug
 * nobody would find, and the dock is what makes the game drivable without
 * memorising the keyboard first.
 */

let singleton: GameEngine | null = null

function engineInstance(catalog: StarCatalog): GameEngine {
  singleton ??= new GameEngine({
    seed:
      new URLSearchParams(window.location.search).get('seed') ?? 'inertialref',
    catalog,
  })
  return singleton
}

/** HUD refresh rate. The simulation runs at 64 Hz; a human reads about 8. */
const PANEL_HZ = 8

/** How long a transient notice stays up. */
const NOTICE_MS = 2_500

/** The camera panel's slider range, restated here because it guards the store. */
const FOV_MIN = 20
const FOV_MAX = 110

/** `auto` first, because it is right more often than it is wrong. */
const HDR_STATES = [
  'auto',
  'extended',
  'standard',
] as const satisfies readonly OutputPreference[]

/** An unknown throw, as a sentence. Every rejection here reaches a notice. */
const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Which inputs, changing, mean the renderer has to be built again.
 *
 * Extended-range output is a *constructor* parameter — `outputType` sets the
 * canvas format and the compositor's tone mapping mode together, before any
 * device exists — so it cannot be toggled on a live renderer. Feeding this to
 * `<Canvas key>` makes the rebuild explicit rather than something that quietly
 * fails to happen.
 *
 * The display signal only participates under `auto`. Under an explicit
 * preference a window dragged between monitors changes nothing, and remounting
 * the whole scene for it would be a visible stall in exchange for no difference.
 */
function rendererKey(
  preference: OutputPreference,
  dynamicRangeHigh: boolean,
): string {
  return preference === 'auto' ? `auto:${dynamicRangeHigh}` : preference
}

export default function App({ catalog }: { catalog: StarCatalog }) {
  const engine = engineInstance(catalog)
  const [status, setStatus] = useState<HarnessStatus | null>(null)
  /*
   * Whether a cutscene is playing, at panel rate. Only the *chrome* hangs off
   * this — the dock, the flight strip, the crosshair all step out of the
   * frame so a capture is the picture and nothing else. The scene itself
   * reads `engine.cinematic` directly every frame; this state exists because
   * React needs a re-render to unmount chrome, and 8 Hz is fast enough for a
   * thing a human just clicked.
   */
  const [cinema, setCinema] = useState(false)
  const [dockOpen, setDockOpen] = usePersistentState(
    'dock.open',
    true,
    isBoolean,
  )
  /*
   * Every restored preference is checked against what this build accepts.
   *
   * `localStorage` outlives the code that wrote it. A `dock.tab` of `"nav"` from
   * before these five names existed parses cleanly, matches no tab, and renders
   * an empty dock with no active tab and no way back that is not devtools; an
   * `aa` of `"8x"` from an experiment reaches the renderer's constructor. The
   * guards turn every one of those into "the default", which is what an absent
   * value already meant.
   */
  const [tab, setTab] = usePersistentState<HudTab>(
    'dock.tab',
    'navigate',
    oneOf(TABS),
  )
  const [notice, setNotice] = useState<string | null>(null)
  /*
   * The three-state HDR override.
   *
   * `docs/design/art.md` calls it mandatory, and spike 1 is why: `auto` is a
   * capability probe rather than a display test, there is no headroom API, and
   * it will therefore be wrong for somebody on every browser, in both
   * directions. Persisted, because a player who turned it off did not mean
   * "until the next reload".
   */
  const [hdr, setHdr] = usePersistentState<OutputPreference>(
    'render.hdr',
    'auto',
    oneOf(HDR_STATES),
  )
  /*
   * The graphics and camera panels' knobs. Persisted like the HDR override —
   * a lens flare turned off to chase an artifact should stay off across the
   * reload that tests the fix — and mirrored onto plain engine fields below,
   * because the frame loop reads them and must not touch React to do it.
   */
  const [lensFlare, setLensFlare] = usePersistentState(
    'render.lensFlare',
    true,
    isBoolean,
  )
  const [aa, setAa] = usePersistentState<AaLevel>(
    'render.aa',
    '2x',
    oneOf(AA_LEVELS),
  )
  // The same range the camera panel's slider offers. A stored value outside it
  // is not a field of view somebody nearly asked for; it reaches `engine.fov`
  // and the projection matrix behind it.
  const [fov, setFov] = usePersistentState(
    'camera.fov',
    DEFAULT_FOV,
    numberWithin(FOV_MIN, FOV_MAX),
  )
  const [dynamicRangeHigh, setDynamicRangeHigh] = useState(
    () => window.matchMedia(EXTENDED_RANGE_QUERY).matches,
  )
  const [output, setOutput] = useState<RendererDescription | null>(null)
  /*
   * Whether there is a server, and whether it believes in the same universe.
   *
   * Nothing waits on it. The simulation is authoritative locally and always has
   * been — `docs/design/modes.md` makes solo offline the normal case rather
   * than a degraded one — so this is a readout the HUD shows, in the same sense
   * that altitude is, and its failure path is a sentence rather than a retry.
   */
  const [monitor] = useState(() => new ConnectionMonitor())
  const [connection, setConnection] = useState<Connection>(DISCONNECTED)
  // The renderer itself, for the one thing that has to happen to it after R3F
  // has finished configuring it. Not state: nothing renders differently for it.
  const renderer = useRef<RendererHandle | null>(null)
  /*
   * Bumped by the presentation watchdog's last rung, and by nothing else. In
   * the deepest boot wedge — draws submitted every frame, presentation stuck,
   * immune even to real resizes — the only recovery is a fresh canvas and
   * renderer, and folding this into `canvasKey` is the sanctioned way to get
   * one. See `render/presentationWatchdog.ts` for the measurements.
   */
  const [canvasEpoch, setCanvasEpoch] = useState(0)
  /** Guards save and load against each other. See `commands.save`. */
  const storageBusy = useRef(false)

  // The media query is live: a window can be dragged from an EDR display to one
  // without, and reading it once at startup gets that permanently wrong.
  useEffect(() => watchDynamicRange(setDynamicRangeHigh), [])

  /*
   * Replay the canvas measurement whenever it could have been lost.
   *
   * R3F sizes its canvas from a ResizeObserver, and Chrome does not deliver
   * the *initial* observation to a hidden document — which is what this page
   * is during every Vite full-reload triggered from the editor in front of
   * it. Becoming visible again does not replay the lost observation either:
   * the canvas sits at the default 300×150 with no renderer behind it, a
   * black screen with a healthy HUD that only a manual window resize could
   * revive. The measurement hook also listens to window `resize`, so a
   * synthetic one is exactly the kick it is waiting for; when the measurement
   * already landed, re-measuring the same size is a no-op. Verified live:
   * dispatching `resize` on the stuck page took the canvas from 300×150 to
   * full size — even while the document was still hidden, which is why the
   * kick is unconditional rather than gated on visibility.
   *
   * This mount-time kick is not sufficient on its own: a *focused* fresh load
   * could still come up black until a manual resize, because the mount kick
   * races the async renderer build — `createRenderer` awaits a device probe
   * and `renderer.init()`, and a measurement kicked before R3F has a backend
   * to hand it to is lost with nothing scheduled to replay it. The second
   * kick, in the renderer-ready callback below, closes that hole at the one
   * moment it provably cannot be too early.
   */
  useEffect(() => {
    const kick = (): void => {
      window.dispatchEvent(new Event('resize'))
    }
    kick()
    document.addEventListener('visibilitychange', kick)
    return () => document.removeEventListener('visibilitychange', kick)
  }, [])

  useEffect(() => {
    engine.lensFlare = lensFlare
    engine.fov = fov
  }, [engine, lensFlare, fov])

  useEffect(() => {
    const unsubscribe = monitor.subscribe(setConnection)
    monitor.start()
    return () => {
      unsubscribe()
      monitor.stop()
    }
  }, [monitor])

  /*
   * No release-on-unmount effect here, deliberately — the factory is the
   * *sole* owner of renderer disposal. An effect keyed on the canvas string
   * used to call `releaseRenderer()` in its cleanup, and under StrictMode
   * that cleanup fires once between the doubled mounts: it could dispose the
   * very renderer the surviving mount had adopted, whose animation loop died
   * with it — a black canvas, a healthy HUD, and nothing in the console.
   * R3F's unmount cannot release a `WebGPURenderer` either way; the factory
   * releases the previous build before starting the next, which covers the
   * one real replacement path (the HDR preference remounting the canvas).
   */
  // MSAA joins the key because it is a constructor fact; the `2x`↔`4x` step
  // only changes the drawing-buffer scale, which R3F applies live via `dpr`.
  // The watchdog epoch joins it so the last recovery rung can rebuild.
  const canvasKey = `${rendererKey(hdr, dynamicRangeHigh)}:${aaAntialias(aa) ? 'msaa' : 'raw'}:${canvasEpoch}`

  /*
   * Verify that boot actually put pixels on screen, and climb the recovery
   * ladder if it did not. Keyed on `output` because sampling before the
   * renderer exists proves nothing, and on `canvasEpoch` so a rebuilt canvas
   * gets its own verification pass — with the remount lever withheld the
   * second time, or a genuinely black scene would rebuild forever.
   */
  useEffect(() => {
    if (output === null) return
    const canvas = renderer.current?.renderer.domElement
    if (canvas === undefined) return
    const watch = watchPresentation(canvas, {
      allowRemount: canvasEpoch === 0,
      remount: () => setCanvasEpoch((epoch) => epoch + 1),
    })
    return () => watch.cancel()
  }, [output, canvasEpoch])

  useEffect(() => {
    // Expose the harness for the console and for automated drivers. This is the
    // same object the headless runner uses, so a scenario reproduced here can
    // be replayed in a test.
    const globalScope = window as unknown as Record<string, unknown>
    globalScope['ir'] = engine.harness
    globalScope['engine'] = engine
    console.info(
      '%cInertialRef',
      'color:#38bdf8;font-weight:bold',
      '— harness ready. Try ir.help()',
    )

    const timer = window.setInterval(() => {
      setStatus(engine.harness.status())
      setCinema(engine.cinematic !== null)
    }, 1000 / PANEL_HZ)
    return () => window.clearInterval(timer)
  }, [engine])

  /*
   * One notice, one timer.
   *
   * Each call used to start a timer and forget it, so a notice raised two
   * seconds after another was cleared by the *first* one's timer a fraction of
   * a second later — the messages that arrive in bursts (save, then load, then
   * a warp step) were exactly the ones that flickered past unread. The ref
   * holds the only live timer, and the effect below cancels it on unmount so a
   * cutscene starting mid-notice does not set state on a gone component.
   */
  const noticeTimer = useRef(0)
  const flash = useCallback((message: string) => {
    window.clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  const commands: HudCommands = {
    togglePause: () => {
      const paused = !engine.world.clock.paused
      engine.world.clock.setPaused(paused)
      flash(paused ? 'paused' : 'running')
    },
    warp: (direction) => {
      const next = nextWarp(engine.world.clock.timeScale, direction)
      engine.world.clock.setTimeScale(next)
      flash(`time warp ${next}×`)
    },
    toggleAssist: () =>
      flash(`flight assist ${engine.toggleFlightAssist() ? 'on' : 'off'}`),
    killRotation: () => {
      engine.killRotation()
      flash('rotation killed')
    },
    /*
     * One at a time, and never at the same time as each other.
     *
     * Both are one keystroke and one button, and both are asynchronous against
     * IndexedDB. Two loads interleaved restore two worlds into one; a save
     * racing a load writes a state that never existed. The guard is a ref
     * rather than state because nothing renders differently for it — the
     * operations are milliseconds and a button that flickered disabled would be
     * worse than one that quietly ignores the second press.
     */
    save: () => {
      if (storageBusy.current) return
      storageBusy.current = true
      void engine
        .save()
        .then((text) => flash(`saved ${text.length} bytes`))
        .catch((cause: unknown) => flash(`save failed — ${describe(cause)}`))
        .finally(() => {
          storageBusy.current = false
        })
    },
    load: () => {
      if (storageBusy.current) return
      storageBusy.current = true
      void engine
        .load()
        .then((ok) => flash(ok ? 'loaded' : 'nothing to load'))
        .catch((cause: unknown) => flash(`load failed — ${describe(cause)}`))
        .finally(() => {
          storageBusy.current = false
        })
    },
  }

  useShipControls(engine, {
    onToggleAssist: commands.toggleAssist,
    onKillRotation: commands.killRotation,
    onPause: commands.togglePause,
    onWarp: commands.warp,
    onSave: commands.save,
    onLoad: commands.load,
    onToggleHud: () => setDockOpen(!dockOpen),
    onShowNavigation: () => {
      setTab('navigate')
      setDockOpen(true)
    },
    onShowPerformance: () => {
      setTab('perf')
      setDockOpen(true)
    },
  })

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-slate-200">
      <Canvas
        key={canvasKey}
        // Not renderer *settings* — the renderer itself. `createRenderer` probes
        // what the browser can output, builds a `WebGPURenderer` around the
        // answer and awaits `init()`; R3F awaits the promise, so nothing draws
        // against a half-built backend. See `render/createRenderer.ts`.
        gl={createRenderer(hdr, aaAntialias(aa), (handle) => {
          renderer.current = handle
          engine.gl = handle
          setOutput(handle.description)
          // The second half of the measurement-replay above: the backend now
          // exists, so a re-measure cannot be lost. A macrotask rather than
          // requestAnimationFrame, because rAF does not fire in a hidden tab
          // and a background load must still size its canvas for the frame
          // that draws the moment the tab is focused.
          window.setTimeout(() => window.dispatchEvent(new Event('resize')), 0)
        })}
        // A logarithmic depth buffer makes this range workable; a linear one
        // would have no usable precision anywhere in it. The flag itself moved
        // into the factory, because it is a constructor parameter there.
        camera={{ fov: DEFAULT_FOV, near: 0.05, far: 1e10 }}
        // The device ratio capped at 2, times the supersampling factor. A
        // number rather than a range because `4x` must *raise* the buffer
        // above the device ratio, which a clamp can only lower.
        dpr={Math.min(window.devicePixelRatio, 2) * aaDprFactor(aa)}
        // R3F configures the renderer *after* the factory resolves and sets its
        // own tone mapping while doing so. This is where ours goes back.
        onCreated={(state) => {
          if (renderer.current !== null) commitToneCurve(renderer.current)
          // The perf overlay's GPU measurement submits its own frames, and this
          // is the only place R3F offers the scene and camera to submit them with.
          engine.view = { scene: state.scene, camera: state.camera }
        }}
      >
        <SceneView engine={engine} />
      </Canvas>

      {/*
       * Everything above the scene, clamped to standard range.
       *
       * `docs/design/art.md` wants the HUD composited after tone mapping at fixed
       * luminance so it stays legible against a star. The browser already
       * composites the DOM over the canvas — but the dock and the flight strip
       * are `backdrop-blur`, and a backdrop filter samples what is behind it,
       * which on the extended path includes a star's disc at twice diffuse
       * white. `dynamic-range-limit` inherits, so one declaration on the layer
       * holds for every overlay inside it, and it must not be on the root: the
       * canvas is a sibling and would be clamped with it.
       */}
      <div className="hud-layer pointer-events-none absolute inset-0">
        {/* Renders nothing at all when no cutscene is running. While one is,
            every other piece of chrome below unmounts — Esc skips, and the
            dock comes straight back. */}
        <ErrorBoundary
          what="the cutscene overlay"
          className="pointer-events-auto absolute bottom-5 left-1/2 w-[34rem] max-w-[80vw] -translate-x-1/2 font-mono text-[11px]"
        >
          <CutsceneOverlay engine={engine} />
        </ErrorBoundary>
        {!cinema && (
          <ErrorBoundary
            what="the dock"
            className="pointer-events-auto absolute right-3 top-3 w-[27rem] max-w-[calc(100vw-1.5rem)] font-mono text-[11px] leading-relaxed"
          >
            <HudDock
              engine={engine}
              status={status}
              render={{
                preference: hdr,
                output,
                onCyclePreference: () => {
                  const next =
                    HDR_STATES[
                      (HDR_STATES.indexOf(hdr) + 1) % HDR_STATES.length
                    ] ?? 'auto'
                  // The renderer is rebuilt for this, so say what happened —
                  // otherwise the only feedback is a frame the player may not be
                  // able to see the difference in, which is the whole problem.
                  setHdr(next)
                  flash(`hdr ${next}`)
                },
              }}
              graphics={{
                lensFlare,
                onLensFlare: setLensFlare,
                aa,
                onAa: (level) => {
                  // Crossing the MSAA boundary rebuilds the renderer, so say so —
                  // the stall would otherwise read as a hang.
                  setAa(level)
                  flash(`anti-aliasing ${level}`)
                },
              }}
              camera={{ fov, onFov: setFov }}
              connection={connection}
              onCheckConnection={monitor.refresh}
              open={dockOpen}
              onOpenChange={setDockOpen}
              tab={tab}
              onTabChange={setTab}
              commands={commands}
              onNotice={flash}
            />
          </ErrorBoundary>
        )}
        {/*
         * Three boundaries rather than one around the layer.
         *
         * A single boundary would take the whole overlay down with whichever
         * piece failed — and the dock is how the simulation is driven, so
         * losing it to a throw in the flight strip's distance formatter is the
         * expensive half of the failure, not the cheap one. The scene is
         * outside all of them: `<Canvas>` is a sibling of `.hud-layer` and
         * nothing in here can reach it.
         */}
        {!cinema && (
          <ErrorBoundary
            what="the flight strip"
            className="pointer-events-auto absolute bottom-3 left-3 max-w-[calc(100vw-1.5rem)] font-mono text-[11px]"
          >
            <FlightStrip status={status} />
          </ErrorBoundary>
        )}

        {!cinema && notice !== null && (
          /* A notice echoes what was asked for, and one of the things that can
             be asked for is whatever was typed into the address field. Bounded
             so a paste is a truncated sentence rather than a band across the
             bottom of the frame. */
          <div
            title={notice}
            className="pointer-events-none absolute bottom-3 left-1/2 max-w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 truncate rounded bg-sky-500/20 px-3 py-1 font-mono text-xs text-sky-200"
          >
            {notice}
          </div>
        )}

        {!cinema && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="h-4 w-4 rounded-full border border-sky-300/40" />
          </div>
        )}
      </div>
    </div>
  )
}
