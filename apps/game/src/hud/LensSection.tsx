import type { ReactNode } from 'react'
import { effectiveFocalLength } from '@inertialref/rendering'
import { DEFAULT_FOV_DEG, DEFAULT_LENS } from '../engine/GameEngine.ts'
import { CAMERA_LENS, usePersistentState } from '../state/preferences.ts'
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
 * sliders that disagree. The same argument `GraphicsPanel` makes about the
 * graphics knobs, applied to the instrument they are knobs on.
 *
 * A lens rather than an angle, and the four channels are the argument: an angle
 * has no aperture, no focus and no exposure, and `docs/design/art.md` commits to
 * all three. 18.84 mm on a 24 mm gauge is the flying default and is also why a
 * planet filling the frame from close up wears a magnified cap of itself. The
 * sliders write the `camera.lens` preference; `state/engineKnobs.ts` carries it
 * to `engine.flightLens` and `CameraRig` applies it, so the value survives the
 * canvas remounting under an HDR change.
 */
export function LensSection({
  children,
}: {
  /**
   * A fifth row, in the same three columns.
   *
   * The planetarium's glare is one: an aperture's own artifact, so it is a
   * lens channel rather than a section of its own — and it is not on
   * `/settings/camera`, because a preference page that offered it would be
   * offering a second writer of a value only the planetarium holds.
   */
  children?: ReactNode
}) {
  const [lens, setLens] = usePersistentState(CAMERA_LENS)
  const camera: CameraState = { lens, onLens: setLens }
  return (
    <Section
      id="camera.lens"
      title="Lens"
      // After zoom — what the picture is actually taken at, and what every
      // reading in the Optics section is computed from. The glass alone reads
      // 19 mm beside an 8.5° field, which is two lenses on one panel.
      trailing={`${effectiveFocalLength(camera.lens).toFixed(0)} mm`}
    >
      {/*
       * Label and reading on one line, the travel on the next.
       *
       * Three columns on one line is the arrangement every settings page uses
       * and it is the wrong one here. A 19 rem panel minus a 5 rem label and a
       * 7 rem reading leaves the slider about 110 px — a hundred and ten
       * positions for a logarithmic travel from 8.4 to 68 mm, where one pixel
       * is most of a stop. These are the mode's precise controls; the travel is
       * what wants the width, and a label and its reading are two short strings
       * that read perfectly well at opposite ends of a line.
       *
       * It also lets both of them be as long as they need to be. "Focal length"
       * fitted a 5 rem column with nothing to spare, and "31.3 mm · 42°" is
       * within one character of overflowing a 7 rem one.
       */}
      {(['focal', 'zoom', 'aperture', 'focus'] as const).map((channel) => (
        <div key={channel} className="flex flex-col">
          <div className="flex items-baseline justify-between gap-3">
            <span className="type-ui shrink-0 text-slate-400">
              {LENS_CHANNELS[channel].label}
            </span>
            <span className="type-readout truncate text-right text-slate-300">
              {LENS_CHANNELS[channel].format(camera.lens)}
            </span>
          </div>
          <LensSlider channel={channel} camera={camera} />
        </div>
      ))}
      {children}
      <div className="mt-1 flex items-center justify-end gap-2">
        <Action
          label="Reset lens"
          title={`Back to the ${DEFAULT_FOV_DEG.toFixed(0)}° default — ${DEFAULT_LENS.focalLength.toFixed(1)} mm, no zoom, f/${DEFAULT_LENS.fStop.toFixed(1)}, focused at infinity`}
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
