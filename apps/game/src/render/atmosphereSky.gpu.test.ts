import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  BackSide,
  Mesh,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import { SOLAR_PLANETS } from '@inertialref/universe'
import { zenithSkyRadiance } from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import { createAtmosphereMaterial } from './materials.ts'

/*
 * The sky from the ground, drawn by the shell and read back.
 *
 * A clear noon sky on Earth is the authored zenith color — blue over green
 * over red — and the aerosol glow around the sun is white, because Earth's
 * aerosols scatter all three channels about alike. The orange of a sunset is
 * the transmittance table reddening a grazing beam, not a property of the
 * aerosol, and a recipe that tints the aerosol with the limb color applies it
 * a second time: the forward lobe sits around the sun at noon, which it turns
 * salmon, and its multiple scattering lays the tint over the whole day sky,
 * which it turns lavender.
 */

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu?.dispose())

const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
const haze = earth.haze!
const top = 1 + haze.height / earth.radius
/** Sun elevation over the observer's horizon. */
const SUN = (59 * Math.PI) / 180

/** RGB of a narrow view from two meters above the ground along `direction`. */
async function skyToward(
  direction: Vector3,
): Promise<[number, number, number]> {
  const air = createAtmosphereMaterial()
  const scattering = scatteringFor(haze, top)
  air.setScattering(
    scattering.recipe,
    scattering.transmittance,
    scattering.multiScatter,
  )
  air.center.value.set(0, 0, 0)
  air.innerRadius.value = 1
  air.outerRadius.value = top
  air.sunDirection.value.set(Math.cos(SUN), Math.sin(SUN), 0)
  air.sunColor.value.setRGB(1, 1, 1)
  expect(air.material.side).toBe(BackSide)
  const scene = new Scene()
  scene.add(new Mesh(new SphereGeometry(top, 96, 64), air.material))
  const eye = new Vector3(0, 1 + 2 / earth.radius, 0)
  const camera = new PerspectiveCamera(2, 1, 1e-6, 10)
  camera.position.copy(eye)
  camera.lookAt(eye.clone().add(direction))
  camera.updateMatrixWorld(true)
  scene.updateMatrixWorld(true)
  const pixels = await gpu.draw(scene, camera, {
    width: 4,
    height: 4,
    float: true,
  })
  air.material.dispose()
  const [red, green, blue] = pixels.at(2, 2)
  return [red, green, blue]
}

it('paints the noon zenith in the authored color, not the limb', async () => {
  const [red, green, blue] = await skyToward(new Vector3(0, 1, 0))
  // The authored zenith is 0.28 : 0.48 : 0.95. Single scattering at 31°
  // from the sun, the aerosol's forward lobe and the multiple scattering
  // all pull toward white; none of them may reverse the order.
  expect(blue).toBeGreaterThan(green)
  expect(green).toBeGreaterThan(red)
  expect(red / blue).toBeLessThan(0.75)
})

it('leaves the aureole around a high sun white', async () => {
  const offset = (3 * Math.PI) / 180
  const pixel = await skyToward(
    new Vector3(Math.cos(SUN + offset), Math.sin(SUN + offset), 0),
  )
  // Three degrees off a 59° sun the aerosol lobe outweighs the Rayleigh sky
  // several times over, so what is left of the blue is the only tint it
  // carries. A tenth either way is a white glow; the limb-tinted recipe
  // measured 1.00 : 0.49 : 0.31 here.
  const brightest = Math.max(...pixel)
  const faintest = Math.min(...pixel)
  expect(faintest / brightest).toBeGreaterThan(0.85)
})

it('reports the zenith it draws as the air the observer stands under', async () => {
  // `airOverhead` marches the zenith on the CPU, with the sun's
  // transmittance exact where the shell reads a half-float table and with
  // 32 samples where the shell takes 12. Enhanced's veil is that number, so
  // it may not drift from the sky on screen by more than the two marches
  // differ: the shell draws 1.7–2.3% under the CPU column, per channel, at
  // this sun. Five percent is that with room, and costs a star 0.03 mag.
  const drawn = await skyToward(new Vector3(0, 1, 0))
  const scattering = scatteringFor(haze, top)
  const reported = zenithSkyRadiance(
    scattering.recipe,
    scattering.multiScatterTable,
    1 + 2 / earth.radius,
    Math.sin(SUN),
  )
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(drawn[c]! / reported[c]! - 1)).toBeLessThan(0.05)
})
