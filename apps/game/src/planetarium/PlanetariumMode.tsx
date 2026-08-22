'use no memo'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { PerspectiveCamera } from 'three/webgpu'
import { DEFAULT_FILL } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { CompactDock } from '../dock/CompactDock.tsx'
import { Dock } from '../dock/Dock.tsx'
import { DockRail } from '../dock/DockRail.tsx'
import { DockProvider } from '../dock/DockProvider.tsx'
import { togglePanel } from '../dock/layout.ts'
import { useDockLayout } from '../dock/useDockLayout.ts'
import { isBoolean, usePersistentState } from '../hud/panelState.ts'
import { useCompact } from '../hud/viewport.ts'
import { QUERY } from '../pages/paths.ts'
import type { PlanetariumContext } from './context.ts'
import { planetariumPanels } from './registry.tsx'
import { pick } from './pick.ts'
import { projectScene } from './project.ts'
import { SkyLabels } from './SkyLabels.tsx'
import { useObserverInput } from './useObserverInput.ts'

/*
 * The planetarium.
 *
 * Everything it does is a *view*: the observatory moves a camera, the panels
 * read the harness, and nothing here teleports the ship or touches canonical
 * state. That is what lets it share a build and a running world with the flight
 * modes rather than being a second application — you can leave a ship in orbit
 * of Mars, spend ten minutes looking at Saturn's rings, and come back to find
 * the ship exactly where it was, with the same state hash.
 *
 * The URL is the document. `?at=` is where the camera is pointed, and it is
 * written back on every focus so the address bar always describes what is on
 * screen — which is what makes a planetarium view a thing you can send someone.
 */

/** Where the camera opens when nothing else says. The disc everyone knows. */
const DEFAULT_TARGET = 's:SOL/b:2'

export function PlanetariumMode({
  engine,
  fov,
  onFov,
}: {
  engine: GameEngine
  fov: number
  onFov: (fov: number) => void
}) {
  const [params, setParams] = useSearchParams()
  const compact = useCompact()
  const requested = params.get(QUERY.at)

  const [target, setTarget] = useState<string | null>(null)
  const [labels, setLabels] = usePersistentState(
    'planetarium.labels',
    true,
    isBoolean,
  )
  const [orbits, setOrbits] = usePersistentState(
    'planetarium.orbits',
    true,
    isBoolean,
  )
  const [ship, setShip] = usePersistentState(
    'planetarium.ship',
    false,
    isBoolean,
  )
  const [notice, setNotice] = useState<string | null>(null)

  /*
   * Presentation switches, pushed onto the engine rather than read from React.
   *
   * The frame loop reads these every frame and must not touch React to do it —
   * the same arrangement `App` uses for the lens flare. Restored on the way
   * out, because leaving the planetarium with the ship still hidden would be
   * this mode reaching into the flight modes.
   */
  useEffect(() => {
    engine.showShip = ship
    engine.showOrbits = orbits
    return () => {
      engine.showShip = true
      engine.showOrbits = false
    }
  }, [engine, ship, orbits])

  /*
   * Hand the camera back on the way out.
   *
   * `engine.observer` is only produced while the observatory has a target, so
   * dropping the target is what returns the camera to the ship. Without this,
   * leaving for a flight mode would leave the chase camera parked at whatever
   * the planetarium was looking at — the ship visible in the distance, flying
   * away from a stationary view.
   */
  useEffect(
    () => () => {
      engine.harness.observatory.clear()
    },
    [engine],
  )

  const focus = useCallback(
    (address: string, options: { url?: boolean } = {}) => {
      try {
        const status = engine.harness.look(address)
        setTarget(status.target?.address ?? null)
        setNotice(null)
        if (options.url !== false && status.target !== null) {
          // `replace`, not push: focusing is a continuous act — a tour through
          // six moons is six clicks — and a back button that walked back
          // through every one of them would be useless for leaving the mode.
          setParams(
            (current) => {
              const next = new URLSearchParams(current)
              next.set(QUERY.at, status.target?.address ?? '')
              return next
            },
            { replace: true },
          )
        }
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [engine, setParams],
  )

  /*
   * Open on what the URL asks for, and keep it that way.
   *
   * Reconciling against the observatory's *actual* target rather than guarding
   * with a "have I run yet" ref, and that is not a style preference — the ref
   * version is broken. React re-runs effects on a remount while refs survive
   * it, so the cleanup below clears the target and the guard then refuses to
   * set it again: the planetarium comes up with the camera on nothing, in dev
   * every time and in production whenever anything remounts the mode. Asking
   * the thing that owns the state is idempotent by construction.
   *
   * It also makes writing the resolved address back into the URL free: the
   * effect re-runs, finds the observatory already on that address, and stops.
   */
  useEffect(() => {
    const wanted = requested ?? DEFAULT_TARGET
    if (engine.harness.observatory.target?.address === wanted) return
    focus(wanted, { url: requested === null })
  }, [engine, requested, focus])

  const panels = planetariumPanels({
    engine,
    target,
    focus,
    labels,
    onLabels: setLabels,
    orbits,
    onOrbits: setOrbits,
    ship,
    onShip: setShip,
    fov,
    onFov,
  } satisfies PlanetariumContext)
  const [layout, setLayout] = useDockLayout('planetarium', panels)

  /*
   * A click in the sky.
   *
   * The projection is redone here rather than shared with the label layer's,
   * and that is the cheap correct choice: a pick happens on a click and a label
   * pass happens every frame, so caching one for the other would mean a hit
   * test against positions from the last frame — off by however far the camera
   * moved, which during an ease is most of the screen.
   */
  const onPick = useCallback(
    (point: { x: number; y: number }) => {
      const scene = engine.scene()
      const view = engine.view
      if (scene === null || view === null) return
      const size = { width: window.innerWidth, height: window.innerHeight }
      const hit = pick(
        projectScene(scene, view.camera as PerspectiveCamera, size),
        point,
      )
      if (hit !== null) focus(hit.address)
    },
    [engine, focus],
  )

  const surface = useObserverInput(engine, {
    enabled: true,
    onPick,
    onFrame: () => engine.harness.observatory.frameTarget(DEFAULT_FILL),
    onReset: () => focus(DEFAULT_TARGET),
  })

  return (
    <div className="absolute inset-0">
      {/*
       * The input surface, under every panel and over the canvas.
       *
       * A layer of its own rather than listeners on the canvas: the canvas is
       * remounted whenever the renderer is rebuilt (an HDR change, the
       * presentation watchdog's last rung), and listeners attached to it would
       * go with it silently — the camera would simply stop responding, with
       * nothing in the console. `touch-action: none` is what stops a drag from
       * scrolling the page out from under the gesture on a phone.
       *
       * `pointer-events-auto` explicitly, and it is not redundant: `.hud-layer`
       * is `pointer-events: none` so the scene beneath stays reachable, and
       * `ErrorBoundary`'s `className` styles its *fallback* rather than a
       * wrapper — so nothing between here and the layer turns them back on.
       * Without it the hit target at every pixel is the canvas, and the camera
       * silently ignores every drag.
       */}
      <div
        ref={surface}
        className="pointer-events-auto absolute inset-0 touch-none"
        style={{ cursor: 'grab' }}
        aria-hidden
      />

      <SkyLabels engine={engine} enabled={labels} target={target} />

      {/* The aiming point. Small, dim and always there: it is the answer to
          "what will a click hit", and in a mode with no ship it is the only
          thing anchoring the centre of the frame. */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="size-1.5 rounded-full border border-sky-300/40" />
      </div>

      {notice !== null && (
        <p className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 rounded bg-rose-500/20 px-3 py-1 font-mono text-[11px] text-rose-200">
          {notice}
        </p>
      )}

      <DockProvider>
        {compact ? (
          <CompactDock panels={panels} layout={layout} />
        ) : (
          <Dock
            panels={panels}
            layout={layout}
            onLayout={setLayout}
            // Always rendered, even with every zone empty: the rail is the only
            // way a closed panel comes back, and one that disappeared with the
            // last panel would be a dead end.
            rail={
              <DockRail
                panels={panels}
                layout={layout}
                onToggle={(id: string) => {
                  const definition = panels.find((panel) => panel.id === id)
                  if (definition === undefined) return
                  // Against the previous state rather than the rendered one,
                  // for the reason `Dock`'s `move` gives at length.
                  setLayout((current) =>
                    togglePanel(current, id, definition.zone),
                  )
                }}
              />
            }
          />
        )}
      </DockProvider>
    </div>
  )
}
