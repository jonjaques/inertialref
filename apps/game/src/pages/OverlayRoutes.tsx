import { AnimatePresence } from 'motion/react'
import { Route, Routes, useLocation } from 'react-router'
import type { HudRenderState } from '../hud/controls.ts'
import { AboutPage } from './AboutPage.tsx'
import { KeysPage } from './KeysPage.tsx'
import { AuthCallbackPage } from './AuthCallbackPage.tsx'
import { overlaySurface } from './paths.ts'
import {
  ABOUT,
  KEYS,
  AUTH_CALLBACK,
  PROFILE,
  SETTINGS,
  SIGN_IN,
  SIGN_UP,
} from './paths.ts'
import { ProfilePage } from './ProfilePage.tsx'
import { SettingsPage } from './SettingsPage.tsx'
import { SignInPage } from './SignInPage.tsx'
import { SignUpPage } from './SignUpPage.tsx'

/**
 * The dialogs need far less than the modes do, and saying so is what keeps the
 * route test able to render them without an engine, a renderer or a canvas.
 */
interface OverlayRouteProps {
  readonly render: HudRenderState
  /** Say what a press just did, through the notice the shell flashes. */
  readonly onNotice: (message: string) => void
}

/**
 * The dialogs: settings, about, the account pages.
 *
 * `AnimatePresence` is what gives one an exit animation — React Router swaps
 * the subtree, and without something holding the outgoing tree mounted there is
 * nothing left to animate out. The `null` fallback route is the "no dialog"
 * state, and it is a real route rather than an absence so that closing one
 * animates instead of cutting.
 *
 * **Not `mode="wait"`, and not keyed on the pathname.** Both were, and together
 * they leaked the dialog: on close the scrim animated to `opacity: 0` and then
 * was never removed, so a full-viewport `pointer-events-auto` layer stayed over
 * the mode and swallowed every click on it. The scene was still rendering
 * behind an invisible sheet of glass, which is the worst shape a bug can take —
 * nothing to see, and nothing works. `mode="wait"` is what stopped the exit
 * completing; dropping it is what lets the node go.
 *
 * The key is the dialog's *surface* rather than its path, because losing
 * `mode="wait"` means an outgoing and an incoming child render together. Keyed
 * on the pathname, every settings tab was a key change, and two 70% scrims
 * cross-fading stack to 91% — a visible flash of the scene going dark on every
 * click of a tab. Keyed on the surface, a section change is content changing
 * inside a panel that never re-enters, which is what it looks like anyway.
 */
export function OverlayRoutes({ render, onNotice }: OverlayRouteProps) {
  const location = useLocation()
  return (
    <AnimatePresence>
      <Routes location={location} key={overlaySurface(location.pathname)}>
        <Route
          path={SETTINGS}
          element={<SettingsPage render={render} onNotice={onNotice} />}
        />
        <Route
          path={`${SETTINGS}/:section`}
          element={<SettingsPage render={render} onNotice={onNotice} />}
        />
        <Route path={ABOUT} element={<AboutPage />} />
        <Route path={KEYS} element={<KeysPage />} />
        <Route path={SIGN_IN} element={<SignInPage />} />
        <Route path={SIGN_UP} element={<SignUpPage />} />
        <Route path={PROFILE} element={<ProfilePage />} />
        <Route path={AUTH_CALLBACK} element={<AuthCallbackPage />} />
        <Route path="*" element={null} />
      </Routes>
    </AnimatePresence>
  )
}
