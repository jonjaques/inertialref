import { Camera, Library } from 'lucide-react'
import { PICTURES } from '@inertialref/devtools'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import type { PlanetariumContext } from './context.ts'
import { PictureCard } from './PictureCard.tsx'
import { CompositionControls } from './CompositionControls.tsx'
import { GalaxySection } from './GalaxySection.tsx'

const QUICK_SHOTS = ['earthrise', 'centauri-daybreak', 'far-shore']

export function PresetsPanel(context: PlanetariumContext) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Action
          label="All presets"
          icon={Library}
          onClick={() => context.managePresets()}
        />
        <Action
          label="Save / share"
          icon={Camera}
          onClick={() => context.managePresets(true)}
        />
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {QUICK_SHOTS.map((id) => {
          const picture = PICTURES.find((one) => one.id === id)!
          return (
            <PictureCard
              key={id}
              picture={picture}
              onTake={() => context.takePicture(picture, true)}
            />
          )
        })}
      </div>
      <Section
        id="planetarium.presets.framing-tools"
        title="Compose"
        defaultOpen={false}
      >
        <CompositionControls {...context} />
      </Section>
      <Section
        id="planetarium.presets.galaxy-tools"
        title="Galaxy views"
        defaultOpen={false}
      >
        <GalaxySection {...context} />
      </Section>
    </div>
  )
}
