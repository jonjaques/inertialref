import { Compass, Tag, Telescope } from 'lucide-react'
import { FovSlider } from '../hud/FovSlider.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import type { PlanetariumContext } from './context.ts'

/** Names, orbits, the ship, and the lens. */
export function ViewPanel({
  labels,
  onLabels,
  orbits,
  onOrbits,
  ship,
  onShip,
  fov,
  onFov,
}: PlanetariumContext) {
  return (
    <div className="flex flex-col gap-2">
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
        label="names"
        detail="draw a name against everything in view"
        on={labels}
        onChange={onLabels}
      />
      <SwitchRow
        icon={Compass}
        label="orbit paths"
        detail="trace each body's path around its primary"
        on={orbits}
        onChange={onOrbits}
      />
      <SwitchRow
        icon={Telescope}
        label="show the ship"
        detail="the hull the flight modes fly, where it actually is"
        on={ship}
        onChange={onShip}
      />

      <div className="mt-1 flex flex-col gap-1">
        <span className="flex items-center justify-between text-[10px] tracking-widest text-sky-400/80 uppercase">
          field of view
          <span className="text-slate-400 tabular-nums">{fov}°</span>
        </span>
        <FovSlider fov={fov} onFov={onFov} />
      </div>
      {/* A lens choice is a framing choice here, not just a crop: the
          observatory solves its distance against this angle, so narrowing the
          lens pulls the camera back rather than magnifying. */}
      <p className="text-[10px] text-slate-400">
        the camera re-solves its distance, so the subject stays the same size
      </p>
    </div>
  )
}
