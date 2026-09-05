import { exposureValue, type Lens } from './lens.ts'

/** A unit of the surface shaders is an albedo-one surface under terrestrial sunlight. */
export const SURFACE_LUMINANCE = 30_000
export const SOLAR_LUMINANCE = 1.6e9
export const SENSOR_RESPONSES = ['composite', 'direct'] as const
export type SensorResponse = (typeof SENSOR_RESPONSES)[number]
export const RESPONSE_PRESETS = [
  'natural',
  'neutral',
  'gentle',
  'crisp',
] as const
export type ResponsePreset = (typeof RESPONSE_PRESETS)[number]
export const RESPONSE_SHOULDERS: Readonly<Record<ResponsePreset, number>> = {
  natural: 0.72,
  neutral: 0.72,
  gentle: 0.58,
  crisp: 0.86,
}

export interface SensorSettings {
  readonly response: SensorResponse
  /** Zero holds the current automatic exposure; one gives the bible's time constants. */
  readonly rate: number
  /** Stops from the set exposure, positive in either direction. */
  readonly range: { readonly bright: number; readonly dark: number }
  readonly peak: number
  readonly curve: ResponsePreset
  /** Kelvin. D65 is the unfiltered instrument. */
  readonly balance: number
}

export const DEFAULT_SENSOR_SETTINGS: SensorSettings = {
  response: 'composite',
  rate: 1,
  range: { bright: 24, dark: 16 },
  peak: 2,
  curve: 'natural',
  balance: 6500,
}

export const naturalResponse = (settings: SensorSettings): boolean =>
  settings.response === 'composite' && settings.curve === 'natural'

export const exposureMultiplier = (ev: number): number => 1 / (1.2 * 2 ** ev)

export function isSensorSettings(value: unknown): value is SensorSettings {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const range = record.range as Record<string, unknown> | null
  const within = (v: unknown, lo: number, hi: number): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
  return (
    SENSOR_RESPONSES.includes(record.response as SensorResponse) &&
    RESPONSE_PRESETS.includes(record.curve as ResponsePreset) &&
    within(record.rate, 0, 4) &&
    within(record.peak, 1, 2) &&
    within(record.balance, 2000, 12_000) &&
    typeof range === 'object' &&
    range !== null &&
    within(range.bright, 0, 32) &&
    within(range.dark, 0, 24)
  )
}
export const exposureForLuminance = (luminance: number): number =>
  Math.log2(Math.max(1e-12, luminance) / 1.2)

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

/** Percentiles exclude the empty bin; otherwise a crescent meters the vacuum around it. */
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
    const weight = Math.max(
      0,
      Math.min(next, count * 0.95) - Math.max(cumulative, count * 0.4),
    )
    sum += weight * (HISTOGRAM_MIN + (i + 0.5) * HISTOGRAM_STEP)
    used += weight
    cumulative = next
  }
  const luminance = used === 0 ? 0 : 2 ** (sum / used) / pre
  const wanted =
    used === 0
      ? set - settings.range.dark
      : exposureForLuminance(luminance / METER_SHOULDER)
  return {
    ev: Math.min(
      set + settings.range.bright,
      Math.max(set - settings.range.dark, wanted),
    ),
    samples: count,
    luminance,
  }
}

export interface Exposure {
  readonly response: SensorResponse
  readonly set: number
  readonly auto: number
  readonly adapted: number
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
  #target: MeterReading | null = null
  reading: Exposure | null = null

  measure(
    bins: ArrayLike<number>,
    pre: number,
    lens: Lens,
    settings: SensorSettings,
  ): void {
    this.#target = meterHistogram(bins, pre, exposureValue(lens), settings)
  }

  reset(): void {
    this.#time = null
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
    const set = exposureValue(lens)
    const previous = this.#ev
    const calibrated = naturalResponse(settings)
    const target = Math.min(
      set + settings.range.bright,
      Math.max(
        set - settings.range.dark,
        calibrated
          ? exposureForLuminance(SURFACE_LUMINANCE)
          : (this.#target?.ev ?? exposureForLuminance(SURFACE_LUMINANCE)),
      ),
    )
    const dt = this.#time === null ? 0 : Math.max(0, time - this.#time)
    // A pin is staging relative to the surface calibration, independent of
    // the preceding shot's automatic gain.
    if (pinned !== null)
      this.#ev = exposureForLuminance(SURFACE_LUMINANCE) + pinned
    else if (settings.response === 'direct') this.#ev = set
    else if (calibrated) this.#ev = target
    else
      this.#ev = Math.min(
        set + settings.range.bright,
        Math.max(
          set - settings.range.dark,
          adaptExposure(this.#ev, target, dt, settings.rate),
        ),
      )
    const discontinuity =
      this.#time === null ||
      time < this.#time ||
      pinned !== null ||
      settings.response === 'direct' ||
      Math.abs(this.#ev - previous) > 2
    this.#time = time
    const split = splitExposure(this.#ev, discontinuity ? this.#ev : previous)
    this.reading = {
      response: settings.response,
      set,
      // The gain actually applied over the lens setting, not the meter's goal:
      // Direct ignores the goal and Natural holds the calibration.
      auto: this.#ev - set,
      adapted: this.#ev,
      ...split,
      metered:
        !calibrated &&
        this.#target !== null &&
        pinned === null &&
        settings.response === 'composite',
      luminance: this.#target?.luminance ?? 0,
    }
    return this.reading
  }
}
