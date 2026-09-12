import type { BodyAppearance, LinearRgb } from '@inertialref/universe'

/**
 * The sphere and ground share this input: reflectance without a map, tint with
 * one. A small body's swatch carries its measured albedo even when a map is
 * present; multiplying both brightnesses would spend that albedo twice.
 */
export function surfaceColor(
  appearance: Pick<BodyAppearance, 'color' | 'texture'>,
): LinearRgb {
  const { color, texture } = appearance
  if (texture === null) return color
  const peak = Math.max(color.r, color.g, color.b)
  if (peak === 0 || peak === 1) return color
  return { r: color.r / peak, g: color.g / peak, b: color.b / peak }
}

/** The geometric albedo Enhanced's calibrated exposure suits. */
const ADAPTED_ALBEDO = 0.12
/** Angular radius at which visibility gain starts, and its transition span. */
const ADAPT_FROM = 0.02
const ADAPT_SPAN = 0.2

/**
 * Enhanced and explicit calibrated staging reveal a dark body filling the
 * frame. This gain belongs to a lit draw, never to its reflectance or bake.
 * One threshold supplies the target too, keeping the transition continuous.
 */
export function surfaceVisibilityGain(
  geometricAlbedo: number,
  angularRadius: number,
  enabled: boolean,
): number {
  if (!enabled || geometricAlbedo >= ADAPTED_ALBEDO) return 1
  const filling = Math.min(
    1,
    Math.max(0, (angularRadius - ADAPT_FROM) / ADAPT_SPAN),
  )
  return 1 + (ADAPTED_ALBEDO / Math.max(geometricAlbedo, 0.01) - 1) * filling
}
