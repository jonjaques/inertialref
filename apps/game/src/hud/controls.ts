import {
  DEFAULT_GAUGE,
  FOV_MAX,
  FOV_MIN,
  type Lens,
  lensForFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import type { OutputPreference, RendererDescription } from '../render/output.ts'

/*
 * The knobs the shell owns, as types.
 *
 * Its own module for the reason `planetarium/context.ts` gives: a `.tsx` file
 * that exports anything besides components is a file Vite's Fast Refresh gives
 * up on, and in this app a full reload means rebuilding the renderer and losing
 * the camera. The shapes here are what the shell still assembles — the renderer
 * as the dock sees it, the command table — and the lens as a slider sees it.
 * The graphics knobs have no shape here: they are preferences, the panel reads
 * their definitions, and `state/engineKnobs.ts` carries each to the engine.
 */

/*
 * The field-of-view range is `lens.ts`'s, re-exported.
 *
 * It was declared here, beside the slider that spends it, which was right until
 * two things outside the shell had to solve against the same range: the lens a
 * rise is framed with, which clamps at the long end and says so, and the
 * terrain predicate, whose saturation at 20° is why the long end is there. Two
 * copies of a perceptual limit is how a slider ends up offering an angle the
 * solver will not produce.
 */
export { FOV_MAX, FOV_MIN }

/** The same two limits as glass, on a 24 mm gauge: 8.40 mm and 68.06 mm. */
export const FOCAL_MIN = lensForFov(FOV_MAX).focalLength
export const FOCAL_MAX = lensForFov(FOV_MIN).focalLength

/**
 * Zoom's range, as a multiplier on the focal length.
 *
 * From 1 rather than from below it, because zooming *out* past the widest
 * focal length is the focal-length control's job and two ways to reach the same
 * picture is how a panel ends up with two disagreeing readouts of it.
 */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 8

/** f/1.4 wide open to f/22 stopped down — a fast prime's full range. */
export const F_STOP_MIN = 1.4
export const F_STOP_MAX = 22

/**
 * The focus band, meters, with infinity at the top of the travel.
 *
 * Half a meter is closer than any camera in this game gets to anything. The top
 * is set by the **longest** lens rather than by a round number: hyperfocal is
 * 5.4 m at the flying lens and 4.5 km at the telephoto end with the zoom racked
 * out, so a band that stopped at a kilometer could not reach the one distance
 * at which the telephoto is sharp to infinity — the control was unreachable
 * exactly where it is the only one that matters. 10 km clears it with room, and
 * everything past it is the same picture at every lens here, which is what the
 * ∞ position at the top of the travel is for.
 */
export const FOCUS_MIN = 0.5
export const FOCUS_MAX = 10_000

/**
 * How many positions a lens slider has, and why the channels need to know.
 *
 * Fine enough that the readout moves on every arrow key, coarse enough that the
 * position is an integer the slider can hold rather than a float it rounds. It
 * lives here rather than in the component because one channel's arithmetic
 * depends on it: `focus` spends its top position on infinity, so the finite
 * band has to end exactly one step below the top. Written as a fraction of the
 * travel instead, the sentinel swallows a band of positions that all resolve
 * back to it, and the thumb springs back under every arrow key — from the
 * default lens, which is focused at infinity, the control cannot be moved at
 * all.
 */
export const LENS_SLIDER_STEPS = 1000

/** The travel `focus` leaves for finite distances: everything below the top step. */
const FOCUS_FINITE_BAND = (LENS_SLIDER_STEPS - 1) / LENS_SLIDER_STEPS

/**
 * Slider positions are logarithmic in the value, and every channel here is.
 *
 * A linear focal-length slider spends two thirds of its travel between 30 and
 * 68 mm, where the angle changes by 20°, and gives the wide end — where it
 * changes by 50° — the last third. Logarithmic makes a fixed drag a fixed
 * *ratio*, which is what a stop is on the aperture ring and what a zoom is by
 * definition.
 */
const scrubOf = (value: number, min: number, max: number): number =>
  Math.log(Math.min(max, Math.max(min, value)) / min) / Math.log(max / min)

const valueOf = (scrub: number, min: number, max: number): number =>
  min * (max / min) ** Math.min(1, Math.max(0, scrub))

/** One thing on the lens a slider can move. */
export interface LensChannel {
  readonly label: string
  /** Where the lens's current value sits on the travel, 0..1. */
  readonly scrub: (lens: Lens) => number
  /** The lens with this channel moved to a position on the travel. */
  readonly at: (lens: Lens, scrub: number) => Lens
  /** What the panel prints beside the label. */
  readonly format: (lens: Lens) => string
  /** What a screen reader is told the slider is. */
  readonly description: string
}

/**
 * The four channels, as data rather than as four components.
 *
 * `react/no-multi-comp` is an error here and four sliders that differ only in
 * their arithmetic are four files under any other arrangement. The arithmetic
 * is the part worth testing anyway, and none of it can be tested through a
 * component.
 */
export const formatShutter = (seconds: number): string => {
  if (seconds >= 1) return `${seconds.toFixed(1)} s`
  const denominator = Math.round(1 / seconds)
  // The slider is continuous, so 0.4 s is reachable, and "1/3 s" for it is a
  // quarter of a stop wrong. A reciprocal is printed only when it is within
  // a twentieth of a stop of the value; otherwise the decimal is the truth.
  return Math.abs(1 / denominator / seconds - 1) < 0.035
    ? `1/${denominator} s`
    : `${seconds.toFixed(2)} s`
}

export const LENS_CHANNELS = {
  shutter: {
    label: 'Shutter',
    description: 'Exposure time, seconds',
    scrub: (lens) => scrubOf(lens.shutter, 1 / 8000, 30),
    at: (lens, scrub) => ({ ...lens, shutter: valueOf(scrub, 1 / 8000, 30) }),
    format: (lens) => formatShutter(lens.shutter),
  },
  iso: {
    label: 'Gain',
    description: 'Sensor gain, ISO',
    scrub: (lens) => scrubOf(lens.iso, 25, 409600),
    at: (lens, scrub) => ({ ...lens, iso: valueOf(scrub, 25, 409600) }),
    format: (lens) => `ISO ${Math.round(lens.iso)}`,
  },
  focal: {
    label: 'Focal length',
    description: 'Focal length, millimeters',
    scrub: (lens) => scrubOf(lens.focalLength, FOCAL_MIN, FOCAL_MAX),
    at: (lens, scrub) => ({
      ...lens,
      focalLength: valueOf(scrub, FOCAL_MIN, FOCAL_MAX),
    }),
    // The angle beside the millimeters, because the angle is what somebody
    // composing a shot is actually choosing and the millimeters are what the
    // depth of field and the diffraction below are computed from.
    format: (lens) =>
      `${lens.focalLength.toFixed(1)} mm · ${verticalFovDegrees({ ...lens, zoom: 1 }).toFixed(0)}°`,
  },
  zoom: {
    label: 'Zoom',
    description: 'Zoom, as a multiple of the focal length',
    scrub: (lens) => scrubOf(lens.zoom, ZOOM_MIN, ZOOM_MAX),
    at: (lens, scrub) => ({
      ...lens,
      zoom: valueOf(scrub, ZOOM_MIN, ZOOM_MAX),
    }),
    format: (lens) =>
      `${lens.zoom.toFixed(2)}× · ${verticalFovDegrees(lens).toFixed(0)}°`,
  },
  aperture: {
    label: 'Aperture',
    description: 'Aperture, as an f-number',
    scrub: (lens) => scrubOf(lens.fStop, F_STOP_MIN, F_STOP_MAX),
    at: (lens, scrub) => ({
      ...lens,
      fStop: valueOf(scrub, F_STOP_MIN, F_STOP_MAX),
    }),
    // The f-number alone. The aperture *diameter* it implies is a derived
    // reading and belongs with the other derived readings, not wrapped onto a
    // second line of a control's own value.
    format: (lens) => `f/${lens.fStop.toFixed(1)}`,
  },
  focus: {
    label: 'Focus',
    description: 'Focus distance, meters',
    // Infinity is the top of the travel rather than a value on it: every
    // distance past a kilometer is the same picture at every lens here, and a
    // slider that could only ever *approach* the setting the camera spends its
    // whole life at would be a control with a defect in it.
    //
    // It is exactly *one* position, and that is the whole of the arithmetic
    // below. A sentinel band wider than a step is a band the thumb cannot rest
    // in: every position inside it maps back to infinity, the controlled value
    // snaps the thumb to the top, and the arrow keys move nothing.
    scrub: (lens) =>
      Number.isFinite(lens.focus)
        ? scrubOf(lens.focus, FOCUS_MIN, FOCUS_MAX) * FOCUS_FINITE_BAND
        : 1,
    at: (lens, scrub) => ({
      ...lens,
      focus:
        scrub >= 1
          ? Infinity
          : valueOf(scrub / FOCUS_FINITE_BAND, FOCUS_MIN, FOCUS_MAX),
    }),
    // Meters up to a kilometer and kilometers past it, because the band now
    // reaches 10 km and "10000 m" is a reading nobody parses at a glance.
    format: (lens) =>
      !Number.isFinite(lens.focus)
        ? '∞'
        : lens.focus >= 1000
          ? `${(lens.focus / 1000).toFixed(2)} km`
          : lens.focus < 10
            ? `${lens.focus.toFixed(1)} m`
            : `${lens.focus.toFixed(0)} m`,
  },
} as const satisfies Record<string, LensChannel>

export type LensChannelId = keyof typeof LENS_CHANNELS

/**
 * What a restored `camera.lens` has to prove before it is believed.
 *
 * The same argument as every other guard in `state/accept.ts`, with more surface:
 * `localStorage` outlives the code that wrote it, and a lens is seven numbers
 * where the field of view was one. A focal length of zero is a division; a NaN
 * anywhere in here is a NaN projection matrix and a frame that draws nothing.
 */
export const isLens = (value: unknown): value is Lens => {
  if (typeof value !== 'object' || value === null) return false
  const lens = value as Record<string, unknown>
  const within = (key: string, min: number, max: number): boolean => {
    const held = lens[key]
    return (
      typeof held === 'number' &&
      Number.isFinite(held) &&
      held >= min &&
      held <= max
    )
  }
  return (
    within('focalLength', FOCAL_MIN * 0.99, FOCAL_MAX * 1.01) &&
    within('gauge', DEFAULT_GAUGE, DEFAULT_GAUGE) &&
    within('zoom', ZOOM_MIN, ZOOM_MAX) &&
    within('fStop', F_STOP_MIN, F_STOP_MAX) &&
    within('shutter', 1 / 8000, 30) &&
    within('iso', 25, 409_600) &&
    // The one field that is legitimately not finite, and the reason this guard
    // is written out rather than reduced to "every value is a finite number".
    (lens.focus === null ||
      (typeof lens.focus === 'number' &&
        (lens.focus === Infinity ||
          (lens.focus >= FOCUS_MIN && lens.focus <= FOCUS_MAX))))
  )
}

/**
 * A restored lens, with the one field JSON cannot hold put back.
 *
 * `JSON.stringify(Infinity)` is `null`, and a lens racked to the stop is the
 * lens the camera spends its whole life at — so without this the default lens
 * does not survive its own round trip. Everything downstream guards with
 * `Number.isFinite`, which takes the same branch for `null` as for `Infinity`,
 * so the symptom is quiet: an equality against `DEFAULT_LENS` that can never
 * hold, and a Reset control enabled on a lens that is already the default.
 */
export const reviveLens = (lens: Lens): Lens =>
  Number.isFinite(lens.focus) ? lens : { ...lens, focus: Infinity }

/**
 * The lens and its one writer, as a slider sees them.
 *
 * Built by `LensSection` from the `camera.lens` preference and handed to each
 * channel's slider; nothing above the section assembles one. The graphics
 * knobs have no shape like this at all — the panel reads their definitions.
 */
export interface CameraState {
  readonly lens: Lens
  /**
   * Takes the updater form, and a channel slider has to use it.
   *
   * A lens is seven fields and a slider changes one, so every write here is
   * derived from the lens before it. `camera.lens` is one hook's captured
   * value and `camera.lens` is held by up to four at once — `LensSection` in
   * the dock *and* at `/settings/camera`, plus Optics and the presets — so the
   * snapshot a handler closed over can be a write behind the store.
   */
  readonly onLens: (lens: Lens | ((held: Lens) => Lens)) => void
}

/**
 * The renderer, as far as the dock is concerned: what was asked for, what came
 * back, and how to ask for something else.
 *
 * One shape rather than three because they are read together — the whole point
 * of showing the resolved mode next to the preference is that they routinely
 * disagree, and a browser that cannot produce extended range is supposed to say
 * so rather than silently ignore the setting.
 */
export interface HudRenderState {
  readonly preference: OutputPreference
  readonly output: RendererDescription | null
  /**
   * Ask for a specific state, not the next one.
   *
   * This was `onCyclePreference`, and cycling is what a three-state setting
   * does when it is drawn as one button: reaching `standard` from `standard`
   * cost three presses and three renderer rebuilds, each of which is a visible
   * stall. The control is a radio group now, so the verb is the one a radio
   * group has.
   */
  readonly onPreference: (preference: OutputPreference) => void
}

/** Every verb that is bound to both a key and a button. See `App`. */
export interface HudCommands {
  readonly togglePause: () => void
  readonly warp: (direction: number) => void
  /**
   * Back to one second per second, in one press.
   *
   * Not `warp(-1)` repeated: the ladder is seven rungs, so leaving 100,000×
   * costs six presses and six notices. The transport strip has had the button
   * since the dock existed and the keyboard has not had the key.
   */
  readonly realTime: () => void
  readonly toggleAssist: () => void
  readonly killRotation: () => void
  readonly save: () => void
  readonly load: () => void
}
