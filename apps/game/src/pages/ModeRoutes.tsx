import { lazy, Suspense, useEffect } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router'
import type { DevWorkspace } from '../dock/workspace.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { DocsMode } from '../docs/DocsMode.tsx'
import { HomePage } from './HomePage.tsx'
import { modeLoaders, preloadMode } from './modeLoader.ts'
import {
  CINEMA,
  DOCS,
  HOME,
  PLANETARIUM,
  modeForPath,
  resolvedLocation,
} from './paths.ts'

const CinemaMode = lazy(modeLoaders.cinema)
const FlightMode = lazy(modeLoaders.flight)
const PlanetariumMode = lazy(modeLoaders.planetarium)
const CatalogPage = lazy(() =>
  import('../planetarium/CatalogPage.tsx').then((module) => ({
    default: module.CatalogPage,
  })),
)
const PresetsPage = lazy(() =>
  import('../planetarium/PresetsPage.tsx').then((module) => ({
    default: module.PresetsPage,
  })),
)

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
  readonly engine: GameEngine | null
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
  const mode = modeForPath(at.pathname)
  useEffect(() => {
    // Begin alongside GameLoader, while the engine is still absent. Waiting
    // for its publication adds a network round trip before this mode mounts.
    // React.lazy reads the same rejection through the existing route boundary.
    void preloadMode(mode)?.catch(() => {})
  }, [mode])
  const title =
    mode === 'planetarium'
      ? 'Planetarium'
      : mode === 'cinema'
        ? 'Cinema'
        : 'Flight'
  const admission = (
    <main className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950/85 p-6 text-center">
      <h1 className="type-display text-4xl text-slate-50">{title}</h1>
      <p className="type-body max-w-prose text-slate-300">
        {mode === 'planetarium'
          ? 'Explore the sky and the catalog in one continuous universe.'
          : mode === 'cinema'
            ? 'Watch scripted scenes over the live universe.'
            : 'Fly through a universe simulated in this browser.'}
      </p>
      <p className="type-ui text-slate-400">
        The interactive experience starts when graphics are ready.
      </p>
      <noscript>
        <p className="type-body text-slate-300">
          Enable JavaScript to enter the interactive experience.
        </p>
      </noscript>
      <nav
        aria-label="Explore InertialRef"
        className="type-ui flex gap-6 text-sky-300"
      >
        <Link to={HOME}>Home</Link>
        <Link to={DOCS}>Documentation</Link>
      </nav>
    </main>
  )

  return (
    <Routes location={at}>
      <Route path={HOME} element={<HomePage engine={props.engine} />} />
      <Route
        path="/play/:mode"
        element={
          props.engine === null ? (
            admission
          ) : (
            <Suspense fallback={admission}>
              <FlightMode
                engine={props.engine}
                dev={props.dev}
                onNotice={props.onNotice}
              />
            </Suspense>
          )
        }
      />
      <Route
        path={PLANETARIUM}
        element={
          props.engine === null ? (
            admission
          ) : (
            <Suspense fallback={admission}>
              <PlanetariumMode engine={props.engine} dev={props.dev} />
            </Suspense>
          )
        }
      >
        <Route
          path="presets"
          element={
            props.engine === null ? null : <PresetsPage engine={props.engine} />
          }
        />
        <Route
          path="catalog"
          element={
            props.engine === null ? null : <CatalogPage engine={props.engine} />
          }
        />
      </Route>
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
        element={
          props.engine === null ? (
            admission
          ) : (
            <Suspense fallback={admission}>
              <CinemaMode engine={props.engine} dev={props.dev} />
            </Suspense>
          )
        }
      />
      <Route
        path={`${CINEMA}/:scene`}
        element={
          props.engine === null ? (
            admission
          ) : (
            <Suspense fallback={admission}>
              <CinemaMode engine={props.engine} dev={props.dev} />
            </Suspense>
          )
        }
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
