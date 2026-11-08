/*
 * Which failures become PostHog exceptions, grouped how, and how many.
 *
 * The SDK's global handlers see almost nothing here. Device loss, a pipeline
 * that fails validation, a frame that throws and both React boundaries are
 * caught on purpose so the page can explain itself, and a caught error never
 * reaches `window.onerror`. So the funnels call `reportFailure` themselves:
 * `runtimeFailure.report`, `hud/ErrorBoundary`, the universe worker's bridge
 * and the guide's loop.
 *
 * **Fingerprints, because automatic grouping cannot see a GPU.** Once a stack
 * resolves, PostHog groups on the frames and ignores the message, and every
 * WebGPU validation error fails through the same three.js frames — without a
 * fingerprint of its own, every shader defect in the product is one issue.
 * A device loss has no stack at all; it is a promise callback.
 *
 * **The first graphics failure is held for a moment.** A validation error can
 * arrive before `device.lost` resolves, and the loss is the cause: the
 * validation error is what the dying device said on its way out. A loss that
 * arrives inside the hold replaces it.
 *
 * Nothing here reads a message for meaning beyond normalizing it into a
 * fingerprint, and the guide's failures carry the provider's code and never
 * its message, which can quote the conversation.
 */

export type FailureSource =
  'runtime' | 'graphics' | 'restart' | 'boundary' | 'worker' | 'tour'

export type ExceptionLevel = 'fatal' | 'error' | 'warning'

/** What goes to `captureException`: the error and the properties beside it. */
export interface FailureReport {
  readonly error: Error
  readonly properties: Readonly<Record<string, unknown>>
}

/** A guide failure, by the provider's code alone. */
export class TourError extends Error {
  override readonly name = 'TourError'
  readonly code: string
  constructor(code: string) {
    super(`The guide's provider reported ${code}`)
    this.code = code
  }
}

/** The names `render/rendererErrors.ts` gives the GPU's own failures. */
const GPU_NAMES: Readonly<Record<string, string>> = {
  GPUDeviceLost: 'gpu-device-lost',
  GPUValidationError: 'gpu-validation',
  GPUOutOfMemoryError: 'gpu-out-of-memory',
  GPUInternalError: 'gpu-internal',
}

const LEVELS: Readonly<Record<FailureSource, ExceptionLevel>> = {
  runtime: 'fatal',
  graphics: 'fatal',
  restart: 'warning',
  boundary: 'error',
  worker: 'error',
  tour: 'error',
}

/**
 * A message with what varies between occurrences taken out: labels in quotes
 * or brackets, numbers, hex. `[RenderPipeline "atmosphere 3"] is invalid` and
 * `[RenderPipeline "atmosphere 7"] is invalid` are one defect.
 */
export function normalizeMessage(message: string): string {
  return (message.split('\n')[0] ?? '')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '…')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  return new Error(typeof cause === 'string' ? cause : String(cause))
}

/** The device-loss reason three.js passes along, when the error carries one. */
const reasonOf = (error: Error): string | null => {
  const reason = (error as Error & { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

/** The report for one failure, or null for one that is not a defect. */
export function describeFailure(
  source: FailureSource,
  cause: unknown,
  context: Readonly<Record<string, unknown>> = {},
): FailureReport | null {
  const error = asError(cause)
  const properties: Record<string, unknown> = {
    ...context,
    failure_kind: source,
    $exception_level: LEVELS[source],
  }
  const gpu = GPU_NAMES[error.name]
  if (gpu !== undefined) {
    if (gpu === 'gpu-device-lost') {
      const reason = reasonOf(error) ?? 'unknown'
      // Our own `releaseRenderer` destroys the device; that is not a defect.
      if (reason === 'destroyed') return null
      properties['$exception_fingerprint'] = `${gpu}:${reason}`
    } else
      properties['$exception_fingerprint'] =
        `${gpu}:${normalizeMessage(error.message)}`
  } else if (error instanceof TourError)
    properties['$exception_fingerprint'] = `tour:${error.code}`
  else if (source === 'restart')
    properties['$exception_fingerprint'] = 'graphics-session-restart'
  return { error, properties }
}

/** At most this many exceptions from one page load; a cascade is one story. */
export const PAGE_CAP = 5

/** How long the first graphics failure waits for a device loss to replace it. */
export const GRAPHICS_HOLD_MS = 250

/**
 * The page's reporting policy: each error object once, a cap per page, and
 * the graphics hold. The clock and the sink are injected so the policy is a
 * plain function of what it is told.
 */
export class FailureReporter {
  readonly #send: (report: FailureReport) => void
  readonly #after: (run: () => void, ms: number) => void
  readonly #seen = new WeakSet<object>()
  #sent = 0
  #held: FailureReport | null = null

  constructor(
    send: (report: FailureReport) => void,
    after: (run: () => void, ms: number) => void,
  ) {
    this.#send = send
    this.#after = after
  }

  report(
    source: FailureSource,
    cause: unknown,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    // `GameLoader` and `GameRuntimeBoundary` can both see one error.
    if (typeof cause === 'object' && cause !== null) {
      if (this.#seen.has(cause)) return
      this.#seen.add(cause)
    }
    const report = describeFailure(source, cause, context)
    if (report === null) return
    const lost = report.error.name === 'GPUDeviceLost'
    if (this.#held !== null) {
      if (lost) this.#held = report
      else this.#emit(report)
      return
    }
    if (source === 'graphics' && !lost) {
      this.#held = report
      this.#after(() => {
        const held = this.#held
        this.#held = null
        if (held !== null) this.#emit(held)
      }, GRAPHICS_HOLD_MS)
      return
    }
    this.#emit(report)
  }

  #emit(report: FailureReport): void {
    if (this.#sent >= PAGE_CAP) return
    this.#sent += 1
    this.#send(report)
  }
}
