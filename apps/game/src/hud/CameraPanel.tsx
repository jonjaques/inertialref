import { formatDistance } from '@inertialref/shared'
import {
  compassDegrees,
  effectiveFocalLength,
  lensReadout,
} from '@inertialref/rendering'
import { DEFAULT_FOV_DEG, DEFAULT_LENS } from '../engine/GameEngine.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { Action } from './Action.tsx'
import { type CameraState, LENS_CHANNELS } from './controls.ts'
import { LensSlider } from './LensSlider.tsx'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'

/*
 * The camera, as an adjustable instrument — and where it is pointed.
 *
 * A lens rather than an angle, and the panel is the argument for it: an angle
 * has no aperture, no focus and no exposure, and `docs/design/art.md` commits
 * to all three. 18.84 mm on a 24 mm gauge is the flying default and is also why
 * a planet filling the frame from close up wears a magnified cap of itself. A
 * photographic comparison sometimes wants the longer lens, and reloading to
 * test one is how nobody ever tests one. The sliders write `engine.flightLens`;
 * `CameraRig` applies it, so the value survives the canvas remounting under an
 * HDR change.
 *
 * The readouts under them are the derivations, and two of them settle scope on
 * sight. The hyperfocal distance is 5.4 m at the flight lens, so everything at
 * planetary range is sharp — it climbs with the glass, to 4.5 km at the
 * telephoto end with the zoom racked out, which is the one corner of the
 * controls where defocus reaches the ground. And the diffraction limit is f/12,
 * so the aperture is a free control until it is not.
 *
 * The observatory readout below it moved here out of the planetarium's object
 * panel, and the move is the point rather than a tidy-up. Range, altitude,
 * frame fill, the two orbit angles and the frame id are facts about *where you
 * are standing*, and on a page about Mars they read as a debugger: four rows
 * about the telescope and one about the planet. They are genuinely useful — a
 * shot is composed against fill and phase, and `ir.shot` bookmarks are checked
 * against the address — so they belong beside the lens they describe, in the
 * instrument group, behind the disclosure that says what the instruments are
 * for.
 *
 * The section is absent when nothing is holding the observatory, which is every
 * flight mode. An empty "Observatory" heading in the flight HUD would be a
 * control for a mode that is not running.
 */

export function CameraPanel({ camera }: { camera: CameraState }) {
  /*
   * Six scalars behind `useShallow`, not the status object.
   *
   * `observer` is a fresh object graph on every one of the eight samples a
   * second, so a selector returning it never bails out of a re-render — this
   * panel would rebuild eight times a second beside a camera that has not
   * moved since the session started. Flattened, it re-renders when one of the
   * six actually changes, which while the camera is still is never.
   */
  const eye = useEngine(
    useShallow((snapshot) => {
      const status = snapshot.observer
      if (status === null || status.target === null) return null
      return {
        name: status.target.name,
        address: status.target.address,
        frame: status.target.frame as string,
        radius: status.target.radius,
        distance: status.state.distance,
        azimuth: status.state.azimuth,
        elevation: status.state.elevation,
        altitudeText: status.altitudeText,
        fill: status.fill,
      }
    }),
  )

  /*
   * The viewport the derived readouts are resolved against, and only it.
   *
   * A circle of confusion is a claim about a *display*, so the panel asks the
   * engine what the picture is actually landing on rather than assuming a
   * nominal one. The whole `LensReadout` is a fresh object graph on every one
   * of the eight samples a second and would never bail out of a re-render; two
   * numbers behind `useShallow` change on a resize and at no other time, and
   * the derivation from them is arithmetic this panel can do itself.
   */
  const viewport = useEngine(
    useShallow((snapshot) => snapshot.status?.lens?.viewport ?? null),
  )
  const view = viewport === null ? null : lensReadout(camera.lens, viewport)

  return (
    <div>
      <Section
        id="camera.lens"
        title="Lens"
        // After zoom — what the picture is actually taken at, and what every
        // reading in the Optics section below is computed from. The glass alone
        // reads 19 mm beside an 8.5° field, which is two lenses on one panel.
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
          <span className="text-slate-400">
            Narrow reads like a telephoto photograph; wide is for flying. The
            bookmarks in navigate → shots were composed at{' '}
            {DEFAULT_FOV_DEG.toFixed(0)}°.
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

      {view !== null && (
        <Section
          id="camera.optics"
          title="Optics"
          trailing={`${view.verticalFovDegrees.toFixed(1)}°`}
        >
          <Row
            label="Field"
            value={`${view.verticalFovDegrees.toFixed(1)}° V · ${view.horizontalFovDegrees.toFixed(1)}° H`}
          />
          <Row
            label="Sharp from"
            value={
              view.depthOfField.far === Infinity
                ? `${formatDistance(view.depthOfField.near)} to ∞`
                : `${formatDistance(view.depthOfField.near)} to ${formatDistance(view.depthOfField.far)}`
            }
          />
          <Row
            label="Hyperfocal"
            value={formatDistance(view.depthOfField.hyperfocal)}
          />
          <Row
            label="Aperture"
            value={`⌀ ${view.apertureDiameter.toFixed(1)} mm`}
          />
          {/* A blur circle against the pixel it has to hide inside, and an Airy
              disk against the f-number where it stops fitting. Two-number
              comparisons, so they are two columns rather than a sentence the
              panel would truncate at the ellipsis. */}
          <Row
            label="Blur circle"
            value={`${(view.circleOfConfusion * 1000).toFixed(1)} µm / ${(view.pixelPitch * 1000).toFixed(1)} µm px`}
          />
          <Row
            label="Airy disk"
            value={`${(view.airyDiameter * 1000).toFixed(1)} µm · past f/${view.diffractionLimit.toFixed(0)}`}
          />
          <Row
            label="Resolution"
            value={`${view.pixelAngleMrad.toFixed(2)} · ${view.angularResolutionMrad.toFixed(2)} mrad`}
          />
          <Row
            label="Exposure"
            value={`EV ${view.exposureValue.toFixed(1)} · 1/${Math.round(1 / camera.lens.shutter)} s · ISO ${camera.lens.iso}`}
          />
        </Section>
      )}

      {eye !== null && (
        <>
          <Section
            id="camera.observatory"
            title="Observatory"
            trailing={eye.name}
          >
            <Row label="Range" value={formatDistance(eye.distance)} />
            <Row label="Altitude" value={eye.altitudeText} />
            <Row label="Subject radius" value={formatDistance(eye.radius)} />
            <Row
              label="Fills"
              value={`${Math.round(eye.fill * 100)}% of frame`}
            />
            <Row
              label="Angles"
              // `compassDegrees`, not `% 360`: azimuth accumulates unbounded as
              // you drag and `%` keeps the sign, so the readout showed `-327°
              // az` for a heading of 33°. Elevation is clamped to ±90° and
              // needs none of this.
              value={`${compassDegrees(eye.azimuth)}° az · ${Math.round(
                (eye.elevation * 180) / Math.PI,
              )}° el`}
            />
          </Section>

          <Section id="camera.address" title="Address" trailing={eye.name}>
            <Row label="Text" value={eye.address} wrap />
            <Row label="Frame" value={eye.frame} wrap />
            <div className="mt-1 flex flex-wrap gap-1">
              <Action
                label="Copy Address"
                title="The string every verb, save and log uses"
                onClick={() => {
                  void navigator.clipboard?.writeText(eye.address)
                }}
              />
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
