import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessStatus } from '@inertialref/devtools'
import type { StarCatalog } from '@inertialref/universe'
import { DEFAULT_FOV, GameEngine } from './engine/GameEngine.ts'
import { FlightStrip } from './hud/FlightStrip.tsx'
import { HudDock, type HudCommands, type HudTab } from './hud/HudDock.tsx'
import { usePersistentState } from './hud/panelState.ts'
import { useShipControls } from './hud/useShipControls.ts'
import {
  type Connection,
  ConnectionMonitor,
  DISCONNECTED,
} from './net/health.ts'
import { EXTENDED_RANGE_QUERY, watchDynamicRange } from './render/capability.ts'
import {
  commitToneCurve,
  createRenderer,
  type RendererHandle,
} from './render/createRenderer.ts'
import type { OutputPreference, RendererDescription } from './render/output.ts'
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

/** Time-warp detents. Powers of ten with a 5 and a 25 where the gaps are worst. */
const WARP_STEPS = [1, 5, 25, 100, 1_000, 10_000, 100_000]

/** `auto` first, because it is right more often than it is wrong. */
const HDR_STATES: readonly OutputPreference[] = ['auto', 'extended', 'standard']

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
  const [dockOpen, setDockOpen] = usePersistentState('dock.open', true)
  const [tab, setTab] = usePersistentState<HudTab>('dock.tab', 'navigate')
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
  )
  /*
   * The graphics and camera panels' knobs. Persisted like the HDR override —
   * a lens flare turned off to chase an artifact should stay off across the
   * reload that tests the fix — and mirrored onto plain engine fields below,
   * because the frame loop reads them and must not touch React to do it.
   */
  const [lensFlare, setLensFlare] = usePersistentState('render.lensFlare', true)
  const [fov, setFov] = usePersistentState('camera.fov', DEFAULT_FOV)
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

  // The media query is live: a window can be dragged from an EDR display to one
  // without, and reading it once at startup gets that permanently wrong.
  useEffect(() => watchDynamicRange(setDynamicRangeHigh), [])

  /*
   * Replay the canvas measurement when the document becomes visible.
   *
   * R3F sizes its canvas from a ResizeObserver, and Chrome does not deliver
   * the *initial* observation to a hidden document — which is what this page
   * is during every Vite full-reload triggered from the editor in front of
   * it. Becoming visible again does not replay the lost observation either:
   * the canvas sits at the default 300×150 with no renderer behind it, a
   * black screen with a healthy HUD that only a manual window resize could
   * revive. The measurement hook also listens to window `resize`, so a
   * synthetic one on return to visibility is exactly the kick it is waiting
   * for; when the measurement already landed, re-measuring the same size is a
   * no-op. Verified live: dispatching `resize` on the stuck page took the
   * canvas from 300×150 to full size and built the renderer.
   */
  useEffect(() => {
    const kick = (): void => {
      if (document.visibilityState === 'visible')
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
  const canvasKey = rendererKey(hdr, dynamicRangeHigh)

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

    const timer = window.setInterval(
      () => setStatus(engine.harness.status()),
      1000 / PANEL_HZ,
    )
    return () => window.clearInterval(timer)
  }, [engine])

  const flash = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 2_500)
  }, [])

  const commands: HudCommands = {
    togglePause: () => {
      const paused = !engine.world.clock.paused
      engine.world.clock.setPaused(paused)
      flash(paused ? 'paused' : 'running')
    },
    warp: (direction) => {
      const current = engine.world.clock.timeScale
      const index = WARP_STEPS.findIndex((step) => step >= current)
      const next =
        WARP_STEPS[
          Math.min(
            WARP_STEPS.length - 1,
            Math.max(0, (index < 0 ? 0 : index) + direction),
          )
        ] ?? 1
      engine.world.clock.setTimeScale(next)
      flash(`time warp ${next}×`)
    },
    toggleAssist: () =>
      flash(`flight assist ${engine.toggleFlightAssist() ? 'on' : 'off'}`),
    killRotation: () => {
      engine.killRotation()
      flash('rotation killed')
    },
    save: () => {
      void engine.save().then((text) => flash(`saved ${text.length} bytes`))
    },
    load: () => {
      void engine.load().then((ok) => flash(ok ? 'loaded' : 'nothing to load'))
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
        gl={createRenderer(hdr, (handle) => {
          renderer.current = handle
          engine.gl = handle
          setOutput(handle.description)
        })}
        // A logarithmic depth buffer makes this range workable; a linear one
        // would have no usable precision anywhere in it. The flag itself moved
        // into the factory, because it is a constructor parameter there.
        camera={{ fov: DEFAULT_FOV, near: 0.05, far: 1e10 }}
        dpr={[1, 2]}
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
        <HudDock
          engine={engine}
          status={status}
          render={{
            preference: hdr,
            output,
            onCyclePreference: () => {
              const next =
                HDR_STATES[(HDR_STATES.indexOf(hdr) + 1) % HDR_STATES.length] ??
                'auto'
              // The renderer is rebuilt for this, so say what happened —
              // otherwise the only feedback is a frame the player may not be
              // able to see the difference in, which is the whole problem.
              setHdr(next)
              flash(`hdr ${next}`)
            },
          }}
          graphics={{ lensFlare, onLensFlare: setLensFlare }}
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
        <FlightStrip status={status} />

        {notice !== null && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-sky-500/20 px-3 py-1 font-mono text-xs text-sky-200">
            {notice}
          </div>
        )}

        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-4 w-4 rounded-full border border-sky-300/40" />
        </div>
      </div>
    </div>
  )
}
