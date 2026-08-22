import type { GameEngine } from '../engine/GameEngine.ts'

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
  readonly orbits: boolean
  readonly onOrbits: (on: boolean) => void
  readonly ship: boolean
  readonly onShip: (on: boolean) => void
  readonly fov: number
  readonly onFov: (fov: number) => void
}
