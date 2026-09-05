import type { SensorDiagnostics } from '../render/sensor.ts'
import {
  DEFAULT_SENSOR_SETTINGS,
  naturalResponse,
  type SensorSettings,
  type Exposure,
} from '@inertialref/rendering'
import {
  getLogger,
  getTimer,
  LIGHT_YEAR,
  type Seconds,
} from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import {
  orientationToRenderSpace,
  type Quat,
  type RenderOrigin,
  toRenderSpace,
  UV,
  type UniverseVector,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  snapshot,
  type World,
  type WorldSnapshot,
} from '@inertialref/simulation'
import {
  type Body,
  type CatalogStar,
  cellKey,
  cellOf,
  type EntityId,
  findBody,
  parseAddress,
  type StarCatalog,
  type SystemId,
} from '@inertialref/universe'
import {
  buildScene,
  type CinematicEffects,
  type CinematicTextState,
  isUsableLens,
  type Lens,
  LENS_PRESETS,
  type LensView,
  lodThresholds,
  NO_EFFECTS,
  originForCamera,
  type RenderScene,
  verticalFovDegrees,
  type Viewport,
} from '@inertialref/rendering'
import {
  type HeightfieldSource,
  surveyRegionTask,
  type WorkerFactory,
  WorkerPool,
} from '@inertialref/workers'
import {
  type FrameStats,
  type GameHarness,
  openSession,
  type OrbitPath,
  orbitPaths,
  orbitScopeKey,
  type Session,
  visibleOrbits,
} from '@inertialref/devtools'
import { DEFAULT_SLOT, type SaveStore } from '@inertialref/persistence'
import type { RendererHandle } from '../render/createRenderer.ts'
import { canMeasureGpu, measureGpuFrameMs } from '../render/measure.ts'
import type { LoadedShip } from '../render/shipModels.ts'
import { createBrowserWorkerPort, poolSize } from './browserWorker.ts'
import type { Camera, Object3D } from 'three/webgpu'
import { FrameMetrics, usedHeapMb } from './frameMetrics.ts'
import {
  browserTimingPort,
  onTimingLevel,
  timingDetailed,
} from './browserTiming.ts'
import {
  ENGINE_LATE,
  ENGINE_PHASE,
  PhaseClock,
  TRACK_GROUP,
} from './frameTiming.ts'
import { DROPPED_FRAME_MS, ENGINE_BUDGET_MS } from './perfBudgets.ts'
import { IndexedDbSaveStore } from './indexedDbStore.ts'
import {
  createCutsceneSession,
  type CutsceneSession,
} from '../cinema/session.ts'
import {
  createPresentationStack,
  type StanceHandle,
  type OrbitScope,
  type PresentationStack,
} from './presentation.ts'
import {
  cellPixelsFor,
  DEFAULT_SURFACE_QUALITY,
  type SurfaceQuality,
} from '../render/quality.ts'
import { TerrainStreamer, type TerrainState } from './terrainStreamer.ts'
import type { TerrainReport } from '@inertialref/devtools'

/*
 * The engine.
 *
 * Owns the world, the worker pool, the render origin and the scene, and is
 * driven by one call per animation frame. React does not own any of this: the
 * components below read `engine.scene` and `engine.snapshot`, and the only
 * thing that ever writes canonical state is the fixed-step simulation.
 *
 * That split is what makes the frame loop honest. `frame(delta)` hands the
 * wall-clock delta to the clock, which decides how many fixed ticks to run;
 * everything after that is presentation.
 */

const log = getLogger('game.engine')

/*
 * The frame's two entries — `engine` and `frame` — and the eight phases that
 * tile the first of them.
 *
 * `timer` is constructed at module scope and `main.tsx` attaches the sink in
 * its own body — after every static import has been evaluated to completion —
 * so `on` has to be a getter over the live hub rather than a boolean captured
 * here. It is; see `packages/shared/src/timing.ts`.
 *
 * `ENGINE_PHASE` and `ENGINE_LATE` are frozen module constants chosen by one
 * comparison, rather than a detail built per frame: a track, a group and a
 * color are the same on every frame and only lateness varies. That keeps the
 * cheap level allocation-free at the sites that run sixty times a second, which
 * is the claim the whole flag rests on. `DROPPED_FRAME_MS` is the same number
 * the panel draws its warning line at — one definition of over-budget colors
 * the plot *and* the trace entry.
 */
const timer = getTimer('game.engine')

/**
 * The lens the game is flown behind — 18.84 mm on a 24 mm gauge, which is 65°.
 *
 * One definition: the `<Canvas>` starts from its angle, the camera panel's
 * reset returns to it, and `CameraRig` applies whatever the panel chose. A
 * `Lens` rather than a bare angle because an angle cannot carry an aperture, a
 * focus or an exposure, and the panel shows all three.
 */
export const DEFAULT_LENS: Lens = LENS_PRESETS.flight

/** The same lens as an angle, for the two places Three.js wants degrees. */
export const DEFAULT_FOV_DEG = verticalFovDegrees(DEFAULT_LENS)

const EMPTY_STAR_FIELD: StarField = {
  positions: [],
  names: [],
  colours: [],
  luminosities: [],
}

/** How far the player must move before the starfield is surveyed again. */
const STARFIELD_HYSTERESIS = 8 * LIGHT_YEAR

/**
 * A cutscene frame, converted to render space for the scene components.
 *
 * `texts` and `effects` pass through untouched — they are screen-space — and
 * `NO_EFFECTS` is re-exported beside this so the effects layer has a stable
 * "dormant" value to compare against rather than allocating one per frame.
 */
export interface CinematicView {
  readonly frame: number
  /** The shot's own lens. `engine.lens` resolves it against the flight one. */
  readonly lens: Lens
  readonly camera: { readonly position: Vec3; readonly orientation: Quat }
  readonly ship: {
    readonly position: Vec3
    readonly orientation: Quat
    readonly visible: boolean
  }
  readonly texts: readonly CinematicTextState[]
  readonly effects: CinematicEffects
}

/**
 * The observatory's eye, converted to render space.
 *
 * Narrower than `CinematicView` on purpose: an observer has no script, no
 * titles, no effects and no hero hull — it is a camera and nothing else, and
 * giving it the cinematic shape would invite scene code to read fields that
 * are permanently inert.
 */
export interface ObserverView {
  readonly camera: { readonly position: Vec3; readonly orientation: Quat }
}

export { NO_EFFECTS }
export type { CinematicEffects, CinematicTextState }

export interface StarField {
  readonly positions: readonly UniverseVector[]
  readonly names: readonly string[]
  /**
   * Linear sRGB per star, from the blackbody color of its temperature.
   *
   * Carried per star rather than picked in the shader because the temperature
   * comes from a published color index for the cataloged half of the sky and
   * from a mass for the rest, and neither is available to a vertex program.
   */
  readonly colours: readonly [number, number, number][]
  /**
   * Bolometric luminosity in solar units. The renderer turns this and the
   * distance into an apparent brightness; a star's size on screen is not a
   * constant.
   */
  readonly luminosities: readonly number[]
}

export interface GameEngineOptions {
  readonly seed?: string
  /** The star catalog this world is generated against. */
  readonly catalog?: StarCatalog
  /**
   * Where worker tasks run. Omit for the browser default; pass `null` to
   * generate on the main thread; pass an in-process factory to run the whole
   * engine under Node.
   */
  readonly workers?: WorkerFactory | null
  readonly store?: SaveStore
  readonly now?: () => number
}

/**
 * The engine is the *presentation* half of a session.
 *
 * It used to be the whole thing: the constructor built a `World`, an
 * `IndexedDbSaveStore`, a browser `WorkerPool` and a console log sink, then
 * spawned a ship and put it in orbit. Every one of those had a port underneath
 * it built precisely so it could be swapped — and none of them could be,
 * because the engine reached past its own seams to the concrete adapter. That
 * is why nothing under `apps/` had a test.
 *
 * `openSession` now owns assembly and the mutable (world, player) pair. What is
 * left here is what genuinely belongs to a rendering host: the frame loop, the
 * render origin, the scene, the terrain streamer and the starfield.
 */
export class GameEngine {
  readonly session: Session
  readonly harness: GameHarness
  /**
   * Watching a cutscene, as one object.
   *
   * Here rather than in a component because three of them used to poll the
   * director at three rates and each reach around it into
   * `world.clock.paused`. It publishes through the engine store's sampler, so
   * it costs no timer of its own; `cinema/session.ts` is the whole of it.
   */
  readonly cutscene: CutsceneSession
  /**
   * What is drawn, and who is allowed to say so.
   *
   * Modes push a stance on mount and release it on unmount; a panel's override
   * is another push. `engine/presentation.ts` carries why it is a stack rather
   * than a table, and what "restored by whoever lowered it" was costing before
   * anybody owned it.
   */
  readonly presentation: PresentationStack
  readonly saves: SaveStore
  /*
   * Private, because `terrain()` is what the host answers `ir.terrain()` with
   * and `terrainState()` is the renderer's way in. Nothing outside reaches for
   * the streamer itself.
   *
   * The name is the harness's: `ir.terrain()` asks the host what the streamer
   * holds, and the host cannot answer with the streamer object because that
   * carries `Float32Array`s and the harness returns JSON.
   */
  readonly #terrain: TerrainStreamer
  /** Rolling per-frame samples for the performance overlay. */
  readonly metrics = new FrameMetrics()

  /*
   * The scene and camera R3F built, for measurements that drive the renderer
   * directly rather than watch it.
   *
   * Held because `measureGpuFrameMs` submits its own frames and there is no
   * other way to reach them: R3F keeps its root state in a store keyed by the
   * canvas element and does not hand it out. `null` until `onCreated`.
   */
  view: { readonly scene: Object3D; readonly camera: Camera } | null = null

  /**
   * Whatever presents a frame — the sensor's chain, once `scene/Sensor.tsx`
   * has mounted, and null before.
   *
   * Beside `view` because it answers the same question for the measurement
   * rig: `measureGpu` submits frames through this when it is set and through
   * `renderer.render` on `view` when it is not, so the figure is about the path
   * the loop actually presents. The chain is the only writer; nothing reads it
   * per frame.
   */
  present: (() => void) | null = null

  /** Whether `measureGpu` has a frame to submit at all. */
  canDrawFrame(): boolean {
    return this.present !== null || this.view !== null
  }

  /**
   * Submit `frames` frames and time them across a drained queue, or null when
   * there is nothing to submit or no device to drain — see `measureGpuFrameMs`.
   */
  measureGpu(frames?: number): Promise<number> | null {
    const gl = this.gl
    if (gl === null || !canMeasureGpu(gl.renderer)) return null
    const present = this.present
    const view = this.view
    const draw =
      present ??
      (view === null ? null : () => gl.renderer.render(view.scene, view.camera))
    if (draw === null) return null
    return measureGpuFrameMs(gl.renderer, draw, frames)
  }

  origin: RenderOrigin | null = null
  snapshot: WorldSnapshot | null = null

  /*
   * Whether to draw the debug ship and the meter-scale reference props.
   *
   * Presentation only — nothing canonical moves — which is why it lives here
   * rather than in the harness: the headless runner has no ship to draw. It
   * exists for the camera bookmarks, where a gray cone parked dead center of
   * every composition defeats the point of composing.
   *
   * **Written by `presentation` and by the console, and by nothing else.** It
   * had three writers, one of them a panel, under a convention this file named
   * ("restored by whoever lowered it") and assigned to nobody — which is how
   * leaving the planetarium after arriving from the menu restored it to a value
   * it had never held. A mode that wants it hidden pushes a stance.
   */
  showShip = true

  /*
   * Presentation switches the dock's graphics and camera panels drive.
   *
   * Plain fields like `showShip`, and for the same reason: the frame loop
   * reads them every frame and must not touch React to do it. Each is bound
   * to the persisted preference that owns it by `state/engineKnobs.ts`, so
   * neither side needs the other to re-render. The lens is applied by
   * `CameraRig` rather than written to the camera here, because the camera
   * belongs to R3F and is replaced whenever the canvas remounts — a value
   * pushed at a camera object would be lost with it.
   */
  lensFlare = true

  /**
   * What the surface may be turned down to, bound to the persisted preference
   * by `state/engineKnobs.ts` exactly as `lensFlare` is, and reachable from a
   * driving script as `engine.surfaceQuality = {...}`. The streamer reads
   * the refinement threshold off it every step; the scene components read
   * the rest every frame and write uniforms only when a value moved.
   */
  surfaceQuality: SurfaceQuality = DEFAULT_SURFACE_QUALITY

  /**
   * The player's own lens — what the flight camera is looking through.
   *
   * Bound to the persisted preference by `state/engineKnobs.ts`, exactly as
   * `lensFlare` is. It is not `lens`: a script's lens outranks it, and the
   * resolution of that order is the getter below rather than a field anyone
   * can overwrite.
   *
   * **The setter declines a lens it cannot use and keeps the last good one**,
   * which is the guard the framing solver used to make on the angle it was
   * pushed. This is public on an object `App` hands to `window.engine`, so a
   * capture script computing a focal length from `Number(input)` reaches it
   * without a slider or a storage predicate in the way; `isUsableLens` carries
   * what a NaN costs, and the worst of it — a NaN standoff, stored — outlives
   * the assignment.
   */
  #flightLens: Lens = DEFAULT_LENS

  get flightLens(): Lens {
    return this.#flightLens
  }

  set flightLens(lens: Lens) {
    if (isUsableLens(lens)) this.#flightLens = lens
  }

  /**
   * The lens this frame is composed through.
   *
   * **One producer, under the pose's own precedence.** `AGENTS.md` forbids a
   * second producer of the camera and orders the arms *cutscene, then
   * observatory, then the ship*; the optics follow the same order through the
   * same code, because a picture composed through one lens and measured through
   * another is exactly the class of bug this phase exists to close. The
   * observatory has no lens of its own — it solves a standoff against whatever
   * the camera panel is set to, which is the flight lens — so the order has two
   * arms rather than three.
   *
   * A getter rather than a field: `this.cinematic` is written once per frame by
   * `#step`, and a mirrored copy would be a second thing to keep in step.
   */
  get lens(): Lens {
    return this.cinematic?.lens ?? this.#flightLens
  }

  /**
   * Where a lens the engine did not choose goes.
   *
   * Installed by `state/engineKnobs.ts`, because the persisted preference
   * *owns* the lens: it is what a reload restores and what the panel's sliders
   * show, so a lens a verb fitted has to reach it or the picture on screen and
   * the picture the panel describes part company at the next slider move.
   *
   * Null headlessly, where there is no preference and no panel, and the field
   * is the whole of the truth.
   */
  onLensRequest: ((lens: Lens) => void) | null = null

  /**
   * Fit a lens, through whoever owns it — and **both** writes are required.
   *
   * The field first, because it is what `framingLens()` answers *this instant*
   * and `ir.preset` composes on the very next line: a `fill` standoff is solved
   * against the lens, so a fit that only queued the owner's write would compose
   * against the lens from a moment ago. Measured: `the-rings` landed at 2.735
   * radii instead of 2.249, which is the 65° answer wearing an 80° label.
   *
   * Then the owner, so the preference the panel shows and a reload restores is
   * the lens on screen. The binding carries it back to this field, which is the
   * same value again.
   *
   * Declined at both boundaries, each by its own guard: a lens the field's
   * setter would refuse does not reach the owner either, or the preference
   * holds a NaN the next reload rejects while the picture keeps the last good
   * one; and a lens the owner refuses — outside the sliders' band, which a
   * capture script may well ask for — stays on the field alone, because
   * `state/engineKnobs.ts` asks the owner only what it accepts.
   *
   * Not a second producer: `engine.lens` still resolves cutscene-then-flight,
   * and this writes the one flight lens a panel's slider also writes.
   */
  requestLens(lens: Lens): void {
    if (!isUsableLens(lens)) return
    this.#flightLens = lens
    this.onLensRequest?.(lens)
  }

  /**
   * The flight lens alone — what the observatory's framing solver reads.
   *
   * Separate from `lensView` because that one resolves cutscene-first, and the
   * observatory produces a camera only when the cutscene arm is null. See
   * `Observatory.#lens` for the standoff error the composed lens would cause.
   */
  framingLens(): Lens {
    return this.#flightLens
  }

  /**
   * The lens and the pixels it lands on, for anything that needs both.
   *
   * `null` until the scene has reported a drawing buffer, which is the honest
   * answer before the first frame: a circle of confusion is a claim about a
   * display, and there is no display yet.
   */
  lensView(): LensView | null {
    const viewport = this.#viewport
    return viewport === null ? null : { lens: this.lens, viewport }
  }

  /**
   * How much bigger the drawing buffer is than the display, per axis.
   *
   * 2 at 4× AA, 1 otherwise, bound to the anti-aliasing preference by
   * `state/engineKnobs.ts` beside `lensFlare`.
   * Supersampling raises the sample count, not the detail a viewer can
   * resolve — so feeding the raw buffer height into the terrain predicate asks
   * for 6.5× the patches to draw geometry the resolve filter averages away.
   * The place to spend on sharper terrain is `cellPixels`.
   */
  supersample = 1

  /**
   * How many *display* pixels one CSS pixel is, written by the shell.
   *
   * Named for what it holds rather than for the port that reads it: the
   * session's render side answers `pixelRatio()` from this field.
   *
   * The companion to `supersample` and a different number: that one is the
   * factor the buffer is inflated by for anti-aliasing and is divided back out,
   * this one is the device ratio and is deliberately kept — the terrain
   * predicate and the circle of confusion are claims about physical pixels.
   *
   * What needs it is the pointer. A drag delta arrives in CSS pixels, and a
   * sensitivity solved from `pixelAngle` alone is per display pixel: on a 2×
   * display it moves the picture at half the rate of the hand, and on a phone,
   * which is the case free look exists for, at two thirds.
   */
  displayRatio = 1

  #viewport: Viewport | null = null

  /**
   * The drawing buffer's size, from the scene, in buffer pixels.
   *
   * Divided back down to display pixels here rather than at the call site,
   * because the scene knows the buffer and the engine knows what made it that
   * size. A two-times *display* genuinely wants twice the patches for the same
   * picture and keeps them; a two-times *supersample* does not.
   */
  set viewportPixels(size: { width: number; height: number }) {
    // Written every frame by the scene, so unchanged inputs return before
    // allocating — otherwise a fresh viewport object churns per frame for a
    // value that moves only on a resize.
    const factor = Math.max(1, this.supersample)
    const width = Math.max(1, Math.round(size.width / factor))
    const height = Math.max(1, Math.round(size.height / factor))
    const held = this.#viewport
    if (held !== null && held.width === width && held.height === height) return
    this.#viewport = { width, height }
  }

  /*
   * How much of the lens's artifact stack is showing, 0..1 — the ghost chain,
   * not the glow and the streak, which are always the whole point.
   *
   * A field rather than a constant in `SunFlare` because it is a *composition*
   * decision and the two producers of a camera disagree about it. A flight
   * camera is 1: `docs/design/art.md` § the lens is explicit that the camera
   * admits it is a camera. A scripted shot runs near 0 (`SunFlare` floors the
   * cinematic case). The menu is the third case and the reason this exists —
   * the ghosts march along the line from the star through frame center, so a
   * sun on the right of the poster puts a red aperture ring squarely over the
   * paragraph on the left. That is a lens artifact landing on type, which is
   * the one place it is never a photograph.
   *
   * Pushed and released like `showShip`, through `presentation`.
   */
  flareArtifacts = 1

  sensorSettings: SensorSettings = DEFAULT_SENSOR_SETTINGS
  exposure: Exposure | null = null
  sensorDiagnostics: SensorDiagnostics | null = null

  get calibratedLight(): boolean {
    return (
      naturalResponse(this.sensorSettings) ||
      (this.cinematic?.effects.calibratedLight ?? 0) > 0
    )
  }

  /**
   * Whether the interface is in the frame.
   *
   * A plain field written by the presentation stack beside `showShip`, so the
   * sampler publishes it and every piece of chrome reads one answer. `Shift+H`,
   * `ir.chrome(false)` and a capture script all reach it through `setChrome`.
   */
  chrome = true

  /** Names on the sky. A stance field, so a capture can push it off. */
  labels = true

  /**
   * The layer stance a capture holds, while it holds one.
   *
   * Names and traces together, because they are one question to the thing that
   * asks it: a plate shows what the preset does, and both of these are drawn
   * over whatever it does.
   */
  #layerStance: StanceHandle | null = null

  setLayers(visible: boolean): void {
    if (visible) {
      this.#layerStance?.release()
      this.#layerStance = null
      return
    }
    this.#layerStance ??= this.presentation.push({
      labels: false,
      showOrbits: false,
    })
  }

  /*
   * The host's renderer, once it has one. `null` under Node, and for as long as
   * the capability probe is still running.
   *
   * Here rather than only in React state because a renderer you cannot reach
   * from the console is a renderer you cannot debug: `engine.gl.description`
   * answers "am I actually on WebGPU", `engine.gl.tone.shoulder.value = 0.6`
   * retunes the highlight roll-off without a reload, and `engine.gl.renderer.info`
   * is the draw-call count. The dock reads the same object, so what is displayed
   * and what is inspected cannot disagree.
   */
  gl: RendererHandle | null = null

  /*
   * The modeled hull the player is flying, once its glTF resolves.
   *
   * Three scene components need it every frame — `ShipModel` mounts it,
   * `CameraRig` scales the chase distance from its length, `NearFieldProps`
   * steps aside from its beam — and it changes exactly once per session. On
   * the engine rather than in module state in `SceneView`, because Vite
   * re-evaluates an edited render module while Fast Refresh preserves the
   * mounted components' hook state: a module-level copy resets to null mid-
   * session and the chase camera snaps back to the 6 m framing, inside the
   * saucer. The engine is the one singleton every HMR generation shares.
   * Null means the debug cone is standing in.
   */
  hull: LoadedShip | null = null

  /*
   * The frame's cinematic state, in render space, when a cutscene is playing.
   *
   * The director (in devtools) speaks universe coordinates; this is its output
   * converted through the frame's origin, ready for the scene components to
   * copy onto objects. On the engine rather than in any module for the same
   * reason `hull` is: `CameraRig`, `ShipModel`, the effects layer and the DOM
   * overlay all read it every frame, and module state in an edited render file
   * silently resets under Fast Refresh. `null` means no cutscene — the whole
   * system dormant, which is the normal state of the game.
   */
  cinematic: CinematicView | null = null

  /*
   * The planetarium's camera, in render space, when the observatory has a
   * target — the second producer of a presentation eye.
   *
   * Structurally identical to `cinematic` and here for the same reasons: the
   * scene components read it every frame, and module state in an edited render
   * file resets under Fast Refresh. `null` means the camera belongs to the
   * ship, which is the flight modes' normal state.
   *
   * The precedence in `#step` is cutscene, then observatory, then ship, and it
   * is that way round because a scripted scene is the one thing that is
   * allowed to take the camera away from whatever is holding it — that is what
   * makes `ir.play()` work from inside the planetarium.
   */
  observer: ObserverView | null = null

  /*
   * Whether to trace each body's orbit, and the traces themselves.
   *
   * Presentation, like `showShip`, and rebuilt rather than sampled: a trace is
   * a period of Kepler solves per body — a few milliseconds for a system — and
   * doing that per frame would be a visible hitch at every time warp. What
   * makes rebuilding rare enough is that a trace's *shape* is fixed in its
   * primary's frame; only the anchor moves, and the scene component re-hangs
   * the curve on the primary's current position for one vector add per point.
   * See `orbitPaths.ts`, which carries the anchor for exactly this.
   */
  showOrbits = false
  /** Whether a trace is drawn for everything, or only for the subject's context. */
  orbitScope: OrbitScope = 'context'
  orbits: readonly OrbitPath[] = []
  #orbitsWorld = -1
  #orbitsSystems = ''
  /*
   * Every trace the loaded systems have, before the scope filter.
   *
   * Cached separately because the two halves of a rebuild are invalidated by
   * different things and only one of them is expensive. Sampling is Kepler's
   * equation ~97 times for every body in every loaded system — 18.4 ms on a
   * Sol retarget, 22.2 ms on a Proxima one, on the exact interaction the mode
   * exists for — and it depends on nothing but the systems. Filtering is a
   * predicate over ~130 paths and depends on the focus, which is what a
   * retarget changes. Keyed together, every focus change re-solved every
   * orbit.
   *
   * The anchor is what makes the split legal: a path carries the instant it
   * was built against and `OrbitTraces` differences the primary's live pose
   * against it, so an old path follows a moving primary exactly. The one thing
   * that does age is the *phase* — the sweep starts at the body's own
   * eccentric anomaly, so where the closed curve's two ends meet drifts away
   * from the body. It was already ageing between rebuilds, and a full ellipse
   * looks the same wherever it is cut.
   */
  #orbitsAll: readonly OrbitPath[] = []
  #orbitsAllKey = ''

  /**
   * URL of an audio track the cutscene overlay should sync to the playhead.
   *
   * The reference edit is timed against a piece of music this repository does
   * not carry; `scripts/media.mjs` pulls it out of the site's R2 bucket at
   * build time into `apps/game/public/media/`, and `hud/CutsceneOverlay.tsx`
   * probes for it and adopts it when it is there. Set from the console
   * (`engine.cutsceneAudio = '/media/other.m4a'` after dropping a local file
   * into `apps/game/public/media/`) and the overlay keeps the element within a
   * lip-sync tolerance of the reference clock.
   */
  cutsceneAudio: string | null = null

  /**
   * The frame's phase sequence, one instance for the life of the engine.
   *
   * A field rather than a local, so the boundary survives from `open` to the
   * last `step` without being threaded through nine call sites — and so the
   * allocation happens once rather than sixty times a second.
   */
  readonly #phases = new PhaseClock('game.engine')

  /**
   * When the previous animation frame began, so a `frame` entry can cover the
   * interval between them rather than the engine's share of one.
   *
   * `null` until the first frame has been drawn. Written unconditionally, even
   * while the level is `off`, so that turning it on mid-session cannot emit a
   * first bar reaching back to whenever it was last on.
   */
  #lastFrameStart: number | null = null

  #scene: RenderScene | null = null
  #frameMs = 16
  #fps = 60
  #ticksLastFrame = 0
  #starField: StarField = EMPTY_STAR_FIELD
  #starFieldCentre: UniverseVector | null = null
  #starFieldPending = false
  /*
   * Which world the in-flight survey belongs to. A survey is asynchronous and
   * the world can be replaced under it; without this, its result landed in the
   * new world's starfield — a save loaded in another system briefly wore the
   * old system's stars. Masked for as long as terrain tasks queued ahead of
   * the survey delayed it past every observer, and surfaced the moment the
   * streamer stopped requesting patches from orbit.
   */
  #starFieldWorld = 0

  constructor(options: GameEngineOptions = {}) {
    this.session = openSession({
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      // `undefined` means "the browser default"; `null` means "no pool at all".
      workers:
        options.workers === undefined
          ? () => createBrowserWorkerPort()
          : options.workers,
      poolSize: poolSize(),
      now: options.now ?? (() => performance.now()),
      store: options.store ?? new IndexedDbSaveStore(),
      // The one production adapter of the render side, whole.
      render: {
        scene: () => this.#scene,
        frameStats: () => this.frameStats(),
        terrain: () => this.terrain(),
        lensView: () => this.lensView(),
        framingLens: () => this.framingLens(),
        pixelRatio: () => this.displayRatio,
        setFlightLens: (lens) => this.requestLens(lens),
        timing: () => browserTimingPort,
        setChrome: (visible) => this.setChrome(visible),
        setLayers: (visible) => this.setLayers(visible),
        measureGpu: (frames) => this.measureGpu(frames),
      },
      onWorldReplaced: () => this.#invalidateDerived(),
    })
    this.harness = this.session.harness
    this.cutscene = createCutsceneSession({
      status: () => this.harness.cutsceneStatus(),
      outcome: () => this.harness.cutsceneOutcome(),
      // The one reader of this field on the presentation side. It used to have
      // three, in three components, answering the same question.
      paused: () => this.world.clock.paused,
      play: (id) => this.harness.play(id),
      seek: (frame) => void this.harness.seekCutscene(frame),
      pause: () => this.harness.pause(),
      resume: () => this.harness.resume(),
      stop: () => this.harness.stopCutscene(),
    })
    this.presentation = createPresentationStack((stance) => {
      this.showShip = stance.showShip
      this.showOrbits = stance.showOrbits
      this.labels = stance.labels
      this.orbitScope = stance.orbitScope
      this.flareArtifacts = stance.flareArtifacts
      this.chrome = stance.chrome
      // The observatory's *lifetime*, not the camera: a layer that was holding
      // a target releases it on the way out, and the camera falls back to the
      // ship through the precedence in `#step` exactly as it always did.
      if (!stance.observatory) this.harness.observatory.clear()
    })
    this.saves = this.session.store
    this.#terrain = new TerrainStreamer(this.session.pool())
    /*
     * The level, forwarded across the worker boundary.
     *
     * A worker is a separate global scope with its own module registry, so it
     * cannot read `browserTiming.ts`'s level and has to be sent it. The engine
     * is the one thing that holds both the switch and the pool, and it fires
     * once on subscribe — the level is decided in `main.tsx` before any engine
     * exists, and a change-only subscription would leave a pool built after
     * `?timing=full` never hearing about it.
     */
    this.#releaseTiming = onTimingLevel((level) => {
      this.session.pool()?.setTimingLevel(level)
    })
    this.#start()
  }

  readonly #releaseTiming: () => void

  /** Live read, never a captured reference — loading a save replaces it. */
  get world(): World {
    return this.session.world
  }

  /**
   * The layer that holds the interface out of the frame, while there is one.
   *
   * A push rather than a field, because clearing the chrome is a viewer's
   * override on top of whatever the mode asked for — the same shape as the
   * ship toggle — and `release()` means "whatever was underneath" rather than
   * a literal `true` that a later mode might not have wanted.
   */
  #chromeStance: StanceHandle | null = null

  /**
   * Put the interface in or out of the frame.
   *
   * Here rather than in React state so that `Shift+H`, `ir.chrome(false)` and
   * a plate script all reach one switch. It is the state a plate is defined to
   * be taken in, and a plate has to be reproducible from a script.
   */
  setChrome(visible: boolean): void {
    if (visible) {
      this.#chromeStance?.release()
      this.#chromeStance = null
      return
    }
    this.#chromeStance ??= this.presentation.push({ chrome: false })
  }

  /* ----------------------------------------------------------------------- */
  /* The render side of the host                                             */
  /* ----------------------------------------------------------------------- */

  scene(): RenderScene | null {
    return this.#scene
  }

  frameStats(): FrameStats {
    return {
      fps: this.#fps,
      frameMs: this.#frameMs,
      ticksLastFrame: this.#ticksLastFrame,
    }
  }

  player(): EntityId | null {
    return this.session.player()
  }

  pool(): WorkerPool | null {
    return this.session.pool()
  }

  /**
   * Install the heightfield producer the renderer offers, or take it away.
   *
   * The GPU tile producer follows the renderer, which arrives after this
   * engine is built and is rebuilt when the HDR preference remounts the
   * canvas — so it is a setter rather than a constructor option, like `gl`.
   * `null` puts the pool back.
   */
  setHeightfieldSource(source: HeightfieldSource | null): void {
    this.#terrain.source = source
  }

  get starField(): StarField {
    return this.#starField
  }

  terrainState(): TerrainState {
    return this.#terrain.state()
  }

  /** Where a heightfield request goes this frame — the streamer's answer. */
  heightfieldSource(): HeightfieldSource | null {
    return this.#terrain.heightfields()
  }

  /**
   * The body at an address, out of the loaded world, or null.
   *
   * For a reader holding a `RenderBody` — the scene's description, which
   * carries the address and the appearance and not the surface — that needs
   * the body itself: the orbital bake wants `surface`, and the scene is
   * right not to carry a surface grammar per drawn body per frame.
   */
  bodyFor(address: string): Body | null {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body') return null
    return findBody(this.world.loadSystem(parsed.system), parsed.body) ?? null
  }

  /**
   * What the streamer holds this frame, as data the harness can return.
   *
   * The triangle count is summed from the drawn set rather than multiplied out
   * from a constant. A patch is 64² quads and its resolution is a parameter, so
   * a figure that quoted 8,192 would be the one number in the terrain baseline
   * nobody re-measured.
   */
  terrain(): TerrainReport | null {
    const { bodyAddress, ...rest } = this.#terrain.summary()
    return { body: bodyAddress, ...rest }
  }

  /**
   * Everything derived from the world, dropped in one place.
   *
   * Called whenever the world is replaced. Splitting this across `replaceWorld`
   * and `load` is how the starfield came to survive a jump of four light years.
   */
  #invalidateDerived(): void {
    this.origin = null
    this.snapshot = null
    this.#scene = null
    this.#starField = EMPTY_STAR_FIELD
    this.#starFieldCentre = null
    this.#starFieldWorld += 1
    this.orbits = []
    this.#orbitsSystems = ''
    this.#orbitsAll = []
    this.#orbitsAllKey = ''
    this.#terrain.clear()
    log.info('world replaced, derived state dropped', {
      tick: this.world.clock.tick,
    })
  }

  /** Frame the opening shot. The ship itself is placed by `openSession`. */
  #start(): void {
    /*
     * Earth, three-quarter lit, from the `gibbous` bookmark — not the session's
     * default target in a 400 km sunward orbit, which opened on a flat
     * full-phase wall of Mercury. The first frame is the one place the game
     * chooses its own composition, and Earth is the one disk every player can
     * judge at a glance. The galaxy-relative form, because the address resolves
     * against whatever galaxy this seed named; Sol itself is in every world —
     * it is home.
     */
    this.harness.shot('gibbous', 's:SOL/b:2')
    log.info('universe ready', {
      seed: this.world.seedText,
      seedHex: formatSeed(this.world.rootSeed),
      system: this.session.system.name,
      opening: 'Earth · gibbous',
    })
  }

  /**
   * One animation frame.
   *
   * `delta` is wall-clock seconds. It reaches the clock and nothing else — the
   * simulation is stepped a whole number of fixed ticks, and the leftover is
   * the interpolation alpha for presentation.
   */
  frame(delta: Seconds): void {
    const started = performance.now()
    this.#step(delta, started)
    const elapsed = performance.now() - started

    this.#frameMs = this.#frameMs * 0.9 + elapsed * 0.1
    this.#fps = delta > 0 ? this.#fps * 0.9 + (1 / delta) * 0.1 : this.#fps

    /*
     * Sampled out here rather than at the end of `#step`, because `#step`
     * returns early on a frame with no player and those are exactly the frames
     * worth seeing on a plot — a gap in the trace during a load is information,
     * and a plot that quietly omits them shows a frame rate the session never
     * had.
     *
     * `renderer.info` is last frame's, because this runs before the draw. That
     * is the correct pairing anyway: the draw call count belongs to the scene
     * that produced it, not the one being built now.
     *
     * Nothing here allocates. `clock.achievedTimeScale` and `pool.queued` exist
     * as getters precisely so this loop does not build two throwaway objects a
     * frame to read two numbers off them.
     */
    const render = this.gl?.renderer.info.render
    this.metrics.sample({
      periodMs: delta * 1000,
      engineMs: elapsed,
      ticks: this.#ticksLastFrame,
      achievedTimeScale: this.world.clock.achievedTimeScale,
      drawCalls: render?.drawCalls ?? Number.NaN,
      triangles: render?.triangles ?? Number.NaN,
      queuedJobs: this.pool()?.queued ?? Number.NaN,
      heapMb: usedHeapMb(),
    })

    /*
     * Two entries, and which budget each is judged against is the whole point.
     *
     * `engine` is this method's own work — ticks, snapshot, scene build, terrain
     * reconciliation — and it is what `metrics.engineMs` plots against
     * `ENGINE_BUDGET_MS`. `frame` is the wall-clock interval between animation
     * frames, which is what `metrics.period` plots against `DROPPED_FRAME_MS`.
     *
     * They were one entry, named `frame`, covering the engine step and colored
     * against 25 ms — which is `perfBudgets.ts`'s constant for the *period*, and
     * that file's own comment warns that "coloring on the budget alone gets this
     * wrong in the most misleading direction". It did: a session whose engine ran
     * at 2 ms while the renderer took 28 reported "none over 25 ms", because the
     * only thing being compared to 25 was the half that was fine.
     *
     * **The period covers the frame that just ended, not the one starting now.**
     * `[#lastFrameStart, started]` is the interval every span from the previous
     * frame actually falls inside — its engine phases, and the ten `useFrame`
     * consumers that run *after* `frame` returns and would otherwise be outside
     * any frame at all. That containment is what lets `ir.profile` compute a
     * share of wall clock and name a Render span as the thing that dominated a
     * late frame. Skipped on the first frame, which has no previous.
     *
     * The counts ride on the period entry, which is where they belong: they are
     * last frame's draw, and last frame is what this bar covers. Built only at
     * `full` — `trace` has no properties channel, so formatting four integers
     * into strings sixty times a second would fill a table nothing renders.
     */
    if (timer.on) {
      timer.measure(
        'engine',
        started,
        started + elapsed,
        elapsed > ENGINE_BUDGET_MS ? ENGINE_LATE : ENGINE_PHASE,
      )
      const previous = this.#lastFrameStart
      if (previous !== null) {
        const late = started - previous > DROPPED_FRAME_MS
        timer.measure(
          'frame',
          previous,
          started,
          timingDetailed()
            ? {
                track: 'Engine',
                group: TRACK_GROUP,
                color: late ? 'error' : 'primary',
                properties: [
                  ['drawCalls', String(render?.drawCalls ?? 0)],
                  ['triangles', String(render?.triangles ?? 0)],
                  ['ticks', String(this.#ticksLastFrame)],
                  ['queued', String(this.pool()?.queued ?? 0)],
                ],
              }
            : late
              ? ENGINE_LATE
              : ENGINE_PHASE,
        )
      }
    }
    // Outside the `timer.on` branch: turning the level on mid-session must not
    // produce a first `frame` bar reaching back to whenever it was last off.
    this.#lastFrameStart = started

    // Now that the previous frame's counters have been recorded, clear them for
    // the draw that follows. `autoReset` is off for the reason given where it is
    // turned off; this is the other half of that decision.
    this.gl?.renderer.info.reset()
  }

  /**
   * The eight distinguishable things a frame does, which `engineMs` reports as
   * one number.
   *
   * `started` comes from `frame` rather than being read again here, so the
   * phases begin exactly where the frame does and the tiling has no gap at its
   * head. Every `#phases.step` closes the phase since the previous boundary and
   * opens the next one there — see `frameTiming.ts` for why one read per
   * boundary rather than a pair per span, which is a fact about the clock's
   * 100 µs resolution rather than a micro-optimization.
   *
   * The early returns below emit nothing further, and that is the honest
   * picture: a frame with no camera or no player did not do the work, and a gap
   * in the trace during a load is information.
   */
  #step(delta: Seconds, started: number): void {
    this.#phases.open(started)
    this.#ticksLastFrame = this.world.advance(delta)
    /*
     * The tick batch, never one entry per tick: 64 marks a second is the
     * instrumentation becoming the load.
     *
     * **The name is `advance` on every frame and the two counts ride in
     * `properties`,** which is the same trade `serveTasks` makes for a region
     * address and for the same three reasons: a label is the aggregation key in
     * `ir.profile`, a key in the sink's retained-name set, and the argument to
     * `clearMeasures`. `achievedTimeScale` is `timeScale × steps / wanted`, and
     * once the step budget caps — which is what the warp button is for — that
     * ratio is a different float every frame. Folding it in gives one bucket
     * per frame, a name set that grows at frame rate, and a flame chart in
     * which no two bars share a name, precisely in the mode where frames are
     * most likely to be late.
     *
     * Behind `timingDetailed()`, so the ternary evaluates to a frozen constant
     * at every level below `full` and this call site allocates nothing. It has
     * to be here rather than inside `step`: arguments are evaluated before the
     * call, so a string built for a `PhaseClock` that is closed is a string
     * built for nothing, sixty times a second, in the shipped build.
     */
    this.#phases.step(
      'advance',
      timingDetailed()
        ? {
            ...ENGINE_PHASE,
            properties: [
              ['ticks', String(this.#ticksLastFrame)],
              ['warp', this.world.clock.achievedTimeScale.toFixed(2)],
            ],
          }
        : ENGINE_PHASE,
    )

    const shot = snapshot(this.world)
    this.snapshot = shot
    this.#phases.step('snapshot', ENGINE_PHASE)

    /*
     * The cutscene director's per-frame ask, against `renderTime` so a paused
     * or stepped clock gives frame-exact stills. Everything downstream — the
     * origin, the scene build, terrain, the star survey — follows the
     * *cinematic* eye when there is one: the origin must stay within its
     * rebase window of wherever the camera actually is, and a scene built
     * around a ship an AU behind the shot would light and sort for nobody.
     *
     * **Above the missing-player returns below, and it has to be.** A cutscene
     * owns the camera precisely when the ship does not matter, so the cutscene
     * arm of the precedence order must not depend on the ship arm resolving.
     * With the sample underneath them, a single frame during a load or an
     * authority hand-off — `session.player()` null for one frame — meant the
     * director was never asked again: it kept `#active`, `this.cinematic` kept
     * its last non-null value for the rest of the session, `engineStore`
     * published `cinema: true` forever, and every piece of chrome unmounted,
     * including the control that stops it.
     */
    const cinematic = this.harness.cutsceneSample(shot.renderTime)
    this.#phases.step('cutscene', ENGINE_PHASE)
    /*
     * The observatory's eye, when a cutscene is not already holding the camera.
     *
     * `delta` rather than simulation time: the fly-to easing is a presentation
     * filter, and a planetarium in which pausing the clock also froze a
     * transition mid-flight would be a bug in every screenshot taken while
     * paused. It reads the lens off this engine when it needs one, so nothing
     * has to be pushed into it first.
     */
    const observed =
      cinematic === null ? this.harness.observerSample(delta) : null
    this.#phases.step('observatory', ENGINE_PHASE)

    // The one precedence order, unchanged: cutscene, then observatory, then
    // the ship. Only the *last* of the three needs a player.
    const player = this.session.player()
    const camera =
      player === null
        ? undefined
        : shot.entities.find((entity) => entity.id === player)

    const eye =
      cinematic?.camera.position ?? observed?.position ?? camera?.position
    if (eye === undefined) {
      // Nothing owns the camera this frame. Publishing the two presentation
      // eyes as null anyway is the point: a stale one held across a frame is
      // what latched the chrome off.
      this.cinematic = null
      this.observer = null
      return
    }

    this.origin = originForCamera(this.origin, eye)
    this.observer =
      observed === null || observed === undefined
        ? null
        : {
            camera: {
              position: toRenderSpace(this.origin, observed.position),
              orientation: orientationToRenderSpace(
                this.origin,
                observed.orientation,
              ),
            },
          }
    this.cinematic =
      cinematic === null
        ? null
        : {
            frame: cinematic.frame,
            lens: cinematic.lens,
            camera: {
              position: toRenderSpace(this.origin, cinematic.camera.position),
              orientation: orientationToRenderSpace(
                this.origin,
                cinematic.camera.orientation,
              ),
            },
            ship: {
              position: toRenderSpace(this.origin, cinematic.ship.position),
              orientation: orientationToRenderSpace(
                this.origin,
                cinematic.ship.orientation,
              ),
              visible: cinematic.ship.visible,
            },
            texts: cinematic.texts,
            effects: cinematic.effects,
          }

    /*
     * Everything above is camera; everything below needs the ship.
     *
     * `buildScene` is built *around* the player's entity, and terrain, the
     * star survey and the orbit traces all hang off the scene it produces —
     * so a frame without one leaves them as they were and takes the next
     * frame's. That was always the behavior; what changed is that the two
     * presentation eyes are published before it rather than after.
     */
    if (player === null || camera === undefined) return

    // The render-space transforms above belong to no phase — a handful of
    // quaternion multiplies — and charging them to whichever phase happens to
    // follow is a lie the tiling would make invisible.
    this.#phases.skip()

    /*
     * The lens reaches the scene as thresholds, so the tier a body draws at
     * follows the optics it is being looked at through — a telephoto resolves a
     * distant moon into a sphere at a distance a wide lens still draws as a
     * point. Only the point-to-billboard step moves; `lod.ts` says why the
     * other two do not.
     */
    const view = this.lensView()
    this.#scene = buildScene(
      shot,
      this.origin,
      player,
      cinematic !== null ? cinematic.camera : (observed ?? undefined),
      view === null ? undefined : lodThresholds(view.lens, view.viewport),
    )
    this.#phases.step('scene', ENGINE_PHASE)

    /*
     * `shot.renderTime`, not the clock: the snapshot presents the world one tick
     * in the past, and terrain that disagrees with the ship about what time it
     * is drifts from under it by 800 m at orbital speed.
     *
     * The whole `RenderBody` rather than its address, because a patch has to
     * ride the compression `placeAt` gave the body it sits on. Past
     * `NEAR_LIMIT` the sphere is drawn nearer and smaller so its angular size
     * survives, and terrain placed at true meters against it would be a
     * different object at a different distance.
     */
    // The lens the selection is made against, set beside the eye it is made
    // from. A per-frame presentation input and not the streamer's to decide,
    // and the *pair* rather than its halves — a lens measured over a viewport
    // it never landed on is a selection nobody can reproduce.
    this.#terrain.lensView = view
    this.#terrain.cellPixels = cellPixelsFor(this.surfaceQuality.terrain)
    this.#terrain.update(
      this.world,
      shot.renderTime,
      eye,
      this.origin,
      this.#scene.terrainCandidates[0] ?? null,
    )
    /*
     * One phase on the Engine track; the streamer's own five are on the Terrain
     * track inside it. Two tracks at two granularities is what tracks are for —
     * these tile the engine step and those tile this — and it is why a
     * share-of-frame sum is taken per track rather than across all of them.
     */
    this.#phases.step('terrain', ENGINE_PHASE)

    this.#maybeSurveyStars(eye)
    // A star sweep fires once per 8 ly of hysteresis, so it is rare and large —
    // exactly the shape a mean over 240 frames cannot show and a track can.
    this.#phases.step('survey', ENGINE_PHASE)

    this.#maybeTraceOrbits()
    this.#phases.step('orbits', ENGINE_PHASE)
  }

  /**
   * Keep the orbit traces in step with what is loaded.
   *
   * Rebuilt when the toggle turns on, when a save replaces the world, and when
   * the set of loaded systems changes — and at no other time. A timer would be
   * the obvious alternative and would be wrong twice: it rebuilds when nothing
   * has changed, and it does *not* rebuild at the moment a new system loads,
   * which is the one moment there is something new to draw.
   */
  #maybeTraceOrbits(): void {
    if (!this.showOrbits) {
      if (this.orbits.length > 0) this.orbits = []
      // Both keys, so "rebuilt when the toggle turns on" means the sampling
      // too. Clearing only the scope key leaves `#orbitsAllKey` matching, so
      // turning orbits back on after an hour of warp re-filters paths swept at
      // the anomaly the body had before it — invisible in a uniform-alpha
      // ellipse, and a claim the method's own docstring does not make.
      this.#orbitsSystems = ''
      this.#orbitsAllKey = ''
      return
    }
    const systems = this.world.loadedSystems()
    // Once. The scope key and the sampling key are both a function of it, and
    // two spellings of "the loaded set" is two things a reader has to check
    // are the same list.
    const systemIds = systems.map((system) => system.id)
    /*
     * Which traces are worth drawing depends on what is being looked at, so the
     * focused frame is part of the rebuild key.
     *
     * Everything at once is what the first version drew, and in a system viewed
     * from inside it is a dozen ellipses seen edge-on — a fan of near-straight
     * lines across the frame that says nothing about anything. A planetarium
     * shows the *context* of its subject: the orbits of its siblings, and the
     * orbits of the things going round it. That is two relationships, and both
     * are one field on the path.
     */
    const focus = this.harness.observatory.target?.frame ?? null
    /*
     * Which traces are context is `visibleOrbits`, and the key it is cached
     * against is `orbitScopeKey` — both in `packages/devtools/src/orbitPaths.ts`
     * and both tested there. The selection rule used to live in this method,
     * reachable only through the frame loop, so the one thing it does — turn a
     * hundred and twenty-nine lines into eight — had no test, and neither did
     * the key. Both failures are silent: a key that omitted the scope leaves the
     * View panel's switch looking dead until the reader navigates away and back.
     */
    const scope = {
      focus,
      // The frame the subject itself orbits, so its siblings can be recognized.
      grandparent:
        focus !== null && this.world.frames.has(focus)
          ? this.world.frames.get(focus).parent
          : null,
      subject: this.harness.observatory.target?.address ?? null,
      scope: this.orbitScope,
    }
    const key = orbitScopeKey(systemIds, scope)
    if (
      key === this.#orbitsSystems &&
      this.#orbitsWorld === this.#starFieldWorld
    )
      return
    this.#orbitsSystems = key
    this.#orbitsWorld = this.#starFieldWorld

    // The sampling half, keyed on what it actually reads. A retarget moves
    // `scope` and nothing here, so it re-filters instead of re-solving.
    const systemsKey = `${this.#starFieldWorld}|${systemIds.join(',')}`
    if (systemsKey !== this.#orbitsAllKey) {
      this.#orbitsAllKey = systemsKey
      this.#orbitsAll = systems.flatMap((system) =>
        orbitPaths(this.world, system),
      )
      log.info('orbit paths sampled', {
        paths: this.#orbitsAll.length,
        systems: systems.length,
      })
    }
    this.orbits = visibleOrbits(this.#orbitsAll, scope)
    log.info('orbit traces rebuilt', {
      paths: this.orbits.length,
      of: this.#orbitsAll.length,
      focus: focus ?? 'everything',
    })
  }

  /**
   * Keep a local starfield around the player.
   *
   * Re-surveyed only when the player has actually gone somewhere, because a
   * 40 ly sweep is tens of thousands of stars and belongs in a worker — which
   * is exactly where it goes.
   *
   * Two halves. The worker invents the procedural stars, which is the expensive
   * part; the cataloged ones are read straight out of the local index, which is
   * cheaper than serializing them across a thread boundary would be, and means
   * the real sky is on screen on the first frame after a jump even if the worker
   * pool is busy or absent.
   */
  #maybeSurveyStars(centre: UniverseVector): void {
    if (this.#starFieldPending) return
    const moved =
      this.#starFieldCentre === null ||
      UV.distance(this.#starFieldCentre, centre) > STARFIELD_HYSTERESIS
    if (!moved) return

    this.#starFieldCentre = centre
    this.#starFieldPending = true
    const world = this.#starFieldWorld
    const radiusCells = 2
    // `cellOf`, not a hand-inlined copy of it. The copy restated CELL_SIZE as
    // `20 * 9.4607304725808e15` and recomputed `approxMeters` three times, so
    // changing the galaxy's cell size would have left the client surveying
    // cells that no longer correspond to where the player is — a compile-clean
    // change that presents as "the stars are in the wrong place".
    const cell = cellOf(centre)
    const catalog = this.world.catalog

    // The worker has no catalog, so what it needs to know about one travels
    // with the request: how many stars are already in each cell, and the radius
    // inside which it should invent none. Only non-empty cells are listed.
    const catalogued: Record<string, number> = {}
    const catalogStars: CatalogStar[] = []
    for (let x = cell.x - radiusCells; x <= cell.x + radiusCells; x += 1)
      for (let y = cell.y - radiusCells; y <= cell.y + radiusCells; y += 1)
        for (let z = cell.z - radiusCells; z <= cell.z + radiusCells; z += 1) {
          const stars = catalog.inCell({ x, y, z })
          if (stars.length === 0) continue
          catalogued[cellKey({ x, y, z })] = stars.length
          catalogStars.push(...stars)
        }

    const payload = {
      seed: formatSeed(this.world.galaxySeed),
      min: {
        x: cell.x - radiusCells,
        y: cell.y - radiusCells,
        z: cell.z - radiusCells,
      },
      max: {
        x: cell.x + radiusCells,
        y: cell.y + radiusCells,
        z: cell.z + radiusCells,
      },
      catalogued,
      completeRadius: catalog.completeRadius,
    }

    // The cataloged half goes up *now*, not when the worker answers — that
    // is the header's promise about the real sky being on screen on the first
    // frame after a jump. Gated on the survey it waited behind a busy pool,
    // and a single failed survey dropped it entirely, with the hysteresis
    // then blocking any retry until the player had moved another 8 ly.
    {
      const positions: UniverseVector[] = []
      const names: string[] = []
      const colours: [number, number, number][] = []
      const luminosities: number[] = []
      for (const star of catalogStars) {
        positions.push(star.position)
        names.push(star.name)
        const c = star.physical.colour
        colours.push([c.r, c.g, c.b])
        luminosities.push(star.physical.solarLuminosities)
      }
      this.#starField = { positions, names, colours, luminosities }
    }

    const run =
      this.pool() === null
        ? Promise.resolve(
            surveyRegionTask.run(payload, { cancelled: () => false }),
          )
        : (this.pool() as WorkerPool).run(surveyRegionTask, payload)

    void Promise.resolve(run)
      .then((cells) => {
        // The world this survey was asked about is gone; let the next frame
        // start one against the world that replaced it.
        if (world !== this.#starFieldWorld) return
        /*
         * The expensive half, and it is not inside any frame.
         *
         * The `survey` phase in `#step` brackets the *dispatch* — building the
         * cataloged half and handing the region walk to the pool — and returns.
         * This runs in a microtask whenever the worker answers, outside
         * `frame()` entirely, and it allocates four arrays over every star in
         * an 8 ly sweep. Left uninstrumented it was main-thread work on no
         * track at all, which is the exact gap this whole phase exists to
         * close.
         *
         * A span rather than a `PhaseClock` step, because it is a one-off with
         * no neighbor to tile against. Opened after the stale-world return, so
         * an entry means the field was actually rebuilt.
         */
        const applying = timer.span('survey.apply', ENGINE_PHASE)
        const positions: UniverseVector[] = []
        const names: string[] = []
        const colours: [number, number, number][] = []
        const luminosities: number[] = []

        for (const star of catalogStars) {
          positions.push(star.position)
          names.push(star.name)
          const c = star.physical.colour
          colours.push([c.r, c.g, c.b])
          luminosities.push(star.physical.solarLuminosities)
        }
        for (const entry of cells) {
          for (const star of entry.stars) {
            const [sx, sy, sz, ox, oy, oz] = star.position
            positions.push(UV.universeVector(sx, sy, sz, ox, oy, oz))
            names.push(star.name)
            colours.push([...star.colour] as [number, number, number])
            luminosities.push(star.solarLuminosities)
          }
        }
        this.#starField = { positions, names, colours, luminosities }
        applying.end()
        log.info('starfield surveyed', {
          stars: positions.length,
          catalogued: catalogStars.length,
        })
      })
      .catch((cause: unknown) =>
        log.warn('starfield survey failed', { cause: String(cause) }),
      )
      .finally(() => {
        this.#starFieldPending = false
      })
  }

  /* --------------------------------------------------------------------- */
  /* Player commands                                                        */
  /* --------------------------------------------------------------------- */

  setControl(
    translation: [number, number, number],
    rotation: [number, number, number],
  ): void {
    const player = this.session.player()
    if (player === null) return
    this.world.setControl(player, vec3(...translation), vec3(...rotation))
  }

  toggleFlightAssist(): boolean {
    const player = this.session.player()
    if (player === null) return false
    return this.world.setFlightAssist(
      player,
      !this.world.entities.require(player).flightAssist,
    )
  }

  killRotation(): void {
    const player = this.session.player()
    if (player === null) return
    this.world.killRotation(player)
  }

  loadedSystemIds(): readonly SystemId[] {
    return this.world.loadedSystems().map((system) => system.id)
  }

  async save(slot: string = DEFAULT_SLOT): Promise<string> {
    const text = this.harness.save()
    await this.saves.write(slot, text)
    log.info('saved', { slot, bytes: text.length })
    return text
  }

  async load(slot: string = DEFAULT_SLOT): Promise<boolean> {
    const contents = await this.saves.read(slot)
    if (!contents.ok) {
      log.warn('load failed', { slot, error: contents.error })
      return false
    }
    const result = this.harness.load(contents.value)
    if (!result.ok) {
      log.warn('load failed', { slot, error: result.error })
      return false
    }
    // No `this.origin = null` here: `onWorldReplaced` already dropped every
    // piece of derived state, which is the point of having one hook.
    return true
  }

  dispose(): void {
    // Before the session, because releasing the subscription is what stops a
    // level change reaching a pool that is about to be terminated. `App.tsx`
    // holds the engine in a module `singleton ??=`, so StrictMode's second pass
    // returns the same instance and the browser never reaches here at all —
    // this is the tests' path, and the one a second host would take.
    this.#releaseTiming()
    // The ground before the session. A producer the host installed is the
    // host's to dispose, but the reference is this engine's, and so is the
    // window in flight on it: a job that lands after the pool is gone is an
    // answer into a cache nothing reads.
    this.#terrain.source = null
    this.#terrain.clear()
    this.session.dispose()
  }
}
