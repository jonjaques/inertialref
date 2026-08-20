import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useState } from 'react'
import type { HarnessStatus } from '@inertialref/devtools'
import { GameEngine } from './engine/GameEngine.ts'
import { FlightStrip } from './hud/FlightStrip.tsx'
import { HudDock, type HudCommands, type HudTab } from './hud/HudDock.tsx'
import { usePersistentState } from './hud/panelState.ts'
import { useShipControls } from './hud/useShipControls.ts'
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

function engineInstance(): GameEngine {
  singleton ??= new GameEngine({ seed: new URLSearchParams(window.location.search).get('seed') ?? 'inertialref' })
  return singleton
}

/** HUD refresh rate. The simulation runs at 64 Hz; a human reads about 8. */
const PANEL_HZ = 8

/** Time-warp detents. Powers of ten with a 5 and a 25 where the gaps are worst. */
const WARP_STEPS = [1, 5, 25, 100, 1_000, 10_000, 100_000]

export default function App() {
  const engine = engineInstance()
  const [status, setStatus] = useState<HarnessStatus | null>(null)
  const [dockOpen, setDockOpen] = usePersistentState('dock.open', true)
  const [tab, setTab] = usePersistentState<HudTab>('dock.tab', 'navigate')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    // Expose the harness for the console and for automated drivers. This is the
    // same object the headless runner uses, so a scenario reproduced here can
    // be replayed in a test.
    const globalScope = window as unknown as Record<string, unknown>
    globalScope['ir'] = engine.harness
    globalScope['engine'] = engine
    console.info('%cInertialRef', 'color:#38bdf8;font-weight:bold', '— harness ready. Try ir.help()')

    const timer = window.setInterval(() => setStatus(engine.harness.status()), 1000 / PANEL_HZ)
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
      const next = WARP_STEPS[Math.min(WARP_STEPS.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))] ?? 1
      engine.world.clock.setTimeScale(next)
      flash(`time warp ${next}×`)
    },
    toggleAssist: () => flash(`flight assist ${engine.toggleFlightAssist() ? 'on' : 'off'}`),
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
  })

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-slate-200">
      <Canvas
        gl={{
          // Twenty orders of magnitude of depth in one scene: a linear depth
          // buffer z-fights everywhere, and this costs a fragment shader
          // instruction.
          logarithmicDepthBuffer: true,
          antialias: true,
          powerPreference: 'high-performance',
        }}
        // A logarithmic depth buffer makes this range workable; a linear one
        // would have no usable precision anywhere in it.
        camera={{ fov: 65, near: 0.05, far: 1e10 }}
        dpr={[1, 2]}
      >
        <SceneView engine={engine} />
      </Canvas>

      <HudDock
        engine={engine}
        status={status}
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
  )
}
