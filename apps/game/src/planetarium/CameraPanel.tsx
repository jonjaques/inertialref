import { TargetControls } from './TargetControls.tsx'
import { Compass } from 'lucide-react'
import { formatReading, wholeDegrees } from '@inertialref/shared'
import { compassDegrees, MIN_STANCE_HEIGHT } from '@inertialref/rendering'
import { Action } from '../hud/Action.tsx'
import { Row } from '../hud/Row.tsx'
import { Section } from '../hud/Section.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { useActionTitle } from '../input/useKeymap.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'
import { GroundSection } from './GroundSection.tsx'
import { useSurveySites } from './useSurveySites.ts'

/*
 * Where the eye is, and how it holds the subject — both arms of it.
 *
 * The camera is in exactly one arm at a time — orbit above half a radius, the
 * ground below it — so a panel per arm is a panel that is entirely disabled
 * whenever the camera is in the other one. In the default view that is nine
 * dead controls under a heading reading "in orbit", which is not a mode
 * indicator, it is a control surface asking to be pressed and refusing.
 *
 * One panel, and the arm decides which section is drawn. The subject and the
 * target head it in both. **Frame** is the orbit arm: the three verbs that
 * move the eye, the readings they move, and the head's offset with the way
 * back from it. **Ground** is the sites, the descent and the heading, and
 * below the floor it is where the pose readouts go.
 *
 * What the eye looks *through* is the Lens panel's (`hud/LensPanel.tsx`), and
 * the split is by question: this panel is "where am I looking from", that one is
 * "through what", and the one-tap framings that answer "show me a crescent"
 * are the Presets panel's. Layers are the View panel's, by what a control
 * changes: a layer changes pixels the scene does not own, and the camera
 * changes the picture itself.
 */
export function CameraPanel(context: PlanetariumContext) {
  const { engine, target, dolly, frameSubject, freeLook, onFreeLook } = context
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

  // One string out of the snapshot, as `LensPanel` reads it.
  const galaxy = useEngine((snapshot) => snapshot.observer?.galaxyView ?? null)

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
      <TargetControls {...context} />

      {/* A Milky Way view has no subject either, and the line above has
          just named what is on screen — "nothing selected" under it would
          contradict the panel's own heading. */}
      {eye === null ? (
        <p className="type-ui px-1 py-2 text-pretty text-slate-400">
          {galaxy === null
            ? 'Nothing selected. Click something in the sky, or pick a row in the navigator.'
            : 'The view holds its own framing. Pick something in the navigator to frame it instead.'}
        </p>
      ) : (
        !standing && (
          <Section id="planetarium.camera.frame" title="Frame">
            {/*
             * The verbs first, because they are what this section is opened
             * for, and the readings under them say what the verbs did.
             *
             * Negative notches close the distance: `applyZoom` takes a
             * multiplier on distance and `ZOOM_PER_NOTCH` is 1.18, so a
             * positive notch retreats. The wheel is signed the same way and
             * these two are the same act with a pointer that has no wheel.
             *
             * "Fit", not "Hold framing". It solves the distance at which the
             * subject fills `DEFAULT_FILL` of the height at the lens now
             * fitted, and it does not restore a fill the viewer had dollied
             * to, because nothing stores one. Primary, because it is the one
             * verb in this row anybody presses twice.
             */}
            <div className="mb-1.5 flex flex-wrap gap-1">
              <Action
                label="Fit"
                tone="primary"
                title={frameTitle}
                onClick={frameSubject}
              />
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
            </div>
            {/* Distance from the center and height above the surface, which
                differ by the subject's radius — and the radius itself is on
                the Object panel, where the facts about the body are. */}
            <Row label="Distance" value={formatReading(eye.distance)} />
            <Row label="Altitude" value={eye.altitudeText} />
            <Row label="Frame fill" value={`${Math.round(eye.fill * 100)}%`} />
            <Row
              label="Azimuth · elevation"
              // `compassDegrees`, not `% 360`: azimuth accumulates unbounded as
              // you drag and `%` keeps the sign, so the readout showed `−327°`
              // for a heading of 33°. Elevation is clamped to ±90° by the arm.
              value={`${compassDegrees(eye.azimuth)}° · ${wholeDegrees(eye.elevation)}°`}
            />
            {/*
             * The head's offset from the subject, while there is one, and the
             * way back. Only in the orbit arm: on the ground the offset *is*
             * the heading and the tilt, which the Ground section shows as two
             * controls of its own.
             */}
            {eye.aimed && (
              <div className="flex items-baseline justify-between gap-2">
                <span className="type-ui shrink-0 text-slate-400">Looking</span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="type-readout truncate text-right text-slate-300">
                    {`${compassDegrees(eye.yaw)}° · ${wholeDegrees(eye.look)}° off ${eye.name}`}
                  </span>
                  <Action
                    label="Recenter"
                    title={`Point the camera back at ${eye.name}`}
                    onClick={() => engine.harness.observatory.center()}
                  />
                </span>
              </div>
            )}
            {/*
             * The toggle, and it is not the only way to look — the secondary
             * button always drags the look. It is the only way on a phone and
             * with a keyboard alone, which is the whole reason it exists as a
             * control rather than as a modifier.
             */}
            <SwitchRow
              icon={Compass}
              label="Free look"
              detail="Drag to turn the head instead of orbiting."
              on={freeLook}
              onChange={onFreeLook}
              title={lookTitle}
            />
          </Section>
        )
      )}

      {eye !== null && (
        <Section
          id="planetarium.camera.ground"
          title="Ground"
          /*
           * Arrives closed: most sessions never land, and a panel whose first
           * screen is six site cards is answering a question nobody asked.
           * The trailing says which arm the camera is in, which is the part a
           * reader needs without opening it — and opening it once is a
           * decision that sticks.
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
    </div>
  )
}
