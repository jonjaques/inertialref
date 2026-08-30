import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { AnimatePresence, motion } from 'motion/react'
import { useLocation, useNavigate } from 'react-router'
import type { GameEngine } from './engine/GameEngine.ts'
import { currentEngine } from './engine/instance.ts'
import type {
  CameraState,
  GraphicsState,
  HudCommands,
  HudRenderState,
} from './hud/controls.ts'
import { BootOverlay } from './hud/BootOverlay.tsx'
import { ChromeContext } from './hud/chrome.ts'
import { CutsceneOverlay } from './hud/CutsceneOverlay.tsx'
import { ErrorBoundary } from './hud/ErrorBoundary.tsx'
import { TrackOverlay } from './hud/TrackOverlay.tsx'
import {
  CAMERA_LENS,
  DEBUG_ON,
  RENDER_AA,
  RENDER_HDR,
  RENDER_LENS_FLARE,
  usePersistentState,
} from './state/preferences.ts'
import { useAction } from './input/useKeymap.ts'
import { devPanels } from './hud/registry.tsx'
import { nextWarp } from './hud/warp.ts'
import { useShipControls } from './hud/useShipControls.ts'
import {
  type Connection,
  ConnectionMonitor,
  DISCONNECTED,
} from './net/health.ts'
import { firstLight } from './render/firstLight.ts'
import { type AaLevel, type OutputPreference } from './render/output.ts'
import { DocumentMeta } from './pages/DocumentMeta.tsx'
import { ModeRoutes } from './pages/ModeRoutes.tsx'
import { OverlayRoutes } from './pages/OverlayRoutes.tsx'
import {
  KEYS,
  modeForPath,
  modeHasBootCover,
  overlayState,
  resolvedLocation,
  SETTINGS,
} from './pages/paths.ts'
import { useEngine } from './state/engineStore.ts'

/*
 * The chrome island.
 *
 * The canvas lives in `scene/SceneBackdrop.tsx`. This tree is the HUD, the
 * modes and the dialogs, and it mounts without waiting for the catalog or
 * for `three/webgpu`. Canonical state never enters component state — the
 * panel receives a snapshot, and if this component unmounted the universe
 * would carry on unchanged.
 *
 * Every command below exists exactly once and is bound to both a key and a
 * button. Two implementations of "time warp" that drift by one step is a bug
 * nobody would find, and the dock is what makes the game drivable without
 * memorising the keyboard first.
 */

/** How long a transient notice stays up. */
const NOTICE_MS = 2_500

/** An unknown throw, as a sentence. Every rejection here reaches a notice. */
const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export default function App() {
  /*
   * Subscribe first: `currentEngine()` is not reactive, and the store
   * flipping off empty is how this tree learns the backdrop has constructed
   * one.
   */
  const status = useEngine((snapshot) => snapshot.status)
  const cinema = useEngine((snapshot) => snapshot.cinema)
  const output = useEngine((snapshot) => snapshot.output)
  const chromeHidden = !useEngine((snapshot) => snapshot.presentation.chrome)
  const engine: GameEngine | null = currentEngine()
  const { phase: boot, status: bootStatus } = useStore(firstLight.store)

  const location = useLocation()
  const navigate = useNavigate()
  const mode = modeForPath(resolvedLocation(location).pathname)

  const [debug, setDebug] = usePersistentState(DEBUG_ON)
  const [notice, setNotice] = useState<string | null>(null)
  const [hdr, setHdr] = usePersistentState(RENDER_HDR)
  const [lensFlare, setLensFlare] = usePersistentState(RENDER_LENS_FLARE)
  const [aa, setAa] = usePersistentState(RENDER_AA)
  const [lens, setLens] = usePersistentState(CAMERA_LENS)
  const [connection, setConnection] = useState<Connection>(DISCONNECTED)
  const monitor = useRef<ConnectionMonitor | null>(null)
  const storageBusy = useRef(false)

  useEffect(() => {
    if (engine === null) return
    const next = new ConnectionMonitor({
      catalog: engine.world.catalog.version,
    })
    monitor.current = next
    const unsubscribe = next.subscribe(setConnection)
    next.start()
    return () => {
      unsubscribe()
      next.stop()
      monitor.current = null
    }
  }, [engine])

  const noticeTimer = useRef(0)
  const flash = useCallback((message: string) => {
    window.clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  const commands: HudCommands = {
    togglePause: () => {
      if (engine === null) return
      const paused = !engine.world.clock.paused
      engine.world.clock.setPaused(paused)
      flash(paused ? 'paused' : 'running')
    },
    warp: (direction: number) => {
      if (engine === null) return
      const next = nextWarp(engine.world.clock.timeScale, direction)
      engine.world.clock.setTimeScale(next)
      flash(`time warp ${next}×`)
    },
    realTime: () => {
      if (engine === null) return
      engine.world.clock.setTimeScale(1)
      flash('time warp 1×')
    },
    toggleAssist: () => {
      if (engine === null) return
      flash(`flight assist ${engine.toggleFlightAssist() ? 'on' : 'off'}`)
    },
    killRotation: () => {
      if (engine === null) return
      engine.killRotation()
      flash('rotation killed')
    },
    save: () => {
      if (engine === null || storageBusy.current) return
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
      if (engine === null || storageBusy.current) return
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

  const graphicsState: GraphicsState = {
    lensFlare,
    onLensFlare: setLensFlare,
    aa,
    onAa: (level: AaLevel) => {
      setAa(level)
      flash(`anti-aliasing ${level}`)
    },
  }
  const cameraState: CameraState = { lens, onLens: setLens }
  const renderState: HudRenderState = {
    preference: hdr,
    output,
    onPreference: (next: OutputPreference) => {
      if (next === hdr) return
      setHdr(next)
      flash(`hdr ${next}`)
    },
  }

  const dev = {
    panels:
      engine === null
        ? []
        : devPanels({
            engine,
            status,
            render: renderState,
            graphics: graphicsState,
            camera: cameraState,
            connection,
            onCheckConnection: () => monitor.current?.refresh(),
            commands,
            onNotice: flash,
          }),
    open: debug,
    onOpenChange: setDebug,
  }

  useShipControls(engine, {
    onToggleAssist: commands.toggleAssist,
    onKillRotation: commands.killRotation,
    onPause: commands.togglePause,
    onWarp: commands.warp,
    onSave: commands.save,
    onLoad: commands.load,
  })
  useAction('time.normal', commands.realTime)
  useAction('chrome.instruments', () => setDebug(!debug))
  useAction('chrome.all', () => engine?.setChrome(!engine.chrome))
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

  return (
    /*
     * Transparent, not `bg-black`. The canvas is a sibling island behind this
     * tree; a black fill here would paint over it. The document is already
     * `#000`. `h-full w-full`, not `h-screen w-screen` — `h-screen` is `100vh`,
     * which on iOS Safari is the height the page would have if the toolbars
     * were hidden.
     */
    <div
      className="relative h-full w-full overflow-hidden text-slate-200"
      id="app"
    >
      {/* Renders nothing; keeps the tab, the canonical link and the analytics
          page view in step with the address bar. Inside the shell rather than
          in `Root.tsx` because it needs the router's location. */}
      <DocumentMeta />

      {/*
       * Everything above the scene, clamped to standard range.
       *
       * `docs/design/art.md` wants the HUD composited after tone mapping at fixed
       * luminance so it stays legible against a star. The browser already
       * composites the DOM over the canvas — but the dock and the flight strip
       * are `backdrop-blur`, and a backdrop filter samples what is behind it,
       * which on the extended path includes a star's disk at twice diffuse
       * white. `dynamic-range-limit` inherits, so one declaration on the layer
       * holds for every overlay inside it, and it must not be on the root: the
       * canvas is a sibling island and would be clamped with it.
       *
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
       *   50 the boot overlay   — over the mode box on interactive modes only
       *
       * The tooltip wrapper portals its content *into* this layer at `z-50`
       * — above every band here, and inside the standard-range clamp, which
       * is the point: a chip portalled to `<body>` sat outside the clamp and
       * composited over a star at twice diffuse white. See
       * `components/ui/tooltip.tsx`.
       */}
      <ChromeContext value={chromeHidden}>
        <div className="hud-layer pointer-events-none absolute">
          {engine !== null && (
            <div className="pointer-events-none absolute inset-0 z-10">
              <ErrorBoundary
                what="the cutscene overlay"
                className="type-readout pointer-events-auto absolute bottom-5 left-1/2 w-[34rem] max-w-[80%] -translate-x-1/2"
              >
                <CutsceneOverlay
                  engine={engine}
                  transport={debug && mode !== 'cinema'}
                />
              </ErrorBoundary>
              <ErrorBoundary what="the track overlay">
                <TrackOverlay engine={engine} />
              </ErrorBoundary>
            </div>
          )}
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
                  camera={cameraState}
                  dev={dev}
                  onNotice={flash}
                />
              </ErrorBoundary>
            </div>
          )}

          {/* A notice echoes what was asked for. `AnimatePresence` rather than
            a CSS transition because the element is conditionally rendered.
            Transform is dropped for anyone who asks for reduced motion; see
            `MotionConfig` in `Root.tsx`. */}
          <AnimatePresence>
            {(!cinema || mode === 'cinema') && notice !== null && (
              <motion.div
                key={notice}
                role="status"
                aria-live="polite"
                title={notice}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.15 }}
                className="type-readout pointer-events-none absolute bottom-16 left-1/2 z-30 max-w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 truncate rounded border border-sky-500/40 bg-slate-950/85 px-3 py-1 text-sky-200 backdrop-blur"
              >
                {notice}
              </motion.div>
            )}
          </AnimatePresence>

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

          {/* Interactive modes cover their own box until first light. Content
            pages do not: the words are already the document, and the canvas
            fades in behind them. */}
          {modeHasBootCover(mode) && boot !== 'done' && (
            <div className="pointer-events-none absolute inset-0 z-50">
              <ErrorBoundary
                what="the loading screen"
                className="type-readout pointer-events-auto absolute bottom-3 left-3"
              >
                <BootOverlay
                  phase={boot === 'revealing' ? 'revealing' : 'booting'}
                  status={bootStatus}
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
