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
   * Whether the primary drag and the arrow keys turn the head instead of
   * orbiting.
   *
   * Session state, not a preference, and the two ways in are why: the secondary
   * button always looks, so a mouse never needs this — it is the only way in on
   * a phone and with a keyboard alone. Somebody who turned it on for one
   * picture has not said anything about the next session, and a planetarium
   * whose primary gesture had silently changed since last time would be a mode
   * that had to be re-learned.
   */
  readonly freeLook: boolean
  readonly onFreeLook: (on: boolean) => void
  /**
   * Say what a press just did, through the notice the mode already flashes.
   *
   * A preset moves the camera *and* the lens, and two changes with no word for
   * them is a picture a viewer has to reverse-engineer. It is the same notice
   * the address bar and the harness verbs use, which is deliberate: one place
   * on screen where the interface reports what it was asked for.
   */
  readonly onNotice: (message: string) => void
  /**
   * Move the camera in or out by `notches` of the wheel's own step.
   *
   * The *dolly*, which is not the zoom and not the framing. One control cannot
   * be all three: a zoom magnifies and moves nothing, a dolly changes every
   * parallax in the frame, and holding a subject's size is a solve for the
   * distance that does it at whatever lens is fitted. Narrowing the lens
   * re-solves no standoff on its own — `focus` and `frameTarget` store the
   * distance they solve — so "the subject stays the same size" is true of the
   * solve and false of the other two. Each act has its own control, and the
   * sentence under it is about that act.
   */
  readonly dolly: (notches: number) => void
  /**
   * Solve the standoff that fills the frame with the subject at this lens.
   *
   * The *framing* act, and it solves rather than restores: `DEFAULT_FILL` of
   * the frame height at whatever lens is fitted, which is what `F` and the
   * shot presets run. Nothing stores the fill a viewer dollied to, so this
   * cannot put one back — and a control labelled for an intent the code does
   * not keep would be the panel describing a coupling nobody wired all over
   * again.
   */
  readonly frameSubject: () => void
}
