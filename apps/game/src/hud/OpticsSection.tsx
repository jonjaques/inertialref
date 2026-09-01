import { formatReading } from '@inertialref/shared'
import { lensReadout } from '@inertialref/rendering'
import { useEngine, useShallow } from '../state/engineStore.ts'
import type { CameraState } from './controls.ts'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'

/**
 * What the lens does, derived — the readings, not the controls.
 *
 * Two of them settle scope on sight. The hyperfocal distance is 5.4 m at the
 * flight lens, so everything at planetary range is sharp — it climbs with the
 * glass, to 4.5 km at the telephoto end with the zoom racked out, which is the
 * one corner of the controls where defocus reaches the ground. And the
 * diffraction limit is f/12, so the aperture is a free control until it is not.
 *
 * **The one section in the interface whose default is closed.** Every other one
 * opens, because a panel that arrives collapsed is a panel somebody has to
 * discover twice. This is eight derived readings, and a planetarium panel whose
 * first screen is the Airy disk is describing the instrument to somebody who
 * came to look at Saturn. It still persists like the rest, so opening it once
 * is a decision that sticks.
 */
export function OpticsSection({ camera }: { camera: CameraState }) {
  /*
   * The viewport the derived readouts are resolved against, and only it.
   *
   * A circle of confusion is a claim about a *display*, so this asks the engine
   * what the picture is actually landing on rather than assuming a nominal one.
   * The whole `LensReadout` is a fresh object graph on every one of the eight
   * samples a second and would never bail out of a re-render; two numbers
   * behind `useShallow` change on a resize and at no other time, and the
   * derivation from them is arithmetic this component can do itself.
   */
  const viewport = useEngine(
    useShallow((snapshot) => snapshot.status?.lens?.viewport ?? null),
  )
  if (viewport === null) return null
  const view = lensReadout(camera.lens, viewport)

  return (
    <Section
      id="camera.optics"
      title="Optics"
      defaultOpen={false}
      trailing={`${view.verticalFovDegrees.toFixed(1)}°`}
    >
      <Row
        label="Field of view"
        value={`${view.verticalFovDegrees.toFixed(1)}° × ${view.horizontalFovDegrees.toFixed(1)}°`}
      />
      <Row
        label="In focus"
        value={
          view.depthOfField.far === Infinity
            ? `${formatReading(view.depthOfField.near)} to ∞`
            : `${formatReading(view.depthOfField.near)} to ${formatReading(view.depthOfField.far)}`
        }
      />
      <Row
        label="Hyperfocal"
        value={formatReading(view.depthOfField.hyperfocal)}
      />
      <Row
        label="Aperture"
        value={`⌀ ${view.apertureDiameter.toFixed(1)} mm`}
      />
      {/* A blur circle against the pixel it has to hide inside, and an Airy
          disk against the f-number where it stops fitting. Two-number
          comparisons, so they are two columns rather than a sentence the panel
          would truncate at the ellipsis. */}
      <Row
        label="Blur circle"
        value={`${(view.circleOfConfusion * 1000).toFixed(1)} µm / ${(view.pixelPitch * 1000).toFixed(1)} µm px`}
      />
      <Row
        label="Airy disk"
        value={`${(view.airyDiameter * 1000).toFixed(1)} µm · past f/${view.diffractionLimit.toFixed(0)}`}
      />
      {/* What one pixel spans, against what the glass can actually separate.
          Two numbers, so the reader can see which of the two is the limit. */}
      <Row label="Per pixel" value={`${view.pixelAngleMrad.toFixed(2)} mrad`} />
      <Row
        label="Resolving power"
        value={`${view.angularResolutionMrad.toFixed(2)} mrad`}
      />
      <Row
        label="Exposure"
        value={`EV ${view.exposureValue.toFixed(1)} · 1/${Math.round(1 / camera.lens.shutter)} s · ISO ${camera.lens.iso}`}
      />
    </Section>
  )
}
