'use no memo'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PerspectiveCamera } from 'three/webgpu'
import { DEFAULT_FILL } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { StanceHandle } from '../engine/presentation.ts'
import type { CameraState } from '../hud/controls.ts'
import { Workspace } from '../dock/Workspace.tsx'
import type { DevWorkspace } from '../dock/workspace.ts'
import {
  PLANETARIUM_FLARE,
  PLANETARIUM_LABEL_DENSITY,
  PLANETARIUM_LABEL_MINOR,
  PLANETARIUM_LABELS,
  PLANETARIUM_ORBIT_SCOPE,
  PLANETARIUM_ORBITS,
  PLANETARIUM_HINTED,
  PLANETARIUM_SHIP,
  usePersistentState,
} from '../state/preferences.ts'
import { useChromeHidden } from '../hud/chrome.ts'
import { useKeyLabel } from '../input/useKeymap.ts'
import { useEngine } from '../state/engineStore.ts'
import { QUERY, withSearchParam } from '../pages/paths.ts'
import { useOverlayStore } from '../pages/overlay.ts'
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

/** Where the camera opens when nothing else says. The disk everyone knows. */
const DEFAULT_TARGET = 's:SOL/b:2'

export function PlanetariumMode({
  engine,
  camera,
  dev,
}: {
  engine: GameEngine
  camera: CameraState
  dev: DevWorkspace
}) {
  const search = useOverlayStore((state) => state.mode.search)
  const setModeSearch = useOverlayStore((state) => state.setModeSearch)
  const requested = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  ).get(QUERY.at)

  const [target, setTarget] = useState<string | null>(null)
  const [labels, setLabels] = usePersistentState(PLANETARIUM_LABELS)
  const [orbits, setOrbits] = usePersistentState(PLANETARIUM_ORBITS)
  const [ship, setShip] = usePersistentState(PLANETARIUM_SHIP)
  const [labelDensity, setLabelDensity] = usePersistentState(
    PLANETARIUM_LABEL_DENSITY,
  )
  const [labelMinor, setLabelMinor] = usePersistentState(
    PLANETARIUM_LABEL_MINOR,
  )
  const [orbitScope, setOrbitScope] = usePersistentState(
    PLANETARIUM_ORBIT_SCOPE,
  )
  const [flare, setFlare] = usePersistentState(PLANETARIUM_FLARE)
  /*
   * What the mode has to say, and whether it is a complaint.
   *
   * Two tones on one surface, because there is one place on screen where this
   * mode reports back and a preset that moved the camera and the lens has to
   * say so — "Earthrise — Luna, 20°" is not a failure, and drawing it in the
   * rose the address errors use would read as one. Everything else about the
   * surface, including that `Shift+H` clears it, stays the same.
   */
  const [notice, setNotice] = useState<{
    text: string
    tone: 'error' | 'said'
  } | null>(null)
  /*
   * Whether the primary drag and the arrow keys look instead of orbiting.
   *
   * Session state rather than a preference, and the two ways in are why: the
   * secondary button always looks, so a mouse never needs this — it is the only
   * way in on a phone and with a keyboard alone. Somebody who turned it on for
   * one picture has not said anything about the next session, and a planetarium
   * that opened with the drag doing something other than orbiting would be a
   * mode whose primary gesture had silently changed.
   */
  const [freeLook, setFreeLook] = useState(false)
  const [hinted, setHinted] = usePersistentState(PLANETARIUM_HINTED)
  // The sheet's own chord, so the hint cannot name a key the editor has moved.
  const keysLabel = useKeyLabel('chrome.keys')
  const chromeHidden = useChromeHidden()
  const drawLabels = useEngine((snapshot) => snapshot.presentation.labels)
  /*
   * Whether the camera is on the ground, sampled with the rest of the status.
   *
   * A boolean, so it bails out of the re-render with `Object.is` — the whole
   * observer status is a fresh object graph eight times a second and selecting
   * it here would rebuild this mode at that rate.
   */
  const standing = useEngine(
    (snapshot) =>
      snapshot.observer?.surface !== null &&
      snapshot.observer?.surface !== undefined,
  )

  /*
   * The mode's stance: what it wants drawn while it is on screen.
   *
   * One push on mount, released on unmount, and `update` for the switches — so
   * "restore" means *whatever was underneath*, not a literal. This mode used to
   * restore `showShip` to `true` and `showOrbits` to `false` on the way out,
   * which is wrong whenever it was entered from the menu: the menu had hidden
   * the ship, and leaving the planetarium put back a value nothing had set.
   *
   * `observatory: true` is a claim on the target's *lifetime*, not on the
   * camera. Releasing it is what hands the camera back — without it, leaving
   * for a flight mode leaves the chase camera parked on whatever was being
   * looked at, with the ship flying away from a stationary view.
   */
  const stance = useRef<StanceHandle | null>(null)
  useEffect(() => {
    const held = engine.presentation.push({ observatory: true })
    stance.current = held
    return () => {
      stance.current = null
      held.release()
    }
  }, [engine])
  useEffect(() => {
    stance.current?.update({
      showShip: ship,
      showOrbits: orbits,
      orbitScope,
      labels,
      flareArtifacts: flare,
      observatory: true,
    })
  }, [engine, ship, orbits, orbitScope, labels, flare])

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
          setModeSearch(
            withSearchParam(search, QUERY.at, status.target?.address ?? ''),
          )
        }
      } catch (cause) {
        setNotice({
          text: cause instanceof Error ? cause.message : String(cause),
          tone: 'error',
        })
      }
    },
    [engine, search, setModeSearch],
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
    labelDensity,
    onLabelDensity: setLabelDensity,
    labelMinor,
    onLabelMinor: setLabelMinor,
    orbits,
    onOrbits: setOrbits,
    orbitScope,
    onOrbitScope: setOrbitScope,
    ship,
    onShip: setShip,
    flare,
    onFlare: setFlare,
    camera,
    // The dolly and the framing, as the observatory's own verbs. The wheel and
    // the pinch already reach the first through `useObserverInput`; this is the
    // same act with a button on it, for a pointer that has neither.
    dolly: (notches: number) => {
      engine.harness.observatory.zoomNotches(notches)
    },
    frameSubject: () => {
      engine.harness.observatory.frameTarget()
    },
    freeLook,
    onFreeLook: setFreeLook,
    onNotice: (text: string) => setNotice({ text, tone: 'said' }),
  } satisfies PlanetariumContext)

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
        projectScene(
          scene,
          view.camera as PerspectiveCamera,
          size,
          engine.lens,
        ),
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
    standing,
    freeLook,
    onFreeLook: setFreeLook,
    // Idempotent: the hook fires this on every gesture and the preference is
    // already true after the first, so the write happens once and the effect
    // that persists it bails on the rest.
    onGesture: () => setHinted(true),
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
       *
       * `hud-bleed` because the sky it drags runs under the notch: `.hud-layer`
       * holds its children clear of the safe areas so the *chrome* is readable,
       * and a drag that starts in the 44 px a landscape iPhone keeps at each
       * side is still a drag.
       */}
      {/* The cursor says which act a drag is: `grab` for the orbit, `move`
          for the look. Standing, a drag always turns the head, so the two
          conditions are the same question asked of two things. */}
      <div
        ref={surface}
        className="hud-bleed pointer-events-auto absolute touch-none select-none"
        style={{ cursor: freeLook || standing ? 'move' : 'grab' }}
        aria-hidden
      />

      {!hinted && !chromeHidden && (
        /*
         * The one thing a planetarium has to say before it says anything else.
         *
         * Every gesture here is discoverable by trying it and none of them is
         * discoverable by looking, which is the specific failure a scene with
         * no chrome in it has. It leaves on the first gesture and stays gone —
         * a hint that came back on the next reload would be an advertisement
         * rather than an introduction, which is why it is a preference and not
         * session state.
         */
        <p className="type-ui pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 text-balance text-slate-400">
          drag to orbit · wheel to dolly · click to focus · {keysLabel ?? '?'}{' '}
          for keys
        </p>
      )}

      <SkyLabels
        engine={engine}
        // The stance, not the preference: a capture pushes `labels: false` over
        // it, and reading the preference here would draw the names anyway.
        enabled={drawLabels}
        density={labelDensity}
        minor={labelMinor}
        target={target}
      />

      {/* The aiming point. Small, dim and always there: it is the answer to
          "what will a click hit", and in a mode with no ship it is the only
          thing anchoring the center of the frame. Chrome, so `Shift+H` clears
          it — the labels above are content and stay. */}
      {!chromeHidden && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="size-1.5 rounded-full border border-sky-300/40" />
        </div>
      )}

      {notice !== null && !chromeHidden && (
        <p
          className={`pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 rounded border bg-slate-950/85 px-3 py-1 type-readout backdrop-blur ${
            notice.tone === 'error'
              ? 'border-rose-500/40 text-rose-200'
              : 'border-sky-500/40 text-sky-200'
          }`}
        >
          {notice.text}
        </p>
      )}

      {/* Two panes, the floating panels, and the menu that says what is in
          them — the same component every other mode renders, given this mode's
          own panels plus the author's instruments. */}
      <Workspace
        id="planetarium"
        title="Planetarium"
        panels={panels}
        dev={dev}
      />
    </div>
  )
}
