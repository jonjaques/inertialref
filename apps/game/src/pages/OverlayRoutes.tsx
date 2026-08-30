import { AnimatePresence } from 'motion/react'
import type {
  CameraState,
  GraphicsState,
  HudRenderState,
} from '../hud/controls.ts'
import { AboutPage } from './AboutPage.tsx'
import { KeysPage } from './KeysPage.tsx'
import { AuthCallbackPage } from './AuthCallbackPage.tsx'
import { locationOf, useOverlayStore } from './overlay.ts'
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
  readonly graphics: GraphicsState
  readonly camera: CameraState
  readonly render: HudRenderState
}

/**
 * The dialogs: settings, about, the account pages.
 *
 * `AnimatePresence` is what gives one an exit animation — the store swaps
 * the subtree, and without something holding the outgoing tree mounted there is
 * nothing left to animate out. Rendering `null` when no dialog is open is the
 * "no dialog" state, and it is a real child rather than an absence so that
 * closing one animates instead of cutting.
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
export function OverlayRoutes({ graphics, camera, render }: OverlayRouteProps) {
  const overlay = useOverlayStore((state) => state.overlay)
  const path = overlay === null ? '' : locationOf(overlay).pathname
  const surface = overlaySurface(path)

  let dialog = null
  if (overlay !== null) {
    if (path === SETTINGS || path.startsWith(`${SETTINGS}/`)) {
      dialog = (
        <SettingsPage
          key={surface}
          graphics={graphics}
          camera={camera}
          render={render}
        />
      )
    } else if (path === ABOUT) {
      dialog = <AboutPage key={surface} />
    } else if (path === KEYS) {
      dialog = <KeysPage key={surface} />
    } else if (path === SIGN_IN) {
      dialog = <SignInPage key={surface} />
    } else if (path === SIGN_UP) {
      dialog = <SignUpPage key={surface} />
    } else if (path === PROFILE) {
      dialog = <ProfilePage key={surface} />
    } else if (path === AUTH_CALLBACK) {
      dialog = <AuthCallbackPage key={surface} />
    }
  }

  return <AnimatePresence>{dialog}</AnimatePresence>
}
