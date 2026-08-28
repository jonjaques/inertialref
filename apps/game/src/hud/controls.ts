import {
  DEFAULT_GAUGE,
  type Lens,
  lensForFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import type { AaLevel, OutputPreference } from '../render/output.ts'
import type { RendererDescription } from '../render/output.ts'

/*
 * The knobs the shell owns, as types.
 *
 * Its own module for the reason `planetarium/context.ts` gives: a `.tsx` file
 * that exports anything besides components is a file Vite's Fast Refresh gives
 * up on, and in this app a full reload means rebuilding the renderer and losing
 * the camera. These four shapes were declared in the four component files that
 * happen to draw them, and every one of those files is edited while iterating
 * on a panel.
 *
 * They are also read in two places each — the dev dock and the `/settings`
 * page — which is the other half of why they are here: two inline object
 * literals for "the graphics knobs" is how a build ends up with two
 * anti-aliasing switches that disagree.
 */

/**
 * The field-of-view range, once.
 *
 * 20° is a telephoto; past 110° everything fisheyes. Stated as angles even
 * though the lens is canonically a focal length, because the *limits* are
 * perceptual claims about a picture and a focal length is only a claim about a
 * picture once you know the gauge. Both ends are converted below.
 */
export const FOV_MIN = 20
export const FOV_MAX = 110

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
 * Half a meter is closer than any camera in this game gets to anything; a
 * kilometer is past hyperfocal for every lens on the slider, so everything
 * beyond it is the same picture and the last position says so by being ∞.
 */
export const FOCUS_MIN = 0.5
export const FOCUS_MAX = 1000

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
export const LENS_CHANNELS = {
  focal: {
    label: 'Focal Length',
    description: 'Focal length, millimeters',
    scrub: (lens) => scrubOf(lens.focalLength, FOCAL_MIN, FOCAL_MAX),
    at: (lens, scrub) => ({
      ...lens,
      focalLength: valueOf(scrub, FOCAL_MIN, FOCAL_MAX),
    }),
    // The angle beside the millimetres, because the angle is what somebody
    // composing a shot is actually choosing and the millimetres are what the
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
    scrub: (lens) =>
      Number.isFinite(lens.focus)
        ? scrubOf(lens.focus, FOCUS_MIN, FOCUS_MAX) * 0.98
        : 1,
    at: (lens, scrub) => ({
      ...lens,
      focus:
        scrub >= 0.99 ? Infinity : valueOf(scrub / 0.98, FOCUS_MIN, FOCUS_MAX),
    }),
    format: (lens) =>
      Number.isFinite(lens.focus)
        ? `${lens.focus < 10 ? lens.focus.toFixed(1) : lens.focus.toFixed(0)} m`
        : '∞',
  },
} as const satisfies Record<string, LensChannel>

export type LensChannelId = keyof typeof LENS_CHANNELS

/**
 * What a restored `camera.lens` has to prove before it is believed.
 *
 * The same argument as every other guard in `panelState.ts`, with more surface:
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

export interface CameraState {
  readonly lens: Lens
  readonly onLens: (lens: Lens) => void
}

export interface GraphicsState {
  readonly lensFlare: boolean
  readonly onLensFlare: (on: boolean) => void
  readonly aa: AaLevel
  readonly onAa: (level: AaLevel) => void
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
  readonly toggleAssist: () => void
  readonly killRotation: () => void
  readonly save: () => void
  readonly load: () => void
}
