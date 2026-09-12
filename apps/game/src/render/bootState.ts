/*
 * What the boot cover renders from, and the one state that exists before the
 * runtime does.
 *
 * Apart from `firstLight.ts` because the pages read it and the pages are
 * server-rendered. `firstLight.ts` reaches the presentation watchdog and the
 * frame timing, and `runtimeState.ts` promises that no engine module enters
 * the server graph — so the shapes, and the prelude the document shows before
 * a runtime has been published, live here with no imports at all.
 */

export type FirstLightPhase = 'booting' | 'revealing' | 'done'

/** One line of the cover's ledger. */
export interface BootStage {
  readonly label: string
  /**
   * The census as this stage last reported it — `done/total` across every
   * producer — or `null` while there was no fraction worth showing. A finished
   * stage keeps the count it ended on, so the ledger reads as a running total
   * rather than as one number that moves from line to line.
   */
  readonly count: string | null
}

/** Everything the shell renders from. */
export interface FirstLightState {
  readonly phase: FirstLightPhase
  /** The cover's status line: the running stage, with its count. */
  readonly status: string
  /**
   * Every stage the cover has shown, oldest first. The last one is running
   * and `status` is its line; every earlier one is finished. Append-only, so
   * the cover can stream them down rather than replace one with the next.
   */
  readonly stages: readonly BootStage[]
  /** Units finished over units expected, 0 to 1, for the progress rule. */
  readonly fraction: number
  /**
   * How many times the canvas has been rebuilt. Part of the canvas key, and
   * bumped by the watchdog's last rung and by nothing else.
   */
  readonly epoch: number
}

/**
 * The stage the ledger opens on: the runtime itself.
 *
 * `GameLoader` fetches the App chunk and the star catalog together before
 * there is a renderer to wake, and on a cold production load that is the
 * first second or two of the wait. It is the one line the server-rendered
 * admission can show honestly, and `firstLight.ts` opens its own ledger with
 * this line finished — so the cover the runtime mounts continues the one the
 * document arrived with, rather than starting a second under it.
 */
export const RUNTIME_STAGE: BootStage = {
  label: 'loading the runtime',
  count: null,
}

/** Boot as the document sees it before a runtime has been published. */
export const PRELUDE: FirstLightState = {
  phase: 'booting',
  status: `${RUNTIME_STAGE.label}…`,
  stages: [RUNTIME_STAGE],
  fraction: 0,
  epoch: 0,
}
