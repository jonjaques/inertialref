import type { PassReport } from './passReport.ts'
import type { PictureReport } from './pictureReport.ts'
import type { World } from '@inertialref/simulation'
import type { EntityId } from '@inertialref/universe'
import {
  type Lens,
  LENS_PRESETS,
  type LensView,
  type RenderScene,
} from '@inertialref/rendering'
import type {
  HeightfieldCacheStats,
  HeightfieldStoreStats,
  WorkerPool,
} from '@inertialref/workers'
import type { AuthorityPort } from '@inertialref/net'
import type { GuideRefusal } from '@inertialref/protocol'
import {
  captureCameraProcessing,
  DEFAULT_PICTURE_PROCESSING,
  type PictureProcessing,
} from './pictureProcessing.ts'
import type { TerrainReport } from './descent.ts'
import type { GalaxyRenderReport } from './galaxy.ts'
import type { TimingPort } from './profile.ts'

/*
 * The port the harness is built over.
 *
 * `Host` is the simulation side and `RenderHost` the render side, and every
 * collaborator the harness composes — the observatory, the maneuvers, the
 * walker, the director, the flight camera, the dossier — takes one of them
 * rather than the harness. Declared here rather than beside the class that
 * composes them, so a collaborator names its own port without importing the
 * thing it is composed into. `openSession` is the one implementation of
 * `Host`; `renderHost()` is the render side of every host that draws nothing.
 */

/** Frame timing from a render loop, defined once for every reader. */
export interface FrameStats {
  readonly fps: number
  readonly frameMs: number
  readonly ticksLastFrame: number
}

/**
 * What the guide is doing, as one code a script can compare against. Each
 * names one thing: the panel's status line is derived from these, so a change
 * to its wording does not change what a script reads.
 */
export type GuideState =
  /** No guide in this mode: there is a guide only in the Planetarium. */
  | 'absent'
  /** Offline, by the mode's verdict: still asking, refused with its reason, or ready. */
  | 'checking'
  | GuideRefusal
  | 'idle'
  /** A session, from the offer to the close. */
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'searching'
  | 'moving'
  /** The visitor took the camera and the guide has not acted since. */
  | 'visitor-camera'
  | 'paused'
  | 'ending'

/** Conversation diagnostics exclude transcript and provider credentials. */
export interface GuideStatus {
  readonly available: boolean
  readonly loaded: boolean
  readonly state: GuideState
  readonly connection: 'offline' | 'connecting' | 'connected' | 'closing'
  readonly sessionId: string | null
  readonly viewRevision: number | null
  readonly microphone: 'off' | 'muted' | 'active'
  readonly paused: boolean
  /** Function calls received and not yet answered. */
  readonly pendingCalls: number
  /** Backend responses whose chain has not ended without a tool call. */
  readonly inFlight: boolean
  /** Whether the level the beat clock reads is a measurement; `ok` is the only state a tour advances on. */
  readonly meter: GuideMeter
  readonly usage: GuideUsage
}

/**
 * The health of the meter on the guide's voice track. Silence decodes to
 * exact zero, so a meter that cannot measure reads exactly like a guide that
 * has finished speaking; the states name why it cannot.
 */
export type GuideMeter =
  /** The analyser is bound to a live track in a running audio context. */
  | 'ok'
  /** No remote track has been bound, or the analyser could not be made. */
  | 'unmeasured'
  /** The audio context is not running; the browser suspended it. */
  | 'suspended'
  /** The bound track has ended; the provider replaced it. */
  | 'ended'
  /** The voice has produced words for seconds while the meter read exact zero throughout. */
  | 'stuck'

/** What the session has cost so far, as the provider reports it. */
export interface GuideUsage {
  readonly voiceSeconds: number
  readonly responses: number
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
}

export interface GuideHostPort {
  status(): GuideStatus
  /** A typed request, queued as the visitor's own words. */
  ask(text: string): Promise<GuideStatus>
  trace?(enabled?: boolean): readonly GuideTraceEntry[]
}

/** Optional, in-memory data-channel traffic; never authentication traffic. */
export interface GuideTraceEntry {
  readonly sequence: number
  readonly at: number
  readonly direction: 'send' | 'receive' | 'note'
  readonly message: Readonly<Record<string, unknown>>
}

export const NO_GUIDE_USAGE: GuideUsage = Object.freeze({
  voiceSeconds: 0,
  responses: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
})

export const UNAVAILABLE_GUIDE: GuideStatus = Object.freeze({
  available: false,
  loaded: false,
  state: 'absent',
  connection: 'offline',
  sessionId: null,
  viewRevision: null,
  microphone: 'off',
  paused: false,
  pendingCalls: 0,
  inFlight: false,
  meter: 'unmeasured',
  usage: NO_GUIDE_USAGE,
})

/**
 * What the soundtrack is doing, as one code a script can compare against.
 * `absent` is a host with no soundtrack — the headless runner, a test.
 */
export type SoundtrackState =
  | 'absent'
  | 'off'
  | 'waiting'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'unavailable'

/** The soundtrack, as a driver reads it. Plain data, so it survives JSON. */
export interface SoundtrackStatus {
  readonly available: boolean
  readonly state: SoundtrackState
  readonly track: {
    readonly id: string
    readonly title: string
    readonly artist: string
    readonly category: string
  } | null
  /** Seconds into the current track, and its length. */
  readonly position: number
  readonly duration: number
  /** What plays next, by id, nearest first. */
  readonly upcoming: readonly string[]
  readonly crossfading: boolean
  /** Whether the game is holding the music down for a scene of its own. */
  readonly ducked: boolean
  /** The `AudioContext`'s own state, or `none` before the first gesture built one. */
  readonly context: string
  /** How many tracks are kept on this device. */
  readonly kept: number
  /** Why nothing is playing, when that is the state. */
  readonly reason: string | null
}

/** What a driver may ask of the soundtrack. */
export type SoundtrackVerb =
  'play' | 'pause' | 'next' | 'previous' | 'seek' | 'select' | 'cue' | 'card'

export interface SoundtrackHostPort {
  status(): SoundtrackStatus
  /** `seek` takes seconds, `select` a track id, `cue` a track id or a category. */
  command(verb: SoundtrackVerb, argument?: string | number): SoundtrackStatus
}

export const UNAVAILABLE_SOUNDTRACK: SoundtrackStatus = Object.freeze({
  available: false,
  state: 'absent',
  track: null,
  position: 0,
  duration: 0,
  upcoming: [],
  crossfading: false,
  ducked: false,
  context: 'none',
  kept: 0,
  reason: null,
})

export interface TerrainCacheReport {
  readonly available: boolean
  readonly activity: HeightfieldCacheStats | null
  readonly storage: HeightfieldStoreStats | null
}

/** `RenderHost.boot`: renderer absent, drawing under the cover, or up. */
export type BootPhase = 'booting' | 'drawing' | 'booted'

/**
 * The render side of a host: what a frame can answer, and what it can be told.
 *
 * One object rather than ten optional members on the host, because "absent
 * headlessly" is one fact about a host and not ten. A host that draws supplies
 * the whole thing; a host that does not — the headless runner, a test — gets
 * `renderHost()`, which answers every question the way a display-less runtime
 * honestly can: no scene, no frame, no timeline, the flight lens, a ratio of
 * one, and switches that move nothing. Because the default is an adapter and
 * not a set of `?.` calls, a test can supply the two members it is about and
 * no reader ever asks whether a member is there.
 */
export interface RenderHost {
  /** Discontinuous camera placement invalidates presentation history only. */
  declareCut(): void
  /** Inspect reconstruction or select a diagnostic view without persisting it. */
  picture(debugView?: string): PictureReport | null
  terrainCache(): Promise<TerrainCacheReport>
  clearTerrainCache(): Promise<void>
  /** The active mode supplies this lazy adapter; a headless host need not. */
  guide?(): GuideHostPort | null
  /** The soundtrack player, which only a browser host has. */
  soundtrack?(): SoundtrackHostPort | null
  scene(): RenderScene | null
  frameStats(): FrameStats | null
  /**
   * How far the presentation has come up: no renderer yet, a renderer
   * drawing under the boot cover, or the cover lifted. A host with nothing to
   * present — Node, the headless runner — is booted from the start.
   */
  boot(): BootPhase
  /**
   * What the terrain streamer is doing this frame.
   *
   * The one number in the terrain rig that cannot be derived: `simulateDescent`
   * says what the streamer *would* be asked for, and this says what it actually
   * has — how many patches are on screen, how deep the worker queue is, and
   * whether the cache is holding. The two disagreeing is the interesting case.
   */
  terrain(): TerrainReport | null
  /** The live volume, if a renderer is attached. */
  galaxyRender(): GalaxyRenderReport | null
  /**
   * The lens the picture is being taken with, and the pixels it lands on.
   *
   * A getter rather than a setter for the same reason `world` is: the engine
   * resolves the lens every frame under the pose's own precedence — a script's
   * lens, then the flight one — and a host that pushed a copy in here would
   * hold a second producer of it, which is the rule this phase exists to keep.
   * `ir.lens()` reads it to print the instrument; the terrain predicate reads it
   * to measure one. The observatory does not — it takes `framingLens()` below,
   * and the block there says why. Null headlessly, where there is no camera
   * and no display.
   */
  lensView(): LensView | null
  /**
   * The lens the framing solver uses: the flight one, never the composed one.
   *
   * Separate from `lensView` because the observatory is the one consumer that
   * must not see the cutscene arm. It produces a camera only when that arm is
   * null, so framing a target against a script's lens is the observatory
   * depending on the arm it is defined as the fallback for — and the standoff it
   * solves is *stored*, so the error outlives the cutscene that caused it.
   * Measured: `focus('s:SOL/b:2')` during `tng-intro` parks the camera 29.8 Mm
   * out against the 20.8 Mm the flight lens asks for, 43% too far, permanently.
   * The flight preset headlessly, where there is no camera panel.
   */
  framingLens(): Lens
  /**
   * Fit a lens, for the two verbs that solve one.
   *
   * `preset` and `rise` compose a picture whose lens is part of it — Earth is
   * 1.9° across from Luna and Mars is 42.39° from Phobos, so a rise that did
   * not fit its own lens would produce two very different frames under one
   * name. Not a second producer of the lens: `engine.lens` still resolves the
   * cutscene arm first and the flight lens second, and this writes the same
   * flight lens a panel's slider writes. A no-op headlessly, where there is no
   * camera to fit it to and the arithmetic is worth running anyway.
   */
  setFlightLens(lens: Lens): void
  /** The player's settings, independent of cinematic and instrument staging. */
  cameraProcessing(): PictureProcessing
  /** Restore processing through the same preference owner as the camera panel. */
  setCameraProcessing(processing: PictureProcessing): void
  /**
   * How many display pixels one CSS pixel is, on this host.
   *
   * The drag sensitivity needs both and they are not the same number.
   * `lensView().viewport` is *display* pixels with supersampling divided out
   * and the device ratio deliberately kept — the terrain predicate and the
   * circle of confusion are claims about physical pixels. A pointer delta is in
   * CSS pixels. On a 2× display the two differ by two, and a sensitivity that
   * conflated them moved the picture at half the rate of the hand. 1 headlessly,
   * which is also the honest answer for a display that has no ratio to report.
   */
  pixelRatio(): number
  /**
   * Put the interface in or out of the frame.
   *
   * A plate is defined as the frame taken with the chrome cleared, and a plate
   * has to be reproducible from a script — so the state `Shift+H` reaches has
   * to be reachable from here too. Headlessly there is no interface to clear.
   */
  setChrome(visible: boolean): void
  /**
   * Put the sky's own layers — names and traces — in or out of the frame.
   *
   * Separate from `setChrome` because they are different claims: chrome is the
   * interface and these are content, so `Shift+H` clears the first and leaves
   * the second. A plate wants both gone, because a thumbnail of a picture is a
   * thumbnail of what the camera does and the layers are the viewer's.
   */
  setLayers(visible: boolean): void
  /**
   * The performance timeline, when the host has one.
   *
   * Null rather than an empty port, because a host without one has a real
   * answer — "this runtime does not put entries anywhere" — and `ir.profile()`
   * says so instead of returning an empty report that reads like a fast session.
   */
  timing(): TimingPort | null
  /**
   * Submit `frames` frames through whatever presents one and time them across
   * a drained queue — milliseconds per frame.
   *
   * The one GPU figure this project trusts, and the reason it is a verb and not
   * a field: the queue drain is an `await` in the middle of a frame, which is
   * the stall being measured, so it cannot be sampled. Null where there is no
   * device to drain — the WebGL backend, and every headless host — so
   * `ir.gpu()` says so rather than printing a number about nothing.
   */
  measureGpu(frames?: number): Promise<number> | null
  /**
   * `measureGpu`'s frames with every pass timed and named. Null where there is
   * no device, the device has no `timestamp-query`, or no presenting chain is
   * mounted — `measureGpu` falls back to a bare render there, and this does
   * not time a path nothing presents.
   */
  measurePasses(frames?: number): Promise<PassReport> | null
}

/**
 * The render side of a host that has none, with whatever a caller does supply
 * laid over it — the second adapter of `RenderHost`, and the one every test
 * and the headless runner use.
 *
 * Member by member rather than a spread, because a caller's `undefined` would
 * otherwise win over the default and put a `?.` back into every reader.
 */
export function renderHost(overrides: Partial<RenderHost> = {}): RenderHost {
  let processing = captureCameraProcessing(DEFAULT_PICTURE_PROCESSING)
  return {
    declareCut: overrides.declareCut ?? (() => {}),
    picture: overrides.picture ?? (() => null),
    terrainCache:
      overrides.terrainCache ??
      (async () => ({ available: false, activity: null, storage: null })),
    clearTerrainCache: overrides.clearTerrainCache ?? (async () => {}),
    guide: overrides.guide ?? (() => null),
    soundtrack: overrides.soundtrack ?? (() => null),
    scene: overrides.scene ?? (() => null),
    frameStats: overrides.frameStats ?? (() => null),
    boot: overrides.boot ?? (() => 'booted'),
    galaxyRender: overrides.galaxyRender ?? (() => null),
    terrain: overrides.terrain ?? (() => null),
    lensView: overrides.lensView ?? (() => null),
    framingLens: overrides.framingLens ?? (() => LENS_PRESETS.flight),
    setFlightLens: overrides.setFlightLens ?? (() => {}),
    cameraProcessing: overrides.cameraProcessing ?? (() => processing),
    setCameraProcessing:
      overrides.setCameraProcessing ??
      ((next) => {
        processing = captureCameraProcessing(next)
      }),
    pixelRatio: overrides.pixelRatio ?? (() => 1),
    setChrome: overrides.setChrome ?? (() => {}),
    setLayers: overrides.setLayers ?? (() => {}),
    timing: overrides.timing ?? (() => null),
    measureGpu: overrides.measureGpu ?? (() => null),
    measurePasses: overrides.measurePasses ?? (() => null),
  }
}

/**
 * Which build a host runs, and which checkout serves it, as the host was told.
 *
 * The id is `BUILD_ID`, a commit and `-dirty` when the tree had edits. It
 * cannot tell two checkouts apart, because sibling worktrees cut from one
 * commit describe it alike, so a dev server also names the tree it serves.
 * Only a dev server: a shipped bundle must not carry a filesystem path, so a
 * production build's tree is null, and a rig reads that as "unchecked" rather
 * than as a mismatch. A host nothing built — the headless runner, a test —
 * names neither. Plain data, because it crosses to a driver as JSON.
 */
export interface BuildIdentity {
  readonly id: string | null
  readonly tree: string | null
}

/** The identity of a host that no build produced. */
export const UNBUILT: BuildIdentity = Object.freeze({ id: null, tree: null })

/**
 * What the harness is built over: the simulation, and the render side.
 *
 * `world` must be a *getter*, not a captured reference. Loading a save replaces
 * the world wholesale, and a host that copied the reference in at construction
 * leaves the harness — and therefore the debug overlay — reporting on the world
 * that was thrown away while the frame loop runs the new one. That split brain
 * looked exactly like "load silently does nothing" from the outside.
 * `openSession` is the one implementation; it gets this right once.
 */
export interface Host {
  readonly world: World
  /** The entity the camera follows. */
  player(): EntityId | null
  /** Transfer control without replacing the world or rebuilding its adapters. */
  controlPlayer(id: EntityId): void
  /**
   * The trusted host capability: whether this host's walkers may fly. Never
   * read off a save — a replaced world's walkers are given this one.
   */
  readonly canFly: boolean
  pool(): WorkerPool | null
  /** Replace the running world (used by load). */
  replaceWorld(world: World, player: EntityId | null): void
  /**
   * Whoever owns the part of the simulation this client does not.
   *
   * Always present: a solo player has a `LocalAuthority`, which is an
   * implementation rather than the absence of one, and `openSession` supplies
   * it when a caller does not.
   */
  authority(): AuthorityPort
  /**
   * The host's clock, for the things here that measure rather than simulate.
   *
   * Null where the host has none, and the terrain baseline then reports "not
   * timed" rather than reaching for `performance.now()` itself — which nothing
   * below `apps/` is allowed to do.
   */
  readonly now: (() => number) | null
  readonly render: RenderHost
  /** Which build this is and which tree serves it; `ir.build()` answers it. */
  readonly build: BuildIdentity
}
