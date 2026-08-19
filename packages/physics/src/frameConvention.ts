import { type Vec3, vec3 } from '@inertialref/spatial'

/*
 * Axis convention.
 *
 * The simulation is right-handed with **+Y up**: the reference plane of a star
 * system is XZ and system north is +Y. That matches Three.js, so the render
 * bridge applies no axis swap and there is no chance of a half-converted vector
 * reaching the GPU.
 *
 * Textbook orbital mechanics is right-handed with +Z up. Rather than re-derive
 * every formula in a rotated basis — which is where sign errors live — the
 * Kepler code below is written exactly as the textbooks have it and converted
 * once, here, at the boundary.
 *
 *   astro (X, Y, Z)  →  sim (X, Z, -Y)
 *
 * The mapping is a proper rotation (determinant +1), so orbital angular
 * momentum along +Z_astro becomes +Y_sim and prograde stays prograde.
 */
export const astroToSim = (v: Vec3): Vec3 => vec3(v.x, v.z, -v.y)

export const simToAstro = (v: Vec3): Vec3 => vec3(v.x, -v.z, v.y)
