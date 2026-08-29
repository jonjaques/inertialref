import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { HarnessStatus, ObserverStatus } from '@inertialref/devtools'
import type { Playhead } from '../cinema/session.ts'

/*
 * The seam between the engine and React.
 *
 * The engine is the only source of truth and nothing here changes that —
 * AGENTS.md's rule is that canonical state never lives in a component, and a
 * store that *held* the world would be the same violation wearing a library.
 * What this holds is the most recent **snapshot**: an immutable description the
 * engine already knows how to produce, republished at a rate a human can read.
 *
 * Two things it buys that `useState` in `App` did not:
 *
 *   1. **Panels can subscribe instead of being handed props.** `useStore`
 *      is `useSyncExternalStore` with a selector, so a component that reads the
 *      tick re-renders when the tick changes and not when the frame graph does.
 *      Today every panel re-renders eight times a second because `App` holds
 *      the whole status and passes it down; that is the thing this exists to
 *      let the panels stop doing.
 *   2. **React Compiler stops being a hazard.** The compiler assumes what a
 *      component derives is a pure function of its inputs, which is false for a
 *      component reading mutable engine fields — hence `'use no memo'` in
 *      `PerfPanel`. A snapshot read through a selector is a genuinely new value
 *      each time it differs, so the assumption holds and the opt-out is not
 *      needed. Do not read this as license to point panels at live engine
 *      fields; it is the argument for pointing them here instead.
 *
 * zustand rather than a hand-rolled `useSyncExternalStore`: the selector
 * subscription, the equality bail-out and `useShallow` are the whole feature,
 * they are three files of subtle code to get right, and the tearing rules
 * around concurrent React are not a thing to re-derive. The store is created by
 * a factory so a test can have its own; the module singleton below is what the
 * app uses, alongside the engine singleton in `App.tsx`, for the same reason.
 */

/** The presentation switches, as a panel reads them. */
export interface PresentationSnapshot {
  readonly showShip: boolean
  readonly showOrbits: boolean
  /** How much of the lens's artifact stack is showing, 0..1. */
  readonly flareArtifacts: number
  /** Whether the interface is in the frame at all. False is the plate state. */
  readonly chrome: boolean
}

/**
 * Everything the overlay reads about the engine, as one immutable value.
 *
 * Wider than it was, and that is the point: this module's header has always
 * said panels should subscribe instead of being handed props, and for a while
 * nothing did, because the snapshot carried two fields and every panel needed a
 * third. Meanwhile the engine was read by four other mechanisms at four rates —
 * an 8 Hz sampler, `usePolled` at 6/4/3 Hz, bare `setInterval`s at 100 ms and
 * 250 ms, and raw animation-frame loops — seven files each owning a timer over
 * the same singleton, and two of them disagreeing about `showShip` the moment
 * either acted. `usePolled` is gone; what is left is two polls that are not
 * field reads at all — the travel survey (a star sweep, `hud/useTravelTargets.ts`)
 * and the sky labels' projection (geometry over the camera).
 *
 * **Read it through a narrow selector.** `status` is a fresh object graph every
 * sample and never bails out of a re-render, so `useEngine((s) => s.status)`
 * re-renders at the full sample rate by construction. A selector returning a
 * primitive or a stable slice bails out with `Object.is`; several fields want
 * `useShallow`. A wide snapshot read widely is worse than the props it replaced.
 */
export interface EngineSnapshot {
  /** `null` until the first sample lands, which is one interval after mount. */
  readonly status: HarnessStatus | null
  /** Whether a cutscene is running. Chrome unmounts while it is. */
  readonly cinema: boolean
  /** What the planetarium's camera is on. `null` when it is on nothing. */
  readonly observer: ObserverStatus | null
  /** What the engine is drawing, so a panel's toggle reads the engine's answer
   *  rather than its own memory of what it asked for. */
  readonly presentation: PresentationSnapshot
  /** The cutscene playhead. `null` when no scene is open. */
  readonly playhead: Playhead | null
}

/**
 * What the sampler needs from the engine, and nothing more.
 *
 * A port rather than an import of `GameEngine` — the pattern
 * `packages/workers/src/transport.ts` uses — so the test below drives this with
 * eight lines of fake instead of building a world, and so this module cannot
 * grow a dependency on the renderer by accident.
 */
export interface EngineSource {
  readonly harness: {
    status(): HarnessStatus
    observerStatus(): ObserverStatus | null
  }
  readonly cinematic: object | null
  readonly showShip: boolean
  readonly showOrbits: boolean
  readonly flareArtifacts: number
  readonly chrome: boolean
  /**
   * The cutscene session's tick.
   *
   * Published through this snapshot rather than through a timer of its own,
   * which is what makes the playhead cost nothing: three components used to
   * poll the director at three rates to answer the same question.
   */
  readonly cutscene: { sample(): Playhead | null }
}

const NOTHING_DRAWN: PresentationSnapshot = {
  showShip: false,
  showOrbits: false,
  flareArtifacts: 0,
  // True before the first sample, because the interface has to be on screen
  // while the engine is still starting: the boot cover is chrome, and a shell
  // that opened with everything hidden would be a blank page with no way in.
  chrome: true,
}

const IDLE: EngineSnapshot = {
  status: null,
  cinema: false,
  observer: null,
  presentation: NOTHING_DRAWN,
  playhead: null,
}

export type EngineStore = StoreApi<EngineSnapshot>

export function createEngineStore(): EngineStore {
  return createStore<EngineSnapshot>(() => IDLE)
}

/** Republish the engine's current description. The only writer. */
export function sampleOnce(store: EngineStore, source: EngineSource): void {
  store.setState({
    status: source.harness.status(),
    cinema: source.cinematic !== null,
    observer: source.harness.observerStatus(),
    presentation: {
      showShip: source.showShip,
      showOrbits: source.showOrbits,
      flareArtifacts: source.flareArtifacts,
      chrome: source.chrome,
    },
    playhead: source.cutscene.sample(),
  })
}

/**
 * Poll the engine at `hz` and publish each sample. Returns the stop function.
 *
 * The simulation runs at 64 Hz and a human reads about 8, so this is a
 * deliberate downsample rather than a subscription: `status()` walks the world
 * and allocates, and doing that per tick to feed an overlay would cost more
 * than the overlay.
 *
 * It samples once before starting the interval. Without that the first paint
 * after a mount is always the empty snapshot — an interval's worth of
 * `starting…` on a page that has been running for minutes, which is what a
 * remount during a cutscene skip looks like.
 */
export function startEngineSampler(
  store: EngineStore,
  source: EngineSource,
  hz: number,
): () => void {
  sampleOnce(store, source)
  const handle = setInterval(() => sampleOnce(store, source), 1000 / hz)
  return () => clearInterval(handle)
}

/** The app's store. One engine, one sampler, one store. */
export const engineStore = createEngineStore()

/**
 * Subscribe to a slice of the latest snapshot.
 *
 * The selector's return value is compared with `Object.is`, so a scalar or a
 * stable reference bails out of the re-render and a freshly built object never
 * does — and `harness.status()` allocates a new object graph every sample, so
 * `useEngine((s) => s.status)` re-renders at the full sample rate by
 * construction. That is correct for a component that reads most of it and
 * wrong for one that reads two fields; the fix for the second is a selector
 * that returns the two fields, wrapped in `useShallow`.
 */
export function useEngine<T>(select: (snapshot: EngineSnapshot) => T): T {
  return useStore(engineStore, select)
}

export { useShallow } from 'zustand/react/shallow'
