import { describe, expect, it } from 'vitest'
import { DataTexture, Quaternion, type Texture, Vector3 } from 'three/webgpu'
import {
  atmosphereRecipe,
  blobThreshold,
  cloudExtents,
  type LevelFrame,
  type LevelUpdate,
  WEATHER_SCENARIOS,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import {
  type CloudBodyFrame,
  type CloudCameraFrame,
  type CloudFrame,
  type CloudLevelFrame,
  scenarioWeather,
} from './cloudFrame.ts'
import { createCloudField } from './cloudField.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  CLOUD_CLIMATE_KINDS,
  CLOUD_PATTERN_KINDS,
  createCloudUniforms,
} from './cloudUniforms.ts'

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

const NOISE_ORIGIN = { x: 1, y: 2, z: 3 }
const DETAIL_ORIGIN = { x: 4, y: 5, z: 6 }
const TIME = 1000

function body(
  overrides: Partial<CloudBodyFrame> = {},
  scenario: WeatherScenario = WEATHER_SCENARIOS['broken-horizon'],
): CloudBodyFrame {
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
    noiseOrigin: NOISE_ORIGIN,
    detailOrigin: DETAIL_ORIGIN,
    drift: { x: 7, y: 8, z: 9 },
    wind: { x: 10, y: 0, z: -2 },
    clipmap: levels(6),
    volume: levels(3),
    ...scenarioWeather(
      scenario,
      { noise: NOISE_ORIGIN, detail: DETAIL_ORIGIN },
      TIME,
    ),
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

/** A frame under a scenario, its served body's weather the scenario's unless a body is given. */
function cloudFrame(overrides: Partial<CloudFrame> = {}): CloudFrame {
  const scenario = overrides.scenario ?? WEATHER_SCENARIOS['broken-horizon']
  return {
    levers: DEFAULT_CLOUD_LEVERS,
    scenario,
    served: body({}, scenario),
    second: null,
    time: TIME,
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

  it('free the second body’s own stand-ins when disposed, and neither the shared pair nor a bound table', () => {
    const uniforms = createCloudUniforms()
    const freed: Texture[] = []
    const watch = (texture: Texture): Texture => {
      texture.addEventListener('dispose', () => freed.push(texture))
      return texture
    }
    const own = [
      watch(uniforms.second.air.transmittance.value),
      watch(uniforms.second.air.multiScatter.value),
    ]
    watch(uniforms.served.air.transmittance.value)
    watch(uniforms.served.air.multiScatter.value)
    const tables = scattering()
    watch(tables.transmittance)
    watch(tables.multiScatter)
    // Disposed while the second body's nodes hold real tables: the stand-ins
    // are out of every node's reach and still the bundle's to free.
    uniforms.write(
      cloudFrame({ second: body({ address: 'b:4', scattering: tables }) }),
    )
    expect(uniforms.second.air.transmittance.value).toBe(tables.transmittance)
    uniforms.dispose()
    expect(freed).toEqual(own)
  })

  it('are freed with the field built over them', () => {
    const field = createCloudField()
    const freed: Texture[] = []
    const own = [
      field.uniforms.second.air.transmittance.value,
      field.uniforms.second.air.multiScatter.value,
    ]
    for (const texture of own)
      texture.addEventListener('dispose', () => freed.push(texture))
    field.dispose()
    expect(freed).toEqual(own)
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
    const layers = uniforms.served.layers
    expect(layers.base.value.toArray()).toEqual([1000, 4000, 4800])
    expect(layers.top.value.toArray()).toEqual([1500, 4800, 4800])
    expect(layers.coverage.value.toArray()).toEqual([0.6, 0.6, 0])
    expect(layers.sigma.value.z).toBe(0)
    // stratocumulus and altocumulus, by their index in CLOUD_GENERA.
    expect(layers.genus.value.toArray()).toEqual([1, 3, 0])
    expect(layers.sigmaScale.value).toBe(0.04)
    // An absent level holds what a march can read and find nothing in: a
    // cell and a row count to divide by, a radius to look a phase up at.
    expect(layers.cell.value.z).toBe(1)
    expect(layers.radius.value.z).toBe(10)
    expect(layers.phaseRows.value.z).toBeGreaterThan(0)
    expect(layers.depthStratiform.value.z).toBe(0)
  })

  it('give each body its own levels: two clouded bodies in one frame hold two layer sets', () => {
    const uniforms = createCloudUniforms()
    const decks = WEATHER_SCENARIOS['two-decks']
    const fog = WEATHER_SCENARIOS.fog
    uniforms.write(
      cloudFrame({
        scenario: decks,
        served: body({}, decks),
        second: body({ address: 's:3/b:4' }, fog),
      }),
    )
    expect(uniforms.served.layers).not.toBe(uniforms.second.layers)
    expect(uniforms.served.layers.base.value.toArray()).toEqual([
      1000, 4000, 4800,
    ])
    const { base, top, sigma } = fog.layers[0]!
    expect(uniforms.second.layers.base.value.toArray()).toEqual([
      base,
      top,
      top,
    ])
    expect(uniforms.second.layers.sigma.value.toArray()).toEqual([sigma, 0, 0])
    expect(uniforms.second.layers.sigmaScale.value).toBe(sigma)
    expect(uniforms.served.layers.sigmaScale.value).toBe(0.04)
  })

  it('leave the second body’s levels the served body’s where there is no second body', () => {
    const uniforms = createCloudUniforms()
    const decks = WEATHER_SCENARIOS['two-decks']
    uniforms.write(
      cloudFrame({
        scenario: decks,
        second: body({ address: 's:3/b:4' }, WEATHER_SCENARIOS.fog),
      }),
    )
    uniforms.write(cloudFrame({ scenario: decks }))
    expect(uniforms.second.active.value).toBe(0)
    for (const member of ['base', 'top', 'sigma', 'cell', 'radius'] as const)
      expect(uniforms.second.layers[member].value.toArray(), member).toEqual(
        uniforms.served.layers[member].value.toArray(),
      )
  })

  it('copy a level’s every number into its own slot', () => {
    const uniforms = createCloudUniforms()
    const scenario = WEATHER_SCENARIOS['two-decks']
    const served = body({}, scenario)
    // Three levels no two of whose numbers agree, so a slot filled from its
    // neighbor, or a matrix written in columns, reads back wrong.
    const made = (k: number): CloudLevelFrame => ({
      base: 100 + k,
      top: 200 + k,
      sigma: 0.01 * (k + 1),
      radius: 6 + k,
      radiusRange: [4 + k, 9 + k],
      gain: 1.8 + 0.1 * k,
      transport: 0.2 + 0.05 * k,
      cell: 1000 + 100 * k,
      erosion: 0.1 * (k + 1),
      profileRow: 8 * k,
      phaseRow: 32 * k,
      phaseRows: 32 - 9 * k,
      phaseRadius: 2 + 3 * k,
      turn: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => n + 10 * k),
      turnRate: 1e-6 * (k + 1),
      noiseOrigin: { x: 10 + k, y: 20 + k, z: 30 + k },
      detailOrigin: { x: 40 + k, y: 50 + k, z: 60 + k },
      meanDepth: [3 + k, 30 + k],
    })
    const levels = [made(0), made(1), made(2)] as const
    uniforms.write(cloudFrame({ scenario, served: { ...served, levels } }))
    const layers = uniforms.served.layers
    const packed = (read: (level: CloudLevelFrame) => number) =>
      levels.map(read)
    expect(layers.base.value.toArray()).toEqual(packed((l) => l.base))
    expect(layers.top.value.toArray()).toEqual(packed((l) => l.top))
    expect(layers.sigma.value.toArray()).toEqual(packed((l) => l.sigma))
    expect(layers.radius.value.toArray()).toEqual(packed((l) => l.radius))
    expect(layers.radiusMin.value.toArray()).toEqual(
      packed((l) => l.radiusRange[0]),
    )
    expect(layers.radiusMax.value.toArray()).toEqual(
      packed((l) => l.radiusRange[1]),
    )
    expect(layers.gain.value.toArray()).toEqual(packed((l) => l.gain))
    expect(layers.transport.value.toArray()).toEqual(packed((l) => l.transport))
    expect(layers.cell.value.toArray()).toEqual(packed((l) => l.cell))
    expect(layers.erosion.value.toArray()).toEqual(packed((l) => l.erosion))
    expect(layers.profileRow.value.toArray()).toEqual(
      packed((l) => l.profileRow),
    )
    expect(layers.phaseRow.value.toArray()).toEqual(packed((l) => l.phaseRow))
    expect(layers.phaseRows.value.toArray()).toEqual(packed((l) => l.phaseRows))
    expect(layers.phaseRadius.value.toArray()).toEqual(
      packed((l) => l.phaseRadius),
    )
    expect(layers.depthStratiform.value.toArray()).toEqual(
      packed((l) => l.meanDepth[0]),
    )
    expect(layers.depthCumuliform.value.toArray()).toEqual(
      packed((l) => l.meanDepth[1]),
    )
    expect(layers.sigmaScale.value).toBe(0.03)
    expect(uniforms.trace.turn.value.toArray()).toEqual(
      packed((l) => l.turnRate),
    )
    levels.forEach((level, k) => {
      // The frame's nine numbers are rows; the matrix applied to +X is its
      // first column, the first number of each row.
      const column = new Vector3(1, 0, 0).applyMatrix3(layers.turn[k]!.value)
      expect(column.toArray()).toEqual([
        level.turn[0],
        level.turn[3],
        level.turn[6],
      ])
      expect(layers.noiseOrigin[k]!.value.toArray()).toEqual([
        10 + k,
        20 + k,
        30 + k,
      ])
      expect(layers.detailOrigin[k]!.value.toArray()).toEqual([
        40 + k,
        50 + k,
        60 + k,
      ])
    })
    // The three matrices are three objects: one shared would hold the last.
    expect(new Set(layers.turn.map((node) => node.value)).size).toBe(3)
  })

  it('copy a body’s climate: the pattern, the blob thresholds as integers, the terminator', () => {
    const uniforms = createCloudUniforms()
    const cumulus = WEATHER_SCENARIOS['fair-cumulus']
    const dusk = WEATHER_SCENARIOS['dusk-altocumulus']
    uniforms.write(
      cloudFrame({
        scenario: cumulus,
        second: body({ address: 's:3/b:4' }, dusk),
      }),
    )
    const served = uniforms.served.climate
    expect(served.kind.value).toBe(CLOUD_CLIMATE_KINDS.regime)
    const [kind, scale, cells] = served.pattern.value.toArray()
    // Fair-cumulus names blobs, which a regime draws as a uniform cover at
    // the layer's coverage (`regimeWeather`): a 96 km blob cell is a whole
    // sky of cloud or none from a stance.
    expect(kind).toBe(CLOUD_PATTERN_KINDS.uniform)
    expect(scale).toBe(0)
    expect(cells).toBe(1)
    const cover = cumulus.layers[0]!.coverage
    expect(served.cover.value.toArray()).toEqual([cover, 0, 0])
    expect(served.blobThreshold.value.toArray()).toEqual([
      blobThreshold(cover),
      0,
      0,
    ])
    expect(Number.isInteger(served.blobThreshold.value.x)).toBe(true)
    expect(served.convective.value.toArray()).toEqual([1, 0, 0])
    // No terminator: sines no elevation reaches.
    expect(served.terminator.value.toArray()).toEqual([2, 3])
    expect(served.law.value.elements.every((n) => n === 0)).toBe(true)
    // The second body's own: a deck that ends against the sun.
    const second = uniforms.second.climate
    const [full, clear] = second.terminator.value.toArray()
    expect(full).toBeLessThan(clear!)
    expect(clear).toBeLessThanOrEqual(1)
    expect(second.pattern.value.x).toBe(CLOUD_PATTERN_KINDS[dusk.pattern])
  })

  it('carry the levers of the measured choices to the trace, and leave the sun’s weight to the grid', () => {
    const uniforms = createCloudUniforms()
    uniforms.write(cloudFrame())
    const t = uniforms.trace
    expect(t.phaseBins.value).toBe(4)
    expect(t.jitter.value).toBe(0)
    expect(t.transport.value).toBe(0)
    expect(t.handoverBand.value).toBe(2)
    expect(t.clip.value).toBe(1.25)
    t.sunWeight.value = 0.375
    uniforms.write(
      cloudFrame({
        levers: {
          ...DEFAULT_CLOUD_LEVERS,
          phaseBins: 2,
          jitter: 'stbn',
          transport: 'octaves',
          handoverBand: 4,
          clip: 0.75,
        },
      }),
    )
    expect(t.phaseBins.value).toBe(2)
    expect(t.jitter.value).toBe(1)
    expect(t.transport.value).toBe(1)
    expect(t.handoverBand.value).toBe(4)
    expect(t.clip.value).toBe(0.75)
    // Written by the sun grid's schedule, between `write` and the trace.
    expect(t.sunWeight.value).toBe(0.375)
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
        levers: { ...DEFAULT_CLOUD_LEVERS, composite: 'thin' },
      }),
    )
    const t = uniforms.trace
    expect(t.size.value.toArray()).toEqual([480, 270])
    expect(t.history.value.toArray()).toEqual([960, 540])
    expect(t.render.value.toArray()).toEqual([1920, 1080])
    expect(t.farDistance.value).toBeCloseTo(800 / 0.002, 9)
    expect(t.thin.value).toBe(1)
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
