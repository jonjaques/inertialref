import { Aperture, Move3d, Orbit, Rocket, Tag } from 'lucide-react'
import { verticalFovDegrees } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { Action } from '../hud/Action.tsx'
import { LENS_CHANNELS } from '../hud/controls.ts'
import { LensSlider } from '../hud/LensSlider.tsx'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { Section } from '../hud/Section.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { releaseFocus } from '../hud/focus.ts'
import { Asteroid, StellarSpan } from '../icons/index.tsx'
import { LABEL_DENSITIES, ORBIT_SCOPES } from './layers.ts'
import type { PlanetariumContext } from './context.ts'

/*
 * What is drawn over the sky, and what the sky is drawn through.
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
 * Two sections, split by what they are about: what is on the sky, and what the
 * sky is seen through. The lens is not a layer — nothing is drawn by it — and
 * putting the field of view among the toggles was the reason this panel had no
 * headings at all.
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
  flare,
  onFlare,
  camera,
  dolly,
  holdFraming,
}: PlanetariumContext) {
  return (
    <div className="flex flex-col gap-1">
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

      <Section
        id="planetarium.view.lens"
        title="Lens"
        trailing={`${verticalFovDegrees(camera.lens).toFixed(0)}°`}
      >
        {/*
         * Three acts, three controls, and the split is the whole section.
         *
         * They shared one slider, and the copy under it told the reader that
         * narrowing the lens "pulls the camera back rather than magnifying" and
         * that "the subject stays the same size". It did not: the angle was
         * recorded and nothing re-solved the standoff until the next focus. A
         * lens change *is* a magnification; a dolly is the one that changes
         * parallax; holding the framing is a solve. Each sentence below is now
         * true of the control it sits under.
         */}
        <div className="flex flex-col gap-1">
          <span className="type-ui flex items-center gap-1.5 text-slate-400">
            <StellarSpan aria-hidden className="size-3.5 shrink-0" />
            {LENS_CHANNELS.zoom.label}
            <span className="type-readout ml-auto text-slate-300">
              {LENS_CHANNELS.zoom.format(camera.lens)}
            </span>
          </span>
          <LensSlider channel="zoom" camera={camera} />
          <p className="type-ui text-pretty text-slate-400">
            magnifies without moving the camera — no parallax, the same picture
            cropped closer
          </p>
        </div>

        <div className="mt-2 flex flex-col gap-1">
          <span className="type-ui flex items-center gap-1.5 text-slate-400">
            <Move3d aria-hidden className="size-3.5 shrink-0" />
            Dolly
            <span className="ml-auto flex gap-1">
              {/* Negative notches close the distance: `applyZoom` takes a
                  multiplier on distance and `ZOOM_PER_NOTCH` is 1.18, so a
                  positive notch retreats. The wheel is signed the same way and
                  these two buttons are the same act with a pointer that has
                  no wheel. */}
              <Action
                label="In"
                title="Move the camera toward the subject"
                onClick={() => dolly(-2)}
              />
              <Action
                label="Out"
                title="Move the camera away from the subject"
                onClick={() => dolly(2)}
              />
              <Action
                label="Hold Framing"
                title="Re-solve the distance so the subject fills the frame at this lens"
                onClick={holdFraming}
              />
            </span>
          </span>
          <p className="type-ui text-pretty text-slate-400">
            moves the camera — the limb turns and the moons shift against the
            disk. Hold Framing solves the distance instead of choosing it.
          </p>
        </div>

        <div className="mt-2 flex flex-col gap-1">
          <span className="type-ui flex items-center gap-1.5 text-slate-400">
            <Aperture aria-hidden className="size-3.5 shrink-0" />
            Glare
            <span className="ml-auto text-slate-300 tabular-nums">
              {Math.round(flare * 100)}%
            </span>
          </span>
          <Slider
            min={0}
            max={100}
            step={5}
            value={[Math.round(flare * 100)]}
            aria-label="Lens glare and artifacts"
            onValueChange={([next]) => {
              if (next !== undefined) onFlare(next / 100)
            }}
            onClick={releaseFocus}
            // The same 24px-of-hit-area-around-a-6px-track geometry
            // `LensSlider` documents. Written out rather than shared, because
            // the two are the same *shape* and not the same control.
            className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
          />
          {/* An aperture is a designed object, so what it does to a bright
              source is a property of the instrument rather than of the star —
              `docs/design/art.md` licenses glare, bloom and diffraction spikes
              on exactly that basis. Which makes turning it down a *lens*
              decision and not a lie: at zero this is what the sky looks like to
              something with no optics in front of it. */}
          <p className="type-ui text-pretty text-slate-400">
            ghosts, streaks and bloom — the aperture’s own signature, not the
            star’s
          </p>
        </div>
      </Section>
    </div>
  )
}
