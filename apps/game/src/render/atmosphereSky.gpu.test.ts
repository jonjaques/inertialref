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
import {
  diskThroughAir,
  limbFalloff,
  limbLift,
  limbReach,
  zenithSkyRadiance,
} from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import { createAtmosphereMaterial, createStarMaterial } from './materials.ts'
import { createPlanetMaterial } from './planet.ts'
import { setSceneExposure } from './radiance.ts'
import { CALIBRATED_STAR_RADIANCE } from './bodyUniforms.ts'

/*
 * The sky from the ground, drawn by the shell and read back.
 *
 * A clear noon sky on Earth is the authored zenith color — blue over green
 * over red — and the aerosol glow around the sun is whiter than the sky away
 * from it, because the aerosol's scattering departs from gray only along its
 * Ångström slope. The orange of a sunset is the transmittance table
 * reddening a grazing beam, not a property of the aerosol, and a recipe that
 * tints the aerosol with the limb color applies it a second time: the
 * forward lobe sits around the sun at noon, which it turns salmon, and its
 * multiple scattering lays the tint over the whole day sky, which it turns
 * lavender.
 */

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu?.dispose())

const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
const haze = earth.haze!
const top = 1 + haze.height / earth.radius
/** Earth's two scale heights over the datum, the unit the tables are baked in. */
const HEIGHTS = {
  rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
  aerosol: haze.aerosolHeight / earth.radius,
}
/** Sun elevation over the observer's horizon. */
const SUN = (59 * Math.PI) / 180

interface Ground {
  /** The drawn sphere's radius under sea level, as `sunkSphereRadius` sinks it. */
  readonly sunk?: number
  /**
   * The eye's height over sea level, meters; two by default. Negative over a
   * sea that lies under its datum, as a generated sea can.
   */
  readonly height?: number
  /**
   * The lens's vertical field, degrees; 2 by default, which reads a pixel a
   * quarter of a degree off the axis. A claim about a third of a degree of
   * sky needs a narrower one.
   */
  readonly fov?: number
  /** Polar over equatorial radius, with the spin axis along +Y. */
  readonly flattening?: number
  /** The observer's direction from the center; +Y by default. */
  readonly up?: Vector3
  /** The sun's direction; 59° from the horizon toward +X by default. */
  readonly sun?: Vector3
  /**
   * How far the eye stands outside the air, as `buildScene` hands it to
   * the shell; by default what `limbLift` says of `height`, which is none
   * from the ground and all of it from four radii out.
   */
  readonly limb?: number
}

/** RGB of a narrow view from `height` over sea level along `direction`. */
async function skyToward(
  direction: Vector3,
  ground: Ground = {},
  extra?: Mesh,
): Promise<[number, number, number]> {
  const sunk = ground.sunk ?? 1
  const flattening = ground.flattening ?? 1
  const up = ground.up ?? new Vector3(0, 1, 0)
  const air = createAtmosphereMaterial()
  // The tables are baked over the datum, as `Bodies` bakes them; the drawn
  // sphere is `sunk` under it.
  const scattering = scatteringFor(haze, top, HEIGHTS)
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
  const eyeRatio = 1 + (ground.height ?? 2) / earth.radius
  const limb = ground.limb ?? limbLift(eyeRatio, top)
  const falloff = limbFalloff(eyeRatio, HEIGHTS.rayleigh)
  air.setLimb(limb, falloff)
  expect(air.material.side).toBe(BackSide)
  const scene = new Scene()
  // The mesh grows to the limb's reach as `bodyUniforms` grows it.
  const shell = new Mesh(
    new SphereGeometry(limbReach(top, limb, falloff), 96, 64),
    air.material,
  )
  shell.scale.set(1, flattening, 1)
  scene.add(shell)
  if (extra !== undefined) scene.add(extra)
  const eye = up.clone().multiplyScalar(eyeRatio)
  const camera = new PerspectiveCamera(ground.fov ?? 2, 1, 1e-6, 10)
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
  // all pull toward white; none of them may reverse the order. Measured
  // 0.55 red over blue, a CIE xy of (0.275, 0.294) — a clear sky's blue.
  // With a gray aerosol it was 0.77, a pale one.
  expect(blue).toBeGreaterThan(green)
  expect(green).toBeGreaterThan(red)
  expect(red / blue).toBeLessThan(0.65)
})

it('leaves the aureole around a high sun whiter than the sky, and never warm', async () => {
  const offset = (3 * Math.PI) / 180
  const pixel = await skyToward(
    new Vector3(Math.cos(SUN + offset), Math.sin(SUN + offset), 0),
  )
  const zenith = await skyToward(new Vector3(0, 1, 0))
  // Three degrees off a 59° sun the aerosol lobe outweighs the Rayleigh sky
  // several times over, so it is whiter than the open sky: 0.69 of its
  // brightest channel in its faintest, against the zenith's 0.55. It keeps
  // the blue of the Ångström slope and none of the limb's orange, which the
  // limb-tinted recipe drew here at 1.00 : 0.49 : 0.31.
  const whiteness = (rgb: readonly number[]) =>
    Math.min(...rgb) / Math.max(...rgb)
  expect(whiteness(pixel)).toBeGreaterThan(whiteness(zenith) + 0.08)
  expect(pixel[2]).toBeGreaterThan(pixel[0])
})

it('reports the zenith it draws as the air the observer stands under', async () => {
  // `airOverhead` marches the zenith on the CPU, with the sun's
  // transmittance exact where the shell reads a half-float table and with
  // 32 samples where the shell takes 12. Enhanced's veil is that number, so
  // it may not drift from the sky on screen by more than the two marches
  // differ. Five percent costs a star 0.03 mag.
  const drawn = await skyToward(new Vector3(0, 1, 0))
  const scattering = scatteringFor(haze, top, HEIGHTS)
  const reported = zenithSkyRadiance(
    scattering.recipe,
    scattering.multiScatterTable,
    1 + 2 / earth.radius,
    Math.sin(SUN),
  )
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(drawn[c]! / reported[c]! - 1)).toBeLessThan(0.05)
})

it('draws the twilight zenith the CPU column reports', async () => {
  // At −8° the column is lit by Ψ alone, which falls tenfold every two
  // degrees there. The table holds ln Ψ and is read at its texel centers, as
  // `sampleLut` reads it; a linear read, or one a quarter texel off, is a
  // degree of sun and a factor of three in this sky.
  const below = (-8 * Math.PI) / 180
  const sun = new Vector3(Math.cos(below), Math.sin(below), 0)
  const drawn = await skyToward(new Vector3(0, 1, 0), { sun })
  const scattering = scatteringFor(haze, top, HEIGHTS)
  const reported = zenithSkyRadiance(
    scattering.recipe,
    scattering.multiScatterTable,
    1 + 2 / earth.radius,
    Math.sin(below),
  )
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(drawn[c]! / reported[c]! - 1)).toBeLessThan(0.15)
})

it('measures the air from sea level, not from the sunk sphere', async () => {
  // The drawn sphere is sunk 9.9 km under Earth's datum so the terrain covers
  // it. Marched with that sphere as sea level, an observer on a beach stood
  // 9.9 km up in the air: a zenith at half its light, and a setting sun that
  // never reddened. The sky over sea level is the sky over sea level,
  // however deep the sphere under it is drawn.
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
  })
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(drawn[c]! / reference[c]! - 1)).toBeLessThan(0.05)
})

it('stops a ray at the drawn sphere, under every surface, and not at sea level', async () => {
  // A ray the shell meets the ground with is a short, dense, sunless path,
  // far darker than the sky beside it, so the ground's horizon has to lie
  // under every drawn surface. Sea level does not: the far shore's sea lies
  // 211 m under its datum, and from 80 m over that water — 131 m under the
  // datum — a shell stopped at sea level stood its horizon level while the
  // sea's dipped 0.36°, a black band five pixels tall between the water and
  // the sky. A ray 0.15° under level is above the sea's horizon, and sky.
  const dip = (0.15 * Math.PI) / 180
  const elevation = (4.6 * Math.PI) / 180
  const ground: Ground = {
    height: -131,
    fov: 0.2,
    sunk: 1 - 9_900 / earth.radius,
    sun: new Vector3(Math.cos(elevation), Math.sin(elevation), 0),
  }
  const luminance = ([r, g, b]: readonly number[]) =>
    0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  const under = await skyToward(
    new Vector3(-Math.cos(dip), -Math.sin(dip), 0),
    ground,
  )
  const over = await skyToward(
    new Vector3(-Math.cos(dip), Math.sin(dip), 0),
    ground,
  )
  // Stopped at sea level the ray under level drew at 0.004 of the one over
  // it; as sky it is 0.98 of it.
  expect(luminance(under)).toBeGreaterThan(0.7 * luminance(over))
})

it('draws a setting sun brighter than the sky beside it', async () => {
  // Under Enhanced the disk is drawn at eight times the surface white and
  // the shell then dims it by the path's gray mean: 0.78 at a 2° sun, under
  // the aureole around it, so the brightest thing in the scene was a dull
  // spot in its own glow. `diskThroughAir` dims it by the law that drew it.
  const elevation = (2 * Math.PI) / 180
  const sun = new Vector3(Math.cos(elevation), Math.sin(elevation), 0)
  const eye = new Vector3(0, 1 + 2 / earth.radius, 0)
  const scattering = scatteringFor(haze, top, HEIGHTS)
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
  // Measured 1.7 against 0.13, a deep orange disk twelve times the sky
  // beside it. Gray extinction drew the disk under the aureole.
  expect(luminance(onDisk)).toBeGreaterThan(1.5 * luminance(beside))
  // And it set orange: red over green over blue.
  expect(onDisk[0]).toBeGreaterThan(onDisk[1])
  expect(onDisk[1]).toBeGreaterThan(onDisk[2])
})

it("draws the limb from orbit under Enhanced in the air's own colors, and nothing from the ground", async () => {
  // Earth's gas falls off over 8.5 km and its limb is a line two pixels wide
  // on a disk four hundred across. Enhanced's cheat from orbit is the same
  // recipe stretched three scale heights tall and ending at two of them,
  // read through the same tables at the height the stretch maps a sample
  // to, with the aerosol's forward lobe at its foot and not its extinction,
  // and drawn six times over: a bright line under a percent of the radius
  // wide. Seen from four radii out, toward a sun a degree and a half
  // over the tangent point's horizon, the foot reads the table where the
  // beam has crossed a horizon's worth of air and arrives red, and the lobe
  // throws it forward; the crown reads it where the beam arrives white and
  // the gas scatters blue. The sky from a beach is the physics under either
  // view.
  const luminance = ([r, g, b]: readonly number[]) =>
    0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  const limbRay = async (
    tangentMeters: number,
    sunOverHorizontal: number,
    enhanced: boolean,
    ahead = false,
  ) => {
    const pre = 1 / 30_000
    setSceneExposure(
      gpu.renderer,
      pre,
      pre,
      enhanced ? 'enhanced' : 'photographic',
    )
    try {
      const tangent = 1 + tangentMeters / earth.radius
      const eye = 4
      const sine = tangent / eye
      const cosine = Math.sqrt(1 - sine * sine)
      // The tangent point's own radial, and the sun that height over its
      // horizontal: ahead of the eye along the view, or square to it so the
      // aerosol's lobe stays out of the reading.
      const radial = new Vector3(cosine, sine, 0)
      const horizontal = ahead
        ? new Vector3(sine, -cosine, 0)
        : new Vector3(0, 0, 1)
      const sun = horizontal
        .add(radial.clone().multiplyScalar(sunOverHorizontal))
        .normalize()
      return await skyToward(new Vector3(sine, -cosine, 0), {
        height: (eye - 1) * earth.radius,
        fov: 0.05,
        sun,
      })
    } finally {
      setSceneExposure(gpu.renderer, null)
    }
  }

  // Under a high sun square to the view the ring is the gas's blue, a dozen
  // times the physics twenty kilometers up (measured 1.22 against 0.076 in
  // the green).
  const noonFoot = await limbRay(20_000, 0.5, true)
  const physicalNoonFoot = await limbRay(20_000, 0.5, false)
  expect(luminance(noonFoot)).toBeGreaterThan(6 * luminance(physicalNoonFoot))
  expect(noonFoot[2]).toBeGreaterThan(noonFoot[0])

  // Toward a sun a degree and a half over the foot's horizon the ring is
  // orange at five kilometers (4.59 : 1.18 : 0.11), warm at ten
  // (3.55 : 1.44 : 0.26) and blue at the crown forty kilometers up
  // (0.34 : 0.47 : 0.76): the order of a photograph of the limb at
  // sunrise — the troposphere, the stratosphere and the blue above.
  const foot5 = await limbRay(5_000, 0.03, true, true)
  expect(foot5[0]).toBeGreaterThan(2 * foot5[2])
  const foot = await limbRay(10_000, 0.03, true, true)
  expect(foot[0]).toBeGreaterThan(foot[1])
  expect(foot[1]).toBeGreaterThan(foot[2])
  const crown = await limbRay(40_000, 0.03, true, true)
  expect(crown[2]).toBeGreaterThan(crown[0])
  expect(crown[0] / crown[2]).toBeLessThan(0.5 * (foot[0] / foot[2]))

  // The ring ends where the sun sets on the gas as it stands on this
  // planet, foot first. Eight degrees under the horizontal and square to
  // the view, the foot's own beam is in the ground and keeps nothing
  // (measured under 1e-4 of 0.44), while the crown fifty kilometers up, at
  // the ring's ceiling, still keeps a share (7e-4). Read through the
  // table's own horizon — the physical planet's at a fraction of the
  // height — the crown was as dark as the foot, and a backlit Earth wore
  // no ring.
  const squareFoot = await limbRay(10_000, 0.03, true)
  const shadowedFoot = await limbRay(10_000, -0.14, true)
  const shadowedCrown = await limbRay(50_000, -0.14, true)
  expect(luminance(shadowedFoot)).toBeLessThan(0.01 * luminance(squareFoot))
  expect(luminance(shadowedCrown)).toBeGreaterThan(3 * luminance(shadowedFoot))
  // Toward the sun the foot's chord collects the lit gas beyond it, thrown
  // forward by the aerosol's lobe, and reads orange while the sun is a few
  // degrees under its horizontal — 0.23 : 0.068 : 0.008 at three degrees,
  // the ring of a backlit Earth — and under half of that, still warm, at
  // eight.
  const backlitFoot = await limbRay(10_000, -0.05, true, true)
  expect(luminance(backlitFoot)).toBeGreaterThan(0.03)
  expect(backlitFoot[0]).toBeGreaterThan(backlitFoot[1])
  expect(backlitFoot[1]).toBeGreaterThan(backlitFoot[2])
  const deepFoot = await limbRay(10_000, -0.14, true, true)
  expect(luminance(deepFoot)).toBeLessThan(0.5 * luminance(backlitFoot))
  expect(deepFoot[0]).toBeGreaterThan(deepFoot[2])

  // The ring is the shell's: the sphere takes the physics' light, with the
  // lift or without it — within a percent, the lift lighting its air with a
  // cleared beam — and the shell past the edge picks up from it without a
  // step. Twenty kilometers either side of the edge, from four
  // radii under a sun 30° over the tangent point, the disk measured 1.21
  // inside with the lift and without, and the shell outside is within
  // thirty percent of it.
  const disk = (sun: Vector3, lift: number) => {
    const planet = createPlanetMaterial()
    planet.baseColor.value.setRGB(0, 0, 0)
    planet.sunDirection.value.copy(sun)
    planet.seaLevel.value = 1
    const baked = scatteringFor(haze, top, HEIGHTS)
    planet.air.set(baked.recipe, baked.transmittance, baked.multiScatter)
    planet.air.lift(lift, limbFalloff(4, HEIGHTS.rayleigh))
    return new Mesh(new SphereGeometry(1, 128, 96), planet.material)
  }
  const edgeRay = async (tangentMeters: number, lift = 1) => {
    const pre = 1 / 30_000
    setSceneExposure(gpu.renderer, pre, pre, 'enhanced')
    try {
      const tangent = 1 + tangentMeters / earth.radius
      const eye = 4
      const sine = tangent / eye
      const cosine = Math.sqrt(1 - sine * sine)
      const radial = new Vector3(cosine, sine, 0)
      const sun = new Vector3(0, 0, 1)
        .add(radial.clone().multiplyScalar(0.5))
        .normalize()
      return luminance(
        await skyToward(
          new Vector3(sine, -cosine, 0),
          { height: (eye - 1) * earth.radius, fov: 0.05, sun },
          disk(sun, lift),
        ),
      )
    } finally {
      setSceneExposure(gpu.renderer, null)
    }
  }
  const inside = await edgeRay(-20_000)
  expect(Math.abs((await edgeRay(-20_000, 0)) / inside - 1)).toBeLessThan(0.01)
  const outside = await edgeRay(20_000)
  expect(Math.abs(inside / outside - 1)).toBeLessThan(0.3)

  const ground = async (enhanced: boolean) => {
    const pre = 1 / 30_000
    setSceneExposure(
      gpu.renderer,
      pre,
      pre,
      enhanced ? 'enhanced' : 'photographic',
    )
    try {
      return luminance(await skyToward(new Vector3(0, 1, 0)))
    } finally {
      setSceneExposure(gpu.renderer, null)
    }
  }
  expect(await ground(true)).toBeCloseTo(await ground(false), 6)
})
