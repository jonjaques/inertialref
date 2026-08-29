import type { Meters, Radians, Seconds } from '@inertialref/shared'

/*
 * The lens.
 *
 * One object for the camera's optics, because more than one is a picture
 * composed through one lens and measured through another. The terrain
 * screen-space-error predicate is what makes that expensive rather than untidy:
 * it refines while a patch's grid cell subtends more than `cellPixels`, so the
 * pixels-per-radian decides how much terrain exists. Across the focal-length
 * control alone that number spans 8.1× — 378 px/rad at 110° to 3,062 at 20° —
 * which is three levels of refinement everywhere on the visible disk, and the
 * zoom channel multiplies another 8× on top of it for six levels end to end.
 * The patch demand does not go as the square of it, which is the tempting
 * reading: refinement runs out of *levels* at `surfaceDetailFloor` before it
 * runs out of budget, so 20° at zoom 1 measures 1.9× to 3.2× the patches rather
 * than 66×. Three levels is still the whole disk, and a predicate reading
 * anything but the lens the picture is actually taken with is a guess with all
 * of it riding on it.
 *
 * **A lens is a lens, not an angle.** The canonical fields are focal length,
 * sensor gauge, zoom, f-number, focus distance, shutter and gain; the field of
 * view is derived from the first three. The reverse does not work — an angle
 * cannot produce a depth of field, an Airy disk or an exposure, and
 * `docs/design/art.md` commits to all three. Given 65° there is no f/2.8 and no
 * 18.84 mm; given 18.84 mm on a 24 mm gauge, 65° is one line.
 *
 * **The gauge is the sensor's vertical extent, and it is fixed.** Three's
 * `filmGauge` is the *long* side and `getFilmHeight()` divides it by the aspect
 * ratio, so `setFocalLength` yields an angle that moves when the window does —
 * right for a strip of 35 mm film cropped to a format, wrong for a sensor. A
 * lens whose angle changed on a resize would move the terrain selection, the
 * observatory's standoff and every composed shot with it. So `verticalFov` is
 * aspect-independent, the host writes `camera.fov` (which Three treats as
 * vertical), and the horizontal field is derived where it is needed, from the
 * viewport, which is where the aspect ratio lives.
 *
 * **The viewport is display pixels, not the drawing buffer's.** Supersampling
 * raises the sample count, not the detail a viewer can resolve; feeding a 4× AA
 * buffer height into a screen-space-error predicate asks for 6.5× the patches
 * to draw geometry the resolve filter averages away. The caller divides its
 * supersampling factor out before it gets here. The place to spend on sharper
 * terrain is `cellPixels`, where it is a decision with a number on it.
 *
 * Arithmetic, no Three.js, Node-tested — the same bargain `cinematic.ts` and
 * `observer.ts` make.
 */

/** Millimeters. The glass and the sensor are the only things measured in them. */
export type Millimeters = number

/**
 * The sensor's vertical extent, millimeters.
 *
 * Fixed, and the reason it is a constant rather than a per-lens dial is that
 * every angle in the repository was converted through it once: change it and
 * `lensForFov` returns different focal lengths for the same shipped
 * compositions, which is a change of representation nobody asked for. 24 mm is
 * the height of a full-frame sensor, so the focal lengths this produces are the
 * ones a photographer would recognize — the flight lens comes out at 18.84 mm,
 * which is a wide prime, and the cinematic one at 28.97 mm, which is a normal.
 */
export const DEFAULT_GAUGE: Millimeters = 24

/**
 * How large a blur circle still reads as a point, in display pixels.
 *
 * The 1/1500-of-the-diagonal rule every depth-of-field table is built on is a
 * claim about a 10×8 print viewed at 25 cm. This image is looked at through
 * whatever drawing buffer the browser has, so the circle of confusion is a
 * property of the display: `gauge · tolerance / height`. On a 24 mm gauge over
 * 1520 px that is 23.7 µm, which lands close enough to the 29 µm full-frame
 * convention to be a sanity check rather than a coincidence — and it moves with
 * the display the way the blur it predicts actually does.
 */
export const COC_TOLERANCE_PIXELS = 1.5

/** Green, where the eye is most sensitive. Millimeters, for the optics below. */
const WAVELENGTH: Millimeters = 550e-6

/** Airy disk diameter to the first null: `2.44 · λ · N`. */
const AIRY = 2.44

/** Rayleigh's criterion for two points resolved through an aperture. */
const RAYLEIGH = 1.22

const MM_PER_METER = 1000

/**
 * The camera's optics, as an instrument rather than as a projection matrix.
 *
 * Every field is something a photographer sets. Nothing here is derived, and
 * nothing here depends on the window: a lens taken through a resize is the same
 * lens, which is the property the terrain selection and the framing solver both
 * stand on.
 */
export interface Lens {
  /** Focal length, millimeters, before `zoom`. */
  readonly focalLength: Millimeters
  /** Vertical extent of the sensor, millimeters. */
  readonly gauge: Millimeters
  /**
   * Multiplier on the focal length. 1 is the lens's own.
   *
   * Zoom is not the dolly and it is not framing — it magnifies without moving
   * the camera, so it changes no parallax and no occlusion. The planetarium
   * gives each of the three acts its own control, because one control cannot
   * describe all three without saying something false about two of them.
   */
  readonly zoom: number
  /** f-number: focal length over aperture diameter. */
  readonly fStop: number
  /** Focus distance, meters. `Infinity` is a lens racked to the stop. */
  readonly focus: Meters
  /** Shutter time, seconds. */
  readonly shutter: Seconds
  /** Sensor gain, ISO. */
  readonly iso: number
}

/**
 * The picture's size in *display* pixels.
 *
 * Not the drawing buffer's: see the note at the top of this file. Width is
 * carried because the horizontal field, and only the horizontal field, depends
 * on it.
 */
export interface Viewport {
  readonly width: number
  readonly height: number
}

/**
 * What everything measures against when nobody says.
 *
 * 1920×1080 in display pixels — a stated resolution rather than an implied one,
 * so a terrain figure taken in Node and a terrain figure taken in a browser are
 * comparable by construction. Every number in the terrain baseline is quoted
 * against this and the flight lens.
 */
export const BASELINE_VIEWPORT: Viewport = { width: 1920, height: 1080 }

const MIN_FOCAL: Millimeters = 1e-3

/** Focal length after zoom — the only length the derivations use. */
export const effectiveFocalLength = (lens: Lens): Millimeters =>
  Math.max(MIN_FOCAL, lens.focalLength * lens.zoom)

/** Vertical field of view, radians. Aspect-independent, deliberately. */
export const verticalFov = (lens: Lens): Radians =>
  2 * Math.atan(lens.gauge / (2 * effectiveFocalLength(lens)))

/** The same angle in degrees, which is what Three's `camera.fov` wants. */
export const verticalFovDegrees = (lens: Lens): number =>
  (verticalFov(lens) * 180) / Math.PI

/**
 * Horizontal field of view, radians — the one derivation the viewport enters.
 *
 * The sensor is `gauge · aspect` wide, so this follows the window while the
 * vertical field does not. That asymmetry is the whole point of holding the
 * gauge vertical: a resize changes what is at the sides of the frame and
 * nothing else.
 */
export const horizontalFov = (lens: Lens, viewport: Viewport): Radians =>
  2 *
  Math.atan(
    (lens.gauge * aspectRatio(viewport)) / (2 * effectiveFocalLength(lens)),
  )

/** Width over height, guarded so a zero-height buffer is not a NaN lens. */
export const aspectRatio = (viewport: Viewport): number =>
  viewport.height > 0 ? viewport.width / viewport.height : 1

/** Pixels subtended by one radian at the center of the view. */
export const pixelsPerRadian = (lens: Lens, viewport: Viewport): number =>
  viewport.height / (2 * Math.tan(verticalFov(lens) / 2))

/**
 * The angle one pixel subtends at the center of the view, radians.
 *
 * The reciprocal of `pixelsPerRadian`, and stated as its own function because
 * the two are the identity the terrain predicate and the LOD thresholds both
 * stand on — a body a third of a pixel across and a patch cell sixteen pixels
 * across are the same claim measured in opposite directions.
 */
export const pixelAngle = (lens: Lens, viewport: Viewport): Radians =>
  1 / pixelsPerRadian(lens, viewport)

/**
 * The one-way bridge every angle in the repository converts through.
 *
 * One-way because the conversion loses nothing and the reverse loses
 * everything: a focal length carries an aperture, a depth of field and an
 * exposure, and an angle carries none of them. Existing call sites hold
 * angles — 65° for flight, 45° for the cutscene, a slider between 20° and 110°
 * — and each of them becomes a lens exactly once, here.
 *
 * **The angle is preserved, not rounded.** 24 mm puts the flight lens at
 * 18.836226925409882 mm and the cinematic one at 28.970562748477143 mm, and
 * neither is a round number. Taking the nearest millimeter for tidiness moves
 * the flight field from 65° to 64.6°, and `framingDistance` goes as
 * `1/tan(fov/2)`, so every framed body and every `SHOTS` bookmark would stand
 * off 0.85% further for a reason that appears nowhere in the diff.
 * `tng-intro`'s beats are worse than that: they are fitted frame by frame
 * against a reference edit whose measured criteria are tests.
 */
export function lensForFov(
  degrees: number,
  gauge: Millimeters = DEFAULT_GAUGE,
): Lens {
  /*
   * Clamped, and a non-finite angle becomes the flight lens rather than a NaN
   * focal length. This is fed by a slider, a URL parameter and a restored
   * preference; a NaN focal length is a NaN field of view, a NaN projection
   * matrix and a frame that draws nothing anywhere, with nothing in the console
   * to say which of the three produced it.
   */
  const wanted = Number.isFinite(degrees) ? degrees : FLIGHT_FOV
  const angle = (Math.max(0.01, Math.min(179.99, wanted)) * Math.PI) / 180
  return {
    focalLength: gauge / (2 * Math.tan(angle / 2)),
    gauge,
    zoom: 1,
    fStop: DEFAULT_F_STOP,
    focus: Infinity,
    shutter: DEFAULT_SHUTTER,
    iso: DEFAULT_ISO,
  }
}

/**
 * Every number a lens carries, finite and positive where it has to be.
 *
 * The guard belongs to the object rather than to any one writer of it, because
 * a lens reaches the projection matrix from four directions — a slider, a
 * restored preference, a cutscene script and `window.engine` — and only the
 * first two pass through `lensForFov` or a storage predicate. A NaN focal
 * length is a NaN vertical field and a frame that draws nothing anywhere; a
 * zero one is floored to `MIN_FOCAL`, which is a 179.99° field rather than an
 * error. The expensive case is the observatory: `framingDistance` of NaN
 * survives `clampDistance` — both of its comparisons are false — and `focus`
 * *stores* the standoff it solves, so one bad assignment parks the planetarium
 * at a NaN position permanently, with nothing in the console.
 *
 * `focus` is the one field that is legitimately infinite. A lens racked to the
 * stop is where this camera spends its whole life.
 */
export const isUsableLens = (lens: Lens): boolean =>
  Number.isFinite(lens.focalLength) &&
  lens.focalLength > 0 &&
  Number.isFinite(lens.gauge) &&
  lens.gauge > 0 &&
  Number.isFinite(lens.zoom) &&
  lens.zoom > 0 &&
  Number.isFinite(lens.fStop) &&
  lens.fStop > 0 &&
  Number.isFinite(lens.shutter) &&
  Number.isFinite(lens.iso) &&
  (lens.focus === Infinity || Number.isFinite(lens.focus))

/**
 * The exposure triangle every preset starts from.
 *
 * f/2.8 at 1/60 s and ISO 100 is EV 8.9 — an interior, which is what a cockpit
 * is. They are here so that a lens built from an angle is a *complete*
 * instrument rather than a projection matrix with three holes in it: nothing
 * downstream has to ask whether the aperture is known.
 */
export const DEFAULT_F_STOP = 2.8
export const DEFAULT_SHUTTER: Seconds = 1 / 60
export const DEFAULT_ISO = 100

/**
 * The two lenses the engine ships, and the only two it composes against.
 *
 * `flight` is the camera the game is played through and the fallback for every
 * consumer that cannot see a script's lens. `cinematic` is `tng-intro`'s, and
 * its 45° is what the reference edit's own framing measures at. Both are
 * `lensForFov` of the angle they have always had — the conversion is a change
 * of representation, and the compositions test proves it moved nothing.
 */
export const FLIGHT_FOV = 65
export const CINEMATIC_FOV = 45

/**
 * The angles a lens on this build may be set to, degrees.
 *
 * 20° is a telephoto; past 110° everything fisheyes. Stated as angles even
 * though the lens is canonically a focal length, because the *limits* are
 * perceptual claims about a picture and a focal length is only a claim about a
 * picture once you know the gauge.
 *
 * Here rather than beside the slider that spends them, because two things
 * outside the shell solve against the same range: `riseStance`'s lens, which
 * clamps at the long end and says so, and the terrain predicate, whose
 * saturation at 20° is the reason the long end is where it is
 * (`TERRAIN-PLAN.md` § 8).
 */
export const FOV_MIN = 20
export const FOV_MAX = 110

export const LENS_PRESETS = {
  flight: lensForFov(FLIGHT_FOV),
  cinematic: lensForFov(CINEMATIC_FOV),
} as const satisfies Record<string, Lens>

/**
 * A lens and the pixels it lands on — everything a derivation needs.
 *
 * The pair travels together because half the interesting quantities need both:
 * the circle of confusion, the depth of field and the pixel angle are all
 * claims about a lens *on a display*, and a consumer given only the lens would
 * have to find the viewport somewhere else, which is where a second producer
 * comes from.
 */
export interface LensView {
  readonly lens: Lens
  readonly viewport: Viewport
}

/** Aperture diameter, millimeters: `f / N`. 6.7 mm at the flight lens. */
export const apertureDiameter = (lens: Lens): Millimeters =>
  effectiveFocalLength(lens) / Math.max(0.1, lens.fStop)

/** One display pixel's footprint on the sensor, millimeters. */
export const pixelPitch = (lens: Lens, viewport: Viewport): Millimeters =>
  viewport.height > 0 ? lens.gauge / viewport.height : lens.gauge

/** How large a blur circle still reads as sharp, millimeters. */
export const circleOfConfusion = (
  lens: Lens,
  viewport: Viewport,
): Millimeters => pixelPitch(lens, viewport) * COC_TOLERANCE_PIXELS

/**
 * Focus here and everything from half this distance to infinity is sharp.
 *
 * 5.37 m at the flight lens over a 1520 px buffer, and 69.9 m at the telephoto
 * end of the focal-length slider — which settles a scope question on the spot:
 * **depth of field does not reach terrain at any lens the game is flown
 * behind.** At any planetary distance everything is past hyperfocal and sharp,
 * so defocus is a near-field and photo-mode effect (the hull, the cockpit, a
 * rock two meters away). That is why the blur *pass* can be deferred without
 * blocking a terrain phase while the *parameters* cannot — diffraction and
 * exposure act at every scale.
 *
 * It climbs with the glass, and the zoom channel is where it stops being a
 * near-field number: 68 mm at 8× is 544 mm effective and a hyperfocal of
 * **4.47 km**, so a viewer standing on a moon with the telephoto racked out has
 * ground inside the near limit. That corner is what the blur pass owes an answer
 * to when it arrives; it is not a reason to hold the parameters back.
 */
export function hyperfocalDistance(lens: Lens, viewport: Viewport): Meters {
  const f = effectiveFocalLength(lens)
  const c = circleOfConfusion(lens, viewport)
  return (f * f) / (lens.fStop * c) / MM_PER_METER + f / MM_PER_METER
}

/** Where sharpness begins and ends, meters. `far` is `Infinity` past hyperfocal. */
export interface DepthOfField {
  readonly near: Meters
  readonly far: Meters
  readonly hyperfocal: Meters
}

/**
 * The sharp band around the focus distance.
 *
 * Written in millimeters throughout and converted once at the end, because the
 * focal length is the smallest term in every one of these expressions and
 * mixing units is how a depth-of-field formula silently becomes a scale factor.
 * A lens focused at infinity is the limiting case rather than a special one:
 * its near limit *is* the hyperfocal distance.
 */
export function depthOfField(lens: Lens, viewport: Viewport): DepthOfField {
  const hyperfocal = hyperfocalDistance(lens, viewport)
  if (!Number.isFinite(lens.focus))
    return { near: hyperfocal, far: Infinity, hyperfocal }
  const f = effectiveFocalLength(lens)
  const h = hyperfocal * MM_PER_METER
  const s = lens.focus * MM_PER_METER
  /*
   * Focus nearer than the focal length is not a distance a lens has, and the
   * general formula does not degrade gracefully there: both limits go to `f`
   * and rounding leaves the near one an ulp beyond the far one, which reads as
   * an inverted band. The collapse is stated instead.
   */
  if (s <= f)
    return { near: f / MM_PER_METER, far: f / MM_PER_METER, hyperfocal }
  const near = (s * (h - f)) / (s + h - 2 * f)
  const far = s >= h ? Infinity : (s * (h - f)) / (h - s)
  return {
    near: near / MM_PER_METER,
    far: far === Infinity ? Infinity : far / MM_PER_METER,
    hyperfocal,
  }
}

/**
 * Diameter of the Airy disk on the sensor, millimeters.
 *
 * 3.8 µm at f/2.8, against a 15.8 µm pixel on a 1520 px buffer — so the flight
 * lens is nowhere near diffraction-limited and stopping down is free until it
 * is. `diffractionLimit` says where that stops being true.
 */
export const airyDiameter = (lens: Lens): Millimeters =>
  AIRY * WAVELENGTH * lens.fStop

/** The f-number past which the Airy disk outgrows a pixel. f/11.8 at 1520 px. */
export const diffractionLimit = (lens: Lens, viewport: Viewport): number =>
  pixelPitch(lens, viewport) / (AIRY * WAVELENGTH)

/** Two points this far apart are resolved, radians. 0.10 mrad at the flight lens. */
export const angularResolution = (lens: Lens): Radians =>
  (RAYLEIGH * WAVELENGTH) / apertureDiameter(lens)

/**
 * Exposure value, the photographer's single number for a shot's brightness.
 *
 * `log₂(N²/t) − log₂(ISO/100)`: EV 8.9 at f/2.8, 1/60 s and ISO 100. The
 * adaptation loop and the Direct/Composite modes in `docs/design/art.md` are
 * what eventually spend it; it is derived here so that when they arrive there is
 * one place the exposure comes from rather than a second, disagreeing one.
 */
export const exposureValue = (lens: Lens): number =>
  Math.log2((lens.fStop * lens.fStop) / Math.max(1e-9, lens.shutter)) -
  Math.log2(Math.max(1, lens.iso) / 100)

/** Every derived quantity at once, for a panel or a harness readout. */
export interface LensReadout {
  readonly focalLength: Millimeters
  /** After zoom — what the picture is actually taken at. */
  readonly effectiveFocalLength: Millimeters
  readonly gauge: Millimeters
  readonly zoom: number
  readonly fStop: number
  readonly verticalFovDegrees: number
  readonly horizontalFovDegrees: number
  readonly apertureDiameter: Millimeters
  readonly circleOfConfusion: Millimeters
  readonly pixelPitch: Millimeters
  readonly pixelsPerRadian: number
  /** Milliradians, because a pixel is a fraction of one. */
  readonly pixelAngleMrad: number
  readonly depthOfField: DepthOfField
  readonly airyDiameter: Millimeters
  readonly diffractionLimit: number
  readonly angularResolutionMrad: number
  readonly exposureValue: number
  readonly viewport: Viewport
}

/**
 * The whole instrument, resolved against a viewport.
 *
 * One function rather than a panel calling nine, because the panel and
 * `ir.lens()` show the same numbers and a readout that disagreed with the
 * console would be worse than either.
 */
export function lensReadout(lens: Lens, viewport: Viewport): LensReadout {
  return {
    focalLength: lens.focalLength,
    effectiveFocalLength: effectiveFocalLength(lens),
    gauge: lens.gauge,
    zoom: lens.zoom,
    fStop: lens.fStop,
    verticalFovDegrees: verticalFovDegrees(lens),
    horizontalFovDegrees: (horizontalFov(lens, viewport) * 180) / Math.PI,
    apertureDiameter: apertureDiameter(lens),
    circleOfConfusion: circleOfConfusion(lens, viewport),
    pixelPitch: pixelPitch(lens, viewport),
    pixelsPerRadian: pixelsPerRadian(lens, viewport),
    pixelAngleMrad: pixelAngle(lens, viewport) * 1000,
    depthOfField: depthOfField(lens, viewport),
    airyDiameter: airyDiameter(lens),
    diffractionLimit: diffractionLimit(lens, viewport),
    angularResolutionMrad: angularResolution(lens) * 1000,
    exposureValue: exposureValue(lens),
    viewport,
  }
}
