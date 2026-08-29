import { Aperture, Compass, Move3d } from 'lucide-react'
import { formatDistance } from '@inertialref/shared'
import { compassDegrees } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { Action } from '../hud/Action.tsx'
import { LensSection } from '../hud/LensSection.tsx'
import { OpticsSection } from '../hud/OpticsSection.tsx'
import { Row } from '../hud/Row.tsx'
import { Section } from '../hud/Section.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { releaseFocus } from '../hud/focus.ts'
import { useActionTitle } from '../input/useKeymap.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'

/*
 * The eye, whole.
 *
 * The planetarium is the mode whose entire subject is *looking*, and its
 * controls for looking were spread across three surfaces, two of them behind a
 * disclosure meant for the author. The aperture, the focus and the exposure
 * were reached by pressing the console key. The View panel — whose title is a
 * claim about what is drawn *over* the sky — carried two of the four lens
 * channels beside the layers, and the author's Camera instrument's own copy
 * pointed the reader at "navigate → shots", a section that composes the ship.
 *
 * The split against View is by what a control *changes*: a layer changes pixels
 * the scene does not own — names, traces, the ship — and the camera changes the
 * picture itself. So View is Layers, and this is the aim, the pose, the dolly
 * and the frame, all four lens channels, the glare — an aperture's own
 * artifact, so a lens control — and the Optics readouts, in the one section
 * whose default is closed.
 *
 * Surface stays a panel of its own. It is the eye on the ground, but its
 * question is *where can I stand*, and that is a list.
 */
export function CameraPanel({
  engine,
  camera,
  dolly,
  frameSubject,
  flare,
  onFlare,
  freeLook,
  onFreeLook,
}: PlanetariumContext) {
  /*
   * Seven scalars behind `useShallow`, not the status object.
   *
   * `observer` is a fresh object graph on every one of the eight samples a
   * second, so a selector returning it never bails out of a re-render — this
   * panel would rebuild eight times a second beside a camera that has not moved
   * since the session opened. Flattened, it re-renders when one of them
   * actually changes, which while the camera is still is never.
   */
  const eye = useEngine(
    useShallow((snapshot) => {
      const status = snapshot.observer
      if (status === null || status.target === null) return null
      return {
        name: status.target.name,
        address: status.target.address,
        radius: status.target.radius,
        distance: status.state.distance,
        azimuth: status.state.azimuth,
        elevation: status.state.elevation,
        altitudeText: status.altitudeText,
        fill: status.fill,
        standing: status.surface !== null,
        yaw: status.look?.yaw ?? 0,
        pitch: status.look?.pitch ?? 0,
        aimed: status.aimed === true,
      }
    }),
  )

  const lookTitle = useActionTitle(
    'observe.freeLook',
    'Make the drag and the arrow keys look instead of orbit',
  )
  const frameTitle = useActionTitle(
    'observe.frame',
    'Solve the distance that fills the frame with the subject at this lens',
  )

  return (
    <div className="flex flex-col gap-1">
      <Section
        id="planetarium.camera.aim"
        title="Aim"
        trailing={eye === null ? undefined : eye.name}
      >
        {/*
         * The toggle, and it is not the only way to look — the secondary button
         * always drags the look. It is the only way on a phone and with a
         * keyboard alone, which is the whole reason it exists as a control
         * rather than as a modifier.
         */}
        <SwitchRow
          icon={Compass}
          label="Free Look"
          detail={
            eye?.standing === true
              ? 'standing, a drag always turns the head'
              : 'drag and the arrows turn the head instead of orbiting'
          }
          on={freeLook || eye?.standing === true}
          disabled={eye?.standing === true}
          onChange={onFreeLook}
          title={lookTitle}
        />
        {eye !== null && (
          <>
            <Row
              label="Look"
              value={
                eye.aimed
                  ? `${compassDegrees(eye.yaw)}° yaw · ${Math.round((eye.pitch * 180) / Math.PI)}° pitch`
                  : 'centred on the subject'
              }
            />
            {/* Enabled only when there is something to undo. A control whose
                effect is null is one the audit says must not be on screen. */}
            <div className="mt-1 flex flex-wrap gap-1">
              <Action
                label="Recentre"
                title="Point the camera back at whatever the pose is framing"
                disabled={!eye.aimed && !eye.standing}
                onClick={() => engine.harness.observatory.centre()}
              />
            </div>
          </>
        )}
      </Section>

      <Section
        id="planetarium.camera.pose"
        title="Pose"
        trailing={eye === null ? undefined : eye.altitudeText}
      >
        {eye === null ? (
          <p className="type-ui text-slate-400">nothing is being looked at</p>
        ) : (
          <>
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

            <div className="mt-2 flex flex-col gap-1">
              <span className="type-ui flex items-center gap-1.5 text-slate-400">
                <Move3d aria-hidden className="size-3.5 shrink-0" />
                Dolly
                <span className="ml-auto flex gap-1">
                  {/* Negative notches close the distance: `applyZoom` takes a
                      multiplier on distance and `ZOOM_PER_NOTCH` is 1.18, so a
                      positive notch retreats. The wheel is signed the same way
                      and these two buttons are the same act with a pointer that
                      has no wheel. Disabled on the ground, where the eye's
                      distance from the center is a *height* the Surface panel
                      owns — a dolly there is a control with no effect. */}
                  <Action
                    label="In"
                    title="Move the camera toward the subject"
                    disabled={eye.standing}
                    onClick={() => dolly(-2)}
                  />
                  <Action
                    label="Out"
                    title="Move the camera away from the subject"
                    disabled={eye.standing}
                    onClick={() => dolly(2)}
                  />
                  {/* "Frame", not "Hold Framing". It solves the distance at
                      which the subject fills `DEFAULT_FILL` of the height at the
                      lens now fitted, and it does not restore a fill the viewer
                      had dollied to, because nothing stores one. */}
                  <Action
                    label="Frame"
                    title={frameTitle}
                    disabled={eye.standing}
                    onClick={frameSubject}
                  />
                </span>
              </span>
              <p className="type-ui text-pretty text-slate-400">
                {eye.standing
                  ? 'in orbit only — on the ground the height is the Surface panel’s'
                  : 'moves the camera — the limb turns and the moons shift against the disk. Frame solves that distance instead of choosing it.'}
              </p>
            </div>
          </>
        )}
      </Section>

      <LensSection camera={camera} />

      <Section
        id="planetarium.camera.glare"
        title="Glare"
        trailing={`${Math.round(flare * 100)}%`}
      >
        <div className="flex flex-col gap-1">
          <span className="type-ui flex items-center gap-1.5 text-slate-400">
            <Aperture aria-hidden className="size-3.5 shrink-0" />
            Artifacts
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

      <OpticsSection camera={camera} />
    </div>
  )
}
