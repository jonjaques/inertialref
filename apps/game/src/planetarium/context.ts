import type { GameEngine } from '../engine/GameEngine.ts'
import type { OrbitScope } from '../engine/presentation.ts'
import type { CameraState } from '../hud/controls.ts'
import type { LabelDensity } from './layers.ts'

/*
 * What every planetarium panel is handed.
 *
 * Its own module, and not because the type is large: `panels.tsx` must export
 * components and nothing else, or Vite's Fast Refresh gives up on the file and
 * a change to one panel reloads the page — which in this app means rebuilding
 * the renderer and losing the camera. Same rule as `pages/paths.ts`, applied to
 * the mode's own vocabulary.
 */

/** What the panels are handed. One object, because they all read most of it. */
export interface PlanetariumContext {
  readonly engine: GameEngine
  /** The address the observatory is on, refreshed by the mode at panel rate. */
  readonly target: string | null
  readonly focus: (address: string) => void
  readonly labels: boolean
  readonly onLabels: (on: boolean) => void
  /** How many names the sky carries at once. */
  readonly labelDensity: LabelDensity
  readonly onLabelDensity: (density: LabelDensity) => void
  /** Whether asteroids and comets are worth one of those slots. */
  readonly labelMinor: boolean
  readonly onLabelMinor: (on: boolean) => void
  readonly orbits: boolean
  readonly onOrbits: (on: boolean) => void
  /** The subject's context, or every orbit in the system. */
  readonly orbitScope: OrbitScope
  readonly onOrbitScope: (scope: OrbitScope) => void
  readonly ship: boolean
  readonly onShip: (on: boolean) => void
  /** How much of the lens's artifact stack is showing, 0..1. */
  readonly flare: number
  readonly onFlare: (amount: number) => void
  /** The lens, and the only writer of it — see `hud/controls.ts`. */
  readonly camera: CameraState
  /**
   * Move the camera in or out by `notches` of the wheel's own step.
   *
   * The *dolly*, which is not the zoom and not the framing. Three acts shared
   * one control here and the copy under the lens slider described a coupling
   * nobody had wired: narrowing the lens recorded an angle and nothing
   * re-solved the standoff, so the subject did not "stay the same size" — it
   * grew. Each act now has its own control and the sentence is true of the one
   * it belongs to.
   */
  readonly dolly: (notches: number) => void
  /** Re-solve the standoff so the subject fills the frame at the current lens. */
  readonly holdFraming: () => void
}
