import { Compass } from 'lucide-react'
import { formatReading } from '@inertialref/shared'
import { compassDegrees, MIN_STANCE_HEIGHT } from '@inertialref/rendering'
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
import { GroundSection } from './GroundSection.tsx'
import { useSurveySites } from './useSurveySites.ts'

/*
 * The eye, both arms of it.
 *
 * The camera is in exactly one arm at a time — orbit above half a radius, the
 * ground below it — so a panel per arm is a panel that is entirely disabled
 * whenever the camera is in the other one. In the default view that is nine
 * dead controls under a heading reading "in orbit", which is not a mode
 * indicator, it is a control surface asking to be pressed and refusing.
 *
 * One panel, and the arm decides which section is drawn. **Aim** and **Lens**
 * are true in both and are always there. **Orbit** is the pose above the floor.
 * **Ground** is the sites, the descent and the heading, and below the floor it
 * is where the pose readouts go.
 *
 * The split against the View panel is by what a control *changes*: a layer
 * changes pixels the scene does not own — names, traces, the ship — and the
 * camera changes the picture itself. Glare is an aperture's own artifact, so it
 * is the fifth channel of the lens rather than a section.
 */
export function CameraPanel({
  engine,
  camera,
  target,
  dolly,
  frameSubject,
  flare,
  onFlare,
  freeLook,
  onFreeLook,
}: PlanetariumContext) {
  const observatory = engine.harness.observatory
  const sites = useSurveySites(engine, target)
  /*
   * Scalars behind `useShallow`, not the status object.
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
      const surface = status.surface
      return {
        name: status.target.name,
        kind: status.target.kind,
        distance: status.state.distance,
        azimuth: status.state.azimuth,
        elevation: status.state.elevation,
        altitudeText: status.altitudeText,
        fill: status.fill,
        standing: surface !== null,
        site: surface?.site ?? null,
        scrub: surface?.scrub ?? 1,
        height: surface?.stance.height ?? 0,
        ground: surface?.groundElevation ?? 0,
        heading: surface?.stance.heading ?? 0,
        pitch: surface?.stance.pitch ?? 0,
        yaw: status.look?.yaw ?? 0,
        look: status.look?.pitch ?? 0,
        aimed: status.aimed === true,
      }
    }),
  )

  const lookTitle = useActionTitle(
    'observe.freeLook',
    'Turn the head with a drag and the arrow keys, instead of orbiting',
  )
  const frameTitle = useActionTitle(
    'observe.frame',
    'Solve the distance that fills the frame with the subject at this lens',
  )

  /*
   * `observatory.standing`, never the sampled `eye.standing`.
   *
   * The snapshot is republished at `PANEL_HZ`, so for up to 125 ms after a
   * press it still says "in orbit". A second press inside that window took the
   * arrival branch again and re-stood on `sites[0]`, which is always the
   * summit — and a summit above the fade line draws nothing. The observatory
   * answers the same question synchronously.
   */
  const visit = (site: string): void => {
    if (observatory.standing) {
      // Already down here: move the stance and keep the height, the heading and
      // the tilt. `stand` reads an absent heading as north and an absent pitch
      // as the horizon, so routing every site press through it would reset both
      // controls beside it on every press.
      observatory.moveTo(site)
      return
    }
    // Through the harness rather than the observatory, so the console verb and
    // this button are the same call and cannot drift on the degrees/radians
    // boundary. `ir.visit` takes degrees; the arm below it takes radians.
    engine.harness.visit(undefined, { site, height: MIN_STANCE_HEIGHT })
  }

  const standing = eye?.standing === true

  return (
    <div className="flex flex-col gap-1">
      <Section
        id="planetarium.camera.aim"
        title="Aim"
        trailing={eye?.name ?? 'nothing'}
      >
        {/*
         * The toggle, and it is not the only way to look — the secondary button
         * always drags the look. It is the only way on a phone and with a
         * keyboard alone, which is the whole reason it exists as a control
         * rather than as a modifier.
         */}
        <SwitchRow
          icon={Compass}
          label="Free look"
          detail={
            standing
              ? 'On the ground a drag always turns the head.'
              : 'Drag to turn the head instead of orbiting.'
          }
          on={freeLook || standing}
          disabled={standing}
          onChange={onFreeLook}
          title={lookTitle}
        />
        {/*
         * Only in the orbit arm. On the ground the look offset *is* the heading
         * and the tilt, which the Ground section shows as two controls — so
         * this row restated one of them as a pair of numbers, beside a Recenter
         * whose tooltip offered to point the camera back at the planet the
         * camera is standing on.
         */}
        {eye !== null && !standing && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="type-ui shrink-0 text-slate-400">Pointing at</span>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="type-readout truncate text-right text-slate-300">
                {eye.aimed
                  ? `${compassDegrees(eye.yaw)}° · ${degrees(eye.look)}°`
                  : eye.name}
              </span>
              {/* Enabled only when there is something to undo. A control whose
                  effect is null is one the audit says must not be on screen. */}
              <Action
                label="Recenter"
                title={`Point the camera back at ${eye.name}`}
                disabled={!eye.aimed}
                onClick={() => engine.harness.observatory.centre()}
              />
            </span>
          </div>
        )}
      </Section>

      {eye === null ? (
        <p className="type-ui px-1 py-2 text-pretty text-slate-400">
          Nothing selected. Click something in the sky, or pick a row in the
          catalog.
        </p>
      ) : (
        !standing && (
          <Section
            id="planetarium.camera.orbit"
            title="Orbit"
            trailing={eye.altitudeText}
          >
            {/* Distance from the center and height above the surface, which
                differ by the subject's radius — and the radius itself is on the
                Object panel, where the facts about the body are. Two numbers
                here, not three. */}
            <Row label="Distance" value={formatReading(eye.distance)} />
            <Row label="Altitude" value={eye.altitudeText} />
            <Row label="Frame fill" value={`${Math.round(eye.fill * 100)}%`} />
            <Row
              label="Azimuth"
              // `compassDegrees`, not `% 360`: azimuth accumulates unbounded as
              // you drag and `%` keeps the sign, so the readout showed `−327°`
              // for a heading of 33°.
              value={`${compassDegrees(eye.azimuth)}°`}
            />
            {/* Clamped to ±90° by the arm, so it needs none of the above. */}
            <Row label="Elevation" value={`${degrees(eye.elevation)}°`} />

            <div className="mt-2 flex items-center gap-1.5">
              <span className="type-ui shrink-0 text-slate-400">Move</span>
              <span className="ml-auto flex gap-1">
                {/* Negative notches close the distance: `applyZoom` takes a
                    multiplier on distance and `ZOOM_PER_NOTCH` is 1.18, so a
                    positive notch retreats. The wheel is signed the same way
                    and these two are the same act with a pointer that has no
                    wheel. */}
                <Action
                  label="Closer"
                  title="Move the camera in — the limb turns and the moons shift against the disk"
                  onClick={() => dolly(-2)}
                />
                <Action
                  label="Farther"
                  title="Move the camera out — the limb turns and the moons shift against the disk"
                  onClick={() => dolly(2)}
                />
                {/* "Fit", not "Hold framing". It solves the distance at which
                    the subject fills `DEFAULT_FILL` of the height at the lens
                    now fitted, and it does not restore a fill the viewer had
                    dollied to, because nothing stores one. Primary, because it
                    is the one verb in this row anybody presses twice. */}
                <Action
                  label="Fit"
                  tone="primary"
                  title={frameTitle}
                  onClick={frameSubject}
                />
              </span>
            </div>
          </Section>
        )
      )}

      {eye !== null && (
        <Section
          id="planetarium.camera.ground"
          title="Ground"
          /*
           * The second section in the interface that arrives closed, and for
           * the same reason as Optics: most sessions never land, and a panel
           * whose first screen is six site cards is answering a question
           * nobody asked on the way to the lens. The trailing says which arm
           * the camera is in, which is the part a reader needs without
           * opening it — and opening it once is a decision that sticks.
           */
          defaultOpen={false}
          trailing={standing ? formatReading(eye.height) : 'in orbit'}
        >
          <GroundSection
            eye={eye}
            sites={sites}
            standing={standing}
            onVisit={visit}
            onScrub={(scrub) => observatory.setStanceScrub(scrub)}
            onHeight={(height) => observatory.setStanceHeight(height)}
            onHeading={(radians) => observatory.setHeading(radians)}
            onPitch={(radians) => observatory.setPitch(radians)}
            onLevel={() => observatory.levelToHorizon()}
            onLeave={() => engine.harness.ascend()}
          />
        </Section>
      )}

      <LensSection camera={camera}>
        {/*
         * Glare is the fifth channel, in the same two lines as the four above it.
         *
         * An aperture is a designed object, so what it does to a bright source
         * is a property of the instrument rather than of the star —
         * `docs/design/art.md` licenses glare, bloom and diffraction spikes on
         * exactly that basis. Which makes it a lens control and not a lie: at
         * zero this is the sky with no optics in front of it. It had a section
         * of its own, with its own slider geometry and a sentence under it, for
         * one number that belongs on the travel the lens already has.
         */}
        <div className="flex flex-col">
          <div className="flex items-baseline justify-between gap-3">
            <span className="type-ui shrink-0 text-slate-400">Glare</span>
            <span className="type-readout truncate text-right text-slate-300">
              {Math.round(flare * 100)}%
            </span>
          </div>
          <Slider
            min={0}
            max={100}
            step={5}
            value={[Math.round(flare * 100)]}
            aria-label="Lens glare — ghosts, streaks and bloom"
            onValueChange={([next]) => {
              if (next !== undefined) onFlare(next / 100)
            }}
            onClick={releaseFocus}
            // The same 24px-of-hit-area-around-a-6px-track geometry
            // `LensSlider` documents. Written out rather than shared, because
            // the two are the same *shape* and not the same control.
            className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
          />
        </div>
      </LensSection>

      <OpticsSection camera={camera} />
    </div>
  )
}

/** Radians as whole degrees, which is every angle this panel prints. */
const degrees = (radians: number): number =>
  Math.round((radians * 180) / Math.PI)
