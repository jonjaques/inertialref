/*
 * The ice crystals' phase table, sr⁻¹ normalized to ∫p dΩ = 1: `angles`
 * angles × `diameters` rows × 3 bands as little-endian float16 in base64,
 * laid out [row][angle][band]. Angle i is θ = (π/2)(1 − cos(πi/(angles −
 * 1))); row j is the effective diameter `diameterMin + j·diameterStep` µm.
 * `bulk` is [Q_ext, albedo, g] a row; `scales` the power of two a row's
 * stored phase is multiplied by.
 *
 * A stand-in: an isotropic phase, 1/(4π), at three angles and two
 * diameters, from no measurement and no source. A generator writes this
 * file; rerun it rather than editing, then `pnpm exec prettier -w` this
 * file.
 */
export const ICE_AGGREGATE = {
  format: 'inertialref/ice',
  version: 1,
  habit: 'isotropic stand-in',
  citation: 'none: a stand-in',
  license: 'none: a stand-in',
  sourceDate: 'none: a stand-in',
  url: 'none: a stand-in',
  files: [],
  wavelengths: [[], [], []],
  angles: 3,
  diameters: 2,
  diameterMin: 10,
  diameterStep: 5,
  bands: [680, 550, 440],
  scales: [1, 1],
  phase: 'GC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgt',
  bulk: [
    [2, 1, 0],
    [2, 1, 0],
  ],
} as const
