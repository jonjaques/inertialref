/** Fixed optical properties of a design, distinct from the photographer's lens controls. */
export interface Glass {
  readonly blades: number
  readonly bladeAngle: number
  readonly scatter: number
  readonly vignettingCorrection: number
  /** Displacement of red and blue at the corner, in display pixels. */
  readonly lateralColor: number
  readonly fullWell: number
  readonly readNoise: number
}

export const GLASS_PRESETS = {
  flight: {
    blades: 9,
    bladeAngle: Math.PI / 18,
    scatter: 0.015,
    vignettingCorrection: 0.6,
    lateralColor: 0.25,
    fullWell: 20_000,
    readNoise: 3,
  },
  cinematic: {
    blades: 9,
    bladeAngle: 0,
    scatter: 0.015,
    vignettingCorrection: 0.85,
    lateralColor: 0.12,
    fullWell: 20_000,
    readNoise: 3,
  },
} as const satisfies Record<string, Glass>

/** Equal energy per octave gives a radial skirt proportional to inverse angle squared. */
export function psfWeights(levels: number): readonly number[] {
  return Array.from({ length: levels }, () => 1 / levels)
}
