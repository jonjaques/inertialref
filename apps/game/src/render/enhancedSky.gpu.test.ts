import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Node } from 'three/webgpu'
import { vec3, vec4 } from 'three/tsl'
import { SURFACE_LUMINANCE } from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { composeSky } from './enhancedSky.ts'
import {
  airLuminance,
  sceneRadianceGain,
  setSceneExposure,
  visibilityAmbient,
} from './radiance.ts'

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
const NOON_AIR = 0.12

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

it('holds the composed field and the night fill when a darkening sky opens the exposure', async () => {
  // `airAdaptation` opens Enhanced by up to eleven stops at dusk. Everything
  // a material draws is multiplied by the scene gain on its way out, so what
  // Enhanced stages — the composed galaxy, the three-percent night fill —
  // has to carry the inverse, or civil dusk lifts them two thousandfold.
  const drawn = async (graph: Node<'vec3'>) =>
    (
      await gpu.drawGraph(vec4(graph, 1), {
        width: 1,
        height: 1,
        float: true,
      })
    ).at(0, 0)[1]
  const calibrated = 1 / SURFACE_LUMINANCE
  airLuminance.value = 0
  setSceneExposure(gpu.renderer, calibrated, calibrated, 'enhanced')
  const field = await drawn(composeSky(vec3(STAR_CLOUD)).mul(sceneRadianceGain))
  const fill = await drawn(vec3(visibilityAmbient).mul(sceneRadianceGain))
  const opened = calibrated * 2 ** 6
  setSceneExposure(gpu.renderer, opened, opened, 'enhanced')
  expect(
    await drawn(composeSky(vec3(STAR_CLOUD)).mul(sceneRadianceGain)),
  ).toBeCloseTo(field, 5)
  expect(
    await drawn(vec3(visibilityAmbient).mul(sceneRadianceGain)),
  ).toBeCloseTo(fill, 5)
  expect(fill).toBeCloseTo(0.03, 5)
})
