/** Stored radiance changes when the cube's angular filter changes. */
export const GALAXY_CUBE_SAMPLING_VERSION = 'cube@2'

/**
 * A cube face projects [-1, 1] onto a normalized ray. Its largest angular
 * derivative is one at the face center, so 2 / size conservatively bounds
 * one texel's width. Dividing the face's 90 degrees uniformly underestimates
 * center texels by 21.5% and admits dust bands the cube cannot resolve.
 */
export const galaxyCubePixelAngle = (faceSize: number): number => 2 / faceSize
