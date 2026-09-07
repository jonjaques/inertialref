import { LOCAL_CLOUD_RECORDS } from './localClouds.generated.ts'

/**
 * Zucker et al. 2022 gives a 165 ± 6 pc shell radius, not a diameter.
 * A solar-centered sphere and a 25 pc transition approximate its irregular
 * geometry. The 20% residual follows the Lallement cube's solar cell relative
 * to the smooth disk; this is a cavity, not an empty ten-parsec skip.
 */
export const LOCAL_BUBBLE = Object.freeze({
  source: 'https://doi.org/10.1038/s41586-021-04286-5',
  radiusParsecs: 165,
  transitionParsecs: 25,
  residual: 0.2,
})

/** Galactic-center frame offsets; source coordinates are heliocentric, +Z north. */
export const LOCAL_CLOUDS = Object.freeze(
  LOCAL_CLOUD_RECORDS.map((record) => {
    const [x, y, z] = record.centerParsecs
    const [sx, sy, sz] = record.sigmaParsecs
    return Object.freeze({
      ...record,
      center: Object.freeze({ x: x - 8178, y: z + 20.8, z: -y }),
      sigma: Object.freeze({ x: sx, y: sz, z: sy }),
      extinctionPerParsec:
        (record.extinctionMagnitudePerParsec * Math.LN10) / 2.5,
    })
  }),
)

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}
export function localBubbleFactor(x: number, y: number, z: number): number {
  const distance = Math.hypot(x + 8178, y - 20.8, z)
  const b = LOCAL_BUBBLE
  return (
    b.residual +
    (1 - b.residual) *
      smooth(
        (distance - b.radiusParsecs + b.transitionParsecs) /
          (2 * b.transitionParsecs),
      )
  )
}

/** Summed clouds never pick a field value by rank. The compact tail is continuous. */
export function localCloudExtinction(x: number, y: number, z: number): number {
  let extinction = 0
  for (const cloud of LOCAL_CLOUDS) {
    const q =
      ((x - cloud.center.x) / cloud.sigma.x) ** 2 +
      ((y - cloud.center.y) / cloud.sigma.y) ** 2 +
      ((z - cloud.center.z) / cloud.sigma.z) ** 2
    if (q < 25)
      extinction +=
        cloud.extinctionPerParsec * Math.exp(-q / 2) * smooth((25 - q) / 9)
  }
  return extinction
}
