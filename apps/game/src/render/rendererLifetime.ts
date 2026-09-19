import type { Picture } from './picture.ts'
import type { WebGPURenderer } from 'three/webgpu'
import type { CanvasProps, RendererHandle } from './createRenderer.ts'
import type { OutputPreference } from './output.ts'
import type { TileProducer } from './terrainProducer.ts'
import type { WarmProducer } from './warmup.ts'

/*
 * One lifetime for the renderer and what rides on its device.
 *
 * The renderer factory owns the device, and `preload.ts` owns the warm-up.
 * Between them sits a sequence nobody owned: the GPU tile producer holds
 * buffers on the device, so it has to be retired *before* a rebuild's first
 * act destroys that device and *after* the warm-up has opened the census it
 * registers with; a compile that resolves after a rebuild has to install
 * nothing; a compile that fails has to give the producer back; and a terminal
 * failure has to do all of that and release the device. `App` carried every
 * step of it across a canvas factory and three effects, each with a comment
 * saying which other one it had to run before, and nothing could test the
 * ordering because the ordering was React's.
 *
 * Here the sequence is the module. The adapters are the mechanisms that
 * already exist — the factory, the warm-up, the census, the engine's
 * heightfield setter — handed in rather than imported, so every step is
 * assertable in Node against controlled promises, and `App` is left with the
 * callbacks it has to answer: a handle arrived, the scene is warm, something
 * failed.
 */

export interface RendererLifetimeOptions {
  /** Build a renderer on a canvas: `createRenderer`, whose queue and StrictMode dedupe stay its own. */
  readonly build: (
    preference: OutputPreference,
    picture: Picture,
    onReady: (handle: RendererHandle) => void,
  ) => (props: CanvasProps) => Promise<WebGPURenderer>
  /** Release the device: `releaseRenderer`. */
  readonly release: () => void
  /** Warm the scene against a build. Opens the census session the producer registers with. */
  readonly warm: (handle: RendererHandle) => Promise<void>
  /** Register with the open census: `warmAtMount`. */
  readonly register: (producer: WarmProducer) => void
  /** The ground producer for a build, or null when this build does not get one. */
  readonly produce: (handle: RendererHandle) => TileProducer | null
  /** Where a proven producer goes, and where `null` puts the pool back. */
  readonly install: (producer: TileProducer | null) => void
  /** A build resolved. `App` publishes the description from here. */
  readonly onReady: (handle: RendererHandle) => void
  /** The scene is warm. */
  readonly onWarmed: () => void
  /** The warm-up failed; the device is still alive. */
  readonly onWarmFailure: (cause: unknown) => void
}

export interface RendererLifetime {
  /** The build that last resolved, or null before the first one. */
  readonly handle: RendererHandle | null
  /** The producer this build holds, or null. */
  readonly producer: TileProducer | null
  /**
   * The `gl` factory for `<Canvas>`. Retires the producer ahead of the build,
   * whose first act destroys the previous device.
   */
  factory(
    preference: OutputPreference,
    picture: Picture,
  ): (props: CanvasProps) => Promise<WebGPURenderer>
  /**
   * Warm a build that resolved, once per build. The producer is made and
   * registered *after* the warm-up has opened the census, so its compile is
   * one census unit behind the cover rather than a detached task.
   */
  warm(handle: RendererHandle): void
  /** Terminal: retire the producer, then release the device. */
  dispose(): void
}

/** The census label the producer's compile reports under. */
export const PRODUCER_WARM_LABEL = 'compiling the ground producer'

export function createRendererLifetime(
  options: RendererLifetimeOptions,
): RendererLifetime {
  let handle: RendererHandle | null = null
  let producer: TileProducer | null = null
  /*
   * Which builds have been warmed. The effect that calls `warm` runs twice
   * under StrictMode and again on every build, and a second call for the same
   * handle must make no second producer — one per build is the whole
   * invariant, and the retirement ahead of each build is what makes "one
   * exists" mean "this build has one".
   */
  const warmed = new WeakSet<RendererHandle>()

  const retire = (): void => {
    producer?.dispose()
    producer = null
    options.install(null)
  }

  return {
    get handle() {
      return handle
    },
    get producer() {
      return producer
    },

    factory(preference, picture) {
      // Read at the call, not captured at creation: the preferences are live
      // state and a factory made once would build every rebuild at the first.
      return (props) => {
        retire()
        return options.build(preference, picture, (ready) => {
          handle = ready
          options.onReady(ready)
        })(props)
      }
    },

    warm(ready) {
      if (warmed.has(ready)) return
      warmed.add(ready)
      void options.warm(ready).then(options.onWarmed, options.onWarmFailure)
      if (producer !== null) return
      const next = options.produce(ready)
      if (next === null) return
      producer = next
      options.register({
        label: PRODUCER_WARM_LABEL,
        units: 1,
        run: async (done) => {
          const built = await next.warm()
          done()
          // A build that replaced this one retired `next` during the compile;
          // a late result installs nothing.
          if (producer !== next) return
          if (built) {
            options.install(next)
            return
          }
          next.dispose()
          producer = null
        },
      })
    },

    dispose() {
      retire()
      handle = null
      options.release()
    },
  }
}
