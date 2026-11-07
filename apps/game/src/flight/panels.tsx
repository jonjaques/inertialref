import { Aperture } from 'lucide-react'
import type { DockPanelDefinition } from '../dock/panels.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { LensPanel } from '../hud/LensPanel.tsx'
import { Neighborhood } from '../icons/index.tsx'
import { NavigatorPanel } from '../planetarium/NavigatorPanel.tsx'

/**
 * What a flight mode contributes to its workspace.
 *
 * Two panels, and the fact that both are the *same* panels the planetarium
 * draws is the point. The Lens is the viewport's instrument in every mode
 * that has one — set beside the picture it shapes, which a settings page
 * opened over the menu could not show — so flight registers it rather than
 * reaching it through a copy elsewhere. It has no glare: how much of the
 * flare a photograph shows is the planetarium's choice about a picture.
 *
 * The Navigator's case is the older one. There were two navigators: the Catalog, which looked, and the
 * author's Navigate panel, which traveled — and in the planetarium Navigate's
 * Go to, Orbit and Land teleported a ship nobody could see, so the panel
 * appeared to do nothing, while in flight it was the only way to go anywhere at
 * all. Two navigators is the ambiguity this removes; one panel with a verb that
 * depends on the mode is what replaces it.
 *
 * The panel comes from `planetarium/`, which is where it was written and where
 * it still belongs by subject — the navigator is a reading of the sky, and
 * flight is a consumer of it. Moving the file to a neutral directory would be
 * filing by who reads it rather than by what it is about.
 */
export function flightPanels(
  engine: GameEngine,
  onNotice: (message: string) => void,
): readonly DockPanelDefinition[] {
  return [
    {
      id: 'catalog',
      title: 'Navigator',
      icon: Neighborhood,
      zone: 'right',
      hint: 'Everything within reach — fold it, filter it, fly to it',
      render: () => (
        <NavigatorPanel
          engine={engine}
          // Nothing is "current" in flight the way a subject is in the
          // planetarium: the ship is somewhere, and where it is going is a
          // selection this panel makes for itself.
          target={null}
          focus={() => {}}
          verbs="travel"
          onNotice={onNotice}
        />
      ),
    },
    {
      id: 'lens',
      title: 'Lens',
      icon: Aperture,
      zone: 'right',
      defaultOpen: false,
      hint: 'What the picture is taken through — the glass and the exposure',
      render: () => <LensPanel />,
    },
  ]
}
