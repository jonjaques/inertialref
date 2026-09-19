import type { WebGPURenderer } from 'three/webgpu'
import { onTimingLevel } from '../engine/browserTiming.ts'

interface TimestampHost {
  track(enabled: boolean): void
  resolve(kind: 'render' | 'compute'): Promise<unknown>
}

/** One sample in flight; repeated synchronous renders cannot exhaust the query pool. */
export class RenderTimestampDrain {
  readonly #host: TimestampHost
  #enabled = false
  #tracking = false
  #pending = false
  #disposed = false
  settled: Promise<void> = Promise.resolve()

  constructor(host: TimestampHost) {
    this.#host = host
    host.track(false)
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    if (!enabled) this.#track(false)
  }

  beginFrame(): void {
    this.#track(this.#enabled && !this.#pending && !this.#disposed)
  }

  endFrame(): void {
    if (!this.#tracking) return
    this.#pending = true
    // Resolving snapshots and clears the query offsets synchronously. Tracking
    // must stay on until both calls have entered the backend, then stay off
    // until their asynchronous buffer mappings finish.
    const resolve = (kind: 'render' | 'compute'): Promise<unknown> => {
      try {
        return this.#host.resolve(kind)
      } catch (cause) {
        return Promise.reject(cause)
      }
    }
    const pending = [resolve('render'), resolve('compute')]
    this.#track(false)
    this.settled = Promise.allSettled(pending).then(() => {
      this.#pending = false
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#track(false)
  }

  #track(enabled: boolean): void {
    this.#tracking = enabled
    this.#host.track(enabled)
  }
}

const drains = new WeakMap<WebGPURenderer, RenderTimestampDrain>()

export function installGpuTiming(renderer: WebGPURenderer): () => void {
  const backend = renderer.backend as unknown as {
    trackTimestamp: boolean
    device?: GPUDevice
  }
  const supported = backend.device?.features.has('timestamp-query') === true
  const drain = new RenderTimestampDrain({
    track(enabled) {
      backend.trackTimestamp = enabled && supported
    },
    resolve: (kind) => renderer.resolveTimestampsAsync(kind),
  })
  drains.set(renderer, drain)
  const unsubscribe = onTimingLevel((level) =>
    drain.setEnabled(supported && level === 'full'),
  )
  return () => {
    unsubscribe()
    drain.dispose()
    drains.delete(renderer)
  }
}

export function beginGpuTiming(renderer: WebGPURenderer): void {
  drains.get(renderer)?.beginFrame()
}

export function endGpuTiming(renderer: WebGPURenderer): void {
  drains.get(renderer)?.endFrame()
}
