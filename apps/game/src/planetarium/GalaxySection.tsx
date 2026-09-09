import { GalaxyJourneyControls } from './GalaxyJourneyControls.tsx'
import { GALAXY_VIEWS, type GalaxyView } from '@inertialref/rendering'
import { formatShutter } from '../hud/controls.ts'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import { useEngine } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'

// The record, not a written list: a third instrument is a line in
// `GALAXY_VIEWS` and nothing here.
const VIEWS = Object.keys(GALAXY_VIEWS) as GalaxyView[]

export function GalaxySection({ engine, onNotice }: PlanetariumContext) {
  const selected = useEngine((s) => s.observer?.galaxyView ?? null)
  return (
    <Section id="planetarium.presets.galaxy" title="Milky Way">
      <div className="grid grid-cols-2 gap-1.5">
        {VIEWS.map((id) => (
          <Action
            key={id}
            label={GALAXY_VIEWS[id].label}
            tone={selected === id ? 'primary' : 'normal'}
            onClick={() => {
              const view = GALAXY_VIEWS[id]
              engine.harness.galaxyView(id)
              onNotice(
                `Milky Way, ${view.label.toLowerCase()} · ${formatShutter(view.lens.shutter)} · f/${view.lens.fStop} · ISO ${view.lens.iso}`,
              )
            }}
          />
        ))}
      </div>
      <p className="type-ui mt-1.5 text-pretty text-slate-400">
        The stellar disk through a long exposure. Choose a fixed view or travel
        from Earth to 30 kpc above the center. Dust extinction is absent.
      </p>
      <GalaxyJourneyControls engine={engine} onNotice={onNotice} />
    </Section>
  )
}
