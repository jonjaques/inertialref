import type { QualityPreset } from 'three-clouds-webgpu'

/** Keep the port out of the settings bundle until a WebGPU canvas loads it. */
export const CLOUD_QUALITIES = [
  'lowEnd',
  'low',
  'medium',
  'high',
  'ultra',
] as const satisfies readonly QualityPreset[]
export type CloudQuality = (typeof CLOUD_QUALITIES)[number]
export const DEFAULT_CLOUD_QUALITY: CloudQuality = 'high'
