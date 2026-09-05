import { GALAXY_VIEWS } from '@inertialref/rendering'
import { formatShutter } from '../hud/controls.ts'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import { useEngine } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'

export function GalaxySection({ engine, onNotice }: PlanetariumContext) {
  const view = useEngine((s) => s.observer?.galaxyView ?? null)
  return (
    <Section id="planetarium.presets.galaxy" title="Milky Way">
      <div className="grid grid-cols-2 gap-1.5">
        {(['face-on', 'edge-on'] as const).map((id) => (
          <Action
            key={id}
            label={GALAXY_VIEWS[id].label}
            tone={view === id ? 'primary' : 'normal'}
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
        Fixed views through a long exposure. Stellar light, without dust
        extinction. Choose a body to return to its orbit.
      </p>
    </Section>
  )
}
