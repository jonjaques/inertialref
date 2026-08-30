import type { HarnessStatus } from '@inertialref/devtools'
import type { DevWorkspace } from '../dock/workspace.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { CameraState } from '../hud/controls.ts'
import { CinemaMode } from '../cinema/CinemaMode.tsx'
import { DocsMode } from '../docs/DocsMode.tsx'
import { FlightMode } from '../flight/FlightMode.tsx'
import { PlanetariumMode } from '../planetarium/PlanetariumMode.tsx'
import { HomePage } from './HomePage.tsx'
import { useOverlayStore } from './overlay.ts'
import { cinemaSceneFrom, modeForPath, playModeFrom } from './paths.ts'

/*
 * The mode table — one of two, and the split is the whole design:
 *
 *   - **modes** decide what owns the camera and what chrome is on screen
 *   - **overlays** are dialogs that open *over* a mode without replacing
 *     it, and live in `OverlayRoutes.tsx`
 *
 * Everything renders inside `.hud-layer`, which matters twice: pages inherit the
 * standard-range clamp that keeps chrome legible against a star, and the scene
 * is a sibling of that layer, so nothing a mode does can unmount the canvas.
 * The canvas is the other island (`SceneBackdrop`); this table cannot reach it.
 * ADR-0011 holds the argument.
 *
 * The mode is the overlay store's `mode` location, not the address bar. With a
 * dialog open the address bar names the dialog, and deriving the camera owner
 * from that disagrees with the tree still mounted behind it.
 *
 * Props rather than context: these are the same `App` state the dock already
 * receives, and the elements are JSX inside `App`, so they close over it
 * for free. A context would be a second way to reach the same values.
 */

interface ModeRouteProps {
  readonly engine: GameEngine | null
  readonly status: HarnessStatus | null
  readonly camera: CameraState
  /**
   * The author's instruments, and the disclosure that reveals them.
   *
   * Assembled in `App` because only `App` has the renderer description, the
   * connection monitor and the command table — and handed to the mode because
   * the *workspace* they go into belongs to the mode. Every mode below merges
   * them with its own panels; `HomePage` is the one that does not, because the
   * menu is not a place with a workspace in it.
   */
  readonly dev: DevWorkspace
  /**
   * Say what a verb just did, through the notice `App` already flashes.
   *
   * The flight mode needs it now that the Catalog is in its workspace: `Orbit`
   * and `Land` are teleports, and a teleport with no word for it is a picture
   * that changed for a reason nothing on screen gives. The planetarium keeps
   * its own surface, because it also has failures to report and a failure is
   * not a confirmation.
   */
  readonly onNotice: (message: string) => void
}

/**
 * The mode underneath: the menu, a flight session, the planetarium, the player.
 *
 * A *cold* load of an overlay path has no warm background, so the store's
 * mode is the menu — which is the honest answer, because a fresh tab at
 * `/settings` has no session behind it.
 *
 * Not wrapped in `AnimatePresence`, deliberately: a mode owns the camera and a
 * live subscription to the engine, and cross-fading two of them would mean two
 * components fighting over the observatory for the length of the transition.
 */
export function ModeRoutes(props: ModeRouteProps) {
  const modePath = useOverlayStore((state) => state.mode.pathname)
  const mode = modeForPath(modePath)
  const engine = props.engine

  if (engine === null) {
    // The menu's poster is the document. Everything else waits for the
    // backdrop: an unlit planetarium is a cover, not a page of words.
    return mode === 'menu' ? <HomePage /> : null
  }

  switch (mode) {
    case 'flight':
      return (
        <FlightMode
          engine={engine}
          status={props.status}
          play={playModeFrom(modePath)}
          dev={props.dev}
          onNotice={props.onNotice}
        />
      )
    case 'planetarium':
      return (
        <PlanetariumMode
          engine={engine}
          camera={props.camera}
          dev={props.dev}
        />
      )
    case 'docs':
      return <DocsMode engine={engine} dev={props.dev} />
    case 'cinema':
      return (
        <CinemaMode
          engine={engine}
          dev={props.dev}
          scene={cinemaSceneFrom(modePath)}
        />
      )
    default:
      return <HomePage />
  }
}
