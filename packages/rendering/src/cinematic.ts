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

/** One line of text this frame. Position is normalised, origin top-left. */
export interface CinematicTextState {
  readonly id: string
  readonly style: CinematicTextStyle
  readonly text: string
  /** Centre of the line, 0..1 across the frame. */
  readonly x: number
  readonly y: number
  /** 0..1; the full list is emitted every frame so the host can keep stable DOM. */
  readonly opacity: number
  /** Uniform scale about the line's centre; 1 except during a logo settle. */
  readonly scale: number
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
}

export const NO_EFFECTS: CinematicEffects = Object.freeze({
  blackout: 0,
  flash: 0,
  streaks: 0,
  nacelleGlow: 0,
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
 * Opacity at `frame` for a fade-hold-fade window.
 *
 * Ramps are smoothstepped rather than linear because the measured pixel-count
 * ramps are S-shaped — a linear dissolve reads as mechanical against the
 * reference. The window degenerates gracefully: a title whose fade-out starts
 * on its last visible frame simply drops over one frame.
 */
export function fadeEnvelope(window: FadeWindow, frame: number): number {
  if (frame < window.firstVisible || frame > window.lastVisible + 1) return 0
  const rise = Math.max(window.fullOpacity - window.firstVisible, 1e-9)
  const fall = Math.max(window.lastVisible + 1 - window.fadeOutStart, 1e-9)
  return Math.min(
    smooth((frame - window.firstVisible) / rise),
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
 * The measured warp-flash shape: 15 frames, build 4 / whiteout 7 / resolve 4,
 * symmetric. Both flashes in the reference land on this envelope, so it is a
 * single function of the start frame rather than two hand-authored ramps.
 */
export function warpFlashEnvelope(
  startFrame: number,
  frame: number,
): WarpFlash {
  const t = frame - startFrame
  if (t < 0 || t > 15) return { flash: 0, streaks: 0 }
  const flash = t < 4 ? smooth(t / 4) : t <= 11 ? 1 : smooth((15 - t) / 4)
  // Streaks lead the wash in and linger after it: the ship stretches into
  // light before the frame floods, and the residual streak is what the eye
  // follows out of the whiteout.
  const streaks = t < 4 ? smooth(t / 3) : smooth((15 - t) / 6)
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
 * `Vec3` spanning AU-scale legs holds micrometre precision in doubles, and
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
 * The orientation whose −Z is `forward` and whose +Y leans towards `upHint`.
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
  // Normalised screen (origin top-left, y down) to camera axes (−Z forward,
  // +Y up): the vertical flips, and x scales by the aspect.
  return Vec.normalize(
    vec3((x * 2 - 1) * tanHalf * aspect, (1 - y * 2) * tanHalf, -1),
  )
}

/**
 * The orientation that puts one world-space target at one screen position,
 * horizon levelled against `upHint`.
 *
 * The single-target relative of `frameTwoTargets`: aim at the target, then
 * rotate the *screen point's* view direction onto the forward axis, so the
 * target lands off-centre by exactly the asked-for amount. Roll comes from the
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
