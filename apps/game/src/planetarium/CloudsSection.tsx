import { AIR_CHECKS, CORNERSTONES, type Picture } from '@inertialref/devtools'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import { useEngine } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'

/** The world a picture stands on, for its group: a station's is its body's. */
const worldOf = (picture: Picture): 'Earth' | 'Mars' | 'A generated world' =>
  picture.address.startsWith('s:SOL/b:2')
    ? 'Earth'
    : picture.address.startsWith('s:SOL/b:3')
      ? 'Mars'
      : 'A generated world'

const GROUPS = (['Earth', 'A generated world', 'Mars'] as const).map(
  (world) => ({
    world,
    pictures: [...CORNERSTONES, ...AIR_CHECKS].filter(
      (one) => worldOf(one) === world,
    ),
  }),
)

/**
 * The pictures the clouds are judged on, a tap each, on a page that can draw
 * the clouds. The weather's cornerstones (ADR-0067) each hold a regime, and
 * the air checks on Mars hold none. The section stays available between
 * pictures, but is hidden on pages without volumetric clouds because a
 * cornerstone without them is a picture of nothing in particular. Labels and
 * no plates, because the cornerstones' plates are the capture's, taken per
 * phase, and none is committed.
 */
export function CloudsSection({
  takePicture,
}: Pick<PlanetariumContext, 'takePicture'>) {
  const cloudsAvailable = useEngine((snapshot) => snapshot.cloudsAvailable)
  if (!cloudsAvailable) return null
  return (
    <Section
      id="planetarium.presets.clouds"
      title="Clouds"
      trailing={`${CORNERSTONES.length + AIR_CHECKS.length}`}
    >
      <div className="flex flex-col gap-1.5">
        {GROUPS.map(({ world, pictures }) => (
          <div key={world} className="flex flex-col gap-1">
            <span className="type-label text-slate-400">{world}</span>
            <div className="grid grid-cols-2 gap-1.5">
              {pictures.map((picture) => (
                <Action
                  key={picture.id}
                  label={picture.label}
                  title={picture.why}
                  onClick={() => takePicture(picture, true)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
