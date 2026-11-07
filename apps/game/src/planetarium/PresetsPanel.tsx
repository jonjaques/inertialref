import { Camera, Library } from 'lucide-react'
import { PICTURES } from '@inertialref/devtools'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import type { PlanetariumContext } from './context.ts'
import { PictureCard } from './PictureCard.tsx'
import { CompositionControls } from './CompositionControls.tsx'
import { GalaxySection } from './GalaxySection.tsx'

const QUICK_SHOTS = ['earthrise', 'centauri-daybreak', 'far-shore']

/**
 * One tap to a good picture: three of the included shots, the library and
 * the save, the compositions that frame whatever is under the camera, and
 * the Milky Way from outside.
 *
 * The thumbnails lead because they are the answer this panel gives without
 * being asked — a visitor who has not found anything to look at yet is one
 * press from Earthrise. The compositions sit under one heading with the light
 * and the step back beside them: all three move the camera relative to the
 * current subject in one press, and three collapsible headings nested inside
 * a fourth was two clicks to reach the sixteen thumbnails this panel is
 * proudest of.
 */
export function PresetsPanel(context: PlanetariumContext) {
  return (
    <div className="flex flex-col gap-2">
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
      <div className="mb-1 flex flex-wrap gap-1">
        <Action
          label="Library"
          icon={Library}
          title="Every included shot, your saved ones, and the view you have now"
          onClick={() => context.managePresets()}
        />
        <Action
          label="Save view"
          icon={Camera}
          title="Name this view, keep it, or send it as a link"
          onClick={() => context.managePresets(true)}
        />
      </div>
      <Section
        id="planetarium.presets.framing-tools"
        title="Compose"
        defaultOpen={false}
      >
        <CompositionControls {...context} />
      </Section>
      <GalaxySection {...context} />
    </div>
  )
}
