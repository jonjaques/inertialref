import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { type FirstLightState, PRELUDE } from '../render/bootState.ts'
import { useRuntimeFailure } from '../runtimeFailure.ts'
import { useRuntime } from '../runtimeState.ts'
import { useHydrated } from '../state/hydration.ts'

/*
 * Boot, as a page reads it.
 *
 * The prelude until a runtime has been published — the document is loading
 * the App chunk and the catalog, and that is a stage of the wait whether or
 * not anything has said so — then the runtime's own ledger, from the same
 * store the cover renders. One store or the other, never a copy: a page that
 * mirrored the ledger into its own state would be a second producer of the
 * same fact, one edit from disagreeing with the cover about which line is
 * running.
 */
const prelude = createStore<FirstLightState>(() => PRELUDE)

/**
 * The ledger a page may draw a line of, or `null` when there is nothing to
 * say.
 *
 * Nothing on the server and nothing before hydration: a spinner in static
 * HTML is a promise to a reader whose browser may never keep it, and the
 * readout is decorative to anyone the picture is not reaching. Nothing once
 * the runtime has failed, either — `RuntimeNotice` has the floor then, and a
 * line still turning beside it would be the promise the notice just withdrew.
 */
export function useBoot(): FirstLightState | null {
  const hydrated = useHydrated()
  const runtime = useRuntime()
  const failure = useRuntimeFailure()
  const boot = useStore(runtime?.boot ?? prelude)
  if (!hydrated || failure !== null) return null
  return boot
}
