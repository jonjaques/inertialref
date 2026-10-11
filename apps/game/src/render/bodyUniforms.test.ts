import { describe, expect, it } from 'vitest'
import { SURFACE_LUMINANCE, type RenderBody } from '@inertialref/rendering'
import { Quaternion, vec3 } from '@inertialref/spatial'
import {
  type BodyFrame,
  type BodyMaps,
  bodyUniforms,
  CALIBRATED_STAR_RADIANCE,
  starAsBody,
  tuningFor,
} from './bodyUniforms.ts'

/*
 * The mapping from a body to what its materials are told, in Node. The
 * materials themselves are compiled by `materials.gpu.test.ts`; this holds the
 * arithmetic that reaches them, which no GPU test can see.
 */

const FRAME: BodyFrame = {
  keyLight: vec3(1e9, 0, 0),
  keyColor: { r: 1, g: 0.9, b: 0.8 },
  visibility: false,
  renderTime: 3600,
  eye: vec3(0, 0, 5e7),
}

const NO_MAPS: BodyMaps = {
  normal: false,
  night: false,
  clouds: false,
  bake: false,
}

const WHITE = { r: 1, g: 1, b: 1 }

/** A rocky world with air, clouds and a sea: Earth's shape of record. */
function body(overrides: Partial<RenderBody> = {}): RenderBody {
  return {
    sunlight: 0.5,
    address: 'sol/3',
    name: 'Earth',
    kind: 'terrestrial',
    placement: {
      position: vec3(0, 0, 0),
      scale: 6.4e6,
      compression: 1,
      angularRadius: 0.1,
      distance: 5e7,
      compressed: false,
      tier: 'sphere',
    },
    orientation: Quaternion.fromAxisAngle(vec3(1, 0, 0), 0.4),
    hasAtmosphere: true,
    terminator: 0.05,
    atmosphereScale: 1.025,
    trueRadius: 6.4e6,
    rotationPeriod: 86_164,
    flattening: 0.9966,
    figure: null,
    rings: null,
    appearance: {
      texture: 'earth',
      maps: [],
      relief: 0,
      geometricAlbedo: 0.43,
      roughness: 0.5,
      clouds: { altitude: 12_000, opacity: 0.8, rotationPeriod: 80_000 },
      rings: null,
      haze: {
        thickness: 0.6,
        color: { r: 0.4, g: 0.6, b: 1 },
        limb: { r: 1, g: 0.5, b: 0.3 },
      },
      color: { r: 0.3, g: 0.4, b: 0.6 },
      pigment: { r: 0.3, g: 0.4, b: 0.6 },
      liquid: null,
    } as unknown as RenderBody['appearance'],
    ...overrides,
  }
}

const FIGURE: RenderBody['figure'] = {
  model: null,
  irregularity: 0.2,
  semiAxes: [6.4e6, 6.0e6, 5.6e6],
}

describe('the figure branch', () => {
  it('flattens a spheroid and every shell around it by the same ratio', () => {
    const spheroid = body()
    const uniforms = bodyUniforms(spheroid, FRAME, NO_MAPS, null)
    expect(uniforms.figured).toBe(false)
    expect(uniforms.scale.y / uniforms.scale.x).toBeCloseTo(0.9966, 12)
    expect(uniforms.clouds!.scale.y / uniforms.clouds!.scale.x).toBeCloseTo(
      0.9966,
      12,
    )
    expect(
      uniforms.atmosphere!.scale.y / uniforms.atmosphere!.scale.x,
    ).toBeCloseTo(0.9966, 12)
    expect(uniforms.atmosphere!.flattening).toBe(0.9966)
  })

  it('flattens nothing about a figured body: not the mesh, the clouds or the air', () => {
    const figured = body({ figure: FIGURE })
    const uniforms = bodyUniforms(figured, FRAME, NO_MAPS, null)
    expect(uniforms.figured).toBe(true)
    expect(uniforms.scale).toEqual({ x: 6.4e6, y: 6.4e6, z: 6.4e6 })
    const clouds = uniforms.clouds!
    expect(clouds.scale.y).toBe(clouds.scale.x)
    const air = uniforms.atmosphere!
    expect(air.scale.y).toBe(air.scale.x)
    expect(air.flattening).toBe(1)
  })

  it("measures a figured body's deck altitude against a round shell", () => {
    // The eye straight over the pole, in the body's own frame, one thousand
    // meters above the shell. Squashed, the shell's pole would sit lower and
    // the eye read higher.
    const figured = body({ figure: FIGURE })
    const shell = bodyUniforms(figured, FRAME, NO_MAPS, null).clouds!.scale.x
    const eye = Quaternion.rotate(figured.orientation, vec3(0, shell + 1000, 0))
    const clouds = bodyUniforms(
      figured,
      { ...FRAME, eye },
      NO_MAPS,
      null,
    ).clouds!
    expect(clouds.eyeAltitude).toBeCloseTo(1000, 3)
  })
})

describe('a mapped body', () => {
  const mapped = body()
  const maps: BodyMaps = {
    normal: true,
    night: true,
    clouds: true,
    bake: false,
  }

  it('takes the tuning for a rocky world under air', () => {
    const tuning = tuningFor(mapped)
    const planet = bodyUniforms(mapped, FRAME, maps, null).planet!
    expect(planet.lunarLambert).toBe(0.3)
    expect(planet.reliefScale).toBe(tuning.reliefScale)
    expect(planet.reliefScale).toBe(6)
    expect(planet.terminator).toBe(mapped.terminator)
    expect(planet.specularStrength).toBe(1)
    expect(planet.nightStrength).toBe(1)
    expect(planet.cloudShadow).toBe(0.55)
    expect(planet.hazeStrength).toBe(0.6)
  })

  it('scales no relief, glint, lights or cloud shadow it has no image for', () => {
    const planet = bodyUniforms(mapped, FRAME, NO_MAPS, null).planet!
    expect(planet.reliefScale).toBe(0)
    expect(planet.specularStrength).toBe(0)
    expect(planet.nightStrength).toBe(0)
    expect(planet.cloudShadow).toBe(0)
  })

  it('scales relief from a bake where there is no normal map', () => {
    const planet = bodyUniforms(
      mapped,
      FRAME,
      { ...NO_MAPS, bake: true },
      null,
    ).planet!
    expect(planet.reliefScale).toBe(6)
    expect(planet.specularStrength).toBe(1)
  })

  it('tints a mapless deck and leaves a mapped one white', () => {
    expect(
      bodyUniforms(mapped, FRAME, NO_MAPS, null).clouds!.baseColor,
    ).toEqual(mapped.appearance.color)
    expect(bodyUniforms(mapped, FRAME, maps, null).clouds!.baseColor).toEqual(
      WHITE,
    )
  })

  it('carries its sunlight in the key color under calibrated staging only', () => {
    expect(bodyUniforms(mapped, FRAME, maps, null).sunColor).toEqual({
      r: 0.5,
      g: 0.45,
      b: 0.4,
    })
    expect(
      bodyUniforms(mapped, { ...FRAME, visibility: true }, maps, null).sunColor,
    ).toEqual(FRAME.keyColor)
  })

  it('drifts its deck by the difference of the two rates', () => {
    const clouds = bodyUniforms(mapped, FRAME, maps, null).clouds!
    expect(clouds.drift).toBeCloseTo(3600 / 80_000 - 3600 / 86_164, 15)
  })

  it('draws no shell at a point', () => {
    const point = body({
      placement: { ...mapped.placement, tier: 'point' },
    })
    const uniforms = bodyUniforms(point, FRAME, maps, null)
    expect(uniforms.clouds).toBeNull()
    expect(uniforms.atmosphere).toBeNull()
  })
})

describe('the star as a body', () => {
  const star = {
    system: 'sol',
    name: 'Sun',
    luminance: SURFACE_LUMINANCE * 40,
    color: { r: 1, g: 0.95, b: 0.9 },
    placement: {
      position: vec3(1e9, 0, 0),
      scale: 7e8,
      compression: 1,
      angularRadius: 0.06,
      tier: 'sphere',
    },
  } as unknown as Parameters<typeof starAsBody>[0]

  it('is a round, airless, unlit body under its own key', () => {
    const asBody = starAsBody(star, false)
    expect(asBody.address).toBe('star:sol')
    expect(asBody.figure).toBeNull()
    expect(asBody.sunlight).toBe(40)
    const uniforms = bodyUniforms(asBody, FRAME, NO_MAPS, star.color)
    expect(uniforms.planet).toBeNull()
    expect(uniforms.atmosphere).toBeNull()
    expect(uniforms.clouds).toBeNull()
    expect(uniforms.rings).toBeNull()
    expect(uniforms.star!.color).toBe(star.color)
    expect(uniforms.star!.exposure).toBe(40)
    // Sitting on its own key light: no direction, and no NaN.
    expect(uniforms.sun).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('stops down as it fills the frame under Enhanced staging', () => {
    const asBody = starAsBody(star, true)
    const uniforms = bodyUniforms(
      asBody,
      { ...FRAME, visibility: true },
      NO_MAPS,
      star.color,
    )
    const filling = (0.06 - 0.015) / 0.085
    expect(uniforms.star!.exposure).toBeCloseTo(
      CALIBRATED_STAR_RADIANCE * (1 - filling * 0.9),
      12,
    )
  })
})
