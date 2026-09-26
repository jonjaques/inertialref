import { presentationClock } from './hud/time.ts'
import { Canvas } from '@react-three/fiber'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useStore } from 'zustand'
import { AnimatePresence, motion } from 'motion/react'
import { useLocation, useNavigate } from 'react-router'
import type { StarCatalog } from '@inertialref/universe'
import { DEFAULT_FOV_DEG, GameEngine } from './engine/GameEngine.ts'
import type { HudCommands, HudRenderState } from './hud/controls.ts'
import { BootOverlay } from './hud/BootOverlay.tsx'
import { ChromeContext } from './hud/chrome.ts'
import { CutsceneOverlay } from './hud/CutsceneOverlay.tsx'
import { ErrorBoundary } from './hud/ErrorBoundary.tsx'
import { TrackOverlay } from './hud/TrackOverlay.tsx'
import { useCoarsePointer, useDevicePixelRatio } from './hud/viewport.ts'
import { bindEngineKnobs } from './state/engineKnobs.ts'
import {
  DEBUG_ON,
  RENDER_PICTURE,
  RENDER_HDR,
  RENDER_SENSOR,
  read,
  write,
  usePersistentState,
} from './state/preferences.ts'
import { useAction } from './input/useKeymap.ts'
import { CharacterControls } from './character/CharacterControls.tsx'
import { devPanels } from './hud/registry.tsx'
import { nextWarp } from './hud/warp.ts'
import { useShipControls } from './hud/useShipControls.ts'
import {
  type Connection,
  ConnectionMonitor,
  DISCONNECTED,
} from './net/health.ts'
import { EXTENDED_RANGE_QUERY, watchDynamicRange } from './render/capability.ts'
import { warmScene, watchSystemAtmospheres } from './render/preload.ts'
import { createFirstLight } from './render/firstLight.ts'
import { createRendererLifetime } from './render/rendererLifetime.ts'
import {
  createTileProducer,
  producerPreference,
} from './render/terrainProducer.ts'
import { warmAtMount } from './render/warmup.ts'
import {
  commitToneCurve,
  createRenderer,
  releaseRenderer,
} from './render/createRenderer.ts'
import {
  dprCeiling,
  type OutputPreference,
  type RendererDescription,
} from './render/output.ts'
import { parsePictureQuery, pictureDprFactor } from './render/picture.ts'
import { preloadMode } from './pages/modeLoader.ts'
import {
  KEYS,
  MODES,
  QUERY,
  modeForPath,
  overlayState,
  resolvedLocation,
  SETTINGS,
} from './pages/paths.ts'
import { SceneView } from './scene/SceneView.tsx'
import { publishRuntime } from './runtimeState.ts'
import { runtimeFailure } from './runtimeFailure.ts'
import {
  engineStore,
  startEngineSampler,
  useEngine,
} from './state/engineStore.ts'

/*
 * The persistent browser runtime.
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
 * memorizing the keyboard first.
 */

let singleton: GameEngine | null = null

function engineInstance(catalog: StarCatalog): GameEngine {
  if (singleton !== null) return singleton
  const query = new URLSearchParams(window.location.search)
  singleton = new GameEngine({
    seed: query.get('seed') ?? 'inertialref',
    catalog,
  })
  /*
   * The address bar's chrome and layer stances, pushed once the engine exists
   * and before anything mounts. A capture rig loads a preset URL and
   * photographs it, and the state a plate is defined in is otherwise a verb it
   * has to evaluate in the page after boot. Every mode sees the layer stance
   * pushed here except the planetarium, which writes `labels` and
   * `showOrbits` into its own stance on mount, above this one — so it reads
   * `layers=0` itself.
   */
  if (query.get(QUERY.chrome) === '0') singleton.setChrome(false)
  if (query.get(QUERY.layers) === '0') singleton.setLayers(false)
  return singleton
}

/** The page-lifetime output override, or null when the address carries none. */
function parseOutputQuery(value: string | null): OutputPreference | null {
  return value === 'standard' || value === 'extended' ? value : null
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
   * Whether a cutscene is playing — read from the sampler in
   * `state/engineStore.ts` rather than held here.
   *
   * What is deliberately *not* read here is `status`. It is a fresh object
   * graph on every sample, so selecting it re-renders this component — and
   * everything under it, the catalog's every row included — at the sample
   * rate. Measured on the shipped build in the planetarium: 4–5 ms of
   * react-dom work eight times a second, the largest avoidable cost on the
   * main thread, and in the dev build each of those was a whole dropped
   * frame. The panels that display live figures subscribe to the store
   * themselves, which is the subscription model the store's header promises.
   *
   * Only the *chrome* hangs off `cinema` — the dock, the flight strip, the
   * crosshair all step out of the frame so a capture is the picture and nothing
   * else. The scene itself reads `engine.cinematic` directly every frame; this
   * exists because React needs a re-render to unmount chrome, and 8 Hz is fast
   * enough for a thing a human just clicked.
   */
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
  const navigate = useNavigate()
  const mode = modeForPath(resolvedLocation(location).pathname)

  /*
   * The debug overlay: off by default, and off is the whole point.
   *
   * The dock is the author's instrument — `docs/design/ux.md` specifies a
   * cockpit where every element has a physical place, and none of this is it —
   * so a first-time visitor should never meet it. Persisted, because somebody
   * who turned it on is working, and a reload is part of working.
   */
  const [debug, setDebug] = usePersistentState(DEBUG_ON)
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
   * Every piece of interface out of the frame — `Shift+H`, and the state a
   * plate is captured in.
   *
   * A presentation stance rather than React state, so `ir.chrome(false)` and a
   * capture script reach the same switch a viewer does. Deliberately not
   * persisted, and deliberately not the cutscene's gate: that one unmounts the
   * mode, which would take the sky labels with it. See `hud/chrome.ts`.
   */
  const chromeHidden = !useEngine((snapshot) => snapshot.presentation.chrome)
  /*
   * The three-state HDR override.
   *
   * `docs/design/art.md` calls it mandatory, and spike 1 is why: `auto` is a
   * capability probe rather than a display test, there is no headroom API, and
   * it will therefore be wrong for somebody on every browser, in both
   * directions. Persisted, because a player who turned it off did not mean
   * "until the next reload".
   */
  const [storedHdr, setHdr] = usePersistentState(RENDER_HDR)
  const [outputOverride] = useState(() =>
    parseOutputQuery(
      new URLSearchParams(window.location.search).get(QUERY.output),
    ),
  )
  // The override wins for this page's lifetime and writes nothing back: a
  // change made in the panel still lands in storage, for the next address.
  const hdr = outputOverride ?? storedHdr
  const [storedPicture] = usePersistentState(RENDER_PICTURE)
  const [pictureQuery] = useState(() =>
    new URLSearchParams(window.location.search).get(QUERY.picture),
  )
  const [pictureOverride] = useState(() => parsePictureQuery(pictureQuery))
  const picture = pictureOverride ?? storedPicture
  const pictureDiagnostic =
    pictureOverride !== null && pictureQuery?.startsWith('bilinear:')
      ? ('bilinear' as const)
      : undefined
  const [displaySize, setDisplaySize] = useState<{
    width: number
    height: number
  } | null>(null)
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
  // The catalog version rides along because the client's claim about which
  // universe it derives is not a constant: a failed catalog fetch degrades this
  // session to Sol alone, and the probe has to say so rather than claim the sky
  // it meant to load.
  const [monitor] = useState(
    () => new ConnectionMonitor({ catalog: catalog.version }),
  )
  const [connection, setConnection] = useState<Connection>(DISCONNECTED)
  /** Guards save and load against each other. See `commands.save`. */
  const storageBusy = useRef(false)
  /*
   * When the cover comes off, and the canvas epoch that a wedged boot bumps.
   *
   * Four `useState`s and five effects used to live here: the warm-up latch, the
   * presented flag, the phase, the epoch, the backend split behind "presented",
   * and three copies of the measurement replay. `render/firstLight.ts` owns all
   * of it — including the part that made it worth moving, which is that
   * "provably presented" means something different on each backend and the
   * module that says so should be the module that decides it.
   */
  const [firstLight] = useState(() => createFirstLight())
  const {
    phase: boot,
    stages: bootStages,
    fraction: bootFraction,
    epoch: canvasEpoch,
  } = useStore(firstLight.store)
  // `start` rather than the factory, because a `useState` initializer is
  // double-invoked under StrictMode and a factory with side effects in it leaks
  // one of every two. It returns its own teardown.
  useEffect(() => firstLight.start(), [firstLight])

  /*
   * The renderer, the ground producer that rides on its device, and the
   * order the two are made and retired in.
   *
   * `render/rendererLifetime.ts` owns the sequence — retire the producer
   * ahead of a build whose first act destroys the device, register its
   * compile only once the warm-up has opened the census, install nothing
   * from a compile that resolves after a rebuild, release the device last —
   * and its header says what each step costs when it runs out of order. What
   * is left here is what only this component can answer: which mechanisms to
   * use, and what to do with a handle, a warm scene, or a failure. Not state:
   * nothing renders differently for the handle; `output` is the part that
   * does, and `onReady` publishes it.
   */
  const [lifetime] = useState(() =>
    createRendererLifetime({
      build: (preference, initialPicture, onReady) =>
        createRenderer(preference, initialPicture, onReady),
      release: releaseRenderer,
      warm: (handle) => warmScene(handle, engine, firstLight.progress),
      register: warmAtMount,
      // A WebGPU build gets the GPU producer unless the page asked for the
      // pool; a WebGL build never sees it.
      produce: (handle) =>
        handle.description.backend !== 'webgpu' ||
        producerPreference(window.location.search) === 'cpu'
          ? null
          : createTileProducer(handle.renderer),
      install: (producer) => engine.setHeightfieldSource(producer),
      onReady: (handle) => {
        engine.gl = handle
        setOutput(handle.description)
        // The measurement replay that follows a renderer build is
        // `firstLight.watch`'s, fired from the effect that reads `output`.
      },
      onWarmed: firstLight.warmed,
      onWarmFailure: (cause) => runtimeFailure.report('graphics', cause),
    }),
  )

  // The media query is live: a window can be dragged from an EDR display to one
  // without, and reading it once at startup gets that permanently wrong.
  useEffect(() => watchDynamicRange(setDynamicRangeHigh), [])

  /*
   * The knobs the frame loop reads, bound to the preferences that own them.
   *
   * One effect and no mirror. `state/engineKnobs.ts` lists the engine fields a
   * preference drives and follows each key alone, so a toggle reaches its own
   * field and nobody else's — and a lens a verb fitted (`ir.preset`,
   * `ir.rise`) goes into the preference through the same module, which is what
   * keeps the panel's sliders agreeing with the picture and the picture alive
   * across the next unrelated toggle.
   *
   * Bind before route effects restore a public picture. Passive effects run
   * child-first: binding here in that phase overwrote the restored lens and
   * camera mode with the stored preferences immediately after the URL applied.
   */
  useLayoutEffect(
    () => bindEngineKnobs(engine, pictureOverride),
    [engine, pictureOverride],
  )

  useEffect(() => {
    const unsubscribe = monitor.subscribe(setConnection)
    monitor.start()
    return () => {
      unsubscribe()
      monitor.stop()
    }
  }, [monitor])

  /*
   * The factory owns renderer replacement. StrictMode cleanup must leave a
   * healthy device alive for the surviving mount. Only terminal failure
   * permits the unmount cleanup to release the device and engine workers.
   */
  const canvasKey = `${rendererKey(hdr, dynamicRangeHigh)}:${canvasEpoch}`

  useEffect(
    () => () => {
      // StrictMode's ordinary replay keeps the device; a terminal failure retires it.
      if (runtimeFailure.getSnapshot() === null) return
      lifetime.dispose()
      engine.gl = null
      engine.view = null
      engine.dispose()
      singleton = null
    },
    [engine, lifetime],
  )

  /*
   * Which ceiling the drawing buffer gets. Deliberately *not* in the key above:
   * the pixel ratio is a live prop, so a tablet that gains a trackpad rescales
   * the buffer rather than rebuilding the renderer around it.
   */
  const coarse = useCoarsePointer()
  /*
   * The ratio the drawing buffer is actually built at, once.
   *
   * `<Canvas dpr>` below and `engine.displayRatio` have to be the same number —
   * the pointer's half of it converts a drag delta in CSS pixels into an angle
   * `pixelAngle` answers per *display* pixel, so a disagreement moves the
   * picture at the wrong rate against a buffer that has already rescaled.
   * Written twice they disagree the moment `devicePixelRatio` moves, which
   * browser zoom and a drag between displays both do without changing `coarse`.
   */
  const displayRatio = Math.min(useDevicePixelRatio(), dprCeiling(coarse))
  useEffect(() => {
    engine.displayRatio = displayRatio
  }, [engine, displayRatio])

  useEffect(() => {
    if (output === null) return
    const canvas = lifetime.handle?.renderer.domElement
    if (canvas === undefined) return
    const measure = (): void => {
      const bounds = canvas.getBoundingClientRect()
      const width = Math.max(1, Math.floor(bounds.width * displayRatio))
      const height = Math.max(1, Math.floor(bounds.height * displayRatio))
      setDisplaySize((held) =>
        held?.width === width && held.height === height
          ? held
          : { width, height },
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    measure()
    return () => observer.disconnect()
  }, [output, displayRatio, lifetime])

  /*
   * Verify that boot actually put pixels on screen.
   *
   * Keyed on `output` because sampling before the renderer exists proves
   * nothing, and on `canvasEpoch` so a rebuilt canvas gets its own verification
   * pass. Which evidence counts, whether the remount lever is still available,
   * and what an exhausted ladder means are all `firstLight`'s.
   */
  useEffect(() => {
    if (output === null) return
    const canvas = lifetime.handle?.renderer.domElement
    if (canvas === undefined) return
    firstLight.watch(canvas, output.backend)
  }, [output, canvasEpoch, firstLight, lifetime])

  /*
   * Warm everything a first encounter would otherwise pay for, behind the
   * boot overlay. Keyed on `output` rather than run once: an HDR
   * change rebuilds the renderer, whose pipeline and texture caches die with
   * it, and a re-warm against the new handle is what keeps the first frame
   * after the rebuild from paying the whole bill again. The lifetime warms
   * each build once, which also absorbs StrictMode's double effect.
   */
  useEffect(() => {
    if (output === null) return
    const handle = lifetime.handle
    if (handle === null) return
    lifetime.warm(handle)
  }, [output, lifetime])

  // Bake atmosphere tables for systems that load mid-session, off the frame
  // loop, so a jump's first look costs a cache hit. See `render/preload.ts`.
  useEffect(() => watchSystemAtmospheres(engine), [engine])

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
      const clock = presentationClock(engine)
      const paused = !clock.paused
      clock.setPaused(paused)
      flash(paused ? 'paused' : 'running')
    },
    warp: (direction: number) => {
      const clock = presentationClock(engine)
      const next = nextWarp(clock.timeScale, direction)
      clock.setTimeScale(next)
      flash(`time warp ${next}×`)
    },
    realTime: () => {
      presentationClock(engine).setTimeScale(1)
      flash('time warp 1×')
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
   * The renderer, as the dock and the `/settings` page see it.
   *
   * The one knob assembled here rather than read from its definition by the
   * panel, because half of it is not a preference: `output` is what this
   * component's renderer build came back with, and the reason the control
   * exists is to show the ask beside the answer.
   */
  const renderState: HudRenderState = {
    preference: hdr,
    output,
    displaySize,
    pictureOverride,
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
      render: renderState,
      connection,
      onCheckConnection: monitor.refresh,
      commands,
      onNotice: flash,
    }),
    open: debug,
    onOpenChange: setDebug,
  }

  useEffect(() => {
    publishRuntime({
      engine,
      dev,
      render: renderState,
      onNotice: flash,
      boot: firstLight.store,
    })
  })
  useEffect(() => () => publishRuntime(null), [])

  /*
   * Every mode's chunk, fetched once the cover is off.
   *
   * A mode's code loads when its route first renders, and the route renders
   * nothing until the code lands — so the first door opened after first
   * light was the scene with no chrome for the length of a chunk fetch, and
   * the planetarium's stance arrived a beat after the menu's had been
   * released, which is a beat of the ship's camera between two pictures that
   * are not it. After `done` rather than at mount, so the three fetches never
   * compete with the census for the network; `ModeLink` also warms the one
   * under the pointer, which is the door most likely to open first.
   */
  useEffect(() => {
    if (boot !== 'done') return
    for (const mode of MODES) void preloadMode(mode)?.catch(() => {})
  }, [boot])

  /*
   * The transport verbs, bound in every mode.
   *
   * No flags. Which keys are live where is a question about contexts, and each
   * mode answers it for itself: the flight axes are `flight`, the cinema's
   * transport shadows the global pause because it is more specific, and the
   * reading room mutes the pause outright. A boolean threaded through here to
   * turn part of a listener off would be the shell answering a question it
   * cannot see the answer to.
   */
  useShipControls(engine, {
    onToggleAssist: commands.toggleAssist,
    onKillRotation: commands.killRotation,
    onPause: commands.togglePause,
    onWarp: commands.warp,
    onSave: commands.save,
    onLoad: commands.load,
  })
  useAction('sensor.response', () => {
    const held = read(RENDER_SENSOR)
    write(RENDER_SENSOR, {
      ...held,
      mode:
        held.mode === 'enhanced'
          ? 'automatic'
          : held.mode === 'automatic'
            ? 'manual'
            : 'enhanced',
    })
  })
  useAction('time.normal', commands.realTime)
  useAction('chrome.instruments', () => setDebug(!debug))
  /*
   * Asked of the engine, not of the snapshot.
   *
   * `chromeHidden` is republished by the sampler at 8 Hz, so two presses inside
   * one interval both read the same stale answer: the second asks for the
   * state the first already set, `#chromeStance ??=` makes it a no-op, and the
   * interface stays gone after a press that asked for it back.
   */
  useAction('chrome.all', () => engine.setChrome(!engine.chrome))
  /*
   * The two dialogs a key opens, as navigations rather than as state.
   *
   * `overlayState` carries the mode's own location along, which is what keeps
   * the mode mounted behind the dialog — without it `ModeRoutes` re-resolves at
   * `/keys`, matches nothing, falls through to the menu and tears down the
   * session the reader was asking about.
   *
   * `resolvedLocation` and not the raw one, because these two are reachable
   * *from inside a dialog*: with `/keys` up, `location` is already `/keys`, and
   * carrying that along would make the sheet its own background — which is the
   * same teardown by a longer route, and needs two Escapes to get out of.
   */
  useAction(
    'chrome.keys',
    () =>
      void navigate(KEYS, { state: overlayState(resolvedLocation(location)) }),
  )
  useAction(
    'chrome.settings',
    () =>
      void navigate(SETTINGS, {
        state: overlayState(resolvedLocation(location)),
      }),
  )

  /*
   * Where the cover sits under a public page rather than over the scene. The
   * page stays readable above it while its backdrop warms, and the cover is
   * then a black ground and nothing else: the front door already carries the
   * mark and the name, and a second wordmark showing through the page's
   * transparent half is two mastheads on one screen.
   */
  const coverUnderPage = mode === 'menu' || mode === 'docs'

  return (
    /*
     * `h-full w-full`, not `h-screen w-screen`.
     *
     * `h-screen` is `100vh`, which on iOS Safari is the height the page would
     * have if the toolbars were hidden — so the bottom of this shell, and the
     * nav bar pinned to it, sat underneath the browser chrome. `w-screen` is
     * `100vw`, which on a desktop includes the scrollbar gutter and so is
     * reliably a few pixels wider than the content box. Both are now the
     * document's own size, which `index.css` sets to `100dvh` and locks against
     * scrolling in one place.
     */
    <div className="absolute inset-0 h-full w-full overflow-hidden bg-black text-slate-200">
      <Canvas
        key={canvasKey}
        // Not renderer *settings* — the renderer itself. `createRenderer` probes
        // what the browser can output, builds a `WebGPURenderer` around the
        // answer and awaits `init()`; R3F awaits the promise, so nothing draws
        // against a half-built backend. See `render/createRenderer.ts`.
        gl={lifetime.factory(hdr, picture)}
        // The factory chooses a depth convention that preserves this range.
        camera={{ fov: DEFAULT_FOV_DEG, near: 0.05, far: 1e10 }}
        // The device ratio capped by what kind of machine this is, times the
        // supersampling factor. A number rather than a range because it must
        // *raise* the buffer above the device ratio, which a clamp can only
        // lower. `dprCeiling` is where the handheld figure and its argument
        // live; the short version is that this scene is fragment-bound close to
        // a planet and a phone is shading the whole display three times over.
        dpr={displayRatio * pictureDprFactor(picture)}
        // R3F configures the renderer *after* the factory resolves and sets its
        // own tone mapping while doing so. This is where ours goes back.
        onCreated={(state) => {
          if (lifetime.handle !== null) commitToneCurve(lifetime.handle)
          // The perf overlay's GPU measurement submits its own frames, and this
          // is the only place R3F offers the scene and camera to submit them with.
          engine.view = { scene: state.scene, camera: state.camera }
        }}
      >
        <SceneView
          engine={engine}
          picture={picture}
          pictureDiagnostic={pictureDiagnostic}
        />
      </Canvas>

      {/* Shared z bands with PageShell preserve cutscene and dialog ordering.
          Neither persistent sibling introduces its own stacking context. */}
      <ChromeContext value={chromeHidden}>
        <div className="hud-layer pointer-events-none absolute">
          <CharacterControls engine={engine} />
          {/* Renders nothing at all when no cutscene is running. While one is,
            every other piece of chrome below unmounts — Esc skips, and the
            dock comes straight back. */}
          <div className="pointer-events-none absolute inset-0 z-10">
            <ErrorBoundary
              what="the cutscene overlay"
              className="type-readout pointer-events-auto absolute bottom-5 left-1/2 w-[34rem] max-w-[80%] -translate-x-1/2"
            >
              {/* The scene's own screen-space layer: blackout, titles, audio.
                No transport: the cinema player provides the controls, and the
                overlay's header says why a second set is not drawn here. */}
              <CutsceneOverlay engine={engine} />
            </ErrorBoundary>
            {/* The reference edit's tracked subject over the render, behind
              `ir.trackOverlay(true)` and drawn by nothing else. After the
              overlay above and so above its blackout, which is the point: the
              boxes have to be readable through a fade. Its own boundary,
              because a debug surface that throws must not take the titles with
              it. */}
            <ErrorBoundary what="the track overlay">
              <TrackOverlay engine={engine} />
            </ErrorBoundary>
          </div>
          {/* A notice echoes what was asked for, and one of the things that can
            be asked for is whatever was typed into the address field. Bounded
            so a paste is a truncated sentence rather than a band across the
            bottom of the frame.

            `bottom-16` rather than the usual `0.75rem` inset: the IR menu is at
            the bottom center now, and a notice at the same inset landed on top
            of it — covering the panel toggles for two and a half seconds after
            every command, which is exactly when somebody is most likely to
            reach for one.

            `AnimatePresence` is here rather than a CSS transition because the
            element is conditionally rendered: it can fade *in* under CSS and
            never fade out, since by the time the notice clears there is no node
            left to transition. The key is the message, so a second notice
            arriving while the first is up crossfades rather than swapping text
            inside a box that never moved. Transform is dropped for anyone who
            asks for reduced motion; see the shared `MotionConfig` in `Root.tsx`. */}
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
                className="type-readout pointer-events-none absolute bottom-16 left-1/2 z-30 max-w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 truncate rounded border border-sky-500/40 bg-slate-950/85 px-3 py-1 text-sky-200 backdrop-blur"
              >
                {notice}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Public pages remain readable above the cover while their backdrop
              warms. Keep the fade mounted in every mode: onRevealed completes
              firstLight and releases its warm-up machinery.

              `z-35` over a scene mode: above the mode's chrome and the cinema
              band at 30, and *below* the dialog band at 40. The dialogs are
              reachable during boot — `?` and the settings key are bound from
              the first frame — and at 50 the cover swallowed them: a live
              sheet under opaque black, taking every click the cover did not.
              `PageShell` is the later sibling and wins a tie, so the gap
              between the two is not decorative. */}
          {boot !== 'done' && (
            <div
              className={`pointer-events-none absolute inset-0 ${coverUnderPage ? 'z-0' : 'z-35'}`}
            >
              <ErrorBoundary
                what="the loading screen"
                className="type-readout pointer-events-auto absolute top-3 right-3"
              >
                <BootOverlay
                  phase={boot === 'revealing' ? 'revealing' : 'booting'}
                  stages={bootStages}
                  fraction={bootFraction}
                  quiet={coverUnderPage}
                  onRevealed={firstLight.revealed}
                />
              </ErrorBoundary>
            </div>
          )}
        </div>
      </ChromeContext>
    </div>
  )
}
