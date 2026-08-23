import { LIGHT_YEAR, type Meters } from '@inertialref/shared'
import {
  type Quat,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import { lookAlong } from './cinematic.ts'

/*
 * The observer: a camera that orbits a thing rather than flying a ship.
 *
 * This is the planetarium's whole camera model, and it is arithmetic rather
 * than a controller so that it can be tested in Node — the same bargain
 * `cinematic.ts` makes, for the same reason. A pointer drag, a wheel notch, a
 * pinch and an arrow key are four ways of producing the same three numbers;
 * what they produce is here, and where the events come from is the host's
 * problem.
 *
 * Three numbers, not a free 6-DoF camera:
 *
 *   - `azimuth`   — around the target's pole
 *   - `elevation` — above its equator, clamped short of the poles
 *   - `distance`  — from its center, in meters
 *
 * A free camera is what a *flight* mode is for. Orbiting a subject is what
 * makes a planetarium usable with one finger on a phone, and it is also the
 * only model in which "look at Jupiter" has an unambiguous answer. The cost is
 * that you cannot fly between two bodies looking sideways; the benefit is that
 * you can never be lost, which is the failure mode every free-fly space
 * browser has.
 *
 * **Distance is handled logarithmically everywhere.** The range this camera
 * covers is from a kilometer above a moon to a hundred light years, which is
 * nineteen decades. Interpolating that linearly spends 99.9% of a transition
 * in the last decade and appears to teleport; the same trap
 * `screenRoutePosition` documents for a cinematic approach, met again at a
 * larger scale. Every zoom is a multiply and every ease is over `log(distance)`.
 */

/** Where the camera is, relative to the thing it is looking at. */
export interface ObserverState {
  /** Radians around the target's pole. Unbounded — it wraps by construction. */
  readonly azimuth: number
  /** Radians above the target's equatorial plane. Clamped by `ELEVATION_LIMIT`. */
  readonly elevation: number
  /** Meters from the target's center. Always positive. */
  readonly distance: Meters
}

/**
 * How close to a pole the camera may get, radians.
 *
 * Not π/2. At exactly the pole the orbit's azimuth is undefined and the
 * horizon-levelling `upHint` becomes parallel to the view direction, so the
 * frame rolls through a half turn in one mouse-pixel. Two degrees of margin is
 * invisible and removes the singularity rather than special-casing it.
 */
export const ELEVATION_LIMIT = Math.PI / 2 - 0.035

/**
 * The closest the camera may sit to a body, as a multiple of its radius.
 *
 * Half a radius of clearance — 3,186 km over Earth, 869 km over Luna — and it
 * is a clearance from three different things at once, which is why it is not
 * the 1.02 it used to be.
 *
 * **The air.** The atmosphere shell is drawn at `(radius + hazeHeight)` over
 * the sunk sphere, and the tallest one in the Solar System model is Titan's, at
 * **1.155 radii** — 400 km of tholin smog on a 2,575 km moon, which is what
 * makes it a featureless orange ball in every photograph before Cassini's
 * radar. Triton is next at 1.030, then Mars at 1.018 and Earth at 1.016 — so at
 * 1.02 radii the camera sat well inside the first and level with the rest,
 * which is the single worst place to put it. The shell covers the whole
 * viewport, the ray's near end clamps to zero so every pixel marches the full
 * chord, and none of it is a picture of anything: it is the inside of a hazy
 * ball. A phone runs out of fragment budget there long before a laptop does,
 * which is how the bug was reported. `observer.test.ts` states the clearance
 * over every haze the model produces, generated as well as vendored, so the
 * number that has to change if a thicker one is authored is this one.
 *
 * **The ground.** Below about 1.011 radii the terrain streamer starts asking
 * the worker pool for a 3×3 window of patches (`terrainOpacity` fades in over
 * one octave from `radius · 2^-7.5`). Standing on a planet is what flight mode
 * is for; the planetarium wants the body as a body.
 *
 * **The frame.** At 1.5 radii a sphere subtends 84° of diameter, so at the
 * default 65° lens the limb is just off the edges and the disk is still
 * legible as a curved world. Nearer than that the picture is ground with no
 * horizon in it — the planetarium is showing you less the closer it gets,
 * which is the opposite of what zooming in is for.
 *
 * The presets survive it: `RANGES`'s closest framing is `fill: 0.95`, which at
 * the default lens is 1.95 radii and never reaches the floor.
 */
export const MIN_DISTANCE_RADII = 1.5

/**
 * The furthest the camera may retreat from *any* target, meters.
 *
 * Absolute rather than a multiple of the target's radius, and that is the
 * whole point. A radius-relative ceiling puts Luna's at 0.003 ly and a star's
 * at 0.3 ly, so "zoom out from a moon until the neighboring stars appear" —
 * the single most planetarium-shaped gesture there is — would work at a star
 * and refuse at a moon, for a reason no user could ever infer. 120 ly is the
 * catalog's complete sphere with room around it, and it is four orders
 * inside `UNIVERSE_HALF_EXTENT`, so the offset arithmetic below cannot leave
 * the addressable universe from any target the catalog names.
 */
export const MAX_OBSERVER_DISTANCE: Meters = 120 * LIGHT_YEAR

/** Radians of orbit per pixel of drag at the reference sensitivity. */
export const DRAG_RADIANS_PER_PIXEL = 0.005

/** Multiplicative zoom for one wheel notch. */
export const ZOOM_PER_NOTCH = 1.18

export const clampElevation = (elevation: number): number =>
  elevation < -ELEVATION_LIMIT
    ? -ELEVATION_LIMIT
    : elevation > ELEVATION_LIMIT
      ? ELEVATION_LIMIT
      : elevation

/**
 * The distance band for a target of a given radius.
 *
 * Exported because the host needs it twice — to clamp a zoom, and to decide
 * whether a "frame it" button would move the camera at all.
 */
export function distanceBounds(radius: Meters): {
  readonly min: Meters
  readonly max: Meters
} {
  // A zero-radius target is a legitimate thing to look at — a system's
  // barycenter, a Lagrange point, a ship — and it has no surface to clear.
  // 1 km is close enough to be "right there" and far enough to be finite.
  const scale = radius > 0 ? radius : 1_000
  const min = scale * MIN_DISTANCE_RADII
  // A target larger than the ceiling is not a thing the catalog contains,
  // but the band still has to be non-empty or `clampDistance` would invert.
  return { min, max: Math.max(min, MAX_OBSERVER_DISTANCE) }
}

export function clampDistance(distance: Meters, radius: Meters): Meters {
  const { min, max } = distanceBounds(radius)
  return distance < min ? min : distance > max ? max : distance
}

/** A drag, in pixels, applied to the orbit. Right is east; down tilts up. */
export function applyDrag(
  state: ObserverState,
  dxPixels: number,
  dyPixels: number,
  sensitivity = 1,
): ObserverState {
  const k = DRAG_RADIANS_PER_PIXEL * sensitivity
  return {
    azimuth: state.azimuth - dxPixels * k,
    // Dragging *down* raises the camera, because the hand is pulling the
    // globe's near face downwards — the grab metaphor every map uses. The
    // opposite convention is defensible and reads as inverted to everyone who
    // has used a map.
    elevation: clampElevation(state.elevation + dyPixels * k),
    distance: state.distance,
  }
}

/**
 * A zoom, as a multiplier on distance.
 *
 * `factor` above 1 retreats. Wheel notches and pinch gestures both arrive here:
 * a pinch is already a ratio, and a notch becomes one through `ZOOM_PER_NOTCH`.
 */
export function applyZoom(
  state: ObserverState,
  factor: number,
  radius: Meters,
): ObserverState {
  return {
    ...state,
    distance: clampDistance(state.distance * factor, radius),
  }
}

export const zoomFactorForNotches = (notches: number): number =>
  Math.pow(ZOOM_PER_NOTCH, notches)

/**
 * The distance at which a sphere of `radius` fills `fill` of the frame height.
 *
 * `fill` is the fraction of the *vertical* field of view the body's diameter
 * subtends, so 1 is edge-to-edge and the useful framing is nearer 0.6 — a disk
 * with space around it, which is how every planetary photograph anyone
 * recognizes is composed. See `shots.ts`, which makes the same argument in
 * body radii for a fixed lens.
 */
export function framingDistance(
  radius: Meters,
  fovDeg: number,
  fill = 0.6,
): Meters {
  const halfAngle =
    ((fovDeg * Math.PI) / 360) * Math.max(0.01, Math.min(1, fill))
  // The body subtends `halfAngle` from the camera: sin(halfAngle) = r / d for a
  // sphere's true limb. Using tan here — the naive "opposite over adjacent" —
  // frames a body slightly too tight, and visibly so once it fills the frame.
  return radius / Math.sin(halfAngle)
}

/**
 * Where the camera goes, given where the target is.
 *
 * The offset is built in the target's *own* axes and then handed back in
 * universe coordinates: `UV.translate` carries the sector arithmetic, so a
 * camera 40 AU from a star that is 90 light years from the origin is still
 * placed to sub-millimeter precision. Composing this from an `approxMeters`
 * position and a float offset is exactly the mistake ADR-0001 exists to
 * prevent, and it looks fine until you are a few kiloparsecs out.
 */
export function observerPose(
  target: UniverseVector,
  state: ObserverState,
): { readonly position: UniverseVector; readonly orientation: Quat } {
  const offset = observerOffset(state)
  const position = UV.translate(target, offset)
  // The camera looks *inwards*, and the pole is up. `lookAlong` handles the
  // one degenerate case this cannot reach — the elevation clamp is what keeps
  // the view direction off the pole in the first place.
  return {
    position,
    orientation: lookAlong(Vec.negate(offset), vec3(0, 1, 0)),
  }
}

/** The camera's displacement from the target, in the reference plane's axes. */
export function observerOffset(state: ObserverState): Vec3 {
  const cosEl = Math.cos(state.elevation)
  return vec3(
    state.distance * cosEl * Math.cos(state.azimuth),
    state.distance * Math.sin(state.elevation),
    state.distance * cosEl * Math.sin(state.azimuth),
  )
}

/**
 * Ease one observer state toward another, frame-rate independent.
 *
 * Exponential approach rather than a fixed lerp: `1 - exp(-dt/tau)` is the same
 * curve at 30 fps and 144 fps, where `lerp(a, b, 0.1)` is a different
 * time constant on every machine. `tau` is the time to close 63% of the gap.
 *
 * Distance eases in log space and azimuth takes the short way round; both are
 * the difference between a transition that reads as a move and one that reads
 * as a cut. A fly-to from Earth to Proxima is fourteen decades of distance, and
 * a linear ease spends the whole second still in the Solar System.
 */
export function approachState(
  current: ObserverState,
  desired: ObserverState,
  dt: number,
  tau: number,
): ObserverState {
  if (!(dt > 0) || !(tau > 0)) return desired
  const t = 1 - Math.exp(-dt / tau)
  return {
    azimuth:
      current.azimuth + shortestAngle(current.azimuth, desired.azimuth) * t,
    elevation: clampElevation(
      current.elevation + (desired.elevation - current.elevation) * t,
    ),
    distance: Math.exp(
      Math.log(current.distance) +
        (Math.log(desired.distance) - Math.log(current.distance)) * t,
    ),
  }
}

/**
 * The signed rotation from `from` to `to`, in (−π, π].
 *
 * Azimuth is unbounded — it accumulates as you drag — so two headings that name
 * the same direction can be many turns apart numerically. Easing between the
 * raw numbers spins the camera around the body six times to arrive where it
 * already was.
 */
export function shortestAngle(from: number, to: number): number {
  const TAU = Math.PI * 2
  const delta = ((((to - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI
  // The modulo above maps an exact half turn onto −π; π and −π are the same
  // rotation, and picking the positive one makes the function's range match
  // its documentation.
  return delta === -Math.PI ? Math.PI : delta
}

/**
 * An azimuth as a compass bearing: whole degrees in [0, 360).
 *
 * A readout, and it is here rather than in the panel that draws it because the
 * thing it has to get right is a property of `azimuth` itself. Azimuth is
 * unbounded and signed — `applyDrag` subtracts and never wraps, exactly as
 * `shortestAngle` above describes — and JavaScript's `%` is a remainder rather
 * than a modulo, so it keeps the sign. `Math.round(deg) % 360` therefore
 * printed `-23° az` for a rightward drag from the opening state, and `-327°`
 * for a heading of 33°: a bearing swinging between −359 and 359 rather than
 * reading like a compass.
 */
export function compassDegrees(radians: number): number {
  if (!Number.isFinite(radians)) return 0
  const degrees = Math.round((radians * 180) / Math.PI)
  return ((degrees % 360) + 360) % 360
}

/**
 * Where the camera should be to see a body the way the light falls on it.
 *
 * Given the direction from the target to its star, this returns the azimuth and
 * elevation that put the camera at `phaseDeg` from the sun line — the same
 * photographic term `shots.ts` uses, where 0° is a full face and 150° a
 * crescent. It exists so a planetarium preset ("gibbous Saturn") is one call
 * rather than a hand-solved pair of angles, and so the presets agree with the
 * camera bookmarks the flight harness already ships.
 */
export function anglesForPhase(
  toStar: Vec3,
  phaseDeg: number,
  elevationDeg = 0,
): { readonly azimuth: number; readonly elevation: number } {
  const sun = Vec.normalize(toStar)
  const phase = (phaseDeg * Math.PI) / 180
  // The basis is built around the sun line, not the pole — rotating about the
  // pole gets the phase wrong whenever the star sits out of the reference
  // plane, which `placeShot` documents at length and had shipped wrong once.
  const horizontal = Vec.cross(vec3(0, 1, 0), sun)
  const east =
    Vec.length(horizontal) > 1e-6
      ? Vec.normalize(horizontal)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), sun))
  const poleward = Vec.cross(sun, east)
  const tilt = (elevationDeg * Math.PI) / 180
  const swing = Vec.add(
    Vec.scale(east, Math.cos(tilt)),
    Vec.scale(poleward, Math.sin(tilt)),
  )
  const direction = Vec.normalize(
    Vec.add(Vec.scale(sun, Math.cos(phase)), Vec.scale(swing, Math.sin(phase))),
  )
  return {
    azimuth: Math.atan2(direction.z, direction.x),
    elevation: clampElevation(
      Math.asin(Math.max(-1, Math.min(1, direction.y))),
    ),
  }
}
