import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useState } from 'react'
import type { HarnessStatus } from '@inertialref/devtools'
import { GameEngine } from './engine/GameEngine.ts'
import { DebugPanel, FlightStrip } from './hud/DebugPanel.tsx'
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
 */

let singleton: GameEngine | null = null

function engineInstance(): GameEngine {
  singleton ??= new GameEngine({ seed: new URLSearchParams(window.location.search).get('seed') ?? 'inertialref' })
  return singleton
}

/** HUD refresh rate. The simulation runs at 64 Hz; a human reads about 8. */
const PANEL_HZ = 8

export default function App() {
  const engine = engineInstance()
  const [status, setStatus] = useState<HarnessStatus | null>(null)
  const [panelVisible, setPanelVisible] = useState(true)
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

  useShipControls(engine, {
    onToggleAssist: () => flash(`flight assist ${engine.toggleFlightAssist() ? 'on' : 'off'}`),
    onKillRotation: () => {
      engine.killRotation()
      flash('rotation killed')
    },
    onPause: () => {
      const paused = !engine.world.clock.paused
      engine.world.clock.setPaused(paused)
      flash(paused ? 'paused' : 'running')
    },
    onWarp: (direction) => {
      const steps = [1, 5, 25, 100, 1_000, 10_000, 100_000]
      const current = engine.world.clock.timeScale
      const index = steps.findIndex((step) => step >= current)
      const next = steps[Math.min(steps.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))] ?? 1
      engine.world.clock.setTimeScale(next)
      flash(`time warp ${next}×`)
    },
    onSave: () => {
      void engine.save().then((text) => flash(`saved ${text.length} bytes`))
    },
    onLoad: () => {
      void engine.load().then((ok) => flash(ok ? 'loaded' : 'nothing to load'))
    },
    onToggleHud: () => setPanelVisible((visible) => !visible),
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

      <DebugPanel status={status} visible={panelVisible} />
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
