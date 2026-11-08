import { describe, expect, it } from 'vitest'
import { Scene, PerspectiveCamera } from 'three/webgpu'
import { cloudsSettled } from '@inertialref/devtools'
import { mieDroplets, samplePhase } from '@inertialref/rendering'
import * as air from './air.ts'
import * as clipmap from './cloudClipmap.ts'
import * as composite from './cloudComposite.ts'
import * as compositeAir from './cloudCompositeAir.ts'
import * as density from './cloudDensity.ts'
import * as depth from './cloudDepth.ts'
import * as far from './cloudFar.ts'
import * as farAtlas from './cloudFarAtlas.ts'
import * as farSpheres from './cloudFarSpheres.ts'
import * as frame from './cloudFrame.ts'
import * as frameNode from './cloudFrameNode.ts'
import * as front from './cloudFront.ts'
import * as geometry from './cloudGeometry.ts'
import * as history from './cloudHistory.ts'
import * as knots from './cloudKnots.ts'
import * as layers from './cloudLayers.ts'
import * as levers from './cloudLevers.ts'
import * as maps from './cloudMaps.ts'
import * as march from './cloudMarch.ts'
import * as nodes from './cloudNodes.ts'
import * as noise from './cloudNoise.ts'
import * as overPass from './cloudOverPass.ts'
import * as phase from './cloudPhase.ts'
import * as profile from './cloudProfile.ts'
import * as split from './cloudSplit.ts'
import * as sunCascades from './cloudSunCascades.ts'
import * as sunGrid from './cloudSunGrid.ts'
import * as sunlight from './cloudSunlight.ts'
import * as system from './cloudSystem.ts'
import * as trace from './cloudTrace.ts'
import * as uniforms from './cloudUniforms.ts'
import * as volume from './cloudVolume.ts'
import type { CloudResource } from './cloudNodes.ts'
import type { SceneLayout } from './sceneLayout.ts'

/*
 * The weather's modules as the contracts land them: every one imports, its
 * exports exist, and its stubs are neutral, with nothing constructed on a
 * device. It also keeps every module reachable from a test — knip's "unused
 * file" — until each package's own tests land; integration deletes it.
 */

const MODULES: readonly [string, object, readonly string[]][] = [
  [
    'air',
    air,
    [
      'createAirUniforms',
      'sunTableAt',
      'psiTableAt',
      'clearedBeam',
      'sunThroughAt',
      'ORBIT_AIRLIGHT',
      'phasesToward',
      'stepShare',
      'crowdedSamples',
      'airMediumAt',
    ],
  ],
  [
    'cloudLevers',
    levers,
    [
      'CLOUD_PLACEMENTS',
      'CLOUD_CACHES',
      'CLOUD_FAR_KINDS',
      'CLOUD_SUN_DEPTHS',
      'CLOUD_COMPOSITES',
      'CLOUD_FORCES',
      'CLOUD_SWEEP_EXTRAS',
      'DEFAULT_CLOUD_LEVERS',
      'isCloudLevers',
      'cloudResetKey',
    ],
  ],
  [
    'cloudLayers',
    layers,
    [
      'OVER_CLOUDS_LAYER',
      'UNDER_CLOUDS_LAYERS',
      'OVER_CLOUDS_LAYERS',
      'markOverClouds',
    ],
  ],
  ['cloudFrame', frame, ['cloudFrame', 'servedBody']],
  [
    'cloudNodes',
    nodes,
    [
      'traceJitter',
      'finiteOr',
      'cloudStorageTexture',
      'cloudStorage3DTexture',
      'CLOUD_STAND_INS',
      'slabMedium',
      'CLOUD_VACUUM',
      'cloudStandInTexture',
      'cloudStandInBinding',
    ],
  ],
  [
    'cloudUniforms',
    uniforms,
    ['createCloudUniforms', 'CLOUD_CLIPMAP_LEVELS', 'CLOUD_VOLUME_LEVELS'],
  ],
  [
    'cloudGeometry',
    geometry,
    [
      'traceScreen',
      'screenTexel',
      'viewDirection',
      'shellCrossing',
      'shellCrossingFrom',
      'cloudRay',
      'altitudeAlong',
      'altitudeAt',
      'sunMuAt',
      'cloudSample',
      'levelPlane',
      'levelTexel',
      'levelOffset',
      'cubeAtlasUv',
    ],
  ],
  [
    'cloudNoise',
    noise,
    [
      'CLOUD_BASE_TEXELS',
      'CLOUD_BASE_CELLS',
      'CLOUD_DETAIL_TEXELS',
      'CLOUD_CURL_TEXELS',
      'CloudNoise',
    ],
  ],
  ['cloudProfile', profile, ['CloudProfile']],
  [
    'cloudMaps',
    maps,
    [
      'scenarioCoverageNode',
      'CloudMaps',
      'CLOUD_CUBE_TILE',
      'CLOUD_CUBE_GUTTER',
    ],
  ],
  ['cloudClipmap', clipmap, ['CloudClipmap']],
  [
    'cloudDensity',
    density,
    ['fieldMedium', 'synopticMedium', 'analyticMedium', 'sweepMedium'],
  ],
  [
    'cloudVolume',
    volume,
    [
      'CLOUD_VOLUME_SIZE',
      'CLOUD_VOLUME_SLICES',
      'CLOUD_VOLUME_TEXELS',
      'CloudVolume',
    ],
  ],
  [
    'cloudSunCascades',
    sunCascades,
    [
      'SUN_CASCADE_EXTENTS',
      'SUN_CASCADE_SIZE',
      'SUN_CASCADE_SLICES',
      'SUN_DEPTH_FRAME_CAP',
      'CloudSunCascades',
    ],
  ],
  ['cloudSunGrid', sunGrid, ['SUN_GRID_SIZE', 'CloudSunGrid']],
  ['cloudSunlight', sunlight, ['LIGHT_TAPS', 'LIGHT_TAP_REACH', 'cloudSunFn']],
  ['cloudPhase', phase, ['CloudPhase']],
  ['cloudMarch', march, ['cloudMarch', 'cloudSweepMarch']],
  // Types only: the knot writer is an interface the trace implements.
  ['cloudKnots', knots, []],
  ['cloudTrace', trace, ['CloudTrace']],
  ['cloudFar', far, ['createFarField', 'FAR_BLOCK', 'FAR_STEPS_A_LAYER']],
  ['cloudFarAtlas', farAtlas, ['CloudFarAtlas']],
  ['cloudFarSpheres', farSpheres, ['CloudFarSpheres']],
  ['cloudHistory', history, ['CloudHistory']],
  ['cloudCompositeAir', compositeAir, ['skyClass', 'compositeAir']],
  ['cloudComposite', composite, ['CloudComposite']],
  ['cloudFront', front, ['cloudFront']],
  ['cloudSplit', split, ['SPLIT_LABEL', 'splitScenePass']],
  ['cloudOverPass', overPass, ['CloudOverPassNode']],
  ['cloudFrameNode', frameNode, ['CloudFrameNode']],
  ['cloudDepth', depth, ['CloudDepth']],
  ['cloudSystem', system, ['createCloudSystem']],
]

describe('the weather’s modules', () => {
  it.each(MODULES)('%s exports what the contracts name', (_, module, names) => {
    for (const name of names) expect(module, name).toHaveProperty(name)
  })
})

/** What a resource that holds nothing reports. */
function expectNeutral(resource: CloudResource): Promise<void> {
  expect(resource.bytes).toBe(0)
  expect(resource.textures()).toEqual([])
  expect(resource.pending).toBe(false)
  return resource.warm(undefined as never)
}

describe('the stubs are neutral', () => {
  const bundle = uniforms.createCloudUniforms()
  const standIn = nodes.CLOUD_STAND_INS.field()

  it('every resource holds nothing, owes nothing and warms at once', async () => {
    const noiseResource = new noise.CloudNoise()
    const clipmapResource = new clipmap.CloudClipmap(bundle)
    const resources: CloudResource[] = [
      noiseResource,
      new maps.CloudMaps(bundle),
      clipmapResource,
      new volume.CloudVolume({
        uniforms: bundle,
        bake: standIn,
        detail: noiseResource.nodes,
      }),
      new sunCascades.CloudSunCascades(bundle, standIn),
      new phase.CloudPhase(mieDroplets()),
      new trace.CloudTrace({
        uniforms: bundle,
        media: {
          field: standIn,
          volume: null,
          bound: null,
          brickExit: null,
          sweep: standIn,
        },
        sun: { cascades: () => ({}) as never, grid: () => ({}) as never },
        phase: nodes.CLOUD_STAND_INS.phase(),
        far: {
          atlas: nodes.CLOUD_STAND_INS.far(),
          spheres: nodes.CLOUD_STAND_INS.far(),
        },
        depth: () => new depth.CloudDepth(bundle, {} as SceneLayout).texture,
      }),
      new depth.CloudDepth(bundle, {} as SceneLayout),
    ]
    resources.push(
      new sunGrid.CloudSunGrid(bundle, resources[3] as volume.CloudVolume),
      new history.CloudHistory(
        bundle,
        () => (resources[6] as trace.CloudTrace).outputs,
      ),
    )
    for (const kind of levers.CLOUD_FAR_KINDS)
      resources.push(
        far.createFarField(kind, {
          uniforms: bundle,
          field: standIn,
          phase: nodes.CLOUD_STAND_INS.phase(),
          body: 'served',
        }),
      )
    for (const resource of resources) await expectNeutral(resource)
    expect(new Set(resources.map((resource) => resource.name)).size).toBe(
      resources.length,
    )
  })

  it('the trace and the history hold one-level storage textures of the real format', () => {
    const traced = new trace.CloudTrace({} as never).outputs
    const held = new history.CloudHistory(bundle, () => traced).outputs
    for (const texture of [
      traced.light,
      traced.aux,
      traced.knotDepth,
      traced.knotLight,
      held.light,
      held.air,
      held.depth,
    ]) {
      expect(texture.generateMipmaps).toBe(false)
      expect(
        (texture as unknown as { mipmapsAutoUpdate: boolean })
          .mipmapsAutoUpdate,
      ).toBe(false)
    }
  })

  it('no frame is built, no body served, nothing to wait for', () => {
    expect(frame.cloudFrame({} as never, null)).toBeNull()
    expect(frame.servedBody([], { x: 0, y: 0, z: 0 }, () => true, null)).toBe(
      null,
    )
    expect(cloudsSettled(null)).toBeNull()
  })

  it('the split declines and runs nothing', () => {
    let ran = false
    expect(
      split.splitScenePass({} as never, () => {
        ran = true
      }),
    ).toBe(false)
    expect(ran).toBe(false)
    expect(split.SPLIT_LABEL).toBe('scene over clouds')
  })

  it('the system exists and is off', () => {
    const built = system.createCloudSystem({
      renderer: {} as never,
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      layout: {} as SceneLayout,
      scenePass: {} as never,
    })
    expect(built.report.available).toBe(true)
    expect(built.report.on).toBe(false)
    expect(built.report.regime).toBe('off')
    expect(built.report.bytes.total).toBe(0)
    built.beginFrame(null, { processing: 'photographic' })
    built.endFrame()
    built.dispose()
  })

  it('the composite’s meshes are hidden, on their placements’ layers and orders', () => {
    const mesh = new composite.CloudComposite({} as never)
    expect(mesh.passes.visible).toBe(false)
    expect(mesh.split.visible).toBe(false)
    expect(mesh.passes.layers.mask).toBe(1 << layers.OVER_CLOUDS_LAYER)
    expect(mesh.split.layers.mask).toBe(1)
    expect(mesh.passes.renderOrder).toBe(-1e6)
    expect(mesh.split.renderOrder).toBe(1.5)
    mesh.dispose()
  })

  // The table's physics is held in packages/rendering/src/mieTable.test.ts;
  // here only the shape every GPU module sizes its upload by, which holds for
  // the generated table and for any table regenerated at another resolution.
  it('the droplet table decodes to the shape its consumers size against', () => {
    const table = mieDroplets()
    expect(table.phase).toHaveLength(table.radii * table.angles * 3)
    expect(table.bulk).toHaveLength(table.radii)
    expect(table.gloryRed).toHaveLength(table.radii)
    for (const p of table.phase) expect(Number.isFinite(p) && p >= 0).toBe(true)
    const [, green] = samplePhase(
      table,
      -0.3,
      (table.radiusMin + table.radiusMax) / 2,
    )
    expect(Number.isFinite(green) && green > 0).toBe(true)
  })
})
