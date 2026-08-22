import { AnimatePresence } from 'motion/react'
import { Route, Routes, useLocation } from 'react-router'
import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { CameraState } from '../hud/CameraPanel.tsx'
import type { GraphicsState } from '../hud/GraphicsPanel.tsx'
import { CinemaMode } from '../cinema/CinemaMode.tsx'
import { FlightMode } from '../flight/FlightMode.tsx'
import { PlanetariumMode } from '../planetarium/PlanetariumMode.tsx'
import { AboutPage } from './AboutPage.tsx'
import {
  AuthCallbackPage,
  ProfilePage,
  SignInPage,
  SignUpPage,
} from './AccountPages.tsx'
import { HomePage } from './HomePage.tsx'
import {
  ABOUT,
  AUTH_CALLBACK,
  CINEMA,
  HOME,
  type OverlayLocationState,
  PLANETARIUM,
  PROFILE,
  SETTINGS,
  SIGN_IN,
  SIGN_UP,
} from './paths.ts'
import { SettingsPage } from './SettingsPage.tsx'

/*
 * The route table.
 *
 * Two tables, actually, and the split is the whole design:
 *
 *   - **mode routes** decide what owns the camera and what chrome is on screen
 *   - **overlay routes** are dialogs that open *over* a mode without replacing it
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
  readonly fov: number
  readonly onFov: (fov: number) => void
}

/**
 * The dialogs need far less than the modes do, and saying so is what keeps the
 * route test able to render them without an engine, a renderer or a canvas.
 */
interface OverlayRouteProps {
  readonly graphics: GraphicsState
  readonly camera: CameraState
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
  const location = useLocation()
  const state = location.state as OverlayLocationState | null
  const at = state?.background ?? location

  return (
    <Routes location={at}>
      <Route path={HOME} element={<HomePage engine={props.engine} />} />
      <Route
        path="/play/:mode"
        element={<FlightMode engine={props.engine} status={props.status} />}
      />
      <Route
        path={PLANETARIUM}
        element={
          <PlanetariumMode
            engine={props.engine}
            fov={props.fov}
            onFov={props.onFov}
          />
        }
      />
      <Route path={CINEMA} element={<CinemaMode engine={props.engine} />} />
      <Route
        path={`${CINEMA}/:scene`}
        element={<CinemaMode engine={props.engine} />}
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

/**
 * The dialogs: settings, about, the account pages.
 *
 * `AnimatePresence` keyed on the pathname is what gives one an exit animation —
 * React Router swaps the subtree, and without something holding the outgoing
 * tree mounted there is nothing left to animate out. The `null` fallback route
 * is the "no dialog" state, and it is a real route rather than an absence so
 * that closing one animates instead of cutting.
 */
export function OverlayRoutes({ graphics, camera }: OverlayRouteProps) {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route
          path={SETTINGS}
          element={<SettingsPage graphics={graphics} camera={camera} />}
        />
        <Route
          path={`${SETTINGS}/:section`}
          element={<SettingsPage graphics={graphics} camera={camera} />}
        />
        <Route path={ABOUT} element={<AboutPage />} />
        <Route path={SIGN_IN} element={<SignInPage />} />
        <Route path={SIGN_UP} element={<SignUpPage />} />
        <Route path={PROFILE} element={<ProfilePage />} />
        <Route path={AUTH_CALLBACK} element={<AuthCallbackPage />} />
        <Route path="*" element={null} />
      </Routes>
    </AnimatePresence>
  )
}
