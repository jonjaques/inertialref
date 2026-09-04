/**
 * The crosshair ring's stroke: a light hairline between two dark ones, so the
 * mark reads over whatever is behind it.
 *
 * The ring is the one element the Edge Rule places at the center of the frame
 * with no panel behind it, so nothing composites a ground for it — and a
 * `sky-300/40` hairline on its own measured **1.05:1** against the Sun filling
 * the frame, against the 3:1 floor the rest of the chrome holds with margin.
 * The fix has to come from the mark, and the obvious one — a blend mode that
 * inverts against the background — fails on a mid-gray limb, where an inverted
 * mid-gray is mid-gray. Two dark strokes either side of the light one cannot
 * both vanish: over white the dark pair carries the mark, over the sky the
 * light one does, and over any gray between them one of the two clears 3:1.
 *
 * Border, outer ring and inset ring on one element, which is why this is a
 * class list rather than a component: the two sites that draw it differ only
 * in size.
 */
export const CROSSHAIR_RING =
  'rounded-full border border-sky-200/80 ring-1 ring-slate-950/80 inset-ring-1 inset-ring-slate-950/80'
