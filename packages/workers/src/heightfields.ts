import type {
  HeightfieldRequest,
  SurfaceParameters,
} from '@inertialref/universe'
import type { JobHandle } from './pool.ts'
import type { HeightfieldResponse, HeightfieldSource } from './tasks.ts'

/** A retired producer cannot complete this request; another adapter may. */
export class HeightfieldUnavailable extends Error {
  constructor() {
    super('producer unavailable')
    this.name = 'HeightfieldUnavailable'
  }
}

/**
 * Heightfields through a preferred adapter and a fallback. Request ordering
 * belongs to the caller; capability checks and retirement belong here.
 *
 * A null submission means nobody supports the request. A null result means
 * its producer retired and no fallback could finish it. Cancellation still
 * rejects, and ordinary failures propagate without being retried.
 */
export class Heightfields {
  preferred: HeightfieldSource | null = null
  readonly #fallback: HeightfieldSource | null
  #nextId = 1

  constructor(fallback: HeightfieldSource | null) {
    this.#fallback = fallback
  }

  /** The adapter a supported request prefers, for presentation diagnostics. */
  get kind(): string | null {
    if (this.preferred?.available) return this.preferred.kind
    return this.#fallback?.available ? this.#fallback.kind : null
  }

  submit(
    surface: SurfaceParameters,
    request: HeightfieldRequest,
  ): JobHandle<HeightfieldResponse | null> | null {
    const supports = (
      source: HeightfieldSource | null,
    ): source is HeightfieldSource =>
      source !== null &&
      source.available &&
      request.region.level <= (source.maxLevel ?? Infinity) &&
      (source.supports?.(request) ?? true)
    const sources = [this.preferred, this.#fallback].filter(
      (source, i, all): source is HeightfieldSource =>
        supports(source) && all.indexOf(source) === i,
    )
    if (sources.length === 0) return null
    const id = this.#nextId++
    let active: JobHandle<HeightfieldResponse> | null = null
    let settled = false
    let reject!: (reason: unknown) => void
    const result = new Promise<HeightfieldResponse | null>((resolve, fail) => {
      reject = fail
      const attempt = (index: number): void => {
        if (settled) return
        const source = sources[index]
        if (source === undefined) {
          settled = true
          resolve(null)
          return
        }
        if (!supports(source)) {
          attempt(index + 1)
          return
        }
        const failed = (cause: unknown): void => {
          if (settled) return
          active = null
          if (cause instanceof HeightfieldUnavailable || !source.available) {
            attempt(index + 1)
          } else {
            settled = true
            fail(cause)
          }
        }
        try {
          active = source.submit(surface, request)
          void active.result.then((field) => {
            if (settled) return
            settled = true
            resolve(field)
          }, failed)
        } catch (cause) {
          failed(cause)
        }
      }
      attempt(0)
    })
    return {
      id,
      result,
      cancel() {
        if (settled) return
        settled = true
        reject(new Error('cancelled'))
        active?.cancel()
      },
    }
  }
}
