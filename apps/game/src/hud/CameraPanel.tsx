import { formatDistance } from '@inertialref/shared'
import { compassDegrees } from '@inertialref/rendering'
import { DEFAULT_FOV } from '../engine/GameEngine.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { Action } from './Action.tsx'
import type { CameraState } from './controls.ts'
import { FovSlider } from './FovSlider.tsx'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'

/*
 * The camera, as an adjustable instrument — and where it is pointed.
 *
 * The field of view is the one lens decision in every screenshot: 65° is the
 * flying default, and it is also why a planet filling the frame from close up
 * wears a magnified cap of itself. A photographic comparison sometimes wants
 * the longer lens, and reloading to test one is how nobody ever tests one.
 * The slider writes `engine.fov`; `CameraRig` applies it, so the value
 * survives the canvas remounting under an HDR change.
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

  return (
    <div>
      <Section
        id="camera.lens"
        title="Field of View"
        trailing={`${camera.fov}°`}
      >
        <div className="flex items-center gap-2">
          <FovSlider fov={camera.fov} onFov={camera.onFov} />
          <span className="w-9 shrink-0 text-right text-slate-300 tabular-nums">
            {camera.fov}°
          </span>
          <Action
            label="Reset"
            title={`Back to the ${DEFAULT_FOV}° flying default`}
            disabled={camera.fov === DEFAULT_FOV}
            onClick={() => camera.onFov(DEFAULT_FOV)}
          />
        </div>
        <div className="mt-1 text-slate-400">
          Narrow reads like a telephoto photograph; wide is for flying. The
          bookmarks in navigate → shots were composed at {DEFAULT_FOV}°.
        </div>
      </Section>

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
