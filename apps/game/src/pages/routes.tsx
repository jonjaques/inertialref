import { AnimatePresence } from 'motion/react'
import { Route, Routes, useLocation } from 'react-router'
import type { CameraState } from '../hud/CameraPanel.tsx'
import type { GraphicsState } from '../hud/GraphicsPanel.tsx'
import { SETTINGS } from './paths.ts'
import { SettingsPage } from './SettingsPage.tsx'

/*
 * The overlay route table.
 *
 * It renders *inside* `.hud-layer`, which matters twice: pages inherit the
 * standard-range clamp that keeps chrome legible against a star, and the scene
 * is a sibling of that layer, so nothing a route does can unmount the canvas.
 * A router that owned the whole tree would remount `<Canvas>` on every
 * navigation and rebuild the renderer with it — which is the reason this is a
 * route table over a persistent shell rather than the shell itself.
 *
 * Props rather than context: these are the same `App` state the dock already
 * receives, and the route elements are JSX inside `App`, so they close over it
 * for free. A context would be a second way to reach the same values.
 *
 * `AnimatePresence` keyed on the pathname is what gives a page an exit
 * animation — React Router swaps the subtree, and without something holding
 * the outgoing tree mounted there is nothing left to animate out. The index
 * route rendering `null` is the "flying" state, and it is a real route rather
 * than an absence so that leaving a page animates instead of cutting.
 */
export function OverlayRoutes({
  graphics,
  camera,
}: {
  graphics: GraphicsState
  camera: CameraState
}) {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route
          path={SETTINGS}
          element={<SettingsPage graphics={graphics} camera={camera} />}
        />
        {/* Everything else, including `/`, is flying. An unknown path is not
            an error worth a page: the URL is the only way in, and the game
            behind it is unaffected. */}
        <Route path="*" element={null} />
      </Routes>
    </AnimatePresence>
  )
}
