import { describe, expect, it } from 'vitest'
import {
  ClampToEdgeWrapping,
  type Data3DTexture,
  LinearFilter,
} from 'three/webgpu'
import { float, int, uint, uvec2, vec2, vec3 } from 'three/tsl'
import {
  bakeSkyMoments,
  BLUE_NOISE,
  CLOUD_OCTAVE_BOUND,
  CLOUD_OCTAVES,
  cloudOctavesPass,
  CUMULUS_REFERENCE,
  type CumulusFixturePlace,
  cumulusFixture,
  decodeIceTable,
  fieldClock,
  ICE_AGGREGATE,
  iceAggregate,
  iceRowIndex,
  ISCCP_ZONAL,
  isccpZonal,
  regimeWeather,
  SKY_BLOCK_COLUMNS,
  SKY_BLOCK_GUARD,
  SKY_BLOCKS,
  SKY_GROUND_ALBEDO,
  SKY_TABLE_HEIGHT,
  SKY_TABLE_WIDTH,
  SLAB_REFERENCE,
  SLAB_VIEW_SOURCE,
  sunFactorPair,
} from '@inertialref/rendering'
import { MemorySaveStore } from '@inertialref/persistence'
import type { Body } from '@inertialref/universe'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { GameEngine } from '../engine/GameEngine.ts'
import { createCloudJitter, traceJitter } from './cloudJitter.ts'
import {
  crossingExponent,
  crossingTransmittance,
  sunStatistics,
} from './cloudMix.ts'
import {
  CLOUD_STAND_INS,
  type CloudSample,
  exactSlabSun,
  slabMedium,
} from './cloudNodes.ts'
import { createCloudSky } from './cloudSky.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { CLOUD_SOURCE_BYTES, createCloudSource } from './cloudSource.ts'
import {
  type CloudSystem,
  type CloudSystemDeps,
  type CloudSystemFactory,
  createCloudFrontHandle,
  createCloudSystem,
} from './cloudSystem.ts'
import { createCloudUniforms } from './cloudUniforms.ts'

/*
 * The contracts' stubs, each imported and held to its shape: the names a
 * later module reads, the kind of thing each is, and the layout a table
 * declares. Shapes only. No value of a stand-in table is asserted, because
 * a table's values are its generator's, and a test of them here would be
 * rewritten by every package that fills one.
 *
 * This file is the stubs' reader until each has its own, and goes when the
 * last of them does.
 */

const isNode = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (value as { isNode?: boolean }).isNode === true

const sample: CloudSample = {
  offset: vec3(0),
  distance: float(0),
  altitude: float(1500),
  sunMu: float(0.7),
  footprint: float(50),
}

describe('the generated tables’ stand-ins', () => {
  it('each name a format and a version, and hold what their own layout declares', () => {
    for (const table of [
      SLAB_VIEW_SOURCE,
      SLAB_REFERENCE,
      BLUE_NOISE,
      ICE_AGGREGATE,
      CUMULUS_REFERENCE,
      ISCCP_ZONAL,
    ]) {
      expect(table.format).toMatch(/^inertialref\//)
      expect(table.version).toBe(1)
    }
    // The source: four coefficients of the bearing at every node of two
    // depths and a sun, in a slab for each view cosine of each hemisphere.
    // Its texels are a module of their own, which no index exports.
    expect(SLAB_VIEW_SOURCE.texelCount).toBe(
      2 *
        SLAB_VIEW_SOURCE.cosines.length *
        SLAB_VIEW_SOURCE.suns *
        SLAB_VIEW_SOURCE.nodes *
        SLAB_VIEW_SOURCE.nodes *
        4,
    )
    expect(CLOUD_SOURCE_BYTES).toBe(960_000)
    expect(CLOUD_SOURCE_BYTES).toBe(SLAB_VIEW_SOURCE.texelCount * 2)
    // The reference's flux: one value a depth a sun.
    expect(SLAB_REFERENCE.flux).toHaveLength(
      SLAB_REFERENCE.sunMus.length * SLAB_REFERENCE.depths.length,
    )
    // The mask: one byte a texel, in base64.
    const texels = BLUE_NOISE.width * BLUE_NOISE.height * BLUE_NOISE.slices
    expect(BLUE_NOISE.bytes.replace(/=+$/, '')).toHaveLength(
      Math.ceil((texels * 4) / 3),
    )
    expect(Array.isArray(CUMULUS_REFERENCE.probes)).toBe(true)
    expect(Array.isArray(CUMULUS_REFERENCE.curves)).toBe(true)
    expect(Array.isArray(CUMULUS_REFERENCE.voxels)).toBe(true)
  })

  it('decode an ice table on the droplets’ layout, a row an effective diameter', () => {
    const table = iceAggregate()
    expect(table.phase).toHaveLength(table.diameters * table.angles * 3)
    expect(table.bulk).toHaveLength(table.diameters)
    expect(table.bands).toHaveLength(3)
    // Ice maps a radius to a row linearly in diameter: the first row's
    // radius is half its diameter.
    expect(iceRowIndex(table, table.diameterMin / 2)).toBe(0)
    expect(
      iceRowIndex(table, (table.diameterMin + table.diameterStep) / 2),
    ).toBe(1)
    expect(() => decodeIceTable({ ...ICE_AGGREGATE, diameters: 3 })).toThrow()
    expect(() =>
      decodeIceTable({
        ...ICE_AGGREGATE,
        format: 'inertialref/mie' as 'inertialref/ice',
      }),
    ).toThrow()
  })

  it('read ISCCP’s zonal table through a reader that answers null where it holds nothing', () => {
    const zonal = isccpZonal()
    expect(zonal.bands * zonal.bandDegrees).toBe(180)
    expect(zonal.cover('total', zonal.months, 0)).toBeNull()
    expect(zonal.cover('low', 0, zonal.bands)).toBeNull()
    expect(zonal.cover('high', 0.5, 0)).toBeNull()
    expect(zonal.type('no such type')).toBeNull()
  })

  it('hold the octave fits as a list, and pass only on a fit inside the bound', () => {
    expect(Array.isArray(CLOUD_OCTAVES)).toBe(true)
    expect(cloudOctavesPass()).toBe(
      CLOUD_OCTAVES.some((fit) => fit.heldOutError <= CLOUD_OCTAVE_BOUND),
    )
    const fit = { count: 3, a: 0.5, b: 0.4, c: 0.5 } as const
    expect(cloudOctavesPass([{ ...fit, heldOutError: 0.2 }])).toBe(false)
    expect(cloudOctavesPass([{ ...fit, heldOutError: 0.04 }])).toBe(true)
  })

  it('lay the sky table out as three guarded blocks over the sun’s cosine, by height', () => {
    expect(SKY_TABLE_WIDTH).toBe(
      SKY_BLOCKS * (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD),
    )
    expect([SKY_TABLE_WIDTH, SKY_TABLE_HEIGHT]).toEqual([102, 16])
    expect(SKY_GROUND_ALBEDO).toBeGreaterThan(0)
    expect(SKY_GROUND_ALBEDO).toBeLessThan(1)
    const lut = { width: 1, height: 1, data: new Float32Array(4) }
    const sky = bakeSkyMoments({} as never, lut, lut)
    expect([sky.width, sky.height]).toEqual([SKY_TABLE_WIDTH, SKY_TABLE_HEIGHT])
    expect(sky.data).toHaveLength(SKY_TABLE_WIDTH * SKY_TABLE_HEIGHT * 4)
  })

  // 3.7 s in the root suite on this Mac mini (Apple M6), four workers;
  // CI's hosted runner is 2.1 to 3.9 times slower, up to 14 s. Five times that.
  it('cut a cumulus fixture from the field on a place’s voxels', () => {
    const body = {
      radius: 6_371_000,
      surface: { seed: { hi: 0, lo: 0 } },
    } as unknown as Body
    const weather = regimeWeather(body, 'fair-cumulus')
    const place: CumulusFixturePlace = {
      corner: { x: 0, y: body.radius, z: 0 },
      east: { x: 1, y: 0, z: 0 },
      north: { x: 0, y: 0, z: 1 },
      size: [3, 2, 4],
      voxel: 100,
      base: 1000,
    }
    const fixture = cumulusFixture(
      weather,
      fieldClock(weather, 0),
      { x: 0, y: 1, z: 0 },
      place,
    )
    expect(fixture.size).toEqual([3, 2, 4])
    expect(fixture.sigma).toHaveLength(24)
    expect(fixture.radius).toHaveLength(24)
    expect(fixture.sigma.every((value) => value >= 0)).toBe(true)
  }, 80_000)
})

describe('the light’s stub modules', () => {
  it('answer with nodes of the shapes the march reads', () => {
    const uniforms = createCloudUniforms()
    const body = uniforms.served
    const sky = createCloudSky().at(sample, body)
    expect(Object.keys(sky).sort()).toEqual(['mean', 'sunward', 'up'])
    for (const term of Object.values(sky)) expect(isNode(term)).toBe(true)
    const source = createCloudSource()
    const slab = { sunMu: float(0.7), depth: vec2(0) }
    for (const nodes of [source, source.second])
      expect(
        isNode(
          nodes.source(
            { ...slab, convective: float(1) },
            float(10),
            nodes.level(int(0)),
            nodes.view(float(0.5), float(0)),
          ),
        ),
      ).toBe(true)
    const jitter = createCloudJitter({ uniforms })
    expect(jitter.at).toBe(traceJitter)
    expect(isNode(jitter.at(uvec2(0, 0), uint(0)))).toBe(true)
    // Each table module is a resource the field lists, holding nothing on
    // a device it was never warmed on. The source waits for its texels, and
    // reads a stand-in clamped and filtered as the table is until they land.
    for (const resource of [source, jitter]) {
      expect(resource.bytes).toBe(0)
      expect(resource.textures()).toEqual([])
    }
    expect(jitter.pending).toBe(false)
    expect(source.pending).toBe(true)
    const standIn = source.texture as Data3DTexture
    expect([standIn.wrapS, standIn.wrapT, standIn.wrapR]).toEqual([
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
    ])
    expect([standIn.magFilter, standIn.minFilter]).toEqual([
      LinearFilter,
      LinearFilter,
    ])
    expect(new Set([source.name, jitter.name]).size).toBe(2)
    source.dispose()
  })

  it('takes the table when its texels land, laid out as the header says, and holds a level’s class and factor', async () => {
    const source = createCloudSource()
    await source.load()
    expect(source.pending).toBe(false)
    const map = source.texture as Data3DTexture
    expect([map.image.width, map.image.height, map.image.depth]).toEqual([
      SLAB_VIEW_SOURCE.nodes,
      SLAB_VIEW_SOURCE.nodes,
      2 * SLAB_VIEW_SOURCE.cosines.length * SLAB_VIEW_SOURCE.suns,
    ])
    expect([map.wrapS, map.wrapT, map.wrapR, map.magFilter]).toEqual([
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
      LinearFilter,
    ])
    expect(map.generateMipmaps).toBe(false)
    // No level takes a factor until a frame names its genera, and cumulus
    // is the one genus with a fitted pair.
    expect(source.levels.factor.value.toArray()).toEqual([1, 1, 1])
    expect(source.levels.slope.value.toArray()).toEqual([0, 0, 0])
    const genera = [
      ['stratocumulus', 'cumulus'],
      ['altostratus', 'altocumulus'],
      ['cirrus', 'cirrus'],
    ] as const
    source.write({
      served: { climate: { genera } },
      second: null,
    } as unknown as CloudFrame)
    expect(source.levels.factor.value.toArray()).toEqual([
      sunFactorPair('cumulus').l,
      1,
      1,
    ])
    expect(source.levels.slope.value.toArray()).toEqual([
      sunFactorPair('cumulus').a,
      0,
      0,
    ])
    expect(source.levels.ice.value.toArray()).toEqual([0, 0, 1])
    expect(source.secondLevels.ice.value.toArray()).toEqual([0, 0, 0])
    source.dispose()
  })

  it('mix a crossing, and stand the layers’ statistics in for the sun’s cache, as nodes', () => {
    const { layers } = createCloudUniforms().served
    const exponent = crossingExponent(float(1000), float(1200))
    expect(isNode(exponent)).toBe(true)
    expect(isNode(crossingTransmittance(float(0.5), float(20), exponent))).toBe(
      true,
    )
    expect(
      isNode(
        sunStatistics({
          layers,
          level: int(0),
          cover: vec3(0.5),
          convective: vec3(1, 0, 0),
          depth: vec2(4, 10),
          sunMu: float(0.7),
          taps: float(0),
        }),
      ),
    ).toBe(true)
  })

  it('stand in for every node set a march is built over', () => {
    const uniforms = createCloudUniforms()
    const body = uniforms.served
    const medium = CLOUD_STAND_INS.field(
      slabMedium([
        { base: 1000, top: 2000, sigma: 0.01, radius: (h) => h.mul(0.004) },
      ]),
    )(sample, body)
    expect(Object.keys(medium).sort()).toEqual([
      'column',
      'depth',
      'fraction',
      'layer',
      'radius',
      'sigma',
      'statistics',
    ])
    // A slab is one column: its share, its depth, which is its columns'
    // mean as well, no spread, its extent.
    expect(Object.keys(medium.statistics!).sort()).toEqual([
      'depth',
      'fraction',
      'mean',
      'shape',
      'sight',
    ])
    const depths = CLOUD_STAND_INS.sunDepth().depths(sample.offset)
    expect(Object.keys(depths).sort()).toEqual([
      'behind',
      'meanDepthToSun',
      'meanDepthWhole',
      'toSun',
      'weight',
      'whole',
    ])
    const phase = CLOUD_STAND_INS.phase(undefined, 1.9)
    expect(isNode(phase.phase(float(0), body.layers, 0, float(10)))).toBe(true)
    expect(isNode(phase.droplets(float(0), float(10)))).toBe(true)
    expect(isNode(CLOUD_STAND_INS.sky(0.5).at(sample, body).mean)).toBe(true)
    const standIn = CLOUD_STAND_INS.source(0.25)
    expect(
      isNode(
        standIn.source(
          { sunMu: float(1), depth: vec2(0) },
          float(10),
          standIn.level(int(0)),
          standIn.view(float(1), float(0)),
        ),
      ),
    ).toBe(true)
    expect(isNode(CLOUD_STAND_INS.jitter().at(uvec2(0, 0), uint(0)))).toBe(true)
    const sun = exactSlabSun([{ base: 1000, top: 2000, sigma: 0.01 }])(
      sample,
      medium,
      body,
    )
    expect(Object.keys(sun).sort()).toEqual(['air', 'cloud', 'depth', 'octave'])
    expect(isNode(sun.octave(0.5))).toBe(true)
  })
})

describe('the front handle', () => {
  it('holds no trace until a system points it at one, and keeps its uniforms for its life', () => {
    const handle = createCloudFrontHandle()
    expect(handle.textures()).toBeNull()
    const { traceSize, dayColor } = handle.screen
    const outputs = { extent: { width: 4, height: 2 } } as never
    handle.follow(() => outputs)
    expect(handle.textures()).toBe(outputs)
    handle.follow(null)
    expect(handle.textures()).toBeNull()
    expect(handle.screen.traceSize).toBe(traceSize)
    expect(handle.screen.dayColor).toBe(dayColor)
  })

  it('is made by the system’s own factory, one a call', () => {
    const one = createCloudSystem.createFront()
    const other = createCloudSystem.createFront()
    expect(one).not.toBe(other)
    expect(one.screen.traceSize).not.toBe(other.screen.traceSize)
  })

  it('is the engine’s once the cloud chunk arrives, and every system the engine’s factory builds is handed it', () => {
    const engine = new GameEngine({
      seed: 'inertialref',
      workers: () => createInlineWorker(createTaskRegistry()),
      store: new MemorySaveStore(),
      now: () => 0,
    })
    try {
      // Without the flag the chunk never loads: no factory, and no handle.
      expect(engine.cloudFront).toBeNull()
      expect(engine.cloudsAvailable).toBe(false)
      const built: (CloudSystemDeps['front'] | undefined)[] = []
      const chunk: CloudSystemFactory = Object.assign(
        (deps: CloudSystemDeps) => {
          built.push(deps.front)
          return {} as CloudSystem
        },
        { createFront: createCloudFrontHandle },
      )
      engine.cloudSystemFactory = chunk
      const handle = engine.cloudFront
      expect(handle).not.toBeNull()
      expect(engine.cloudsAvailable).toBe(true)
      // One function for the page's life: the sensor's effect depends on it.
      const factory = engine.cloudSystemFactory!
      expect(engine.cloudSystemFactory).toBe(factory)
      // Two chains, as a picture change builds a second: one handle for both.
      factory({} as CloudSystemDeps)
      factory({} as CloudSystemDeps)
      expect(built).toEqual([handle, handle])
      expect(engine.cloudFront).toBe(handle)
      engine.cloudSystemFactory = null
      expect(engine.cloudFront).toBeNull()
      expect(engine.cloudsAvailable).toBe(false)
    } finally {
      engine.dispose()
    }
  })
})
