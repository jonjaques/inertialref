import { afterAll, beforeAll, expect, it } from 'vitest'
import { vec3, vec4 } from 'three/tsl'
import { SURFACE_LUMINANCE } from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { composeSky } from './enhancedSky.ts'
import { airLuminance, setSceneExposure } from './radiance.ts'

/*
 * Enhanced's lift of the faint sky, against the air in front of it.
 *
 * The galaxy is lifted by 2²³ and compressed to half the surface white so it
 * reads beside a sunlit planet. Measured against nothing, that lift drew the
 * Milky Way's bulge and its dust lanes through Earth's noon sky, brighter
 * than the blue it was seen through. The air is part of the sky being
 * compressed, so a day sky leaves the field its physical share of the total.
 */

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => {
  airLuminance.value = 0
  setSceneExposure(gpu.renderer, null)
  gpu?.dispose()
})

/** A bright star cloud: the lift takes it to 2.5 and the ceiling to 0.42. */
const STAR_CLOUD = 3e-7
/** Earth's zenith under a 60° sun, from `zenithSkyRadiance`, scene units. */
const NOON_AIR = 0.49

async function composed(air: number): Promise<number> {
  airLuminance.value = air
  const pixels = await gpu.drawGraph(vec4(composeSky(vec3(STAR_CLOUD)), 1), {
    width: 1,
    height: 1,
    float: true,
  })
  return pixels.at(0, 0)[1]
}

it('lifts the field in a vacuum and leaves it its share of a noon sky', async () => {
  const pre = 1 / SURFACE_LUMINANCE
  setSceneExposure(gpu.renderer, pre, pre, 'enhanced')
  const vacuum = await composed(0)
  const noon = await composed(NOON_AIR)
  expect(vacuum).toBeCloseTo(2.52 / (1 + 2.52 / 0.5), 2)
  // A hundredth of one 8-bit code at the surface white: gone, which is what
  // a field a million times fainter than the air it is seen through is.
  expect(noon).toBeLessThan(1 / 255 / 100)
  expect(noon).toBeGreaterThan(0)
})

it('leaves the photographic field physical whatever the air', async () => {
  const pre = 1 / SURFACE_LUMINANCE
  setSceneExposure(gpu.renderer, pre, pre, 'photographic')
  expect(await composed(NOON_AIR)).toBeCloseTo(STAR_CLOUD, 12)
  expect(await composed(0)).toBeCloseTo(STAR_CLOUD, 12)
})
