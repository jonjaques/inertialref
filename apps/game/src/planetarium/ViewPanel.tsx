import { Orbit, Rocket, Tag } from 'lucide-react'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { Section } from '../hud/Section.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { Asteroid } from '../icons/index.tsx'
import { LABEL_DENSITIES, ORBIT_SCOPES } from './layers.ts'
import type { PlanetariumContext } from './context.ts'

/*
 * What is drawn over the sky.
 *
 * Three switches used to be the whole panel — names, orbits, the ship — and
 * each of them was on or off with nothing in between, which is the wrong shape
 * for both of the ones that matter. A label layer is not a boolean: eighteen
 * names is right for a system and wrong for a planet with two moons, and Sol's
 * ninety-two asteroids will take every slot from a distance because the
 * declutter is greedy by screen size. An orbit layer is not a boolean either:
 * the contextual set answers "where is this relative to the planets" and the
 * whole set answers "what does this system look like", and they are different
 * questions rather than more and less of one.
 *
 * So each layer is a switch *and* the one control that says how much of it, and
 * the second control is hidden while its layer is off — a density stepper under
 * a label switch that is off is a control with no effect, which is worse than
 * an absent one.
 *
 * **A layer, and nothing else.** The split against the Camera panel is by what
 * a control changes: a layer changes pixels the scene does not own — names,
 * traces, the ship — and the camera changes the picture itself. The lens sat
 * here beside the toggles, under a title that is a claim about what is drawn
 * *over* the sky, which is the opposite of what a lens does.
 */
export function ViewPanel({
  labels,
  onLabels,
  labelDensity,
  onLabelDensity,
  labelMinor,
  onLabelMinor,
  orbits,
  onOrbits,
  orbitScope,
  onOrbitScope,
  ship,
  onShip,
}: PlanetariumContext) {
  return (
    <div className="flex flex-col gap-1">
      {/*
       * One section, and it carries the panel's own name — which is a heading
       * this panel used to need and now does not. The lens moved to the Camera
       * panel, where the eye is, so there is no second thing here to be told
       * apart from.
       */}
      <Section id="planetarium.view.sky" title="Layers">
        {/*
         * The same `SwitchRow` the graphics panel uses.
         *
         * These were a local `Toggle` whose on state was an open eye and whose
         * off state was a closed one — a lovely glyph and a control a screen
         * reader announced as a toggle *button* with no state at all. The icon
         * stays as the subject; the switch is the state.
         */}
        <SwitchRow
          icon={Tag}
          label="Names"
          detail="draw a name against everything in view"
          on={labels}
          onChange={onLabels}
        />
        {labels && (
          <div className="mb-1 ml-6 flex flex-col gap-1.5 border-l border-slate-800 pl-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="type-ui text-slate-400">Density</span>
              <OptionGroup
                label="Label density"
                value={labelDensity}
                values={LABEL_DENSITIES}
                onChange={onLabelDensity}
              />
            </div>
            <SwitchRow
              icon={Asteroid}
              label="Minor Bodies"
              detail="let asteroids and comets take a name slot"
              on={labelMinor}
              onChange={onLabelMinor}
            />
          </div>
        )}

        <SwitchRow
          icon={Orbit}
          label="Orbit Paths"
          detail="trace each body's path around its primary"
          on={orbits}
          onChange={onOrbits}
        />
        {orbits && (
          <div className="mb-1 ml-6 flex flex-col gap-1.5 border-l border-slate-800 pl-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="type-ui text-slate-400">Scope</span>
              <OptionGroup
                label="Which orbits are traced"
                value={orbitScope}
                values={ORBIT_SCOPES}
                onChange={onOrbitScope}
              />
            </div>
            <p className="type-ui text-pretty text-slate-400">
              {orbitScope === 'context'
                ? 'the subject’s siblings and whatever goes round it'
                : 'every orbit in the system — the architecture, from outside'}
            </p>
          </div>
        )}

        <SwitchRow
          icon={Rocket}
          label="Show the Ship"
          detail="the hull the flight modes fly, where it actually is"
          on={ship}
          onChange={onShip}
        />
      </Section>
    </div>
  )
}
