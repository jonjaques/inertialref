import type { DockPanelDefinition } from '../dock/panels.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Neighbourhood } from '../icons/index.tsx'
import { CataloguePanel } from '../planetarium/CataloguePanel.tsx'

/**
 * What a flight mode contributes to its workspace.
 *
 * One panel, and the fact that it is the *same* panel the planetarium draws is
 * the point. There were two navigators: the Catalog, which looked, and the
 * author's Navigate panel, which travelled — and in the planetarium Navigate's
 * Go to, Orbit and Land teleported a ship nobody could see, so the panel
 * appeared to do nothing, while in flight it was the only way to go anywhere at
 * all. Two navigators is the ambiguity this removes; one panel with a verb that
 * depends on the mode is what replaces it.
 *
 * The panel comes from `planetarium/`, which is where it was written and where
 * it still belongs by subject — the catalog is a reading of the sky, and flight
 * is a consumer of it. Moving the file to a neutral directory would be filing
 * by who reads it rather than by what it is about.
 */
export function flightPanels(
  engine: GameEngine,
  onNotice: (message: string) => void,
): readonly DockPanelDefinition[] {
  return [
    {
      id: 'catalogue',
      title: 'Catalog',
      icon: Neighbourhood,
      zone: 'right',
      hint: 'Everything within reach — fold it, filter it, fly to it',
      render: () => (
        <CataloguePanel
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
  ]
}
