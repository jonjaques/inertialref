import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useLocation } from 'react-router'
import type { StarCatalog } from '@inertialref/universe'
import { DEFAULT_FOV, GameEngine } from './engine/GameEngine.ts'
import type {
  CameraState,
  GraphicsState,
  HudCommands,
  HudRenderState,
} from './hud/controls.ts'
import { FOV_MAX, FOV_MIN } from './hud/controls.ts'
import { CutsceneOverlay } from './hud/CutsceneOverlay.tsx'
import { ErrorBoundary } from './hud/ErrorBoundary.tsx'
import { isTyping } from './hud/focus.ts'
import {
  isBoolean,
  numberWithin,
  oneOf,
  usePersistentState,
} from './hud/panelState.ts'
import { devPanels } from './hud/registry.tsx'
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
  OUTPUT_PREFERENCES,
  type OutputPreference,
  type RendererDescription,
} from './render/output.ts'
import { DocumentMeta } from './pages/DocumentMeta.tsx'
import { ModeRoutes } from './pages/ModeRoutes.tsx'
import { OverlayRoutes } from './pages/OverlayRoutes.tsx'
import { modeForPath, resolvedLocation } from './pages/paths.ts'
import { SceneView } from './scene/SceneView.tsx'
import {
  engineStore,
  startEngineSampler,
  useEngine,
} from './state/engineStore.ts'

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
  /*
   * The engine's latest description, and whether a cutscene is playing — both
   * read from the sampler in `state/engineStore.ts` rather than held here.
   *
   * `status` is a fresh object on every sample, so selecting it re-renders this
   * component at the sample rate exactly as the old `useState` did; the
   * difference is that a panel can now subscribe to the field it needs instead
   * of being handed the whole thing. `cinema` is a boolean, so it re-renders
   * when it flips and not eight times a second.
   *
   * Only the *chrome* hangs off `cinema` — the dock, the flight strip, the
   * crosshair all step out of the frame so a capture is the picture and nothing
   * else. The scene itself reads `engine.cinematic` directly every frame; this
   * exists because React needs a re-render to unmount chrome, and 8 Hz is fast
   * enough for a thing a human just clicked.
   */
  const status = useEngine((snapshot) => snapshot.status)
  const cinema = useEngine((snapshot) => snapshot.cinema)
  /*
   * Which mode is running, derived from the URL rather than held.
   *
   * A reload, a back button and a pasted link all have to land in the same
   * place, and the only way to guarantee that is for the path to be the source
   * of truth. `modeForPath` is a pure function for exactly that reason — the
   * claim is testable in Node without a browser or a router.
   *
   * Against the location `ModeRoutes` resolves, not the raw pathname. With a
   * dialog open the two differ, and this is the half that decides what chrome
   * is drawn *and* whether the cinema player stays mounted — so disagreeing
   * with the tree it is drawn over is not cosmetic. `resolvedLocation` says
   * what went wrong at length.
   */
  const location = useLocation()
  const mode = modeForPath(resolvedLocation(location).pathname)

  /*
   * The debug overlay: off by default, and off is the whole point.
   *
   * The dock is the author's instrument — `docs/design/ux.md` specifies a
   * cockpit where every element has a physical place, and none of this is it —
   * so a first-time visitor should never meet it. Persisted, because somebody
   * who turned it on is working, and a reload is part of working.
   */
  const [debug, setDebug] = usePersistentState('debug.on', false, isBoolean)
  /*
   * Every restored preference is checked against what this build accepts.
   *
   * `localStorage` outlives the code that wrote it. A stored dock layout naming
   * panels that no longer exist renders empty slots and hides the ones that do;
   * an `aa` of `"8x"` from an experiment reaches the renderer's constructor.
   * The guards turn every one of those into "the default", which is what an
   * absent value already meant. `dock/useWorkspace.ts` does the same for the
   * four preferences the workspace keeps.
   */
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
    oneOf(OUTPUT_PREFERENCES),
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

    return startEngineSampler(engineStore, engine, PANEL_HZ)
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
    warp: (direction: number) => {
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

  /*
   * The render knobs, as one definition each.
   *
   * They are read in two places now — the dock's tabs and the `/settings` page
   * — and `docs/design/ux.md` puts the eventual home in the page rather than
   * the dock. Two inline object literals would be two anti-aliasing switches
   * that could drift apart, which is the same argument `hud/Action.tsx` makes
   * about a label's colour, applied to behaviour.
   */
  const graphicsState: GraphicsState = {
    lensFlare,
    onLensFlare: setLensFlare,
    aa,
    onAa: (level: AaLevel) => {
      // Crossing the MSAA boundary rebuilds the renderer, so say so — the
      // stall would otherwise read as a hang.
      setAa(level)
      flash(`anti-aliasing ${level}`)
    },
  }
  const cameraState: CameraState = { fov, onFov: setFov }
  const renderState: HudRenderState = {
    preference: hdr,
    output,
    onPreference: (next: OutputPreference) => {
      if (next === hdr) return
      // The renderer is rebuilt for this, so say what happened — otherwise the
      // only feedback is a frame the player may not be able to see the
      // difference in, which is the whole problem.
      setHdr(next)
      flash(`hdr ${next}`)
    },
  }

  /*
   * The author's instruments, assembled here and handed to whichever mode is
   * running.
   *
   * `App` is the only place that can build them: the renderer description, the
   * connection monitor and the command table all live here, and three of the
   * six panels read at least one of them. The *workspace* they go into belongs
   * to the mode, because a panel body closes over what the mode has in scope —
   * so this is passed down rather than rendered here. `dock/workspace.ts` has
   * the shape and the reason the disclosure is a setter.
   */
  const dev = {
    panels: devPanels({
      engine,
      status,
      render: renderState,
      graphics: graphicsState,
      camera: cameraState,
      connection,
      onCheckConnection: monitor.refresh,
      commands,
      onNotice: flash,
    }),
    open: debug,
    onOpenChange: setDebug,
  }

  useShipControls(
    engine,
    {
      onToggleAssist: commands.toggleAssist,
      onKillRotation: commands.killRotation,
      onPause: commands.togglePause,
      onWarp: commands.warp,
      onSave: commands.save,
      onLoad: commands.load,
    },
    // The flight axes belong to the flight modes. The planetarium binds the
    // arrows to orbiting a camera and `F` to framing a target, and the cinema
    // player binds them to stepping frames — two window handlers claiming one
    // key is not something a player can diagnose.
    //
    // Space is the same argument, and it was missed: the cinema player binds
    // it to its own transport, so both handlers ran and one press flipped
    // `clock.paused` twice — the documented play/pause control did nothing at
    // all, with nothing to see in the console.
    { axes: mode === 'flight', pause: mode !== 'cinema' },
  )

  /*
   * The debug overlay's own key.
   *
   * Backquote, because it is the console key in every game that has one, it is
   * not a flight axis, and it is not typed into anything here. Bound at the
   * window like the rest, and declining the keystroke when it was aimed at a
   * text field is the same courtesy `useShipControls` extends.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Backquote' || event.metaKey || event.ctrlKey) return
      if (isTyping(event)) return
      event.preventDefault()
      setDebug(!debug)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [debug, setDebug])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-slate-200">
      {/* Renders nothing; keeps the tab, the canonical link and the analytics
          page view in step with the address bar. Inside the shell rather than
          in `main.tsx` because it needs the router's location. */}
      <DocumentMeta />
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
      {/*
       * The overlay layer, and the order things are stacked in it.
       *
       * Every band below is `position: absolute` in one stacking context, so
       * with no `z-index` anywhere the paint order — and, worse, the
       * *hit-testing* order — is DOM order. That was an accident waiting for a
       * mode that covers the viewport: `PlanetariumMode`'s input surface is
       * `absolute inset-0 pointer-events-auto` and is emitted after the dock,
       * so in the planetarium every button, tab and drag handle in the dock
       * was unclickable and the surface silently took the click.
       *
       * So the order is stated, bottom to top, and each band gets an inert
       * wrapper to state it on — `ErrorBoundary`'s `className` styles its
       * *fallback* rather than a wrapper, and the chrome inside positions
       * itself, so there is otherwise nothing here to hang a z-index on. The
       * wrappers are `pointer-events-none` like the layer itself, so they
       * change nothing about what is clickable: each piece of chrome turns
       * events back on for itself, exactly as before.
       *
       *   0  the mode           — its input surface, its panes and its menu
       *   10 the cutscene layer — blackout and titles: picture, not UI
       *   30 notices, and the cinema player
       *   40 dialogs            — over all of it, which is what a dialog is
       *
       * The band that used to sit at 20 was the dev dock, a fixed panel in the
       * top-right corner that `App` drew over whichever mode was running. There
       * is no such thing now: the author's instruments are panels in the mode's
       * own workspace (`dock/Workspace.tsx`), so they are inside the mode band
       * and ordered against its input surface by DOM order, exactly like every
       * other panel.
       *
       * The cutscene layer is above the mode because its blackout is part of
       * the picture. The cinema player is the one mode that has to be read
       * *through* that blackout — it carries the transport and the way out —
       * which is why the mode band is lifted to 30 there and nowhere else.
       *
       * The tooltip wrapper portals its content *into* this layer at `z-50`
       * — above every band here, and inside the standard-range clamp, which
       * is the point: a chip portalled to `<body>` sat outside the clamp and
       * composited over a star at twice diffuse white. See
       * `components/ui/tooltip.tsx`.
       */}
      <div className="hud-layer pointer-events-none absolute inset-0">
        {/* Renders nothing at all when no cutscene is running. While one is,
            every other piece of chrome below unmounts — Esc skips, and the
            dock comes straight back. */}
        <div className="pointer-events-none absolute inset-0 z-10">
          <ErrorBoundary
            what="the cutscene overlay"
            className="type-readout pointer-events-auto absolute bottom-5 left-1/2 w-[34rem] max-w-[80vw] -translate-x-1/2"
          >
            {/* The scene's own screen-space layer: blackout, titles, audio. Its
                transport is the *debug* one — the cinema player provides the
                real controls, and two transports on screen at once would be two
                playheads a person could disagree with, so it is off in the
                cinema mode however the debug overlay is set. */}
            <CutsceneOverlay
              engine={engine}
              transport={debug && mode !== 'cinema'}
            />
          </ErrorBoundary>
        </div>
        {/*
         * The mode: the menu, a flight session, the planetarium, the player.
         *
         * Its own boundary, separate from the cutscene layer's. The scene is
         * outside both: `<Canvas>` is a sibling of `.hud-layer` and nothing in
         * here can reach it, so a throw in a panel loses the panel and not the
         * picture. Each panel carries its own boundary inside this one — see
         * `dock/PanelChrome.tsx` — so one failing readout does not take the
         * menu that could close it down with it.
         */}
        {/*
         * The one exception to "a cutscene hides every other piece of chrome":
         * the cinema player *is* the chrome for a playing scene, and unmounting
         * it would stop the scene it is playing — its cleanup calls
         * `stopCutscene`, so gating it on `!cinema` made pressing play stop the
         * cutscene a fraction of a second later, with nothing to explain it.
         */}
        {(!cinema || mode === 'cinema') && (
          <div
            className={`pointer-events-none absolute inset-0 ${mode === 'cinema' ? 'z-30' : 'z-0'}`}
          >
            <ErrorBoundary
              what={`the ${mode} mode`}
              className="pointer-events-auto absolute inset-0"
            >
              <ModeRoutes
                engine={engine}
                status={status}
                fov={fov}
                onFov={setFov}
                dev={dev}
              />
            </ErrorBoundary>
          </div>
        )}

        {/* A notice echoes what was asked for, and one of the things that can
            be asked for is whatever was typed into the address field. Bounded
            so a paste is a truncated sentence rather than a band across the
            bottom of the frame.

            `bottom-16` rather than the usual `0.75rem` inset: the IR menu is at
            the bottom centre now, and a notice at the same inset landed on top
            of it — covering the panel toggles for two and a half seconds after
            every command, which is exactly when somebody is most likely to
            reach for one.

            `AnimatePresence` is here rather than a CSS transition because the
            element is conditionally rendered: it can fade *in* under CSS and
            never fade out, since by the time the notice clears there is no node
            left to transition. The key is the message, so a second notice
            arriving while the first is up crossfades rather than swapping text
            inside a box that never moved. Transform is dropped for anyone who
            asks for reduced motion; see `MotionConfig` in `main.tsx`. */}
        {/* The cinema exception again, and for the same reason as the dialog
            band below: the player's workspace carries the save, warp and HDR
            controls, and this notice is the only confirmation any of them
            gives — visually and to a screen reader. Suppressed there, the
            commands ran silently. In every other mode a cutscene still takes
            the notice out of the picture. */}
        <AnimatePresence>
          {(!cinema || mode === 'cinema') && notice !== null && (
            <motion.div
              key={notice}
              /* Announced, not just drawn. This is the only confirmation most
                 commands give — `hdr extended`, `go to SOL`, `saved` — and it
                 is gone in 2.5 seconds, so a reader that never hears it gets no
                 feedback at all. `polite` rather than `assertive`: it is a
                 receipt for something the user just did, not an interruption. */
              role="status"
              aria-live="polite"
              title={notice}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
              /* The accent is the edge, not the ground. `bg-sky-500/20` alone
                 is 80% scene, so over a sunlit planet the notice composited to
                 1.3:1 and the thing it was echoing back — often whatever was
                 just typed into the address field — was unreadable at exactly
                 the moment it was worth reading. The panel ground carries it;
                 the accent stays what it is everywhere else in this system, a
                 material rather than a fill behind text. */
              className="type-readout pointer-events-none absolute bottom-16 left-1/2 z-30 max-w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 truncate rounded border border-sky-500/40 bg-slate-950/85 px-3 py-1 text-sky-200 backdrop-blur"
            >
              {notice}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Dialogs, over a running simulation and over whatever mode is behind
            them. Inside the layer so they inherit the standard-range clamp; a
            sibling of `<Canvas>`, so navigating cannot remount the renderer.

            The cinema mode is the same exception it is for the mode band
            above: its workspace carries the settings link, so a scene being
            open must not unmount the dialog that link opens — gated on
            `!cinema` alone, settings from the player changed the URL and drew
            nothing, and a second press wrapped the dead `/settings` as the new
            background and killed the scene. Elsewhere a cutscene still clears
            the frame. */}
        {(!cinema || mode === 'cinema') && (
          <div className="pointer-events-none absolute inset-0 z-40">
            <ErrorBoundary
              what="the page overlay"
              className="pointer-events-auto absolute inset-0"
            >
              <OverlayRoutes
                graphics={graphicsState}
                camera={cameraState}
                render={renderState}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  )
}
