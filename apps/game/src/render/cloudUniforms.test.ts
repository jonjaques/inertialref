import { describe, expect, it } from 'vitest'
import { DataTexture, Quaternion, Vector3 } from 'three/webgpu'
import {
  atmosphereRecipe,
  cloudExtents,
  type LevelFrame,
  type LevelUpdate,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import type {
  CloudBodyFrame,
  CloudCameraFrame,
  CloudFrame,
} from './cloudFrame.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { createCloudUniforms } from './cloudUniforms.ts'

/*
 * `write` is a copy, and a copy is where a frame's numbers can be put in the
 * wrong slot without anything failing: an `eyeOver` packed one boundary off,
 * a quaternion turned the other way, a layer the scenario does not have
 * left at the last scenario's height. The GPU modules read these slots by
 * name, so this holds the slots.
 */

const R = 6_371_000
const EYE = 1_250.5

function level(k: number): LevelFrame {
  return {
    level: k,
    anchor: { x: 0, y: 1, z: 0 },
    east: { x: 1, y: 0, z: 0 },
    north: { x: 0, y: 0, z: -1 },
    texelMeters: 250 * 2 ** k,
    size: 256,
    eye: [12.25 * (k + 1), -3.5],
    along: [R + EYE, 12.25, -3.5],
    origin: [-128 + k, -128],
    epoch: 1,
  }
}

const levels = (count: number): LevelUpdate => ({
  frames: Array.from({ length: count }, (_, k) => level(k)),
  dirty: Array.from({ length: count }, () => []),
  rebuilt: Array.from({ length: count }, () => false),
})

function scattering(): AtmosphereScattering {
  const recipe = atmosphereRecipe(
    {
      color: { r: 0.3, g: 0.5, b: 0.9 },
      limb: { r: 1, g: 0.5, b: 0.2 },
      thickness: 1,
      aerosolAngstrom: 1.3,
      ozone: 300,
    },
    1.02,
    { rayleigh: 0.0013, aerosol: 0.0002 },
  )
  return {
    recipe,
    transmittance: new DataTexture(),
    multiScatter: new DataTexture(),
    multiScatterTable: {} as never,
  }
}

function body(overrides: Partial<CloudBodyFrame> = {}): CloudBodyFrame {
  const boundaries = [900, 2200, 2200, 2200, 2200, 2200]
  return {
    address: 's:3/b:2',
    datumRadius: R,
    compression: 1,
    toBodyFixed: { x: 0.1, y: -0.2, z: 0.3, w: Math.sqrt(1 - 0.14) },
    eye: { x: 0, y: R + EYE, z: 0 },
    sun: { x: 0.6, y: 0.8, z: 0 },
    shells: {
      datumRadius: R,
      eye: EYE,
      boundaries,
      eyeOver: boundaries.map((b) => EYE - b),
    },
    scattering: null,
    limb: 0.75,
    limbFalloff: 0.01,
    dayColor: { r: 1, g: 0.9, b: 0.8 },
    noiseOrigin: { x: 1, y: 2, z: 3 },
    detailOrigin: { x: 4, y: 5, z: 6 },
    drift: { x: 7, y: 8, z: 9 },
    wind: { x: 10, y: 0, z: -2 },
    clipmap: levels(6),
    volume: levels(3),
    cascades: { cascades: [], dirty: [], stale: [] },
    ...overrides,
  }
}

const camera: CloudCameraFrame = {
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
  halfTan: 0.5,
  aspect: 16 / 9,
  pixelAngle: 0.002,
}

function cloudFrame(overrides: Partial<CloudFrame> = {}): CloudFrame {
  return {
    levers: DEFAULT_CLOUD_LEVERS,
    scenario: WEATHER_SCENARIOS['broken-horizon'],
    served: body(),
    second: null,
    time: 1000,
    frameSeconds: 1 / 60,
    period: [7, 0],
    camera,
    previousCamera: null,
    translation: { x: 0.5, y: 0, z: 0 },
    enhanced: false,
    regime: 'converging',
    reset: 'none',
    jump: false,
    frameIndex: 41,
    extents: cloudExtents(
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    ),
    ...overrides,
  }
}

describe('the cloud uniforms', () => {
  it('pack the shells by boundary, and form the numerator in float64', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame())
    const served = uniforms.served
    expect(served.datumRadius.value).toBe(R)
    expect(served.eye.value).toBe(EYE)
    expect(served.eyeOver.value.toArray()).toEqual([
      EYE - 900,
      EYE - 2200,
      EYE - 2200,
      EYE - 2200,
    ])
    expect(served.eyeOverHigh.value.toArray()).toEqual([EYE - 2200, EYE - 2200])
    expect(served.boundaries.value.toArray()).toEqual([900, 2200, 2200, 2200])
    expect(served.eyeTerm.value).toBe(EYE * (2 * R + EYE))
    expect(served.up.value.toArray()).toEqual([0, 1, 0])
    expect(served.sunUp.value).toBeCloseTo(0.8, 15)
    expect(served.active.value).toBe(1)
  })

  it('rotate render axes to body-fixed as the quaternion does', () => {
    const uniforms = createCloudUniforms()
    const frame = cloudFrame()
    uniforms.write(frame)
    const q = frame.served.toBodyFixed
    const v = new Vector3(0.3, -0.7, 0.2)
    const byMatrix = v.clone().applyMatrix3(uniforms.served.toBodyFixed.value)
    const byQuaternion = v
      .clone()
      .applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w))
    expect(byMatrix.distanceTo(byQuaternion)).toBeLessThan(1e-12)
  })

  it('clear the beam only under Enhanced, as the surfaces do', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame())
    expect(uniforms.served.cleared.value).toBe(0)
    uniforms.write(cloudFrame({ enhanced: true }))
    expect(uniforms.served.cleared.value).toBe(0.75)
  })

  it('point the air at the frame’s tables, and lift it by the limb', () => {
    const uniforms = createCloudUniforms()
    const tables = scattering()
    uniforms.write(cloudFrame({ served: body({ scattering: tables }) }))
    const servedAir = uniforms.served.air
    expect(servedAir.top.value).toBe(tables.recipe.topRatio)
    expect(servedAir.transmittance.value).toBe(tables.transmittance)
    expect(servedAir.limb.value).toBe(0.75)
    expect(servedAir.limbFalloff.value).toBe(0.01)
    uniforms.write(cloudFrame())
    expect(servedAir.top.value).toBe(1)
    expect(servedAir.transmittance.value).not.toBe(tables.transmittance)
  })

  it('give the second body stand-ins of its own, and idle it when there is none', () => {
    const uniforms = createCloudUniforms()
    // Two table nodes over one stand-in compile to one binding (rule 57).
    expect(uniforms.second.air.transmittance.value).not.toBe(
      uniforms.served.air.transmittance.value,
    )
    expect(uniforms.second.air.multiScatter.value).not.toBe(
      uniforms.served.air.multiScatter.value,
    )
    uniforms.write(
      cloudFrame({ second: body({ address: 'b:4', datumRadius: 3_980_000 }) }),
    )
    expect(uniforms.second.active.value).toBe(1)
    expect(uniforms.second.datumRadius.value).toBe(3_980_000)
    uniforms.write(cloudFrame())
    expect(uniforms.second.active.value).toBe(0)
    expect(uniforms.served.active.value).toBe(1)
  })

  it('copy each level frame into its slot', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame())
    uniforms.served.clipmap.forEach((slot, k) => {
      expect(slot.texel.value).toBe(250 * 2 ** k)
      expect(slot.eye.value.toArray()).toEqual([12.25 * (k + 1), -3.5])
      expect(slot.origin.value.toArray()).toEqual([-128 + k, -128])
      expect(slot.along.value.toArray()).toEqual([R + EYE, 12.25, -3.5])
      expect(slot.north.value.toArray()).toEqual([0, 0, -1])
    })
    expect(uniforms.served.volume).toHaveLength(3)
    expect(uniforms.served.volume[2]!.texel.value).toBe(1000)
  })

  it('put an absent layer at the union’s top with nothing in it', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame({ scenario: WEATHER_SCENARIOS['two-decks'] }))
    const layers = uniforms.layers
    expect(layers.base.value.toArray()).toEqual([1000, 4000, 4800])
    expect(layers.top.value.toArray()).toEqual([1500, 4800, 4800])
    expect(layers.coverage.value.toArray()).toEqual([0.6, 0.6, 0])
    expect(layers.sigma.value.z).toBe(0)
    // stratocumulus and altocumulus, by their index in CLOUD_GENERA.
    expect(layers.genus.value.toArray()).toEqual([1, 3, 0])
    expect(layers.sigmaScale.value).toBe(0.04)
  })

  it('quarter the step budget in the immediate regime, and wrap the frame index', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame())
    expect(uniforms.trace.maxSteps.value).toBe(192)
    expect(uniforms.trace.immediate.value).toBe(0)
    uniforms.write(cloudFrame({ regime: 'immediate', frameIndex: 2 ** 32 + 5 }))
    expect(uniforms.trace.maxSteps.value).toBe(48)
    expect(uniforms.trace.immediate.value).toBe(1)
    expect(uniforms.trace.frame.value).toBe(5)
  })

  it('hold the jitter at the lever’s index while it is set, and step it with the frame otherwise', () => {
    const uniforms = createCloudUniforms()
    const held = { ...DEFAULT_CLOUD_LEVERS, jitterFrame: 3 }
    for (const frameIndex of [41, 42, 2 ** 32 + 7]) {
      uniforms.write(cloudFrame({ levers: held, frameIndex }))
      expect(uniforms.trace.frame.value, `frame ${frameIndex}`).toBe(3)
    }
    // Wrapped as the frame's own index is: a u32 past 2³² starts over.
    uniforms.write(
      cloudFrame({ levers: { ...held, jitterFrame: 2 ** 32 + 9 } }),
    )
    expect(uniforms.trace.frame.value).toBe(9)
    uniforms.write(cloudFrame({ frameIndex: 42 }))
    expect(uniforms.trace.frame.value).toBe(42)
  })

  it('size the trace and hand over at the footprint', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(
      cloudFrame({
        levers: {
          ...DEFAULT_CLOUD_LEVERS,
          composite: 'thin',
          sweepExtra: 'curl',
        },
      }),
    )
    const t = uniforms.trace
    expect(t.size.value.toArray()).toEqual([480, 270])
    expect(t.history.value.toArray()).toEqual([960, 540])
    expect(t.render.value.toArray()).toEqual([1920, 1080])
    expect(t.farDistance.value).toBeCloseTo(400 / 0.002, 9)
    expect(t.thin.value).toBe(1)
    expect(t.sweepExtra.value).toBe(4)
    expect(t.wind.value.toArray()).toEqual([10, 0, -2])
    expect(uniforms.period.value.toArray()).toEqual([7, 0])
  })

  it('take the current camera for the previous one on a first frame', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame())
    const c = uniforms.camera
    expect(c.plane.value.x).toBeCloseTo(0.5 * (16 / 9), 15)
    expect(c.plane.value.y).toBe(0.5)
    expect(c.previousPlane.value.toArray()).toEqual(c.plane.value.toArray())
    expect(c.previousForward.value.toArray()).toEqual([0, 0, -1])
    expect(c.translation.value.toArray()).toEqual([0.5, 0, 0])
  })

  it('write in place, so a node built over a value sees every frame', () => {
    const uniforms = createCloudUniforms()
    const up = uniforms.served.up.value
    const plane = uniforms.camera.plane.value
    uniforms.write(cloudFrame())
    uniforms.write(cloudFrame({ frameIndex: 42 }))
    expect(uniforms.served.up.value).toBe(up)
    expect(uniforms.camera.plane.value).toBe(plane)
  })
})
