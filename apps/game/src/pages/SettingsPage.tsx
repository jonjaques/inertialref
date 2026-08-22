import { CameraPanel, type CameraState } from '../hud/CameraPanel.tsx'
import { GraphicsPanel, type GraphicsState } from '../hud/GraphicsPanel.tsx'
import { OverlayPage } from './OverlayPage.tsx'

/*
 * Settings, as a page.
 *
 * The panels are the ones the dock already draws — the same components, the
 * same props, the same engine fields underneath. That is deliberate: this page
 * exists to prove the routed-overlay path carries real state, and inventing a
 * second set of controls for the same three knobs is how a build ends up with
 * two anti-aliasing switches that disagree.
 *
 * `docs/design/ux.md` puts settings here rather than in the dock, and the dock
 * is scaffolding rather than the shipping HUD, so the eventual move is out of
 * the dock and into this page. Both render today; neither is a copy.
 */
export function SettingsPage({
  graphics,
  camera,
}: {
  graphics: GraphicsState
  camera: CameraState
}) {
  return (
    <OverlayPage title="settings" subtitle="the simulation keeps running">
      <GraphicsPanel graphics={graphics} />
      <CameraPanel camera={camera} />
    </OverlayPage>
  )
}
