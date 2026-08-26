/*
 * The names for the things the View panel switches on and off.
 *
 * Its own module rather than a corner of `ViewPanel.tsx`, for the reason
 * `context.ts` and `presets.ts` are: a `.tsx` that exports a constant beside
 * its components is a file Fast Refresh gives up on, and a full reload in this
 * app rebuilds the `WebGPURenderer` and loses the camera. Two readers need
 * these anyway — the panel that sets them and the label layer that spends them.
 */

/**
 * How many names the sky carries at once.
 *
 * Three steps rather than a slider, because the useful settings are not a
 * continuum: they are "the eight things that matter", "a readable sky", and
 * "caption everything, I am looking for something specific". A slider would
 * make the reader find those three by feel. The counts are in `SkyLabels.tsx`,
 * where the declutter that spends them is.
 */
export type LabelDensity = 'sparse' | 'normal' | 'dense'

export const LABEL_DENSITIES: readonly LabelDensity[] = [
  'sparse',
  'normal',
  'dense',
]

export const isLabelDensity = (value: unknown): value is LabelDensity =>
  typeof value === 'string' &&
  (LABEL_DENSITIES as readonly string[]).includes(value)

/** See `engine/presentation.ts` § `OrbitScope` for what the two mean. */
export const ORBIT_SCOPES = ['context', 'all'] as const

export const isOrbitScope = (value: unknown): value is 'context' | 'all' =>
  value === 'context' || value === 'all'
