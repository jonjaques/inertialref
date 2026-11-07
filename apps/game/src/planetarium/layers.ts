import type { OrbitScope } from '../engine/presentation.ts'
import { oneOf } from '../state/accept.ts'

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

/*
 * `oneOf` from `state/accept.ts`, which is the closed-set validator every
 * persisted setting already goes through. Written out, each of these is a
 * third and fourth copy of the same three lines — and `isOrbitScope` had also
 * re-declared `OrbitScope` as a literal union, so adding a scope in
 * `presentation.ts` would leave a narrower predicate compiling happily and
 * silently rejecting the stored value.
 */
export const isLabelDensity = oneOf(LABEL_DENSITIES)

/**
 * Which spacecraft take a name.
 *
 * A switch of its own, as minor bodies are, because the question is different
 * from density: a station is a hundred meters across and the sky it hangs in
 * is a planet's, so naming every one in view is a list of hardware over a
 * world. `nearby` is the subject's own, what goes round it, the companion it is
 * tracked against, and anything inside the near field of the eye; `off` names
 * none but the subject, which keeps its name whatever this says.
 */
export type SpacecraftScope = 'nearby' | 'all' | 'off'

export const SPACECRAFT_SCOPES: readonly SpacecraftScope[] = [
  'nearby',
  'all',
  'off',
]

export const SPACECRAFT_SCOPE_LABELS: Readonly<
  Record<SpacecraftScope, string>
> = {
  nearby: 'Nearby',
  all: 'All',
  off: 'Off',
}

export const isSpacecraftScope = oneOf(SPACECRAFT_SCOPES)

/** See `engine/presentation.ts` § `OrbitScope` for what the two mean. */
export const ORBIT_SCOPES: readonly OrbitScope[] = ['context', 'all']

/**
 * What the two scopes are called on a chip.
 *
 * `context` is the field's name for "the subject's own family" and it is not a
 * word anybody reads that way in two syllables on a 24 px control. The stored
 * value stays the id, so rewording this is not a migration.
 */
export const SCOPE_LABELS: Readonly<Record<OrbitScope, string>> = {
  context: 'Nearby',
  all: 'All',
}

export const isOrbitScope = oneOf(ORBIT_SCOPES)
