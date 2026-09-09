import { useSyncExternalStore } from 'react'

export interface RuntimeFailure {
  readonly kind: 'unsupported' | 'graphics' | 'runtime' | 'restart'
  readonly detail: string
}

/** The first failure survives later errors from the same broken device. */
export function createRuntimeFailureStore() {
  let failure: RuntimeFailure | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => failure,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    report(kind: RuntimeFailure['kind'], cause: unknown) {
      if (failure !== null) return
      failure = {
        kind,
        detail: cause instanceof Error ? cause.message : String(cause),
      }
      for (const listener of listeners) listener()
    },
  }
}

export const runtimeFailure = createRuntimeFailureStore()
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
