import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  type Node,
  RGBAFormat,
  StorageBufferAttribute,
  Vector3,
} from 'three/webgpu'
import {
  bool,
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  Loop,
  max,
  min,
  select,
  storage,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CUMULUS_FIELD_SUN,
  CUMULUS_LINEAR_SKIES,
  CUMULUS_REFERENCE,
  CUMULUS_VIEWS,
  cumulusAirSky,
  type CumulusCase,
  cumulusFixture,
  type CumulusFixture,
  type CumulusProbe,
  cumulusSkyHeight,
  cumulusSkyRadiance,
  cumulusSkyTable,
  fixtureMedium,
  GENUS_TABLE,
  halfBitsOf,
  iceAggregate,
  isolateCumulus,
  mieDroplets,
  PHASE_ATLAS,
  skyByDirection,
  skyMomentsAt,
  SLAB_REFERENCE,
  subjectWeather,
  viewRay,
  viewSun,
  sunFactorPair,
} from '@inertialref/rendering'
import { cloudRay } from './cloudGeometry.ts'
import { CLOUD_TRANSPORTS } from './cloudLevers.ts'
import { cloudMarch, type CloudMarchDeps } from './cloudMarch.ts'
import { marchLight, placeBody } from './cloudMarchRig.ts'
import type {
  CloudMedium,
  CloudPhaseNodes,
  CloudSkyNodes,
  CloudSun,
} from './cloudNodes.ts'
import { CloudPhase } from './cloudPhase.ts'
import { createCloudSource } from './cloudSource.ts'
import { createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The isolated cumulus (rubric row 6): the march on the reference's two
 * clouds, each seen three ways, against the float64 path tracer's
 * `CUMULUS_REFERENCE`.
 *
 * **The row is a declared miss.** The light after first order is a plane
 * slab's source, and a plane slab cannot describe a cloud with sides: on
 * the CPU's fine march, with first order and the sky exact, design §5.5
 * passes 1 case of 6 and fails 21 of the 36 measures. Nothing here is
 * tuned toward it. Each measure is recorded, with the factor of the sun on
 * and off, and held as a ceiling at the figure measured, so the row cannot
 * get worse unseen and a later rule is watched moving it. Retaken by
 * whoever changes the slab's rule, the sky's term or the march's step.
 *
 * **What draws.** The reference's own cloud, the fixture cut from the
 * field and isolated, as a 3D texture of the scaled extinction and the
 * radius; the march's own step, eight jitters averaged; first order
 * through the committed phase under the case's sun; the light after first
 * order through the committed source table; and the sky's term read from
 * the case's sky. The sun's two depths are marched through the fixture
 * itself, 96 steps each way, so a figure here is the light's and not the
 * sun cache's: the shipped sun's taps and grid read the whole field, and
 * the reference's cloud stands alone.
 *
 * **A measure**, as the path tracer's report holds them, the worst of the
 * three bands: the core's median and the base's (15%), the rim's worst bin
 * and its peak (20%), the sunward edge's worst bin (20%) and its depth, the
 * mean of its bins over the core, less one (30%); each bound three of the
 * reference's own errors where that is larger.
 *
 * **The sky's term has a gate of its own, on the light a cloud scatters**
 * (ruling 008): the march under no sun against the path tracer's sky
 * alone, a mask's mean over a mask's mean, the sky seen straight through
 * the cloud on neither side. Under the air's own sky by direction
 * (`CUMULUS_REFERENCE.airSplit`), with the march reading the sky table's
 * four numbers at the case's height and sun as the product does: the
 * record, the term's form and its transport together. And under the sky
 * linear in direction on the quadrature's moments
 * (`CUMULUS_LINEAR_SKIES.linearSplit`), the march reading those moments:
 * the transport alone, under the sky the term's form assumes. The pixel,
 * with the straight part put back on both sides, is recorded.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(8, 8)
})

afterAll(() => {
  gpu.dispose()
})

const JITTERS = 8
/** Steps toward the sun and away from it a sample's two depths are marched in. */
const SUN_STEPS = 96
const BANDS = [0, 1, 2] as const
/** The level the fixture stands in on the rig's body, meters, and the eye's height in it. */
const LEVEL = [0, 6000] as const
const EYE = 3000

type Triple = readonly [number, number, number]

/** A fixture as a 3D texture: the scaled extinction, the radius, and the scaled column over a voxel and whole. */
function fixtureTexture(fixture: CumulusFixture): Data3DTexture {
  const [nx, ny, nz] = fixture.size
  const data = new Uint16Array(nx * ny * nz * 4)
  const whole = new Float64Array(nx * nz)
  const at = (x: number, y: number, z: number): number => (y * nz + z) * nx + x
  for (let z = 0; z < nz; z += 1)
    for (let x = 0; x < nx; x += 1) {
      let over = 0
      for (let y = ny - 1; y >= 0; y -= 1) {
        const depth = fixture.sigma[at(x, y, z)]! * fixture.voxel
        // The column over the voxel's center, and the column whole, which
        // the second pass below writes.
        data[at(x, y, z) * 4 + 2] = halfBitsOf(over + depth / 2)
        over += depth
      }
      whole[z * nx + x] = over
    }
  for (let y = 0; y < ny; y += 1)
    for (let z = 0; z < nz; z += 1)
      for (let x = 0; x < nx; x += 1) {
        const cell = at(x, y, z)
        data[cell * 4] = halfBitsOf(fixture.sigma[cell]!)
        data[cell * 4 + 1] = halfBitsOf(fixture.radius[cell]!)
        data[cell * 4 + 3] = halfBitsOf(whole[z * nx + x]!)
      }
  // [up][north][east]: a texture's depth, height and width.
  const map = new Data3DTexture(data, nx, nz, ny)
  map.format = RGBAFormat
  map.type = HalfFloatType
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.wrapS = ClampToEdgeWrapping
  map.wrapT = ClampToEdgeWrapping
  map.wrapR = ClampToEdgeWrapping
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

interface Drawn {
  readonly light: Triple
  readonly transmittance: number
}

/** What a draw is lit by: each a share of the whole, zero or one. */
interface Lights {
  /** First order, through the committed phase. */
  readonly first: number
  /** The sun at all: none leaves the sky alone. */
  readonly sun: number
  /** The sky's term. */
  readonly sky: number
  /** The factor of the sun: the `'slab'` transport, or the `'plane'` one. */
  readonly factor: boolean
}

/** A subject's fixture: the field's own cloud at its place, isolated. */
function subjectFixture(
  subject: (typeof CUMULUS_REFERENCE.subjects)[number],
): CumulusFixture {
  const { weather, clock } = subjectWeather(subject)
  return isolateCumulus(
    cumulusFixture(weather, clock, CUMULUS_FIELD_SUN, subject.place),
  ).fixture
}

/** The light a draw stands in: where its sun is, how wide, and its sky. */
interface Scene {
  /** Toward the sun, unit, in the fixture's east, up and north. */
  readonly toSun: Triple
  /** Radians. */
  readonly sunRadius: number
  /** The sky's three moments, and `c` where a sky has one: none, a sky linear in direction. */
  readonly sky: CumulusCase['sky'] & { readonly upper?: Triple }
}

/**
 * The march over one fixture: level rays north from where each is told to
 * start, one a thread.
 */
async function fixtureRig(fixture: CumulusFixture) {
  const traced = fixtureMedium(fixture)
  const [nx, ny, nz] = fixture.size
  const extent: Triple = [
    nx * fixture.voxel,
    ny * fixture.voxel,
    nz * fixture.voxel,
  ]
  const map = fixtureTexture(fixture)
  const cells = texture3D(map)
  const uniforms = createCloudUniforms()
  const body = uniforms.served
  placeBody(uniforms, { eye: EYE, layers: [LEVEL] })
  uniforms.trace.maxSteps.value = 192
  uniforms.trace.lightTaps.value = 4
  // A level that is all cumulus, of droplets.
  const droplets = mieDroplets()
  body.layers.phaseRow.value.set(PHASE_ATLAS.dropletRow, 0, 0)
  body.layers.phaseRows.value.set(
    droplets.radii,
    droplets.radii,
    droplets.radii,
  )
  body.layers.phaseRadius.value.set(
    droplets.radiusMin,
    droplets.radiusMin,
    droplets.radiusMin,
  )
  body.climate.convective.value.set(1, 1, 1)
  // What the sky's term reads of the level, as a frame writes them: the
  // transport scale at the level's reference radius, and its reference
  // extinction, a cumulus's 52 km⁻¹ with the diffraction out of it.
  const { asymmetry, share } = SLAB_REFERENCE.media.find(
    (item) => item.radius === 10,
  )!
  body.layers.transport.value.set(1 - asymmetry, 1 - asymmetry, 1 - asymmetry)
  const reference = GENUS_TABLE.cumulus.sigma * (1 - share)
  body.layers.sigma.value.set(reference, reference, reference)
  const source = createCloudSource()
  await source.load()
  const { l, a } = sunFactorPair('cumulus')
  source.levels.factor.value.set(l, l, l)
  source.levels.slope.value.set(a, a, a)
  const atlas = new CloudPhase(droplets, iceAggregate())
  await atlas.warm(gpu.renderer)

  const firstShare = uniform(1)
  const sunShare = uniform(1)
  const skyMean = uniform(new Vector3())
  const skyUp = uniform(new Vector3())
  const skySunward = uniform(new Vector3())
  const skyUpper = uniform(new Vector3())
  const phase: CloudPhaseNodes = {
    droplets: (nu, radius) => atlas.droplets(nu, radius),
    // The gain stays the row's: what is switched is first order's light.
    phase: (nu, layers, level, radius) =>
      atlas
        .phase(nu, layers, level, radius)
        .mul(vec4(firstShare, firstShare, firstShare, 1)),
  }
  const sky: CloudSkyNodes = {
    at: () => ({
      mean: skyMean,
      up: skyUp,
      sunward: skySunward,
      upper: skyUpper,
    }),
  }

  const capacity = 4096
  const input = new StorageBufferAttribute(new Float32Array(capacity * 4), 1)
  const output = new StorageBufferAttribute(new Float32Array(capacity * 4), 1)
  const from = storage(input, 'float', capacity * 4)
  const into = storage(output, 'float', capacity * 4)
  const count = uniform(0, 'uint')
  const size = vec3(...extent)

  const kernel = Fn(() => {
    If(instanceIndex.lessThan(count), () => {
      const read = (k: number) => from.element(instanceIndex.mul(4).add(k))
      // Where the pixel's ray starts, meters from the fixture's low corner.
      const origin = vec3(read(0), read(1), read(2)).toVar()
      /** The fixture at a point, meters from its low corner: nothing outside it. */
      const cellAt = (point: Node<'vec3'>): Node<'vec4'> => {
        const inside = point.x
          .greaterThanEqual(0)
          .and(point.y.greaterThanEqual(0))
          .and(point.z.greaterThanEqual(0))
          .and(point.x.lessThanEqual(size.x))
          .and(point.y.lessThanEqual(size.y))
          .and(point.z.lessThanEqual(size.z))
        return select(
          inside,
          cells.sample(point.div(size).xzy).level(float(0)),
          vec4(0),
        )
      }
      const medium = (sample: { offset: Node<'vec3'> }): CloudMedium => {
        const cell = cellAt(origin.add(sample.offset)).toVar()
        return {
          fraction: float(1),
          sigma: cell.x,
          layer: int(0),
          column: float(1e9),
          radius: max(cell.y, 1),
          depth: cell.zw,
        }
      }
      /**
       * The sun through the fixture itself: its depth from the sample to
       * the sun and the whole of that ray's, by the midpoint rule over the
       * ray's run inside the fixture each way. No air stands in the
       * reference, and the sun's irradiance is one on a face turned to it.
       */
      const sun = (sample: { offset: Node<'vec3'> }): CloudSun => {
        const point = origin.add(sample.offset).toVar()
        const toward = (direction: Node<'vec3'>): Node<'float'> => {
          // How far the fixture runs along the ray: the nearest of the
          // three faces ahead.
          const ahead = (
            d: Node<'float'>,
            p: Node<'float'>,
            edge: Node<'float'>,
          ): Node<'float'> =>
            select(
              d.greaterThan(0),
              edge.sub(p).div(max(d, 1e-9)),
              select(d.lessThan(0), p.div(max(d.negate(), 1e-9)), float(1e30)),
            )
          const run = max(
            min(
              ahead(direction.x, point.x, size.x),
              min(
                ahead(direction.y, point.y, size.y),
                ahead(direction.z, point.z, size.z),
              ),
            ),
            0,
          )
          const step = run.div(SUN_STEPS).toVar()
          const depth = float(0).toVar()
          Loop(SUN_STEPS, ({ i }) => {
            depth.addAssign(
              cellAt(
                point.add(direction.mul(step.mul(float(i).add(0.5)))),
              ).x.mul(step),
            )
          })
          return depth
        }
        const toSun = toward(body.sun).toVar()
        const behind = toward(body.sun.negate()).toVar()
        const through = exp(toSun.negate())
        return {
          cloud: through,
          air: vec3(sunShare),
          depth: vec2(toSun, toSun.add(behind)),
          octave: () => through,
        }
      }
      const deps: CloudMarchDeps = {
        uniforms,
        phase,
        medium,
        sun,
        ...marchLight(uniforms),
        sky,
        source,
      }
      const direction = vec3(0, 0, 1)
      const ray = cloudRay(
        direction,
        body,
        float(extent[2] + 3 * fixture.voxel),
      )
      const fine = cloudMarch(
        { ...ray, start: float(0), end: float(extent[2] + 3 * fixture.voxel) },
        read(3),
        bool(true),
        deps,
        null,
        { skyTable: true },
      )
      const to = instanceIndex.mul(4)
      into.element(to).assign(fine.light.x)
      into.element(to.add(1)).assign(fine.light.y)
      into.element(to.add(2)).assign(fine.light.z)
      into.element(to.add(3)).assign(fine.transmittance)
    })
  })().compute(capacity)

  return {
    fixture,
    /** Where a pixel of an image `pixels` a side starts its ray, as the reference's pixels do. */
    origin: (pixels: number, pixel: readonly [number, number]): Triple =>
      viewRay(traced, pixels, ...pixel),
    /** Rays drawn from their starts, meters from the fixture's low corner: each the mean of its jitters. */
    async draw(
      held: Scene,
      origins: readonly Triple[],
      lights: Lights,
    ): Promise<Drawn[]> {
      const { toSun } = held
      body.sun.value.set(toSun[0], toSun[1], toSun[2])
      body.sunUp.value = toSun[1]
      atlas.serve(held.sunRadius, null)
      firstShare.value = lights.first
      sunShare.value = lights.sun
      const share = lights.sky
      skyMean.value.set(
        held.sky.mean[0] * share,
        held.sky.mean[1] * share,
        held.sky.mean[2] * share,
      )
      skyUp.value.set(...held.sky.up)
      skySunward.value.set(...held.sky.sunward)
      skyUpper.value.set(...(held.sky.upper ?? [0, 0, 0]))
      uniforms.trace.transport.value = CLOUD_TRANSPORTS.indexOf(
        lights.factor ? 'slab' : 'plane',
      )
      const drawn: Drawn[] = []
      const each = Math.floor(capacity / JITTERS)
      for (let start = 0; start < origins.length; start += each) {
        const batch = origins.slice(start, start + each)
        const rays = input.array as Float32Array
        batch.forEach((origin, i) => {
          for (let k = 0; k < JITTERS; k += 1)
            rays.set([...origin, (k + 0.5) / JITTERS], (i * JITTERS + k) * 4)
        })
        input.needsUpdate = true
        count.value = batch.length * JITTERS
        await gpu.compute(kernel)
        const out = new Float32Array(await gpu.readBuffer(output))
        batch.forEach((_, i) => {
          const light: [number, number, number] = [0, 0, 0]
          let transmittance = 0
          for (let k = 0; k < JITTERS; k += 1) {
            const row = (i * JITTERS + k) * 4
            for (const band of BANDS) light[band] += out[row + band]! / JITTERS
            transmittance += out[row + 3]! / JITTERS
          }
          drawn.push({ light, transmittance })
        })
      }
      return drawn
    },
    dispose() {
      kernel.dispose()
      input.dispose()
      output.dispose()
      map.dispose()
      atlas.dispose()
      source.dispose()
      uniforms.dispose()
    },
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)

/** A case's six measures, each the worst of the three bands: the march over the reference, less one. */
interface Measures {
  core: number
  base: number
  rimBin: number
  rimPeak: number
  edgeBin: number
  edgeDepth: number
}
const MEASURES = [
  'core',
  'base',
  'rimBin',
  'rimPeak',
  'edgeBin',
  'edgeDepth',
] as const
/** Row 6's bars, by measure. */
const BARS: Measures = {
  core: 0.15,
  base: 0.15,
  rimBin: 0.2,
  rimPeak: 0.2,
  edgeBin: 0.2,
  edgeDepth: 0.3,
}

/**
 * A case's measures and which of them pass: each bound its bar, or three of
 * the reference's own errors where that is larger.
 */
function measure(
  held: CumulusCase,
  probes: readonly CumulusProbe[],
  pixels: readonly Triple[],
): { readonly errors: Measures; readonly failed: (keyof Measures)[] } {
  const errors: Measures = {
    core: 0,
    base: 0,
    rimBin: 0,
    rimPeak: 0,
    edgeBin: 0,
    edgeDepth: 0,
  }
  const failed = new Set<keyof Measures>()
  const worse = (
    key: keyof Measures,
    got: number,
    want: number,
    sigma: number,
  ): void => {
    const error = got / want - 1
    if (Math.abs(error) > Math.abs(errors[key])) errors[key] = error
    if (Math.abs(got - want) > Math.max(BARS[key] * Math.abs(want), 3 * sigma))
      failed.add(key)
  }
  const medians = CUMULUS_REFERENCE.medians.find(
    (item) => item.case === held.id,
  )!
  for (const band of BANDS) {
    const of = (mask: CumulusProbe['mask'], bin?: number): number[] =>
      probes.flatMap((probe, i) =>
        probe.mask === mask && (bin === undefined || probe.bin === bin)
          ? [pixels[i]![band]]
          : [],
      )
    const core = median(of('core'))
    worse('core', core, medians.core[band], medians.coreError[band])
    worse(
      'base',
      median(of('base')),
      medians.base[band],
      medians.baseError[band],
    )
    for (const mask of ['rim', 'edge'] as const) {
      const curve = CUMULUS_REFERENCE.curves.find(
        (item) =>
          item.case === held.id && item.mask === mask && item.band === band,
      )!
      // A bin's mean over the core's median, as the reference's curve is.
      const bins = curve.bins.map((bin) => mean(of(mask, bin)) / core)
      const key = mask === 'rim' ? 'rimBin' : 'edgeBin'
      bins.forEach((got, k) => {
        worse(key, got, curve.radiance[k]!, curve.error[k]!)
      })
      if (mask === 'rim') {
        const peak = curve.radiance.indexOf(Math.max(...curve.radiance))
        worse(
          'rimPeak',
          Math.max(...bins),
          curve.radiance[peak]!,
          curve.error[peak]!,
        )
      } else {
        // The edge's depth: how far its bins stand under the core, or over.
        const want = mean(curve.radiance) - 1
        const sigma =
          Math.hypot(...curve.error) / Math.max(curve.error.length, 1)
        const got = mean(bins) - 1
        const error = got / want - 1
        if (Math.abs(error) > Math.abs(errors.edgeDepth))
          errors.edgeDepth = error
        if (
          Math.abs(got - want) >
          Math.max(BARS.edgeDepth * Math.abs(want), 3 * sigma)
        )
          failed.add('edgeDepth')
      }
    }
  }
  return { errors, failed: [...failed] }
}

/*
 * Row 6 as measured on the Mac mini (Mac18,5, Apple M6), each case's six
 * measures with the factor of the sun on and off, the march over the
 * reference less one, in `MEASURES`' order. The ceilings below stand five
 * points off each.
 *
 * With the factor 0 of 6 cases pass and 30 of the 36 measures fail;
 * without it 0 and 24. The CPU's fine march, with first order and the sky
 * exact, reads 1 of 6 and 22, and 1 and 21 (the depth rule's second
 * critic): the difference is the cores toward the sun and from behind it,
 * which the sky's term reads half too bright and half too dark under the
 * sky the reference's pixels were traced under (`SKY_MEASURED`).
 */
const MEASURED: Readonly<
  Record<
    string,
    { readonly on: readonly number[]; readonly off: readonly number[] }
  >
> = {
  'congestus:back': {
    on: [-0.233, 0.308, 0.643, 0.533, 0.687, -0.256],
    off: [-0.404, 0.108, 0.712, 0.6, 0.826, -0.307],
  },
  'congestus:forward': {
    on: [0.416, 0.268, -0.256, -0.136, -0.209, -0.19],
    off: [0.271, 0.146, -0.184, -0.13, -0.184, -0.175],
  },
  'congestus:side': {
    on: [-0.166, 0.167, 0.454, 0.384, 0.407, -0.396],
    off: [-0.101, 0.222, 0.429, 0.365, 0.404, -0.363],
  },
  'cumulus:back': {
    on: [-0.259, 0.423, 1.015, 0.707, 0.637, -0.317],
    off: [-0.425, 0.147, 1.177, 0.805, 0.732, -0.375],
  },
  'cumulus:forward': {
    on: [0.497, 0.093, -0.264, -0.218, -0.278, -0.255],
    off: [0.359, -0.092, -0.22, -0.215, -0.249, -0.247],
  },
  'cumulus:side': {
    on: [-0.124, 0.248, 0.265, 0.265, 0.304, -0.31],
    off: [-0.057, 0.333, 0.24, 0.24, 0.274, -0.272],
  },
}
/** How far over its measured figure a measure may stand: an adapter's own sampler and `exp2`. */
const MARGIN = 0.05
/** The measures that fail with the factor on and off, each two off its count of 30 and 24. */
const FAILED = { on: 32, off: 26 } as const
/**
 * The sky's term by mask, green, the march's scattered light over the path
 * tracer's, less one, as measured on the Mac mini (Mac18,5, Apple M6), in
 * `SKY_MASKS`' order: under the air's own sky with the table's four
 * numbers, and under the linear sky on the quadrature's moments.
 *
 * Under the air's own sky the term reads a rim and an edge at half the
 * tracer's light toward a 15° sun and away from it (−46% to −53%), a core
 * +95% and +105% toward it and −34% and −39% from behind, and every mask
 * within 10% across a 45° sun. Under the linear sky, which is the term's
 * own, rims, edges and bases are within 16% and the two suns' side views
 * within 6%, and the cores toward a 15° sun and from behind it stay +50%
 * to +54% and −42% to −46%: the flux's view term carries a flux through a
 * level's own depth, and a core seen level is lit on its near face by the
 * sky on the eye's side. A horizon's band and an aureole are not in three
 * moments, and neither is mended here (ruling 008).
 */
const SKY_MASKS = ['rim', 'edge', 'core', 'base'] as const
const SKY_MEASURED: Readonly<
  Record<
    string,
    { readonly air: readonly number[]; readonly linear: readonly number[] }
  >
> = {
  'congestus:back': {
    air: [-0.522, -0.527, -0.335, -0.224],
    linear: [-0.113, -0.162, -0.417, -0.12],
  },
  'congestus:forward': {
    air: [-0.502, -0.463, 0.947, 0.166],
    linear: [-0.007, 0.026, 0.5, 0.093],
  },
  'congestus:side': {
    air: [-0.061, -0.065, 0.07, 0.001],
    linear: [-0.041, -0.056, -0.01, -0.026],
  },
  'cumulus:back': {
    air: [-0.485, -0.49, -0.392, -0.27],
    linear: [-0.051, -0.092, -0.461, -0.097],
  },
  'cumulus:forward': {
    air: [-0.514, -0.486, 1.049, -0.036],
    linear: [-0.006, 0.023, 0.541, 0.056],
  },
  'cumulus:side': {
    air: [-0.054, -0.048, 0.101, -0.025],
    linear: [-0.016, -0.031, 0.007, -0.02],
  },
}
/** How far over its measured figure a mask may stand: an adapter's own sampler and `exp2`. */
const SKY_MARGIN = 0.03

const signed = (value: number): string =>
  `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)}`

describe('the isolated cumulus, against the path-traced reference', () => {
  it('holds row 6 at its measured miss, measure by measure, with the factor of the sun on and off, where no case passes; records first order and the sun past it by mask; and holds the sky’s scattered light by mask under the air’s own sky and under the linear one', async () => {
    const record: Record<string, unknown> = {}
    const failures = { on: 0, off: 0 }
    const passed = { on: 0, off: 0 }
    for (const subject of CUMULUS_REFERENCE.subjects) {
      const rig = await fixtureRig(subjectFixture(subject))
      for (const held of CUMULUS_REFERENCE.cases) {
        if (held.subject !== subject.id) continue
        const at = CUMULUS_REFERENCE.probes.flatMap((probe, i) =>
          probe.case === held.id ? [i] : [],
        )
        const probes = at.map((i) => CUMULUS_REFERENCE.probes[i]!)
        const origins = probes.map((probe) =>
          rig.origin(held.pixels, probe.pixel),
        )
        const view = CUMULUS_VIEWS.find((item) => item.id === held.view)!
        const scene: Scene = {
          toSun: viewSun(view),
          sunRadius: held.sunRadius,
          sky: held.sky,
        }
        // The sky behind the cloud, which a pixel's transmittance passes.
        const behind = cumulusSkyRadiance(held.sky, viewSun(view), [0, 0, 1])
        const pixelsOf = (drawn: readonly Drawn[], sky: number): Triple[] =>
          drawn.map(({ light, transmittance }) => [
            light[0] + sky * transmittance * behind[0],
            light[1] + sky * transmittance * behind[1],
            light[2] + sky * transmittance * behind[2],
          ])
        const lines: string[] = []
        const caseRecord: Record<string, unknown> = {}
        for (const factor of [true, false]) {
          const key = factor ? 'on' : 'off'
          const whole = pixelsOf(
            await rig.draw(scene, origins, {
              first: 1,
              sun: 1,
              sky: 1,
              factor,
            }),
            1,
          )
          for (const pixel of whole)
            for (const band of BANDS)
              expect(Number.isFinite(pixel[band])).toBe(true)
          const { errors, failed } = measure(held, probes, whole)
          MEASURES.forEach((name, k) => {
            expect(
              Math.abs(errors[name]),
              `${held.id}, factor ${key}, ${name}`,
            ).toBeLessThanOrEqual(
              Math.abs(MEASURED[held.id]![key][k]!) + MARGIN,
            )
          })
          failures[key] += failed.length
          if (failed.length === 0) passed[key] += 1
          caseRecord[key] = { errors, failed }
          lines.push(
            `  factor ${key}: ${MEASURES.map((name) => `${name} ${signed(errors[name])}`).join(', ')}; fails ${failed.length === 0 ? 'none' : failed.join(' ')}`,
          )
        }
        /*
         * The light's parts, a mask's sum over the scaled medium's
         * reference, less one, green: first order against `scaled.first`,
         * the sun's light past it against `rest` less the sky, with the
         * factor on and off. `rest` was traced under the case's own sky,
         * the table's moments as the reference was cut, so that sky's row
         * comes out of it.
         */
        const firstOnly = await rig.draw(scene, origins, {
          first: 1,
          sun: 1,
          sky: 0,
          factor: false,
        })
        const higher = {
          on: await rig.draw(scene, origins, {
            first: 0,
            sun: 1,
            sky: 0,
            factor: true,
          }),
          off: await rig.draw(scene, origins, {
            first: 0,
            sun: 1,
            sky: 0,
            factor: false,
          }),
        }
        const parts: Record<string, unknown> = {}
        for (const mask of ['rim', 'edge', 'core', 'base'] as const) {
          const sum = (values: (i: number) => number): number =>
            probes.reduce(
              (total, probe, i) =>
                total + (probe.mask === mask ? values(i) : 0),
              0,
            )
          const scaled = (i: number) => CUMULUS_REFERENCE.scaled[at[i]!]!
          const skyAt = (i: number) => CUMULUS_LINEAR_SKIES.table[at[i]!]!
          const first =
            sum((i) => firstOnly[i]!.light[1] - higher.off[i]!.light[1]) /
              sum((i) => scaled(i).first[1]) -
            1
          const past = (drawn: readonly Drawn[]): number =>
            sum((i) => drawn[i]!.light[1]) /
              sum((i) => scaled(i).rest[1] - skyAt(i).sky[1]) -
            1
          parts[mask] = {
            first,
            higherOn: past(higher.on),
            higherOff: past(higher.off),
          }
          lines.push(
            `  ${mask}: first order ${signed(first)}, the sun past it ${signed(past(higher.off))} (${signed(past(higher.on))} with the factor)`,
          )
        }
        caseRecord.parts = parts
        /*
         * The sky's term, scattered light against scattered light (ruling
         * 008): no sun, and the sky the march reads in each of its two
         * forms.
         */
        const where = held.skyAt!
        const table = skyMomentsAt(
          cumulusSkyTable(),
          cumulusSkyHeight(where.height),
          where.sunMu,
        )
        const quadrature = CUMULUS_LINEAR_SKIES.moments.find(
          (item) => item.case === held.id,
        )!
        const alone = { first: 0, sun: 0, sky: 1, factor: false } as const
        const underAir = await rig.draw(
          { ...scene, sky: table },
          origins,
          alone,
        )
        const underLinear = await rig.draw(
          { ...scene, sky: quadrature },
          origins,
          alone,
        )
        // The air's own sky on the eye's line, which looks north: what a
        // pixel's transmittance passes of it.
        const toSun = viewSun(view)
        const toward = toSun[2] / Math.hypot(toSun[0], toSun[2])
        const airSky = cumulusAirSky(where)
        const onLine = BANDS.map((band) =>
          skyByDirection(
            airSky,
            0,
            toward,
            Math.sqrt(Math.max(0, 1 - toward * toward)),
            band,
          ),
        )
        const skyRecord: Record<string, unknown> = {}
        SKY_MASKS.forEach((mask, k) => {
          const rows = probes.flatMap((probe, i) =>
            probe.mask === mask ? [i] : [],
          )
          const meanOf = (value: (i: number) => number): number =>
            mean(rows.map(value))
          const split = (
            block: typeof CUMULUS_REFERENCE.airSplit,
          ): (typeof CUMULUS_REFERENCE.airSplit)[number] =>
            block.find((item) => item.case === held.id && item.mask === mask)!
          const air = split(CUMULUS_REFERENCE.airSplit)
          const linear = split(CUMULUS_LINEAR_SKIES.linearSplit)
          const bands = (of: (band: 0 | 1 | 2) => number): Triple => [
            of(0),
            of(1),
            of(2),
          ]
          const term = bands(
            (band) =>
              meanOf((i) => underAir[i]!.light[band]) / air.scattered[band] - 1,
          )
          const transport = bands(
            (band) =>
              meanOf((i) => underLinear[i]!.light[band]) /
                linear.scattered[band] -
              1,
          )
          const pixel = bands(
            (band) =>
              meanOf(
                (i) =>
                  underAir[i]!.light[band] +
                  underAir[i]!.transmittance * onLine[band]!,
              ) /
                (air.straight[band] + air.scattered[band]) -
              1,
          )
          for (const value of [...term, ...transport, ...pixel])
            expect(Number.isFinite(value)).toBe(true)
          const measured = SKY_MEASURED[held.id]!
          expect(
            Math.abs(term[1]),
            `${held.id}, the sky's term on the ${mask} under the air's own sky`,
          ).toBeLessThanOrEqual(Math.abs(measured.air[k]!) + SKY_MARGIN)
          expect(
            Math.abs(transport[1]),
            `${held.id}, the sky's term on the ${mask} under the linear sky`,
          ).toBeLessThanOrEqual(Math.abs(measured.linear[k]!) + SKY_MARGIN)
          skyRecord[mask] = {
            term,
            transport,
            pixel,
            // Three of the tracer's own errors, as a share of its light.
            noise: (3 * air.scatteredError[1]) / air.scattered[1],
          }
          const all = (values: Triple): string =>
            values.map((value) => `${(value * 100).toFixed(1)}`).join(', ')
          lines.push(
            `  the sky on the ${mask} (R, G, B, %): under the air's own ${all(term)}; under the linear ${all(transport)}; the pixel ${all(pixel)}`,
          )
        })
        caseRecord.sky = skyRecord
        record[held.id] = caseRecord
        console.info(`cloudCumulus: ${held.id}\n${lines.join('\n')}`)
      }
      rig.dispose()
    }
    console.info(
      `cloudCumulus: with the factor ${passed.on} of 6 cases pass and ${failures.on} of 36 measures fail; without it ${passed.off} and ${failures.off}`,
    )
    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      '.data/clouds/cumulus.json',
      `${JSON.stringify({ note: 'cloudCumulus.gpu.test.ts: row 6 through the march on the reference’s fixture, the sun’s depths marched through the fixture', passed, failures, cases: record }, null, 2)}\n`,
    )
    expect(Object.keys(record)).toHaveLength(6)
    expect(failures.on).toBeLessThanOrEqual(FAILED.on)
    expect(failures.off).toBeLessThanOrEqual(FAILED.off)
  }, 900_000)
})

describe('a uniform box, level at its lit wall', () => {
  /*
   * A plane slab's source on a body with sides, where it is plainest: a
   * uniform box 1,200 m square and 1,400 m tall, of a scaled extinction of
   * 0.025 m⁻¹ at 10 µm, seen level at the middle of the wall the sun
   * lights, under a dark sky. The slab reads the wall's sun at its cosine
   * to the vertical where the wall takes it at its cosine to the wall, so
   * the sun's light past first order is low under a low sun and high
   * under a high one, by the ratio of the two: the path tracer has
   * 2.02 × 10⁻¹ sr⁻¹ under a sun 15° up behind the eye, where the CPU's
   * march of design §5.5 reads −75%, and 9.33 × 10⁻² under one 65° up,
   * where it reads +99% (the depth rule's two critics).
   *
   * **Recorded, and gated by nothing but its sign:** a later rule for a
   * face is watched moving both.
   */
  const TRACED = [
    { elevation: 15, traced: 0.202, cpu: -0.75 },
    { elevation: 65, traced: 0.0933, cpu: 0.99 },
  ] as const

  it('reads the sun’s light past first order low under a 15° sun and high under a 65° one, with the factor of the sun and without', async () => {
    const voxel = 25
    const size = [64, 64, 64] as const
    const count = size[0] * size[1] * size[2]
    const sigma = new Float32Array(count)
    const inside = (index: number, low: number, high: number): boolean =>
      (index + 0.5) * voxel > low && (index + 0.5) * voxel < high
    // 1,200 m square about the grid's middle, from 100 m to 1,500 m up.
    for (let y = 0; y < size[1]; y += 1)
      for (let z = 0; z < size[2]; z += 1)
        for (let x = 0; x < size[0]; x += 1)
          if (
            inside(x, 200, 1400) &&
            inside(y, 100, 1500) &&
            inside(z, 200, 1400)
          )
            sigma[(y * size[2] + z) * size[0] + x] = 0.025
    const rig = await fixtureRig({
      size,
      voxel,
      base: 0,
      sigma,
      radius: new Float32Array(count).fill(10),
      extinction: sigma,
    })
    const dark = { mean: [0, 0, 0], up: [0, 0, 0], sunward: [0, 0, 0] } as const
    // Level, at the middle of the wall that faces the eye, from south of it.
    const origin: Triple = [800, 800, -voxel]
    for (const { elevation, traced, cpu } of TRACED) {
      const e = (elevation * Math.PI) / 180
      const scene: Scene = {
        // Behind the eye, which looks north.
        toSun: [0, Math.sin(e), -Math.cos(e)],
        sunRadius: 0.0046251225177849735,
        sky: dark,
      }
      const past = async (factor: boolean): Promise<number> => {
        const [drawn] = await rig.draw(scene, [origin], {
          first: 0,
          sun: 1,
          sky: 0,
          factor,
        })
        return drawn!.light[1]
      }
      const plain = await past(false)
      const factored = await past(true)
      console.info(
        `cloudCumulus: a box's lit wall under a sun ${elevation}° up behind the eye: ${plain.toExponential(3)} sr⁻¹, ${signed(plain / traced - 1)}% of the traced ${traced} (the CPU's march ${signed(cpu)}%); with the factor of the sun ${factored.toExponential(3)}, ${signed(factored / traced - 1)}%`,
      )
      expect(plain).toBeGreaterThan(0)
      // Low under the low sun and high under the high one, as the slab's
      // rule makes it: a rule that finds the face moves both toward zero.
      expect(Math.sign(plain / traced - 1)).toBe(Math.sign(cpu))
    }
    rig.dispose()
  }, 600_000)
})
