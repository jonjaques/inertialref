import { exposureValue, type Lens } from './lens.ts'

/** A unit of the surface shaders is an albedo-one surface under terrestrial sunlight. */
export const SURFACE_LUMINANCE = 30_000
export const SOLAR_LUMINANCE = 1.6e9
export const CAMERA_MODES = ['enhanced', 'automatic', 'manual'] as const
export type CameraMode = (typeof CAMERA_MODES)[number]
export const PHOTOGRAPHIC_LOOKS = ['neutral', 'gentle', 'crisp'] as const
export type PhotographicLook = (typeof PHOTOGRAPHIC_LOOKS)[number]
export const LOOK_SHOULDERS: Readonly<Record<PhotographicLook, number>> = {
  neutral: 0.72,
  gentle: 0.58,
  crisp: 0.86,
}

export interface SensorSettings {
  readonly mode: CameraMode
  /** A photographic response style, independent of exposure and source light. */
  readonly look: PhotographicLook
  /** Positive stops brighten Automatic without changing the lens. */
  readonly compensation: number
  /** Zero holds automatic exposure; one gives the bible's time constants. */
  readonly rate: number
  /** Stops from the lens exposure, positive in either direction. */
  readonly range: { readonly bright: number; readonly dark: number }
  readonly peak: number
  /** Kelvin. D65 is the unfiltered instrument. */
  readonly balance: number
}

export const DEFAULT_SENSOR_SETTINGS: SensorSettings = {
  mode: 'enhanced',
  look: 'neutral',
  compensation: 0,
  rate: 1,
  range: { bright: 24, dark: 16 },
  peak: 2,
  balance: 6500,
}

const within = (value: unknown, lo: number, hi: number): boolean =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= lo &&
  value <= hi

function hasKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const actual = Object.keys(value)
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  )
}

function hasSensorControls(record: Record<string, unknown>): boolean {
  return (
    within(record.rate, 0, 4) &&
    within(record.peak, 1, 2) &&
    within(record.balance, 2000, 12_000) &&
    hasKeys(record.range, ['bright', 'dark']) &&
    within(record.range.bright, 0, 32) &&
    within(record.range.dark, 0, 24)
  )
}

export function isSensorSettings(value: unknown): value is SensorSettings {
  return (
    hasKeys(value, [
      'mode',
      'look',
      'compensation',
      'rate',
      'range',
      'peak',
      'balance',
    ]) &&
    CAMERA_MODES.includes(value.mode as CameraMode) &&
    PHOTOGRAPHIC_LOOKS.includes(value.look as PhotographicLook) &&
    within(value.compensation, -8, 8) &&
    hasSensorControls(value)
  )
}

/** Strict compatibility boundary for stored Composite/Direct records. */
export function parseSensorSettings(value: unknown): SensorSettings | null {
  if (isSensorSettings(value)) return value
  if (
    !hasKeys(value, [
      'response',
      'curve',
      'rate',
      'range',
      'peak',
      'balance',
    ]) ||
    (value.response !== 'composite' && value.response !== 'direct') ||
    !['natural', ...PHOTOGRAPHIC_LOOKS].includes(value.curve as string) ||
    !hasSensorControls(value)
  )
    return null
  return {
    mode:
      value.response === 'direct'
        ? 'manual'
        : value.curve === 'natural'
          ? 'enhanced'
          : 'automatic',
    look:
      value.curve === 'natural' ? 'neutral' : (value.curve as PhotographicLook),
    compensation: 0,
    rate: value.rate as number,
    range: value.range as SensorSettings['range'],
    peak: value.peak as number,
    balance: value.balance as number,
  }
}

export const exposureMultiplier = (ev: number): number => 1 / (1.2 * 2 ** ev)
export const exposureForLuminance = (luminance: number): number =>
  Math.log2(Math.max(1e-12, luminance) / 1.2)

/** Authored exposure is an EV offset from the surface calibration. */
export const exposurePinnedToLens = (lens: Lens): number =>
  exposureValue(lens) - exposureForLuminance(SURFACE_LUMINANCE)

export interface CameraPolicy {
  readonly mode: CameraMode
  readonly look: PhotographicLook
  readonly processing: 'enhanced' | 'photographic'
  readonly exposure: 'metered' | 'fixed'
  readonly fixedEV: number | null
  readonly compensation: number
  readonly override: 'staging' | null
}

/** Resolve staging once without rewriting the player's selected camera mode. */
export function resolveCameraPolicy(
  settings: SensorSettings,
  lens: Lens,
  pinned: number | null = null,
): CameraPolicy {
  const override = pinned === null ? null : 'staging'
  const enhanced = settings.mode === 'enhanced' && override === null
  return {
    mode: settings.mode,
    look: settings.look,
    processing: enhanced ? 'enhanced' : 'photographic',
    exposure:
      settings.mode === 'automatic' && override === null ? 'metered' : 'fixed',
    fixedEV:
      pinned !== null
        ? exposureForLuminance(SURFACE_LUMINANCE) + pinned
        : enhanced
          ? exposureForLuminance(SURFACE_LUMINANCE)
          : settings.mode === 'manual'
            ? exposureValue(lens)
            : null,
    compensation:
      settings.mode === 'automatic' && override === null
        ? settings.compensation
        : 0,
    override,
  }
}

export function splitExposure(ev: number, previous: number) {
  const total = exposureMultiplier(ev)
  const pre = exposureMultiplier(previous)
  return { pre, residual: total / pre, total }
}

export function adaptExposure(
  current: number,
  target: number,
  dt: number,
  rate: number,
): number {
  const tau = target > current ? 0.4 : 3.5
  return (
    current + (target - current) * -Math.expm1((-Math.max(0, dt) * rate) / tau)
  )
}

/** The meter bins pre-exposed light. Bin zero includes empty sky and underflow. */
export const HISTOGRAM_BINS = 64
export const HISTOGRAM_MIN = -16
export const HISTOGRAM_STOPS = 32
export const HISTOGRAM_STEP = HISTOGRAM_STOPS / HISTOGRAM_BINS
export const METER_SHOULDER = 0.6

export function histogramBin(light: number): number {
  if (!(light > 0)) return 0
  return Math.min(
    HISTOGRAM_BINS - 1,
    Math.max(
      0,
      Math.floor((Math.log2(light) - HISTOGRAM_MIN) / HISTOGRAM_STEP),
    ),
  )
}

export function histogram(samples: readonly number[]): Uint32Array {
  const bins = new Uint32Array(HISTOGRAM_BINS)
  for (const sample of samples) bins[histogramBin(sample)]! += 1
  return bins
}

export interface MeterReading {
  readonly ev: number
  readonly samples: number
  readonly luminance: number
}

function clampExposure(
  ev: number,
  set: number,
  settings: SensorSettings,
): number {
  return Math.min(
    set + settings.range.bright,
    Math.max(set - settings.range.dark, ev),
  )
}

/** Luminance weighting keeps a small lit disk from metering as the faint sky around it. */
export function meterHistogram(
  bins: ArrayLike<number>,
  pre: number,
  set: number,
  settings: SensorSettings,
): MeterReading {
  let count = 0
  for (let i = 1; i < HISTOGRAM_BINS; i += 1) count += bins[i] ?? 0
  let cumulative = 0
  let sum = 0
  let used = 0
  for (let i = 1; i < HISTOGRAM_BINS; i += 1) {
    const next = cumulative + (bins[i] ?? 0)
    // Trim isolated hot pixels, but retain subjects covering 1% of the lit samples.
    const included = Math.max(
      0,
      Math.min(next, count * 0.999) - Math.max(cumulative, count * 0.4),
    )
    const stops = HISTOGRAM_MIN + (i + 0.5) * HISTOGRAM_STEP
    const weight = included * 2 ** stops
    sum += weight * stops
    used += weight
    cumulative = next
  }
  const luminance = used === 0 ? 0 : 2 ** (sum / used) / pre
  const wanted =
    used === 0
      ? set - settings.range.dark
      : exposureForLuminance(luminance / METER_SHOULDER)
  return { ev: clampExposure(wanted, set, settings), samples: count, luminance }
}

export interface Exposure {
  readonly mode: CameraMode
  readonly requestedMode?: CameraMode
  readonly automaticAvailable?: boolean
  readonly policy: CameraPolicy
  readonly processing: CameraPolicy['processing']
  readonly look: PhotographicLook
  readonly set: number
  /** Effective EV minus lens EV. Negative stops mean added light. */
  readonly auto: number
  readonly adapted: number
  readonly effectiveEV: number
  /** Linear gain relative to the lens exposure. */
  readonly gain: number
  readonly compensation: number
  readonly override: CameraPolicy['override']
  readonly total: number
  readonly pre: number
  readonly residual: number
  readonly metered: boolean
  readonly luminance: number
}

/** State belongs to the instrument, never the universe or the lens's ISO. */
export class ExposureMeter {
  #ev = exposureForLuminance(SURFACE_LUMINANCE)
  #time: number | null = null
  #mode: CameraMode | null = null
  #pin: number | null = null
  #compensation = 0
  #target: MeterReading | null = null
  reading: Exposure | null = null

  measure(
    bins: ArrayLike<number>,
    pre: number,
    lens: Lens,
    settings: SensorSettings,
  ): void {
    if (settings.mode !== 'automatic' || this.#pin !== null) return
    this.#target = meterHistogram(bins, pre, exposureValue(lens), settings)
  }

  /** The host also resets on camera cuts and forward photographic-time scrubs. */
  reset(): void {
    this.#time = null
    this.#mode = null
    this.#pin = null
    this.#compensation = 0
    this.#target = null
    this.#ev = exposureForLuminance(SURFACE_LUMINANCE)
    this.reading = null
  }

  update(
    lens: Lens,
    settings: SensorSettings,
    time: number,
    pinned: number | null = null,
  ): Exposure {
    const policy = resolveCameraPolicy(settings, lens, pinned)
    const set = exposureValue(lens)
    const changed =
      this.#mode !== null &&
      (settings.mode !== this.#mode || pinned !== this.#pin)
    const reversed = this.#time !== null && time < this.#time
    if (changed || reversed) this.reset()
    const previous = this.#ev
    const dt = this.#time === null ? 0 : Math.max(0, time - this.#time)
    if (policy.fixedEV !== null) this.#ev = policy.fixedEV
    else {
      const target = clampExposure(
        (this.#target?.ev ?? exposureForLuminance(SURFACE_LUMINANCE)) -
          policy.compensation,
        set,
        settings,
      )
      const current = this.#ev + this.#compensation - policy.compensation
      this.#ev = clampExposure(
        adaptExposure(current, target, dt, settings.rate),
        set,
        settings,
      )
    }
    const discontinuity =
      this.#time === null ||
      policy.fixedEV !== null ||
      Math.abs(this.#ev - previous) > 2
    this.#time = time
    this.#mode = settings.mode
    this.#pin = pinned
    this.#compensation = policy.compensation
    const split = splitExposure(this.#ev, discontinuity ? this.#ev : previous)
    this.reading = {
      mode: settings.mode,
      policy,
      processing: policy.processing,
      look: policy.look,
      set,
      auto: this.#ev - set,
      adapted: this.#ev,
      effectiveEV: this.#ev,
      gain: 2 ** (set - this.#ev),
      compensation: policy.compensation,
      override: policy.override,
      ...split,
      metered: policy.exposure === 'metered' && this.#target !== null,
      luminance: this.#target?.luminance ?? 0,
    }
    return this.reading
  }
}
