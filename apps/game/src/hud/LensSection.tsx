import { SensorSection } from './SensorSection.tsx'
import { useId, type ReactNode } from 'react'
import {
  effectiveFocalLength,
  verticalFovDegrees,
} from '@inertialref/rendering'
import {
  CAMERA_LENS,
  RENDER_SENSOR,
  usePersistentState,
} from '../state/preferences.ts'
import { useEngine } from '../state/engineStore.ts'
import { Action } from './Action.tsx'
import { type CameraState, LENS_CHANNELS } from './controls.ts'
import { LensSlider } from './LensSlider.tsx'
import { Section } from './Section.tsx'

// Reset follows the preference's declared default without loading the runtime.
const DEFAULT_LENS = CAMERA_LENS.initial
const DEFAULT_FOV_DEG = verticalFovDegrees(DEFAULT_LENS)

/**
 * The four things a lens is, as four sliders.
 *
 * One component, drawn by the Lens panel in every mode that has a viewport
 * (`LensPanel`) — and nowhere else, because the lens is a persisted preference
 * and two copies of a control for one preference is how a build ends up with
 * two sliders that disagree. The lens is the viewport's instrument, so it is
 * set beside the picture it shapes rather than on a page that cannot show it.
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
  held = false,
  children,
}: {
  /**
   * Whether another instrument owns the lens on screen.
   *
   * A fixed Milky Way view exposes through its own declared lens and keeps
   * this one aside until it is left (`engine.lens`, rule 32). The sliders still
   * read the kept lens, and they are disabled rather than live: moving one
   * would change a lens the picture is not taken through, which reads as a
   * control that does nothing.
   */
  held?: boolean
  /**
   * A fifth row, in the same three columns.
   *
   * The planetarium's glare is one: an aperture's own artifact, so it is a
   * lens channel rather than a section of its own — and only the planetarium
   * draws it, because only the planetarium holds an amount of it.
   */
  children?: ReactNode
}) {
  const [lens, setLens] = usePersistentState(CAMERA_LENS)
  const [sensor] = usePersistentState(RENDER_SENSOR)
  const automaticAvailable = useEngine(
    (snapshot) => snapshot.exposure?.automaticAvailable,
  )
  const manual =
    sensor.mode === 'manual' ||
    (sensor.mode === 'automatic' && automaticAvailable === false)
  const camera: CameraState = { lens, onLens: setLens }
  const id = useId()
  /*
   * Whether the lens is the one flight starts with. Presets fit their own lens
   * and write it here — this is the one lens the planetarium and the ship
   * share — so after "The Rings" the ship flies at the preset's focal length.
   * Saying so on the heading, and making the way back the primary verb, is
   * what keeps that from being a lens nobody remembers choosing.
   */
  const custom =
    lens.focalLength !== DEFAULT_LENS.focalLength ||
    lens.zoom !== DEFAULT_LENS.zoom ||
    lens.fStop !== DEFAULT_LENS.fStop ||
    lens.focus !== DEFAULT_LENS.focus ||
    lens.shutter !== DEFAULT_LENS.shutter ||
    lens.iso !== DEFAULT_LENS.iso
  return (
    <>
      <SensorSection held={held} />
      <Section
        id="camera.lens"
        title="Lens"
        // After zoom — what the picture is actually taken at, and what every
        // reading in the Optics section is computed from. The glass alone reads
        // 19 mm beside an 8.5° field, which is two lenses on one panel.
        // While a Milky Way view holds the optics the number here is the
        // kept lens, and the Optics readings under it are the view's — so the
        // heading says which, or the panel shows two lenses as one.
        trailing={`${effectiveFocalLength(camera.lens).toFixed(0)} mm${held ? ' · kept' : custom ? ' · custom' : ''}`}
      >
        {/*
         * Label and reading on one line, the travel on the next.
         *
         * Three columns on one line is the arrangement every settings page uses
         * and it is the wrong one here. A 19 rem panel minus a 5 rem label and a
         * 7 rem reading leaves the slider about 110 px — a hundred and ten
         * positions for a logarithmic travel from 8.4 to 120 mm, where one pixel
         * is most of a stop. These are the mode's precise controls; the travel is
         * what wants the width, and a label and its reading are two short strings
         * that read perfectly well at opposite ends of a line.
         *
         * It also lets both of them be as long as they need to be. "Focal length"
         * fitted a 5 rem column with nothing to spare, and "31.3 mm · 42°" is
         * within one character of overflowing a 7 rem one.
         */}
        {(['focal', 'zoom', 'aperture', 'focus', 'shutter', 'iso'] as const)
          .filter(
            (channel) => manual || (channel !== 'shutter' && channel !== 'iso'),
          )
          .map((channel) => (
            <div key={channel} className="flex flex-col">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  id={`${id}-${channel}`}
                  className="type-ui shrink-0 text-slate-400"
                >
                  {LENS_CHANNELS[channel].label}
                </span>
                <span className="type-readout truncate text-right text-slate-300">
                  {LENS_CHANNELS[channel].format(camera.lens)}
                </span>
                <span id={`${id}-${channel}-about`} hidden>
                  {LENS_CHANNELS[channel].description}
                </span>
              </div>
              <LensSlider
                channel={channel}
                camera={camera}
                labeledBy={`${id}-${channel}`}
                describedBy={`${id}-${channel}-about`}
                disabled={held}
              />
            </div>
          ))}
        {children}
        <div className="mt-1 flex items-center justify-end gap-2">
          <Action
            label="Reset lens"
            title={`Back to the ${DEFAULT_FOV_DEG.toFixed(0)}° default — ${DEFAULT_LENS.focalLength.toFixed(1)} mm, no zoom, f/${DEFAULT_LENS.fStop.toFixed(1)}, focused at infinity`}
            tone={custom && !held ? 'primary' : 'normal'}
            disabled={held || !custom}
            onClick={() => camera.onLens(DEFAULT_LENS)}
          />
        </div>
      </Section>
    </>
  )
}
