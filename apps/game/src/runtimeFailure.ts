import { useSyncExternalStore } from 'react'
import { bootFailed } from './telemetry/boot.ts'
import { reportFailure } from './telemetry/client.ts'

export interface RuntimeFailure {
  readonly kind: 'unsupported' | 'graphics' | 'runtime' | 'restart'
  readonly detail: string
}

/**
 * The first failure survives later errors from the same broken device.
 *
 * `observe` hears every report, the first and the rest: telemetry wants the
 * device loss that arrives after the validation error it caused, which the
 * store rightly drops (`telemetry/failures.ts` holds the first for it).
 */
export function createRuntimeFailureStore(
  observe?: (
    kind: RuntimeFailure['kind'],
    cause: unknown,
    first: RuntimeFailure | null,
  ) => void,
) {
  let failure: RuntimeFailure | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => failure,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    report(kind: RuntimeFailure['kind'], cause: unknown) {
      const first =
        failure === null
          ? {
              kind,
              detail: cause instanceof Error ? cause.message : String(cause),
            }
          : null
      if (first !== null) failure = first
      observe?.(kind, cause, first)
      if (first === null) return
      for (const listener of listeners) listener()
    },
  }
}

/** The page's store, reported to PostHog: `unsupported` is a boot event, not a defect. */
export const runtimeFailure = createRuntimeFailureStore(
  (kind, cause, first) => {
    if (first !== null) bootFailed(first)
    if (kind !== 'unsupported') reportFailure(kind, cause)
  },
)
const serverSnapshot = (): null => null

export function useRuntimeFailure(): RuntimeFailure | null {
  return useSyncExternalStore(
    runtimeFailure.subscribe,
    runtimeFailure.getSnapshot,
    serverSnapshot,
  )
}

/** Animation callbacks execute outside React's error boundaries. */
export function runGraphicsFrame(run: () => void): void {
  if (runtimeFailure.getSnapshot() !== null) return
  try {
    run()
  } catch (cause) {
    console.error('The graphics frame stopped', cause)
    runtimeFailure.report('graphics', cause)
  }
}
