import { objectClass } from '@inertialref/universe'
import type { LabelDensity, SpacecraftScope } from './layers.ts'
import { declutterTiers, type PickCandidate } from './pick.ts'

/*
 * Which names the sky carries, as a function of what is projected.
 *
 * `SkyLabels` draws the answer and positions it every frame; the answer itself
 * is here, pure, because every rule in it is one a reader notices only when it
 * is broken — a sky captioned with asteroids, a subject with no name, a
 * cluster of stations wearing a planet's slot — and none of them fails a test
 * from inside a component.
 */

/**
 * How many names at once, at each of the three densities.
 *
 * More than the top of this range and the sky is a list rather than a sky —
 * which is the whole reason the declutter is greedy and the cap exists. It is a
 * *choice* rather than one constant because the right answer genuinely differs
 * by what is on screen: a single planet with two moons wants every name it can
 * get, and a system seen from outside wants the eight that matter. 8 / 18 / 40.
 */
export const DENSITY: Readonly<Record<LabelDensity, number>> = {
  sparse: 8,
  normal: 18,
  dense: 40,
}

/**
 * How many of those slots spacecraft may take between them: 2, 4 and 8.
 *
 * Inside the density budget and after every natural body, so a cluster at a
 * station cannot take a planet's name. Stations are one or two to a sky now;
 * ships, when they are subjects, are crowds.
 */
export const SPACECRAFT_CAP: Readonly<Record<LabelDensity, number>> = {
  sparse: 2,
  normal: 4,
  dense: 8,
}

/** Minimum separation before one of a pair is dropped, in CSS pixels. */
export const SPACING = { x: 96, y: 18 }

/** Everything the selection reads besides the candidates themselves. */
export interface NameContext {
  readonly density: LabelDensity
  /** Whether asteroids and comets are worth a slot. */
  readonly minor: boolean
  readonly spacecraft: SpacecraftScope
  /** The subject's address. It keeps its name whatever the switches say. */
  readonly subject: string | null
  /** The companion the camera tracks the subject against, if any. */
  readonly companion: string | null
}

/**
 * Whether a spacecraft is named under `nearby`: the subject or the tracked
 * companion, something going round the subject, or anything inside the near
 * field of the eye.
 */
const isNearby = (candidate: PickCandidate, context: NameContext): boolean =>
  candidate.address === context.subject ||
  candidate.address === context.companion ||
  candidate.craft?.parent === context.subject ||
  candidate.craft?.near === true

/** Largest first: the priority the declutter is greedy about. */
const largestFirst = (a: PickCandidate, b: PickCandidate): number =>
  b.radius - a.radius

/**
 * The names to draw, in the order they won their slots.
 *
 * Bodies and stars thin by class and then by size, as they always have. The
 * subject always passes the class switches: `pick.ts` leaves rubble
 * clickable and the catalog lists it, so a reader reaches Bennu by click or by
 * row, and with minor bodies off it would be the one thing on screen with no
 * caption and no selection ring. A thinning rule is about the sky being a
 * list; it is not about the body the reader has just asked for.
 *
 * Spacecraft come after every natural body, inside `SPACECRAFT_CAP`, with one
 * exception: a spacecraft that is the subject goes first of all. A station is
 * a few pixels across in front of a planet that fills the frame, and placed
 * after the planet its name would collide with the planet's whenever the
 * camera looks down on it — the subject losing its ring to the world behind
 * it, which is the failure the subject rule exists to prevent.
 */
export function skyNames(
  candidates: readonly PickCandidate[],
  size: { readonly width: number; readonly height: number },
  context: NameContext,
): PickCandidate[] {
  const natural: PickCandidate[] = []
  const subject: PickCandidate[] = []
  const craft: PickCandidate[] = []
  for (const candidate of candidates) {
    if (
      candidate.offscreen ||
      candidate.x <= 0 ||
      candidate.x >= size.width ||
      candidate.y <= 0 ||
      candidate.y >= size.height ||
      candidate.name.length === 0
    )
      continue
    const of = objectClass(candidate.kind)
    const isSubject = candidate.address === context.subject
    if (of !== 'spacecraft') {
      if (context.minor || isSubject || of !== 'minor') natural.push(candidate)
      continue
    }
    if (isSubject) subject.push(candidate)
    else if (
      context.spacecraft === 'all' ||
      (context.spacecraft === 'nearby' && isNearby(candidate, context))
    )
      craft.push(candidate)
  }
  return declutterTiers(
    [
      { labels: subject, cap: 1 },
      { labels: natural.sort(largestFirst), cap: Number.POSITIVE_INFINITY },
      {
        labels: craft.sort(largestFirst),
        cap: SPACECRAFT_CAP[context.density] - subject.length,
      },
    ],
    SPACING,
    DENSITY[context.density],
  )
}
