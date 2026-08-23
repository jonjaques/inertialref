/*
 * Choosing what a click meant.
 *
 * The planetarium is a pointing interface — "that one, there" — and the whole
 * question is which of the things on screen a pointer at (x, y) was aiming at.
 * Projection belongs to the camera and is done by the caller; what is here is
 * the *decision*, which is the part with a judgement in it and the part a test
 * can pin down.
 */

/** A candidate, already projected to screen pixels by the caller. */
export interface PickCandidate {
  readonly address: string
  readonly name: string
  /** Screen position, CSS pixels, origin top-left. */
  readonly x: number
  readonly y: number
  /** On-screen radius in pixels. Zero for something that projects to a point. */
  readonly radius: number
  /** Behind the camera, or beyond the far plane. Never picked. */
  readonly offscreen: boolean
}

/**
 * How far from a candidate's center a click still counts, in pixels.
 *
 * Generous, and it has to be: most of what is worth clicking in a planetarium
 * is a body a few pixels across, and a hit test against its true radius would
 * make Mercury unclickable from anywhere useful. 24 px is roughly a fingertip,
 * which is also what makes the same rule work on a phone without a second
 * threshold.
 */
export const PICK_SLOP = 24

/**
 * What the pointer is over, or `null`.
 *
 * The ordering rule is the interesting part. Sorting by distance alone means a
 * distant point source three pixels from the cursor beats the planet filling a
 * third of the frame behind it — technically the nearest thing to the pointer,
 * and never what was meant. Sorting by size alone means the largest body on
 * screen swallows every click including the ones aimed at a moon in front of
 * it.
 *
 * So: **anything the pointer is genuinely inside wins, largest first; only when
 * the pointer is inside nothing does proximity decide.** That is the rule every
 * map interface converged on, and it is what makes clicking a planet work at
 * all.
 *
 * Say what it costs, because the obvious reading of "largest first" is the
 * wrong way round: a moon *inside its planet's disk* is not reachable by
 * clicking it — the pointer is inside both and the planet is larger. A moon is
 * picked by being nearer, which is the case when it sits outside the disk
 * (inside neither, so proximity decides) or when its own disk is the only one
 * the pointer is in. For one drawn over its planet, the object panel's list of
 * satellites is the way to reach it. Whether that is the right trade is a
 * design question — `docs/design/planetarium.md` — and not something to change
 * here by adjusting a comparison.
 */
export function pick(
  candidates: readonly PickCandidate[],
  pointer: { readonly x: number; readonly y: number },
  slop: number = PICK_SLOP,
): PickCandidate | null {
  let inside: PickCandidate | null = null
  let nearest: PickCandidate | null = null
  let nearestDistance = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    if (candidate.offscreen) continue
    const distance = Math.hypot(
      candidate.x - pointer.x,
      candidate.y - pointer.y,
    )
    if (distance <= candidate.radius) {
      if (inside === null || candidate.radius > inside.radius)
        inside = candidate
      continue
    }
    if (distance <= slop + candidate.radius && distance < nearestDistance) {
      nearestDistance = distance
      nearest = candidate
    }
  }

  return inside ?? nearest
}

/**
 * Whether two labels overlap enough that drawing both is worse than one.
 *
 * A planetarium draws a name against everything it can see, and in a system
 * viewed from outside that is a dozen names in the same forty pixels. The
 * de-clutter rule is the same one printed star charts use: keep the brighter
 * one, drop the other, and never resolve it by shrinking the type.
 */
export function collides(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  spacing: { readonly x: number; readonly y: number },
): boolean {
  return Math.abs(a.x - b.x) < spacing.x && Math.abs(a.y - b.y) < spacing.y
}

/**
 * Thin a list of labels down to the ones that can be drawn without overlapping.
 *
 * Greedy in the order given, so the caller's ordering *is* the priority — pass
 * them brightest or largest first. Greedy rather than optimal on purpose: the
 * optimal packing changes discontinuously as the camera moves, so labels would
 * flicker in and out as the solver found a different arrangement each frame,
 * and a stable-but-imperfect set is far easier to read than an optimal one that
 * will not hold still.
 */
export function declutter<T extends { readonly x: number; readonly y: number }>(
  labels: readonly T[],
  spacing: { readonly x: number; readonly y: number },
  limit: number,
): T[] {
  const kept: T[] = []
  for (const label of labels) {
    if (kept.length >= limit) break
    if (kept.some((other) => collides(label, other, spacing))) continue
    kept.push(label)
  }
  return kept
}
