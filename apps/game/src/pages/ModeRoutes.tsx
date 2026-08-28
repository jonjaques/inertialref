import { Route, Routes, useLocation } from 'react-router'
import type { HarnessStatus } from '@inertialref/devtools'
import type { DevWorkspace } from '../dock/workspace.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { CameraState } from '../hud/controls.ts'
import { CinemaMode } from '../cinema/CinemaMode.tsx'
import { DocsMode } from '../docs/DocsMode.tsx'
import { FlightMode } from '../flight/FlightMode.tsx'
import { PlanetariumMode } from '../planetarium/PlanetariumMode.tsx'
import { HomePage } from './HomePage.tsx'
import { CINEMA, DOCS, HOME, PLANETARIUM, resolvedLocation } from './paths.ts'

/*
 * The mode route table — one of two, and the split is the whole design:
 *
 *   - **mode routes** decide what owns the camera and what chrome is on screen
 *   - **overlay routes** are dialogs that open *over* a mode without replacing
 *     it, and live in `OverlayRoutes.tsx`
 *
 * Everything renders inside `.hud-layer`, which matters twice: pages inherit the
 * standard-range clamp that keeps chrome legible against a star, and the scene
 * is a sibling of that layer, so nothing a route does can unmount the canvas. A
 * router that owned the whole tree would remount `<Canvas>` on every navigation
 * and rebuild the renderer with it — which is why this is a route table over a
 * persistent shell rather than the shell itself. ADR-0011 holds the argument.
 *
 * Props rather than context: these are the same `App` state the dock already
 * receives, and the route elements are JSX inside `App`, so they close over it
 * for free. A context would be a second way to reach the same values.
 */

interface ModeRouteProps {
  readonly engine: GameEngine
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
}

/**
 * The mode underneath: the menu, a flight session, the planetarium, the player.
 *
 * Rendered at the *background* location when a dialog is open, so a mode is
 * never remounted by opening one.
 *
 * A *cold* load of an overlay path has no background, so this table sees the
 * overlay's own path, matches nothing, and falls through to the menu — which is
 * the honest answer, because a fresh tab at `/settings` has no session behind
 * it.
 *
 * Not wrapped in `AnimatePresence`, deliberately: a mode owns the camera and a
 * live subscription to the engine, and cross-fading two of them would mean two
 * components fighting over the observatory for the length of the transition.
 */
export function ModeRoutes(props: ModeRouteProps) {
  // The same resolution the shell derives its mode from — one function, so the
  // two cannot answer differently about what is on screen.
  const at = resolvedLocation(useLocation())

  return (
    <Routes location={at}>
      <Route path={HOME} element={<HomePage engine={props.engine} />} />
      <Route
        path="/play/:mode"
        element={
          <FlightMode
            engine={props.engine}
            status={props.status}
            dev={props.dev}
          />
        }
      />
      <Route
        path={PLANETARIUM}
        element={
          <PlanetariumMode
            engine={props.engine}
            camera={props.camera}
            dev={props.dev}
          />
        }
      />
      {/*
       * One route for the whole section, and the splat is the point: the
       * documentation's own addresses mirror the repository's directory tree,
       * which is four levels deep and grows a page every time somebody writes
       * one. A route table that enumerated them would be a second copy of
       * `scripts/docs/wings.mjs` that nothing keeps in step, so the mode reads
       * the path and the manifest decides whether it names anything.
       */}
      <Route
        path={`${DOCS}/*`}
        element={<DocsMode engine={props.engine} dev={props.dev} />}
      />
      <Route
        path={CINEMA}
        element={<CinemaMode engine={props.engine} dev={props.dev} />}
      />
      <Route
        path={`${CINEMA}/:scene`}
        element={<CinemaMode engine={props.engine} dev={props.dev} />}
      />
      {/*
       * Anything else falls through to the menu rather than to a 404 page.
       *
       * The URL is the only way in and a typed one is a normal event; a game
       * that answers a misspelling with an error page is a game that made the
       * misspelling look like a failure of the game. The menu is the answer to
       * "where am I", which is the question a wrong URL actually asks.
       */}
      <Route path="*" element={<HomePage engine={props.engine} />} />
    </Routes>
  )
}
