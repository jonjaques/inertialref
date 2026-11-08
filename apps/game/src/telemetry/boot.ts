import type { RuntimeFailure } from '../runtimeFailure.ts'
import { recordEvent } from './posthog.ts'

/*
 * Boot, as a funnel: `boot started` → `boot completed` → `mode entered`.
 *
 * The cold-load budget is the one duration a player experiences, and the rig
 * measures it on one machine. These are the same milestones measured on every
 * machine that reports: `firstLight.ts` already knows when the scene first
 * presented and when the cover finished lifting, both on the clock whose zero
 * is the navigation.
 *
 * A failure before the reveal is `boot failed`, once. After the reveal it is
 * an exception and nothing here: the boot did complete.
 */

let revealed = false
let failed = false
let firstLightMs: number | null = null

/** The runtime chunk is being fetched: the start of everything after the shell. */
export function bootStarted(): void {
  recordEvent('boot started', {
    dpr: window.devicePixelRatio,
    cores: navigator.hardwareConcurrency,
  })
}

/** The scene presented a lit frame. */
export function bootFirstLight(msSinceNavigation: number): void {
  firstLightMs = Math.round(msSinceNavigation)
}

/** The cover has lifted; the interface is in the player's hands. */
export function bootRevealed(msSinceNavigation: number): void {
  if (revealed) return
  revealed = true
  recordEvent('boot completed', {
    ...(firstLightMs === null ? {} : { ms_first_light: firstLightMs }),
    ms_revealed: Math.round(msSinceNavigation),
  })
}

/** A runtime failure, which ends the boot if the boot had not ended. */
export function bootFailed(failure: RuntimeFailure): void {
  if (revealed || failed) return
  failed = true
  recordEvent('boot failed', {
    failure_kind: failure.kind,
    // `unsupported` is not an exception, and its detail is this app's own
    // sentence about which capability was missing.
    ...(failure.kind === 'unsupported'
      ? { failure_detail: failure.detail.slice(0, 200) }
      : {}),
  })
}
