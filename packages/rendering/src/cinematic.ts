import {
  Quaternion as Q,
  type Quat,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'

/*
 * Cinematic arithmetic: the pure half of the scripted-scene system.
 *
 * A cutscene here is a function of a *frame number* — measured against a
 * reference edit, not against wall clock — returning where the camera and the
 * hero ship are, what text is visible at what opacity, and how hard the
 * screen-space effects are driven. This module holds the arithmetic that
 * function is built from: easings, opacity envelopes, camera routes, and the
 * two-target framing solver. The scripts themselves live in `devtools`
 * (they command a world, like `scenario()` does); the host applies the result
 * (it owns Three.js). Everything here is testable in Node, which matters
 * because the reference for the first script is a *measured* edit — title
 * timings and camera holds are numbers a test can hold the evaluator to.
 *
 * Frames are fractional on purpose. The reference edit runs at its own rate
 * (24000/1001 for film-derived material) while the renderer runs at whatever
 * the display gives it; evaluating at integer frames only would turn a 120 Hz
 * presentation into a 24 Hz slideshow. Envelopes are continuous functions that
 * happen to hit their authored values at integer frames.
 */

/** Camera and hero-ship pose, absolute. The host converts to render space. */
export interface CinematicPose {
  readonly position: UniverseVector
  readonly orientation: Quat
}

/**
 * The typographic roles the overlay knows how to set. Sizes and letterforms
 * are the host's business; the script only says what role a line plays.
 */
export type CinematicTextStyle =
  'logo' | 'subtitle' | 'label' | 'name' | 'card' | 'accent'

/**
 * One line of text this frame. Position is normalized, origin top-left, and
 * every field is live: the reference's main logotype flies in from off-frame
 * and shrinks onto its mark, so `x`, `y` and `scale` are animated channels
 * rather than mount-time layout.
 */
export interface CinematicTextState {
  readonly id: string
  readonly style: CinematicTextStyle
  readonly text: string
  /**
   * The small line above the name — 'Starring', 'Executive Producer'. It rides
   * the same element rather than being its own text because the reference
   * left-aligns it to the *name's* left edge, and the name's width is a
   * property of the typeface the host chose, not a number a script can know.
   * One block, centered, with the label flush left inside it, is the only
   * arrangement that survives a font change.
   */
  readonly label?: string
  /** Center of the name line, 0..1 across the frame. */
  readonly x: number
  readonly y: number
  /** 0..1; the full list is emitted every frame so the host can keep stable DOM. */
  readonly opacity: number
  /** Uniform scale about the line's center; 1 once a title has settled. */
  readonly scale: number
}

/**
 * The anamorphic spike a warp point leaves in the lens: a vertical spindle
 * that swells and dies over ~24 frames. The reference plays it twice, both
 * times as the bridge between a ship leaving at warp and the card that
 * follows, and it is anchored where that ship went — not on the frame's
 * center — so it carries a screen position of its own.
 */
export interface CinematicSpark {
  /** 0..1. */
  readonly drive: number
  /** Screen anchor, normalized, origin top-left. */
  readonly x: number
  readonly y: number
}

/** Screen-space effect drives, all 0..1. */
export interface CinematicEffects {
  /** Full-frame black, over the scene and under the text. */
  readonly blackout: number
  /** The warp-flash wash: blue-white flooding the frame. */
  readonly flash: number
  /** Warp streak blades at the nacelles. */
  readonly streaks: number
  /** Nacelle grille glow, building before a warp-out. */
  readonly nacelleGlow: number
  /**
   * The star's light around an occulting limb, during a total eclipse.
   *
   * **Opt-in, and it has to be.** The ring is drawn from real occlusion
   * geometry, so before this existed it appeared wherever a camera sat on a
   * body's anti-sun line — which in the planetarium is one press of `crescent`
   * away, and on the front door is a third of every slow orbit. At the ranges
   * those cameras work at the physical corona is a fraction of a degree past
   * the limb and the drawn one is nearly a disk radius thick, so what it
   * actually delivered was a gold halo swallowing the frame in a mode that had
   * not asked for an eclipse.
   *
   * It is staging, in other words, not lighting — `tng-intro`'s eclipse shot is
   * composed around it — so it belongs with `blackout` and `flash` in the list
   * of things a script turns on, and it is 0 everywhere else by construction.
   */
  readonly corona: number
  /** The warp point's lens spike. */
  readonly spark: CinematicSpark
}

export const NO_SPARK: CinematicSpark = Object.freeze({
  drive: 0,
  x: 0.5,
  y: 0.5,
})

export const NO_EFFECTS: CinematicEffects = Object.freeze({
  blackout: 0,
  flash: 0,
  streaks: 0,
  nacelleGlow: 0,
  corona: 0,
  spark: NO_SPARK,
})

/** Everything a cutscene decides for one frame. */
export interface CinematicSample {
  readonly frame: number
  readonly camera: CinematicPose
  /** Vertical field of view, degrees — a cinematic lens, not the flight one. */
  readonly fov: number
  readonly ship: CinematicPose & { readonly visible: boolean }
  readonly texts: readonly CinematicTextState[]
  readonly effects: CinematicEffects
  /** True on and after the final frame; the director restores and stops. */
  readonly done: boolean
}

/* ------------------------------------------------------------------------- */
/* Easing                                                                     */
/* ------------------------------------------------------------------------- */

/** Clamp to [0,1]; every easing runs through it so callers never have to. */
export const saturate = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** The classic smoothstep: zero slope at both ends. */
export function smooth(t: number): number {
  const s = saturate(t)
  return s * s * (3 - 2 * s)
}

/** Accelerating from rest — a move that starts imperceptibly. */
export function easeIn(t: number): number {
  const s = saturate(t)
  return s * s * s
}

/** Decelerating to rest — a move that settles rather than stops. */
export function easeOut(t: number): number {
  const s = saturate(t)
  const inv = 1 - s
  return 1 - inv * inv * inv
}

/**
 * Exponential closing distance: `d0` at t=0, `d1` at t=1, constant *ratio* per
 * unit time in between. This is the fly-through-wipe approach law: an object
 * closing at constant speed grows too slowly to read as "incoming" until it is
 * suddenly past; constant fractional closing is what makes a distant dot hang,
 * swell, and then fill the frame in the last few frames — the recipe the
 * reference edit uses three times.
 */
export function expApproach(d0: number, d1: number, t: number): number {
  return d0 * (d1 / d0) ** saturate(t)
}

/** Unclamped linear blend; `t` is expected to arrive already eased. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * How much of its travel a thrown title has completed: 0 off its mark, 1
 * settled on it.
 *
 * Decelerating across the whole travel rather than easing in and out, because
 * the reference's words enter already at speed — they were thrown from
 * off-frame, not started from rest — and the only interesting part of the
 * curve is how they stop.
 *
 * The default power is a fit, not a taste. Tracking the two logotype words
 * through the throw gives the remaining offset at f1140, f1144 and f1148 as
 * 0.271, 0.181 and 0.107 of the frame; consecutive ratios of 0.668 and 0.591
 * both solve to p = 1.93 over a 27-frame travel from f1134, and the same
 * exponent then predicts f1137 to within a thousandth on all six channels —
 * two positions and a scale, per word. A curve that fits six independent
 * measurements is the curve the reference used.
 */
export function arrival(
  startFrame: number,
  frames: number,
  frame: number,
  power = 1.93,
): number {
  const t = saturate((frame - startFrame) / Math.max(frames, 1e-9))
  return 1 - (1 - t) ** power
}

/**
 * The measured spark envelope: 24 frames, rising over 11 and dying over 13.
 *
 * Asymmetric because it is a lens artifact of something *receding* — the
 * spike builds as the warp point brightens and then trails off with the glare
 * rather than snapping shut. Both of the reference's sparks fit this within a
 * frame at either end.
 */
export function sparkEnvelope(startFrame: number, frame: number): number {
  const t = frame - startFrame
  if (t < 0 || t > 24) return 0
  return t <= 11 ? smooth(t / 11) : smooth((24 - t) / 13)
}

/* ------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Title timing, in the terms the reference analysis measured: the frame a
 * title first crosses the visibility threshold, the frame it reaches full
 * opacity, the frame the fade-out starts, and the last visible frame.
 */
export interface FadeWindow {
  readonly firstVisible: number
  readonly fullOpacity: number
  readonly fadeOutStart: number
  readonly lastVisible: number
}

/**
 * How far into its rise a fade has to be before a threshold mask can see it.
 *
 * The reference's `firstVisibleFrame` is not when a title starts appearing —
 * it is when at least 800 pixels of it cross a B>=195 color floor. Text at
 * RGB (64,138,230) over black only clears that floor near full opacity, so a
 * fade that *starts* on the measured frame crosses the threshold several
 * frames late: a captured render measured exactly +4 on all nine cast credits
 * and +5 on the Roddenberry card.
 *
 * The value is fitted to that lag rather than derived from the color math,
 * because the mask counts *pixels* and anti-aliased edges leave the band well
 * before the glyph interiors do. 0.72 of the rise — `smooth(0.72) = 0.809` —
 * brings every credit to +1, which is as close as an integer frame allows.
 */
const THRESHOLD_FRACTION = 0.72

/**
 * Opacity at `frame` for a fade-hold-fade window.
 *
 * Ramps are smoothstepped rather than linear because the measured pixel-count
 * ramps are S-shaped — a linear dissolve reads as mechanical against the
 * reference.
 *
 * The correction is applied to the **rise only**, and that asymmetry is
 * evidence rather than convenience. A captured render put every credit's
 * threshold crossing exactly four frames late and none of them early on the
 * way out, so the leading edge needed `THRESHOLD_FRACTION` and the trailing
 * edge was already right. Applying it symmetrically instead left the main
 * logotype at 70% opacity nine frames after the reference had lost it.
 *
 * The window degenerates gracefully: a title whose fade-out starts on its last
 * visible frame simply drops over one frame.
 */
export function fadeEnvelope(window: FadeWindow, frame: number): number {
  const rise = Math.max(window.fullOpacity - window.firstVisible, 1e-9)
  const fall = Math.max(window.lastVisible + 1 - window.fadeOutStart, 1e-9)
  const start = window.firstVisible - rise * THRESHOLD_FRACTION
  if (frame < start || frame > window.lastVisible + 1) return 0
  return Math.min(
    smooth((frame - start) / rise),
    smooth((window.lastVisible + 1 - frame) / fall),
  )
}

/** The three phases of a warp flash, for hosts that want to know. */
export interface WarpFlash {
  /** The wash intensity, 0..1, peaking through the whiteout. */
  readonly flash: number
  /** Streak drive: rises through the build, dies through the resolve. */
  readonly streaks: number
}

/**
 * The measured warp-flash shape.
 *
 * A rounded hump, and it **starts before its start frame**. The reference's
 * f1085 and f2382 are threshold crossings in the shot detector, not the frame
 * the light begins — exactly the distinction `THRESHOLD_FRACTION` draws for the
 * titles, met again here. Tracked whole-frame means for the first flash, as a
 * fraction of its own peak, run 0.36 at t=0 and 0.56 at t=1: a third of the way
 * up before the envelope had left zero, which a capture reads as a flash two
 * frames late. So the ramp opens at t = −3.5.
 *
 * And the top is round, not flat. The old envelope held exactly 1 from t=4 to
 * t=11 while the reference rises 0.89 → 1.00 → 0.83 across those same eight
 * frames — a plateau a host cannot shape, because a constant input carries no
 * information for it to shape. Peak sits at t≈6–8.
 *
 * One function for both flashes still: their normalized shapes agree. Their
 * *amplitudes* do not — the second peaks 17% brighter in output mean — which is
 * a fact about the two shots, not about the envelope, and is left to the script.
 */
export function warpFlashEnvelope(
  startFrame: number,
  frame: number,
): WarpFlash {
  const t = frame - startFrame
  if (t < -3.5 || t > 16.5) return { flash: 0, streaks: 0 }
  const flash = Math.min(smooth((t + 3.5) / 9), smooth((16.5 - t) / 7.5))
  // Streaks lead the wash in and linger after it: the ship stretches into
  // light before the frame floods, and the residual streak is what the eye
  // follows out of the whiteout. They open with the wash's own early start, so
  // the frame is never flooding over a ship that has not begun to stretch.
  const streaks = t < 2 ? smooth((t + 3.5) / 5.5) : smooth((16.5 - t) / 9)
  return { flash, streaks }
}

/* ------------------------------------------------------------------------- */
/* Routes                                                                     */
/* ------------------------------------------------------------------------- */

/** A camera (or ship) waypoint: where to be at a given frame. */
export interface RouteBeat {
  readonly frame: number
  readonly position: UniverseVector
}

export interface AimBeat {
  readonly frame: number
  readonly orientation: Quat
}

/**
 * Position along a route, Catmull-Rom over non-uniform frame knots.
 *
 * Hermite with finite-difference tangents rather than linear-with-easing,
 * because the long journey shot is one unbroken camera move: a piecewise
 * linear path announces every waypoint with a visible kink in the planet
 * passes, and the whole point of the beats is that nobody can see where they
 * are. Arithmetic runs in displacements from the segment's start beat — a
 * `Vec3` spanning AU-scale legs holds micrometer precision in doubles, and
 * `UniverseVector` remains the only absolute position in the interface.
 *
 * Before the first beat and after the last the route holds still: a cutscene
 * that keeps creeping after its final beat reads as a bug, not a style.
 */
export function routePosition(
  beats: readonly RouteBeat[],
  frame: number,
): UniverseVector {
  const first = beats[0]
  const last = beats[beats.length - 1]
  if (first === undefined || last === undefined)
    throw new Error('routePosition needs at least one beat')
  if (frame <= first.frame || beats.length === 1) return first.position
  if (frame >= last.frame) return last.position

  let i = 0
  while (i + 1 < beats.length && frame >= (beats[i + 1] as RouteBeat).frame)
    i += 1
  const b1 = beats[i] as RouteBeat
  const b2 = beats[i + 1] as RouteBeat
  const b0 = beats[Math.max(0, i - 1)] as RouteBeat
  const b3 = beats[Math.min(beats.length - 1, i + 2)] as RouteBeat

  const span = b2.frame - b1.frame
  const t = (frame - b1.frame) / span

  // Displacements from b1, so the Hermite runs near the origin regardless of
  // where in the universe the route is.
  const p0 = UV.difference(b0.position, b1.position)
  const p2 = UV.difference(b2.position, b1.position)
  const p3 = UV.difference(b3.position, b1.position)

  // Non-uniform finite-difference tangents, scaled to this segment's span.
  const m1 = Vec.scale(
    Vec.sub(p2, p0),
    span / Math.max(b2.frame - b0.frame, 1e-9),
  )
  const m2 = Vec.scale(
    Vec.sub(p3, Vec.ZERO),
    span / Math.max(b3.frame - b1.frame, 1e-9),
  )

  const t2 = t * t
  const t3 = t2 * t
  const h1 = 2 * t3 - 3 * t2 + 1
  const h2 = t3 - 2 * t2 + t
  const h3 = -2 * t3 + 3 * t2
  const h4 = t3 - t2
  const offset = Vec.add(
    Vec.add(Vec.scale(Vec.ZERO, h1), Vec.scale(m1, h2)),
    Vec.add(Vec.scale(p2, h3), Vec.scale(m2, h4)),
  )
  return UV.translate(b1.position, offset)
}

/** A waypoint in frame terms: where in the frame, and how far from the lens. */
export interface ScreenBeat {
  readonly frame: number
  /** Normalized, origin top-left. Values outside 0..1 are off-frame. */
  readonly x: number
  readonly y: number
  /** Distance from the lens, meters. */
  readonly range: number
}

/** The Hermite cubic bracketing a frame: endpoint values and tangents. */
interface SplineSegment {
  readonly v1: number
  readonly v2: number
  readonly m1: number
  readonly m2: number
  /** Where in the segment, 0..1, and how wide it is in frames. */
  readonly t: number
  readonly span: number
}

/**
 * The segment `frame` falls in. Callers guarantee it is strictly inside the
 * knot range, so this never has to say what a held end looks like — the two of
 * them disagree about that (a value holds, a slope goes to zero).
 *
 * Factored out because a spline's value and its slope have to come from the
 * same cubic: `lineVelocity` is only the derivative of `linePosition` if the
 * bracketing, the clamped end knots and the non-uniform tangent scaling are
 * identical, and two copies of this arithmetic would eventually stop being.
 */
function splineSegment(
  frames: readonly number[],
  values: readonly number[],
  frame: number,
): SplineSegment {
  const n = frames.length
  let i = 0
  while (i + 1 < n && frame >= (frames[i + 1] as number)) i += 1
  const f1 = frames[i] as number
  const f2 = frames[i + 1] as number
  const v0 = values[Math.max(0, i - 1)] as number
  const v1 = values[i] as number
  const v2 = values[i + 1] as number
  const v3 = values[Math.min(n - 1, i + 2)] as number
  const f0 = frames[Math.max(0, i - 1)] as number
  const f3 = frames[Math.min(n - 1, i + 2)] as number

  const span = f2 - f1
  return {
    v1,
    v2,
    m1: ((v2 - v0) * span) / Math.max(f2 - f0, 1e-9),
    m2: ((v3 - v1) * span) / Math.max(f3 - f1, 1e-9),
    t: (frame - f1) / span,
    span,
  }
}

/**
 * Non-uniform Catmull-Rom over one scalar channel, held outside the ends.
 * The vector version's arithmetic, applied per channel.
 */
function splineScalar(
  frames: readonly number[],
  values: readonly number[],
  frame: number,
): number {
  const n = frames.length
  if (frame <= (frames[0] as number) || n === 1) return values[0] as number
  if (frame >= (frames[n - 1] as number)) return values[n - 1] as number

  const { v1, v2, m1, m2, t } = splineSegment(frames, values, frame)
  const t2 = t * t
  const t3 = t2 * t
  return (
    (2 * t3 - 3 * t2 + 1) * v1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * v2 +
    (t3 - t2) * m2
  )
}

/**
 * d/d(frame) of `splineScalar` — the Hermite basis differentiated, divided by
 * the segment's span to convert from segment parameter to frames.
 *
 * Analytic rather than a finite difference so that a velocity is exactly the
 * derivative of the position it is published beside, at every frame including
 * the knots. The Catmull-Rom tangents are already scaled by the span, which
 * makes the result continuous across a knot: both segments meeting there
 * report `(v3 - v1) / (f3 - f1)` regardless of how uneven the spacing is.
 *
 * Zero outside the ends, matching `splineScalar`'s hold.
 */
function splineScalarSlope(
  frames: readonly number[],
  values: readonly number[],
  frame: number,
): number {
  const n = frames.length
  if (frame <= (frames[0] as number) || n === 1) return 0
  if (frame >= (frames[n - 1] as number)) return 0

  const { v1, v2, m1, m2, t, span } = splineSegment(frames, values, frame)
  const t2 = t * t
  return (
    ((6 * t2 - 6 * t) * v1 +
      (3 * t2 - 4 * t + 1) * m1 +
      (-6 * t2 + 6 * t) * v2 +
      (3 * t2 - 2 * t) * m2) /
    span
  )
}

/**
 * A route through the *frame*: screen position and apparent size, interpolated
 * in the terms they were measured in.
 *
 * Range is splined in **log space**, which is the whole point. An approach
 * beat list runs from tens of kilometers to tens of meters, and a Catmull-Rom
 * over those magnitudes in meters does what any spline does when its knots
 * span four decades: the tangent at the near end is set by the far one and it
 * overshoots hard — in practice through the camera and out the other side, so
 * a hull that should have been receding at a kilometer simply vanished for
 * twenty frames. Constant *fractional* closing is also the honest description
 * of every approach in the reference, so the log is not a workaround; it is
 * the right coordinate.
 */
export function screenRoutePosition(
  beats: readonly ScreenBeat[],
  frame: number,
  fovDeg: number,
  aspect: number,
): Vec3 {
  const first = beats[0]
  if (first === undefined)
    throw new Error('screenRoutePosition needs at least one beat')
  const frames = beats.map((beat) => beat.frame)
  const x = splineScalar(
    frames,
    beats.map((beat) => beat.x),
    frame,
  )
  const y = splineScalar(
    frames,
    beats.map((beat) => beat.y),
    frame,
  )
  const range = Math.exp(
    splineScalar(
      frames,
      beats.map((beat) => Math.log(Math.max(beat.range, 1e-6))),
      frame,
    ),
  )
  return screenOffset(x, y, range, fovDeg, aspect)
}

/**
 * Orientation along a route: slerp between beats with a smoothstepped
 * parameter, held outside the ends.
 *
 * Smoothstepped because orientation is the one channel the starfield makes
 * visible — translation barely moves a star at shell distance, but every
 * degree of rotation sweeps the whole background, so a segment that starts or
 * stops turning abruptly reads as a camera operator bumping the tripod.
 */
export function routeOrientation(
  beats: readonly AimBeat[],
  frame: number,
): Quat {
  const first = beats[0]
  const last = beats[beats.length - 1]
  if (first === undefined || last === undefined)
    throw new Error('routeOrientation needs at least one beat')
  if (frame <= first.frame || beats.length === 1) return first.orientation
  if (frame >= last.frame) return last.orientation

  let i = 0
  while (i + 1 < beats.length && frame >= (beats[i + 1] as AimBeat).frame)
    i += 1
  const b1 = beats[i] as AimBeat
  const b2 = beats[i + 1] as AimBeat
  const t = smooth((frame - b1.frame) / (b2.frame - b1.frame))
  return Q.slerp(b1.orientation, b2.orientation, t)
}

/* ------------------------------------------------------------------------- */
/* Framing                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The orientation whose −Z is `forward` and whose +Y leans toward `upHint`.
 *
 * `Q.fromUnitVectors` alone leaves the roll wherever the shortest arc dropped
 * it, which for a composition is the one degree of freedom that matters most —
 * a tilted horizon reads as an error before anything else in the frame does.
 *
 * Here rather than in `devtools/shots.ts` (which re-exports it) because the
 * cinematic evaluator needs it and the layering only permits the import in
 * this direction.
 */
export function lookAlong(forward: Vec3, upHint: Vec3): Quat {
  const back = Vec.negate(Vec.normalize(forward))
  let right = Vec.cross(upHint, back)
  // Aiming straight along the hint (a nadir shot) leaves no horizon to level;
  // any perpendicular is as level as any other.
  if (Vec.length(right) < 1e-6) {
    const fallback = Math.abs(back.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)
    right = Vec.cross(fallback, back)
  }
  const x = Vec.normalize(right)
  const y = Vec.cross(back, x)
  return Q.fromBasis(x, y, back)
}

/** Where a screen point sits as a camera-space direction. */
export function screenDirection(
  x: number,
  y: number,
  fovDeg: number,
  aspect: number,
): Vec3 {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360)
  // Normalized screen (origin top-left, y down) to camera axes (−Z forward,
  // +Y up): the vertical flips, and x scales by the aspect.
  return Vec.normalize(
    vec3((x * 2 - 1) * tanHalf * aspect, (1 - y * 2) * tanHalf, -1),
  )
}

/**
 * The camera-space offset that puts a point at a screen position, `range`
 * meters from the lens.
 *
 * The authoring primitive for anything choreographed *against the frame*
 * rather than against the world. A reference edit is measured in screen
 * coordinates and apparent size — "the hull's bbox center is (0.35, 0.51) and
 * it spans 0.70 of the frame at f872" — and converting each of those to meters
 * by hand is where a recreation quietly stops matching: the numbers in the
 * script no longer resemble the numbers in the measurement, so nobody can see
 * that one has drifted from the other. Beats written in this language can be
 * read straight off the analysis and checked against it.
 *
 * `range` is distance from the lens, not depth along the axis, so a beat's
 * apparent size is `length / range` wherever it sits in the frame.
 */
export function screenOffset(
  x: number,
  y: number,
  range: number,
  fovDeg: number,
  aspect: number,
): Vec3 {
  return Vec.scale(screenDirection(x, y, fovDeg, aspect), range)
}

/**
 * Apparent size of an object, as a fraction of the frame's *width*.
 *
 * The inverse of the measurement a bounding box gives: an object `length`
 * across at `range` covers this much of the frame. Used to state a beat's
 * range in the units the reference was measured in, and asserted by tests.
 */
export function apparentWidth(
  length: number,
  range: number,
  fovDeg: number,
  aspect: number,
): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360)
  return length / Math.max(range, 1e-9) / (2 * tanHalf * aspect)
}

/** The range at which `length` covers `fraction` of the frame's width. */
export function rangeForWidth(
  length: number,
  fraction: number,
  fovDeg: number,
  aspect: number,
): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360)
  return length / Math.max(fraction, 1e-9) / (2 * tanHalf * aspect)
}

/**
 * The orientation that puts one world-space target at one screen position,
 * horizon levelled against `upHint`.
 *
 * The single-target relative of `frameTwoTargets`: aim at the target, then
 * rotate the *screen point's* view direction onto the forward axis, so the
 * target lands off-center by exactly the asked-for amount. Roll comes from the
 * hint rather than the solver, which is what a lone planet pass wants — the
 * second target in those compositions is empty space.
 */
export function frameTarget(
  camera: UniverseVector,
  target: {
    readonly at: UniverseVector
    readonly x: number
    readonly y: number
  },
  fovDeg: number,
  aspect: number,
  upHint: Vec3,
): Quat {
  const base = lookAlong(
    Vec.normalize(UV.difference(target.at, camera)),
    upHint,
  )
  const offset = Q.fromUnitVectors(
    screenDirection(target.x, target.y, fovDeg, aspect),
    vec3(0, 0, -1),
  )
  return Q.normalize(Q.multiply(base, offset))
}

/**
 * The orientation that puts two world-space targets at two screen positions —
 * the match-cut solver.
 *
 * The reference edit specifies compositions as screen coordinates ("planet at
 * (0.66, 0.55), sun at (0.45, 0.43)"), and reproducing one from a camera
 * position is exactly the TRIAD problem: build one basis from the world
 * directions, one from the desired view directions, and the rotation between
 * them is the answer. The primary target lands exactly; the secondary lands
 * exactly only if the camera position gives the pair the same angular
 * separation the screen asks for — position controls separation, orientation
 * controls placement, and the solver deliberately does not blur that split.
 */
export function frameTwoTargets(
  camera: UniverseVector,
  primary: {
    readonly at: UniverseVector
    readonly x: number
    readonly y: number
  },
  secondary: {
    readonly at: UniverseVector
    readonly x: number
    readonly y: number
  },
  fovDeg: number,
  aspect: number,
): Quat {
  const worldA = Vec.normalize(UV.difference(primary.at, camera))
  const worldB = Vec.normalize(UV.difference(secondary.at, camera))
  const viewA = screenDirection(primary.x, primary.y, fovDeg, aspect)
  const viewB = screenDirection(secondary.x, secondary.y, fovDeg, aspect)

  // TRIAD: a frame from each pair, primary axis exact, secondary as close as
  // the geometry allows.
  const triad = (a: Vec3, b: Vec3): { x: Vec3; y: Vec3; z: Vec3 } => {
    const x = a
    const zRaw = Vec.cross(a, b)
    const z =
      Vec.length(zRaw) > 1e-9
        ? Vec.normalize(zRaw)
        : Vec.normalize(
            Vec.cross(a, Math.abs(a.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)),
          )
    return { x, y: Vec.cross(z, x), z }
  }

  const world = triad(worldA, worldB)
  const view = triad(viewA, viewB)

  // The rotation taking view axes onto world axes: columns of the world basis
  // against rows of the view basis, composed as quaternions.
  const worldQ = Q.fromBasis(world.x, world.y, world.z)
  const viewQ = Q.fromBasis(view.x, view.y, view.z)
  return Q.normalize(Q.multiply(worldQ, Q.conjugate(viewQ)))
}

/* ------------------------------------------------------------------------- */
/* Straight paths                                                             */
/* ------------------------------------------------------------------------- */

/** One knot of a throttle profile: how far along the line, at what frame. */
export interface AdvanceBeat {
  readonly frame: number
  /** Signed distance from the anchor along `direction`, meters. */
  readonly t: number
}

/**
 * A straight trajectory flown at varying speed: fixed direction, authored
 * throttle.
 *
 * Straight because the reference's passes are straight. Fitting lines to the
 * measured screen tracks leaves a perpendicular residual of 109 m over the
 * 4.0 km cruise approach (2.7%, about a sixth of a hull length, and
 * concentrated where the far-end widths are noisiest) and 19 m over the
 * 35.9 km wipe approach — 0.05%, which is a straight line by any standard the
 * imagery can support. A *constant-velocity* line does not fit: the reference
 * holds range from f760 to f792 at w ≈ 0.40 and then rushes in. Fixed
 * direction and a speed profile is the honest model, and it is also the brief
 * — an enormous starship is massive, stable and approximately linear.
 *
 * What the type buys is not compression. Attitude comes from
 * `orientationAlong`, which cannot slide because it cannot vary; velocity
 * comes from differentiating the advance rather than from finite-differencing
 * a screen spline; and a mirrored pass is the same path with the lateral
 * components of `anchor` and `direction` negated, so the reference's one wipe
 * animation played three times is one `LinePath` used three times — which is
 * also how it was measured.
 *
 * Everything is in camera axes, the frame `screenOffset` produces offsets in,
 * so `anchor` is a displacement from the lens rather than a place in the
 * universe. Fitting one of these from a measured track is
 * `fitLinePath` in devtools: a solver has no business on the sample path.
 */
export interface LinePath {
  /** Camera axes. The point `t = 0` names. */
  readonly anchor: Vec3
  /**
   * Unit, camera axes, and the direction of *flight* — see `orientationAlong`.
   * Taken at its word rather than normalized on every evaluation: a direction
   * that is not unit rescales the whole advance profile silently, and both
   * producers of one (a hand-authored `Vec.normalize` and `fitLinePath`) are
   * already unit.
   */
  readonly direction: Vec3
  /**
   * The throttle. Splined in log distance, so it may not cross or touch zero:
   * an approach is authored as a *negative* advance rising toward the anchor
   * (−4000 → −60 m), a departure as a positive one leaving it.
   */
  readonly advance: readonly AdvanceBeat[]
}

/** An advance profile in the coordinate it is interpolated in. */
interface AdvanceProfile {
  readonly frames: readonly number[]
  /** log of the distance from the anchor, per knot. */
  readonly logs: readonly number[]
  /** Which side of the anchor the whole pass is on: +1 or −1. */
  readonly side: number
}

/**
 * Log, for the reason `screenRoutePosition` splines range in log space —
 * applied to one scalar instead of three channels. An advance running from
 * tens of kilometers to tens of meters has knots spanning four decades, and a
 * Catmull-Rom over those in meters takes its tangent at the near end from the
 * far one: a hull that should still be 60 m out arrives at 6, which at these
 * ranges is through the lens and gone. In log space those same knots are
 * nearly evenly spaced and the spline is nearly a straight line. Constant
 * *fractional* closing is also what the reference actually flies, so the log
 * is the right coordinate rather than a repair for a bad one.
 *
 * A log needs a positive quantity, and an advance that crosses zero has none.
 * A path that flies *through* its anchor is therefore rejected rather than
 * fudged, because all three fudges are worse: clamping the distance to a floor
 * parks the ship at the anchor for the rest of the pass and reads as a freeze;
 * splining `side · log|t|` puts a pole at the crossing and throws the hull to
 * infinity on both sides of it; and adding a constant to make the profile
 * positive is not the same curve — the offset lands inside the log, silently
 * re-authoring the throttle it was supposed to preserve. The fix an author
 * wants instead is to move the anchor: `anchor + t · direction` is unchanged
 * by sliding the anchor along the line and re-basing every `t` by the same
 * amount, so any crossing profile can be re-anchored past the crossing without
 * moving a single knot. Where the anchor sits is a real authoring decision
 * anyway — it is the point the log measures range *from*, and putting it on
 * the destination is what makes the compression land where the frame is
 * changing fastest.
 */
function advanceProfile(path: LinePath): AdvanceProfile {
  const first = path.advance[0]
  if (first === undefined)
    throw new Error('linePath needs at least one advance beat')
  const side = Math.sign(first.t)
  if (side === 0 || path.advance.some((beat) => Math.sign(beat.t) !== side))
    throw new Error(
      'linePath advance must stay strictly on one side of the anchor: ' +
        'log-range has no zero crossing. Re-anchor the line past it.',
    )
  return {
    frames: path.advance.map((beat) => beat.frame),
    logs: path.advance.map((beat) => Math.log(side * beat.t)),
    side,
  }
}

/**
 * Where the ship is at `frame`, in camera axes.
 *
 * Held outside the ends, like every other route here: a pass that keeps
 * creeping past its last beat reads as a bug, not a style.
 */
export function linePosition(path: LinePath, frame: number): Vec3 {
  const { frames, logs, side } = advanceProfile(path)
  const t = side * Math.exp(splineScalar(frames, logs, frame))
  return Vec.add(path.anchor, Vec.scale(path.direction, t))
}

/**
 * How fast the ship is going at `frame`, in camera axes — meters per *frame*,
 * because the advance is meters and the parameter is frames.
 *
 * Differentiated analytically: the advance is `side · exp(u)` for the log
 * spline `u`, so `dt/dframe` is `t · u′`, and `u′` is the same cubic's slope
 * read off the same segment. Cheap, but that is not why. The alternative — a
 * finite difference of the *screen* spline the hull is choreographed by — is
 * precisely the failure this type exists to remove: a beat list read off
 * tracked bounding boxes carries sub-pixel wobble, and a pixel of wobble at
 * the range a pass ends at is a large angular velocity. Deriving an attitude
 * from that is the sliding read, one level further in.
 *
 * Zero outside the ends, matching the held position. The step from zero to
 * flight speed at the first beat is a real discontinuity and a deliberate one:
 * a hold is staging, not flight, and rounding it off would invent a
 * deceleration the reference does not contain.
 */
export function lineVelocity(path: LinePath, frame: number): Vec3 {
  const { frames, logs, side } = advanceProfile(path)
  // d/dframe of side·exp(u) is side·exp(u)·u′, and side·exp(u) is the advance.
  const t = side * Math.exp(splineScalar(frames, logs, frame))
  return Vec.scale(path.direction, t * splineScalarSlope(frames, logs, frame))
}

/* ------------------------------------------------------------------------- */
/* Attitude                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The attitude for flying a `LinePath`: nose along the line, horizon levelled
 * against `upHint`.
 *
 * It takes the path rather than a frame because the answer does not depend on
 * the frame. A straight line has one flight direction, so the derived attitude
 * is a constant and the nose cannot drift off the velocity — there is nothing
 * for it to drift with respect to. Sliding is impossible by construction
 * rather than within a tolerance, which is the whole argument for fitting
 * lines. Authored facing beats carry no such guarantee: between two
 * hand-written vectors the slerp passes through whatever it passes through,
 * and the f1000→f1035 pair swings about 120° in 35 frames with no intermediate
 * that is a flight attitude at all.
 *
 * `direction` is the direction of *flight*, which is why an approach is
 * authored as a negative advance closing on the anchor rather than a positive
 * one shrinking toward it — written the other way the ship flies tail-first.
 * This deliberately does not read the advance to work the sense out: an
 * attitude that silently flips on the sign of a number elsewhere in the
 * literal is worse than one that is wrong in plain sight, and reversing a pass
 * is negating `direction` and every `t`, which describes the identical line.
 */
export function orientationAlong(path: LinePath, upHint: Vec3): Quat {
  return lookAlong(path.direction, upHint)
}

/**
 * An authored maneuver on top of a derived attitude: bank about the nose and
 * pitch about the derived frame's own right axis, in degrees.
 *
 * The reference's only maneuvers are the bank-away, the skim and the warp-out
 * holds, so attitude wants to be one constant per line plus a sparse overlay
 * where the ship actually does something — not a per-shot list of absolute
 * facing vectors that has to re-state the flight direction at every knot.
 *
 * The axes and the multiplication order are `tngIntro.ts`'s existing
 * `facingBeats`: a Z-axis rotation right-multiplied onto `lookAlong`, plus the
 * X-axis pitch its planet passes already use. So the authored bank numbers
 * survive the migration meaning exactly what they meant before — −8, −18 and
 * −14 through the bank-away, 5, 8 and 4 through the skim.
 *
 * No renormalization. `base` and both factors are unit and an overlay is
 * applied once rather than accumulated, so `withAttitude(base, 0, 0)` is
 * `base` itself and a bank alone is bit-identical to what the facing beats
 * produced — which is what makes "the numbers survive" a testable claim rather
 * than a hope. Chaining overlays would need a `Q.normalize`.
 */
export function withAttitude(
  base: Quat,
  bankDeg: number,
  pitchDeg: number,
): Quat {
  const pitch = Q.fromAxisAngle(vec3(1, 0, 0), (pitchDeg * Math.PI) / 180)
  const bank = Q.fromAxisAngle(vec3(0, 0, 1), (bankDeg * Math.PI) / 180)
  return Q.multiply(Q.multiply(base, pitch), bank)
}
