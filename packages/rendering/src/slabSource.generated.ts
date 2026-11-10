/*
 * The higher orders' source function in a plane slab of the scaled medium,
 * per unit of the sun's irradiance: at a transport depth from each face and
 * a sun's cosine, the three terms the march rebuilds a slab's light from.
 * `(J₀, J₁, J_f)`: isotropic, the first moment about the normal, and the
 * lobe about the sun.
 *
 * Laid out [sun][bottom][top][term]: `suns` cosines from `sunMuMin` to 1,
 * and `nodes` each of `u(t_d)` and `u(t_b)`, the logarithmic map of the
 * transport depth from the lit face and from the far one,
 * `u(t) = ln(1 + t/depthScale)/ln(1 + depthMax/depthScale)`.
 *
 * A stand-in: two nodes an axis and no light at any of them. A generator
 * writes this file from the slab oracle; rerun it rather than editing, then
 * `pnpm exec prettier -w` this file.
 */
export const SLAB_SOURCE = {
  format: 'inertialref/slab-source',
  version: 1,
  nodes: 2,
  suns: 2,
  sunMuMin: 0.05,
  depthScale: 0.02,
  depthMax: 16,
  /** µm: the radius row the table is generated at. */
  radius: 10,
  /** The reconstruction's worst relative error against the oracle, on the domain and between its nodes. */
  reconstructionError: 0,
  terms: [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
} as const
