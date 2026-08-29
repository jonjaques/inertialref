import { effectiveFocalLength } from '@inertialref/rendering'
import { DEFAULT_FOV_DEG, DEFAULT_LENS } from '../engine/GameEngine.ts'
import { Action } from './Action.tsx'
import { type CameraState, LENS_CHANNELS } from './controls.ts'
import { LensSlider } from './LensSlider.tsx'
import { Section } from './Section.tsx'

/**
 * The four things a lens is, as four sliders.
 *
 * One component, drawn in two places — the planetarium's Camera panel and
 * `/settings/camera` — because the lens is a persisted preference and two
 * copies of a control for one preference is how a build ends up with two
 * sliders that disagree. The same argument `hud/controls.ts` makes about the
 * graphics knobs, applied to the instrument they are knobs on.
 *
 * A lens rather than an angle, and the four channels are the argument: an angle
 * has no aperture, no focus and no exposure, and `docs/design/art.md` commits to
 * all three. 18.84 mm on a 24 mm gauge is the flying default and is also why a
 * planet filling the frame from close up wears a magnified cap of itself. The
 * sliders write `engine.flightLens`; `CameraRig` applies it, so the value
 * survives the canvas remounting under an HDR change.
 */
export function LensSection({ camera }: { camera: CameraState }) {
  return (
    <Section
      id="camera.lens"
      title="Lens"
      // After zoom — what the picture is actually taken at, and what every
      // reading in the Optics section is computed from. The glass alone reads
      // 19 mm beside an 8.5° field, which is two lenses on one panel.
      trailing={`${effectiveFocalLength(camera.lens).toFixed(0)} mm`}
    >
      {(['focal', 'zoom', 'aperture', 'focus'] as const).map((channel) => (
        <div key={channel} className="flex items-center gap-2">
          <span className="type-ui w-20 shrink-0 text-slate-400">
            {LENS_CHANNELS[channel].label}
          </span>
          <LensSlider channel={channel} camera={camera} />
          <span className="type-readout w-28 shrink-0 text-right text-slate-300">
            {LENS_CHANNELS[channel].format(camera.lens)}
          </span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-pretty text-slate-400">
          Narrow reads like a telephoto photograph; wide is for flying. The
          compositions were solved at {DEFAULT_FOV_DEG.toFixed(0)}°.
        </span>
        <Action
          label="Reset"
          title={`Back to the ${DEFAULT_FOV_DEG.toFixed(0)}° flying default`}
          disabled={
            camera.lens.focalLength === DEFAULT_LENS.focalLength &&
            camera.lens.zoom === DEFAULT_LENS.zoom &&
            camera.lens.fStop === DEFAULT_LENS.fStop &&
            camera.lens.focus === DEFAULT_LENS.focus
          }
          onClick={() => camera.onLens(DEFAULT_LENS)}
        />
      </div>
    </Section>
  )
}
