/*
 * The droplets' phase table, in the form `apps/ingest/src/mieTable.ts` writes
 * and `mieTable.ts` decodes: an isotropic stand-in of 8 angles × 2 radii × 3
 * bands at p = 1/(4π), with Q_ext 2, albedo 1 and no asymmetry a row, and no
 * glory ring. The phase is little-endian float16, base64.
 */
export const MIE_DROPLETS = {
  format: 'inertialref/mie',
  version: 1,
  angles: 8,
  radii: 2,
  radiusMin: 2,
  radiusMax: 32,
  variance: 0.01,
  bands: [680, 550, 440],
  wavelengthsPerBand: 9,
  bandHalfWidth: 40,
  index: 'none: an isotropic stand-in',
  phase:
    'GC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgtGC0YLRgt',
  bulk: [
    [2, 1, 0],
    [2, 1, 0],
  ],
  gloryRed: [0, 0],
} as const
