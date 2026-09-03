import { DEFAULT_CELL_PIXELS } from '@inertialref/rendering'

/*
 * What the surface may be turned down to, as a few named steps.
 *
 * Not a quality ladder. Each step is one lever with a measured cost — how
 * many pixels a terrain cell may cover before it is refined, which of the
 * ground's detail octaves are evaluated, whether the sea reads the frame
 * behind it — named so that a figure can be reported against the setting it
 * was taken at, and so that the settings panel and a driving script reach
 * the same knob. The frame loop reads `GameEngine.surfaceQuality`; React
 * persists it. Nothing here allocates per frame.
 */

/** How many display pixels a terrain cell may cover before refining. */
export type TerrainDetail = 'fine' | 'balanced' | 'coarse'
/** Which of the ground's per-pixel octaves are evaluated. */
export type GroundDetail = 'full' | 'lean' | 'flat'
/** What the sea sheet does beyond reflecting the sky. */
export type SeaDetail = 'full' | 'plain' | 'flat'

export interface SurfaceQuality {
  readonly terrain: TerrainDetail
  readonly ground: GroundDetail
  readonly sea: SeaDetail
  /** Whether the instanced rocks are drawn at all. */
  readonly rocks: boolean
}

export const TERRAIN_DETAILS: readonly TerrainDetail[] = [
  'fine',
  'balanced',
  'coarse',
]
export const GROUND_DETAILS: readonly GroundDetail[] = ['full', 'lean', 'flat']
export const SEA_DETAILS: readonly SeaDetail[] = ['full', 'plain', 'flat']

export const DEFAULT_SURFACE_QUALITY: SurfaceQuality = {
  terrain: 'balanced',
  ground: 'full',
  sea: 'full',
  rocks: true,
}

/**
 * The refinement threshold each step stands for, display pixels a cell.
 *
 * `balanced` is `DEFAULT_CELL_PIXELS`, which is where the graded tree's own
 * floor and the error predicate meet; `fine` is where the predicate starts
 * adding patches on top of that floor, and `coarse` is a level fewer
 * everywhere the eye is not standing. The patch underfoot is at the detail
 * floor whatever this says.
 */
export function cellPixelsFor(detail: TerrainDetail): number {
  switch (detail) {
    case 'fine':
      return DEFAULT_CELL_PIXELS * 0.75
    case 'balanced':
      return DEFAULT_CELL_PIXELS
    case 'coarse':
      return DEFAULT_CELL_PIXELS * 1.5
  }
}

/**
 * The ground material's own reading of the step: how many of its detail
 * bands run, coarsest first. Two is the macro and the micro octaves with the
 * grain; one is the macro octave alone, which is the band that survives to
 * a kilometer; zero is the mesh and the deposits with nothing under a cell.
 */
export function groundBandsFor(detail: GroundDetail): number {
  switch (detail) {
    case 'full':
      return 2
    case 'lean':
      return 1
    case 'flat':
      return 0
  }
}

/**
 * Wave fields the sea's graph is built with, and the most a setting can ask
 * for: one is the swell, two adds the chop. `render/water.ts` builds against
 * this number, so a setting cannot promise a field the graph does not hold.
 */
export const WAVE_OCTAVES = 2

/** The sea's reading: whether it refracts, and how many wave fields it runs. */
export function seaQualityFor(detail: SeaDetail): {
  readonly refraction: boolean
  readonly waveOctaves: number
} {
  switch (detail) {
    case 'full':
      return { refraction: true, waveOctaves: WAVE_OCTAVES }
    case 'plain':
      return { refraction: false, waveOctaves: WAVE_OCTAVES }
    case 'flat':
      return { refraction: false, waveOctaves: 0 }
  }
}

/** The storage guard: a whole record, every field one of its steps. */
export function isSurfaceQuality(value: unknown): value is SurfaceQuality {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    TERRAIN_DETAILS.includes(record.terrain as TerrainDetail) &&
    GROUND_DETAILS.includes(record.ground as GroundDetail) &&
    SEA_DETAILS.includes(record.sea as SeaDetail) &&
    typeof record.rocks === 'boolean'
  )
}
