import {
  DEFAULT_SENSOR_SETTINGS,
  isSensorSettings,
  type SensorSettings,
} from '@inertialref/rendering'

/** A portable camera choice excludes display headroom and adaptation history. */
export type PictureProcessing = Omit<SensorSettings, 'peak'>

/** Select the recorded fields even when a host supplies its full sensor state. */
export function captureCameraProcessing(
  settings: PictureProcessing,
): PictureProcessing {
  return {
    mode: settings.mode,
    look: settings.look,
    compensation: settings.compensation,
    rate: settings.rate,
    range: { bright: settings.range.bright, dark: settings.range.dark },
    balance: settings.balance,
  }
}

/** Version 1 preserves its camera geometry, not its historical image appearance. */
export const DEFAULT_PICTURE_PROCESSING = captureCameraProcessing(
  DEFAULT_SENSOR_SETTINGS,
)

export function isPictureProcessing(
  value: unknown,
): value is PictureProcessing {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'peak') &&
    isSensorSettings({ ...value, peak: DEFAULT_SENSOR_SETTINGS.peak })
  )
}
