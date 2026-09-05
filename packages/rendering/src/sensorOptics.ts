import { blackbodyColour } from '@inertialref/universe'
import {
  effectiveFocalLength,
  pixelPitch,
  type Lens,
  type Viewport,
} from './lens.ts'

/** Signed blur diameter in pixels: negative in front of the focus plane. */
export function defocusDiameter(
  lens: Lens,
  viewport: Viewport,
  distance: number,
): number {
  const [scale, inverseFocus] = defocusParameters(lens, viewport)
  return scale * (inverseFocus - 1 / Math.max(1e-6, distance))
}

/** The same thin-lens equation in a form that has a finite infinity limit. */
export function defocusParameters(
  lens: Lens,
  viewport: Viewport,
): readonly [number, number] {
  const f = effectiveFocalLength(lens) / 1000
  const s = Math.max(f + 1e-6, lens.focus)
  return [
    (f * f) /
      (((Math.max(0.1, lens.fStop) * pixelPitch(lens, viewport)) / 1000) *
        (1 - f / s)),
    1 / s,
  ]
}

/** The integration interval belongs to simulated time, including at warp. */
export function shutterFraction(
  shutter: number,
  dt: number,
  enabled: boolean,
): number {
  return enabled && dt > 0 ? Math.min(1, Math.max(0, shutter) / dt) : 0
}

/** Declared diagonal camera balance, relative to the unchanged D65 calibration. */
export function whiteBalance(
  kelvin: number,
): readonly [number, number, number] {
  if (kelvin === 6500) return [1, 1, 1]
  const white = blackbodyColour(Math.max(2000, Math.min(12000, kelvin)))
  const reference = blackbodyColour(6500)
  return [reference.r / white.r, reference.g / white.g, reference.b / white.b]
}
