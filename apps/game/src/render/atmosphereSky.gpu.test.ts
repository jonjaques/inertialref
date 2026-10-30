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
import { diskThroughAir, zenithSkyRadiance } from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import { createAtmosphereMaterial, createStarMaterial } from './materials.ts'
import { CALIBRATED_STAR_RADIANCE } from './bodyUniforms.ts'

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

interface Ground {
  /** The drawn sphere's radius under sea level, as `sunkSphereRadius` sinks it. */
  readonly sunk?: number
  /** Polar over equatorial radius, with the spin axis along +Y. */
  readonly flattening?: number
  /** The observer's direction from the center; +Y by default. */
  readonly up?: Vector3
  /** The sun's direction; 59° from the horizon toward +X by default. */
  readonly sun?: Vector3
}

/** RGB of a narrow view from two meters above sea level along `direction`. */
async function skyToward(
  direction: Vector3,
  ground: Ground = {},
  extra?: Mesh,
): Promise<[number, number, number]> {
  const sunk = ground.sunk ?? 1
  const flattening = ground.flattening ?? 1
  const up = ground.up ?? new Vector3(0, 1, 0)
  const air = createAtmosphereMaterial()
  // The tables are baked over the drawn sphere, as `Bodies` bakes them.
  const scattering = scatteringFor(haze, top / sunk)
  air.setScattering(
    scattering.recipe,
    scattering.transmittance,
    scattering.multiScatter,
  )
  air.center.value.set(0, 0, 0)
  air.innerRadius.value = sunk
  air.outerRadius.value = top
  air.seaLevel.value = 1
  air.flattening.value = flattening
  air.spinAxis.value.set(0, 1, 0)
  air.sunDirection.value.copy(
    ground.sun ?? new Vector3(Math.cos(SUN), Math.sin(SUN), 0),
  )
  air.sunColor.value.setRGB(1, 1, 1)
  expect(air.material.side).toBe(BackSide)
  const scene = new Scene()
  const shell = new Mesh(new SphereGeometry(top, 96, 64), air.material)
  shell.scale.set(1, flattening, 1)
  scene.add(shell)
  if (extra !== undefined) scene.add(extra)
  const eye = up.clone().multiplyScalar(1 + 2 / earth.radius)
  const camera = new PerspectiveCamera(2, 1, 1e-6, 10)
  camera.position.copy(eye)
  camera.up.set(0, 0, 1)
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

it('measures the air from sea level, not from the sunk sphere or the stretch', async () => {
  // The drawn sphere is sunk 9.9 km under Earth's datum so the terrain covers
  // it, and the shell is oblate where the terrain is not. Marched from the
  // geometry, an observer at sea level at 77° latitude stood some 30 km up in
  // the air: a zenith at half its light, and a setting sun that never
  // reddened. The sky over sea level is the sky over sea level, however the
  // sphere under it is drawn.
  const latitude = (77 * Math.PI) / 180
  const up = new Vector3(Math.cos(latitude), Math.sin(latitude), 0)
  const sun = up
    .clone()
    .applyAxisAngle(new Vector3(0, 0, 1), (31 * Math.PI) / 180)
  const reference = await skyToward(up, { up, sun })
  const drawn = await skyToward(up, {
    up,
    sun,
    sunk: 1 - 9_900 / earth.radius,
    flattening: earth.polarRadius / earth.radius,
  })
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(drawn[c]! / reference[c]! - 1)).toBeLessThan(0.05)
})

it('draws a setting sun brighter than the sky beside it', async () => {
  // Under Enhanced the disk is drawn at eight times the surface white and
  // the shell then dims it by the path's gray mean: 0.78 at a 2° sun, under
  // the aureole around it, so the brightest thing in the scene was a dull
  // spot in its own glow. `diskThroughAir` dims it by the law that drew it.
  const elevation = (2 * Math.PI) / 180
  const sun = new Vector3(Math.cos(elevation), Math.sin(elevation), 0)
  const eye = new Vector3(0, 1 + 2 / earth.radius, 0)
  const scattering = scatteringFor(haze, top)
  const throughAir = diskThroughAir(
    scattering.recipe,
    eye.y,
    sun.y,
    Math.log(CALIBRATED_STAR_RADIANCE) / Math.log(1.6e9 / 30_000),
  )
  const star = createStarMaterial()
  star.color.value.setRGB(...throughAir)
  star.exposure.value = CALIBRATED_STAR_RADIANCE
  const distance = 3
  const disk = new Mesh(
    new SphereGeometry(distance * Math.tan((0.6 * Math.PI) / 180), 32, 16),
    star.material,
  )
  disk.position.copy(eye).addScaledVector(sun, distance)
  const luminance = ([r, g, b]: readonly number[]) =>
    0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  const onDisk = await skyToward(sun, { sun }, disk)
  const beside = await skyToward(
    sun.clone().applyAxisAngle(new Vector3(0, 1, 0), (1.5 * Math.PI) / 180),
    { sun },
    disk,
  )
  star.material.dispose()
  // Measured 9.3 against 5.4. Gray extinction drew the disk at about 0.6,
  // a ninth of the sky beside it; the aureole is as bright as it is because
  // the shell's gain sits some three times over a measured clear sky.
  expect(luminance(onDisk)).toBeGreaterThan(1.5 * luminance(beside))
  // And it set orange: red over green over blue.
  expect(onDisk[0]).toBeGreaterThan(onDisk[1])
  expect(onDisk[1]).toBeGreaterThan(onDisk[2])
})
