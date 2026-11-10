import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  bool,
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  length,
  max,
  oneMinus,
  sqrt,
  storage,
  texture,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  gammaDepth as gammaDepthOf,
  crossingDepth as crossingDepthOf,
  crossingExponent as crossingExponentOf,
  spreadDepth as spreadDepthOf,
  stepLight as stepLightOf,
  stepShare as stepShareOf,
} from '@inertialref/rendering'
import { altitudeAt, cloudRay, sunMuAt } from './cloudGeometry.ts'
import { traceJitter } from './cloudJitter.ts'
import { CLOUD_PHASE_MODES } from './cloudLevers.ts'
import {
  type CloudAirFn,
  cloudMarch,
  type CloudMarchDeps,
} from './cloudMarch.ts'
import {
  chord,
  depthTexture,
  leaning,
  lookUp,
  MARCH_RIG_RADIUS as R,
  type MarchLayers as Layers,
  marchLight as lightOf,
  marchProbe,
  NO_BUDGET as BUDGET,
  placeBody,
  placeSun,
  type Probed,
  type ProbeOptions,
  readTexels,
  relative,
  sizeTrace,
  SKY_KM,
  testSun,
  traceFrame as frameOf,
  type Triple as Vec3,
} from './cloudMarchRig.ts'
import {
  gammaDepth,
  crossingDepth,
  crossingExponent,
  spreadDepth,
  stepLight,
  stepShare,
} from './cloudMix.ts'
import {
  CLOUD_STAND_INS,
  type CloudFarFn,
  type CloudJitterNodes,
  type CloudMediumFn,
  type CloudPhaseNodes,
  type CloudSample,
  type CloudSunDepthNodes,
  cloudStandInTexture,
  exactSlabSun,
  slabMedium,
} from './cloudNodes.ts'
import { cloudSunFn } from './cloudSunlight.ts'
import {
  CLOUD_TRACE_PHASES,
  CloudTrace,
  type CloudTraceDeps,
} from './cloudTrace.ts'
import { cloudRig, LOOKING_UP } from './cloudSystemRig.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * The trace on the GPU (§9): its kernels against the stand-ins, the march
 * against analytic slabs to float32's bound, and the kernels' outputs — the
 * immediate regime's addressing, the knots, the step counters —
 * through the half-float textures the history and `cloudFront` read.
 *
 * A march held to 10⁻⁴ is read out of a float32 buffer by a probe kernel the
 * test builds around `cloudMarch`; the trace's own outputs are RGBA16F, whose
 * step of 2⁻¹¹ relative is the floor on anything asserted through them.
 */

let gpu: GpuSession
let renderer: WebGPURenderer

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
})

afterAll(() => {
  gpu.dispose()
})

const ISOTROPIC = 1 / (4 * Math.PI)
/** The march's own light per unit of opacity under a white sun: first order at 1/(4π), and the placeholder sky's ½·Ψ with Ψ = 1. */
const LIGHT_PER_OPACITY = 1.5 * ISOTROPIC
/** float32 carried through a march of a few hundred steps and its exponentials. */
const MARCH = 1e-4
/** RGBA16F's step, relative: the floor on anything read out of the trace's textures. */
const HALF = 2 ** -10

/** The march's own probe on this file's device. */
const probe = (
  uniforms: CloudUniforms,
  medium: CloudMediumFn,
  options: ProbeOptions = {},
) => marchProbe(gpu, uniforms, medium, options)

interface Media {
  readonly medium: CloudMediumFn
  readonly deps: CloudTraceDeps
}

/**
 * The trace's deps over the stand-ins: the field carrying `medium`, the sun
 * grid, the far field, the stand-in phase, and the depth copy `depth` stands
 * in for.
 */
function standIns(
  uniforms: CloudUniforms,
  medium: CloudMediumFn,
  depth: () => Texture,
  options: {
    readonly phase?: CloudPhaseNodes
    readonly jitter?: CloudJitterNodes
  } = {},
): Media {
  const field = CLOUD_STAND_INS.field(medium)
  return {
    medium: field,
    deps: {
      uniforms,
      medium: field,
      sun: testSun(field, CLOUD_STAND_INS.sunDepth()),
      phase: options.phase ?? CLOUD_STAND_INS.phase(),
      far: CLOUD_STAND_INS.far(),
      depth,
      ...lightOf(uniforms),
      ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Readbacks                                                                  */
/* ------------------------------------------------------------------------- */

/** The WGSL three builds for a kernel. */
function wgslOf(kernel: ComputeNode): string {
  const nodes = (
    renderer as unknown as {
      _nodes: { getForCompute(node: ComputeNode): { computeShader: string } }
    }
  )._nodes
  return nodes.getForCompute(kernel).computeShader
}

const texels = (map: Texture, width: number, height: number) =>
  readTexels(gpu, map, width, height)

/* ------------------------------------------------------------------------- */
/* The kernels                                                                */
/* ------------------------------------------------------------------------- */

/** Sampled and storage textures a WGSL program declares. */
function bindings(wgsl: string): { sampled: number; storage: number } {
  const declared = [...wgsl.matchAll(/var\s+\w+\s*:\s*(texture_\w+)/g)].map(
    (match) => match[1]!,
  )
  const storage = declared.filter((kind) => kind.startsWith('texture_storage'))
  return { sampled: declared.length - storage.length, storage: storage.length }
}

describe('the kernels', () => {
  it('all compile against the stand-ins, and bind within the stage’s limits', async () => {
    const uniforms = createCloudUniforms()
    const sky = depthTexture(4, 4, () => SKY_KM)
    const { deps } = standIns(uniforms, slabMedium([]), () => sky)
    const trace = new CloudTrace(deps)
    const kernels = trace.kernels()
    // The march's three, one a way of taking the phase's radius, and the
    // counters' clear.
    expect(kernels).toHaveLength(CLOUD_PHASE_MODES.length + 1)
    const from = gpu.reported().length
    const before = gpu.computePipelinesBuilt()
    await trace.warm(renderer)
    expect(gpu.computePipelinesBuilt() - before).toBe(4)
    expect(
      gpu
        .reported()
        .slice(from)
        .filter((entry) => entry.type === 'error'),
    ).toEqual([])
    const counted = kernels.map((kernel) => ({
      name: kernel.name,
      ...bindings(wgslOf(kernel)),
    }))
    // WebGPU's default device: 16 sampled and 4 storage textures a stage.
    for (const { sampled, storage } of counted) {
      expect(sampled).toBeLessThanOrEqual(16)
      expect(storage).toBeLessThanOrEqual(4)
    }
    // The stand-ins' census: the field's 5, the sun grid, the air's 2, the
    // phase, the far atlas, the depth copy and the jitter's mask. A floor as
    // well as a ceiling: the counts are a regex over three's WGSL, and a
    // spelling that stopped matching would pass the ceiling at zero. The sky
    // and the source bind only in a kernel that reads them, and this march
    // reads neither. Every way of taking the phase binds the one atlas.
    for (const march of counted.slice(0, CLOUD_PHASE_MODES.length))
      expect(march).toMatchObject({
        name: 'cloud trace',
        sampled: 12,
        storage: 4,
      })
    expect(counted.at(-1)!.name).toBe('cloud stats')
    trace.dispose()
    sky.dispose()
  }, 120_000)
})

describe('the system’s own trace kernel', () => {
  /*
   * The census above counts the stand-ins, which bind what a test's field
   * binds. This one counts the kernel the system builds over the real field,
   * the real sun grid, the real phase and the real far atlas, which is the
   * one a device has to accept: WebGPU's default device allows a stage 16
   * sampled textures and 4 storage textures, and nothing raises the limit.
   *
   * Eleven today: the clipmap's cover (a 2D array), the base and detail
   * noises (3D), the profile, the sun grid (3D), the air's transmittance and
   * Ψ, the phase atlas, the far atlas, the depth copy and the jitter's mask
   * (3D), which is bound whichever draw the lever takes. Phase 1's design
   * counts three more at worst (§4.5): the clipmap's `kind`, the sky table
   * and the slab source, 14 of 16. The count is exact, not a
   * ceiling, so a binding nobody counted fails here rather than at the
   * sixteenth, and the package that adds one changes this number where a
   * reviewer reads it.
   */
  const SAMPLED = { '2d': 6, '2d_array': 1, '3d': 4 }
  const STAGE_SAMPLED = 16
  const STAGE_STORAGE = 4

  it('binds 11 sampled textures of the stage’s 16, and its 4 storage textures', async () => {
    const rig = cloudRig(gpu, 16, 16)
    try {
      await rig.system!.warm()
      const trace = rig.system!.resources.find(
        (held) => held.name === 'trace',
      ) as CloudTrace
      // Each of the march's three kernels, by how it takes the phase's radius.
      for (const kernel of trace.kernels().slice(0, CLOUD_PHASE_MODES.length)) {
        expect(kernel.name).toBe('cloud trace')
        const wgsl = wgslOf(kernel)
        const counted = bindings(wgsl)
        const kinds: Record<string, number> = {}
        for (const [, kind] of wgsl.matchAll(/var\s+\w+\s*:\s*texture_(\w+)</g))
          if (!kind!.startsWith('storage'))
            kinds[kind!] = (kinds[kind!] ?? 0) + 1
        expect(kinds).toEqual(SAMPLED)
        expect(counted.sampled).toBe(11)
        expect(counted.sampled).toBeLessThanOrEqual(STAGE_SAMPLED)
        expect(counted.storage).toBe(STAGE_STORAGE)
      }
    } finally {
      rig.dispose()
    }
  }, 120_000)
})

describe('the march’s reads', () => {
  /** The fragment program of a quad whose color is a march through `medium`. */
  async function fragmentOf(medium: CloudMediumFn): Promise<string> {
    const uniforms = createCloudUniforms()
    const field = CLOUD_STAND_INS.field(medium)
    const deps: CloudMarchDeps = {
      uniforms,
      phase: CLOUD_STAND_INS.phase(),
      medium: field,
      sun: testSun(field, CLOUD_STAND_INS.sunDepth()),
      ...lightOf(uniforms),
    }
    const material = new MeshBasicNodeMaterial()
    material.colorNode = Fn(() => {
      const ray = cloudRay(vec3(0, 1, 0), uniforms.served, float(1e9))
      const result = cloudMarch(ray, float(0.5), bool(true), deps, null)
      return vec4(result.light, result.transmittance)
    })()
    const mesh = new Mesh(new PlaneGeometry(2, 2), material)
    const scene = new Scene()
    scene.add(mesh)
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
    camera.position.z = 0.5
    camera.updateMatrixWorld()
    const { fragmentShader } = await gpu.shader(mesh, camera, scene)
    material.dispose()
    mesh.geometry.dispose()
    return fragmentShader
  }

  it('names the level of every texture it reads, in a fragment as in compute, where a plain read would not', async () => {
    /*
     * A compute stage has no derivatives, so three names level 0 there by
     * itself; a fragment's read is `textureSample` unless the code names one,
     * and inside a loop that breaks it is undefined, with three's uniformity
     * check off. The march, its sun, its phase and its air name theirs, so
     * the march compiles alike wherever it runs.
     */
    const slab = slabMedium([{ base: 1000, top: 1600, sigma: 0.002 }])
    const named = await fragmentOf(slab)
    expect(named).toMatch(/\btextureSampleLevel\(/)
    expect(named).not.toMatch(/\btextureSample\(/)
    // The control: one plain read in the medium, which is what the
    // assertion above would catch.
    const map = texture(cloudStandInTexture('2d', 'rgba8'))
    const plain: CloudMediumFn = (sample, body) => {
      const medium = slab(sample, body)
      return {
        ...medium,
        sigma: medium.sigma.add(map.sample(vec2(0.5)).x.mul(0)),
      }
    }
    expect(await fragmentOf(plain)).toMatch(/\btextureSample\(/)
  })
})

/* ------------------------------------------------------------------------- */
/* The march against analytic slabs                                          */
/* ------------------------------------------------------------------------- */

/** The light a ray gathers under a white sun for an opacity `1 − T`, every band. */
function expectLight(probed: Probed, opacity: number): void {
  for (const band of probed.light)
    expect(relative(band, LIGHT_PER_OPACITY * opacity)).toBeLessThanOrEqual(
      MARCH,
    )
}

const SLAB = { base: 1000, top: 1600 } as const
/** A layer the media leave empty, under the slab: the span starts at its base. */
const EMPTY_BELOW = [100, 200] as const

describe('the march through one slab', () => {
  it('passes e^−σL and gathers its integral at every slant and jitter: c = 1 is Beer’s law', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const sigma = 0.002
    const march = probe(uniforms, slabMedium([{ ...SLAB, sigma }]))
    const cosines = [1, 0.9, 0.7, 0.5, 0.3]
    const jitters = [0, 0.37, 0.91]
    const rays = cosines.flatMap((mu) =>
      jitters.map((jitter) => ({ direction: leaning(mu), jitter })),
    )
    const probed = await march(rays)
    probed.forEach((result, i) => {
      const mu = cosines[Math.floor(i / jitters.length)]!
      const expected = Math.exp(-sigma * chord(0, mu, SLAB.base, SLAB.top))
      expect(relative(result.transmittance, expected)).toBeLessThanOrEqual(
        MARCH,
      )
      expectLight(result, 1 - expected)
      expect(result.exhausted).toBe(0)
    })
  })

  it('keeps T and the light as the steps that cut the layer change', async () => {
    /*
     * The jitter moves every step boundary, the budget changes nothing a ray
     * that finishes needs, and a slab 8 km farther is met by steps the
     * approach has grown to about 140 m where the near one's are about 60:
     * eighteen ways of cutting one 600 m column, each ending on the layer's
     * own crossings.
     */
    const sigma = 0.002
    const expected = Math.exp(-sigma * 600)
    for (const base of [1000, 9000]) {
      const uniforms = createCloudUniforms()
      placeBody(uniforms, { eye: 0, layers: [[base, base + 600]] })
      const slab = slabMedium([{ base, top: base + 600, sigma }])
      const march = probe(uniforms, slab)
      const results: Probed[] = []
      for (const maxSteps of [200, 400, 1024]) {
        uniforms.trace.maxSteps.value = maxSteps
        const rays = [0, 0.5, 0.99].map((jitter) => ({
          direction: [0, 1, 0] as Vec3,
          jitter,
        }))
        results.push(...(await march(rays)))
      }
      for (const result of results) {
        expect(relative(result.transmittance, expected)).toBeLessThanOrEqual(
          MARCH,
        )
        expectLight(result, 1 - expected)
      }
      /*
       * The cuts did move, or the test would pass whatever the step integral
       * did: the depth moments are taken at each step's middle, so the mean
       * depth lands differently on each jitter's cut. The half-opacity front
       * does not: it is placed inside the step that crosses it by the step's
       * own extinction, which in a uniform slab is ln 2/σ past the base on
       * any cut.
       */
      const means = new Set(results.map((result) => result.reproject))
      expect(means.size).toBeGreaterThanOrEqual(3)
      for (const { front } of results)
        expect(Math.abs(front - (base + Math.LN2 / sigma))).toBeLessThan(0.05)
    }
  })

  it('stops under 1% transmittance, with the light it gathered on the way', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[1000, 3000]] })
    const march = probe(
      uniforms,
      slabMedium([{ base: 1000, top: 3000, sigma: 0.1 }]),
    )
    const [result] = await march([{ direction: [0, 1, 0] }])
    // A step holds an optical depth of 0.675 at most here, the in-cloud
    // floor of 6.75 m at 1 km, so the march stops within a step of 1%.
    expect(result!.transmittance).toBeLessThan(0.01)
    expect(result!.transmittance).toBeGreaterThan(0.01 * Math.exp(-0.7))
    expect(result!.stopped).toBeLessThan(1100)
    // Through 2 km at that floor a march without the exit takes about three
    // hundred steps.
    expect(result!.steps).toBeLessThan(60)
    expectLight(result!, 1 - result!.transmittance)
  })

  it('hides the air between its exit and t₁ behind the cloud it stopped in', async () => {
    /*
     * An air of constant light per unit length and no extinction: the air
     * over a stretch is its length times that light, which the composite
     * adds under the cloud's opacity all the way to t₁. Past the exit the
     * cloud passes under 1%, so B there is (T − 1) times that stretch's
     * light, and the part before the exit is a share of its own stretch's.
     * Stopped at the exit, B lets the whole stretch behind the cloud through.
     */
    const glow = [3, 2, 1] as const
    const air: CloudAirFn = () => ({
      extinction: vec3(0),
      single: vec3(...glow),
      multiple: vec3(0),
    })
    const uniforms = createCloudUniforms()
    // A layer the medium leaves empty carries the span 2.4 km past the slab.
    placeBody(uniforms, {
      eye: 0,
      layers: [
        [SLAB.base, SLAB.top],
        [3000, 4000],
      ],
    })
    const march = probe(uniforms, slabMedium([{ ...SLAB, sigma: 0.02 }]), {
      air,
    })
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.3 }])
    const { transmittance, stopped, start, end } = result!
    expect(transmittance).toBeLessThan(0.01)
    expect(stopped).toBeLessThan(SLAB.top)
    // The union's top, crossed in float32.
    expect(Math.abs(end - 4000)).toBeLessThan(0.01)
    glow.forEach((light, c) => {
      const behind = ((transmittance - 1) * light * (end - stopped)) / R
      const before = result!.air[c]! - behind
      expect(before).toBeLessThanOrEqual(MARCH * Math.abs(behind))
      expect(before).toBeGreaterThanOrEqual(
        (-light * (stopped - start) * (1 + MARCH)) / R,
      )
    })
  })
})

describe('a partly cloudy level (the crossing’s law, §5.9)', () => {
  const halfClear = { ...SLAB, sigma: 20 / 600, fraction: 0.5 }
  const CELL = 1000

  /** What the law passes of a ray of up-cosine μ from the datum through the slab, float64. */
  function lawThrough(mu: number, cover: number, sigma: number): number {
    const s = chord(0, mu, SLAB.base, SLAB.top)
    const rise = SLAB.top - SLAB.base
    const run = Math.sqrt(Math.max(s * s - rise * rise, 0))
    const n = crossingExponentOf(run, CELL)
    return Math.exp(-crossingDepthOf(cover, sigma * s, n))
  }

  it('passes a half-clear layer of depth 20 by its crossing’s columns at every slant, and half of it vertically, on any cut', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [[SLAB.base, SLAB.top]],
      cell: CELL,
    })
    const march = probe(uniforms, slabMedium([halfClear]))
    const cosines = [1, 0.8, 0.5, 0.2]
    expect(lawThrough(1, 0.5, halfClear.sigma)).toBeCloseTo(0.5, 8)
    // A slant ray counts more than one column, and passes less than half.
    expect(lawThrough(0.5, 0.5, halfClear.sigma)).toBeLessThan(0.48)
    for (const maxSteps of [16, 48, 192, 1024]) {
      uniforms.trace.maxSteps.value = maxSteps
      const rays = cosines.flatMap((mu) =>
        [0, 0.6].map((jitter) => ({ direction: leaning(mu), jitter })),
      )
      const probed = await march(rays)
      probed.forEach((result, i) => {
        const expected = lawThrough(cosines[i >> 1]!, 0.5, halfClear.sigma)
        expect(relative(result.transmittance, expected)).toBeLessThanOrEqual(
          MARCH,
        )
        // (b): between the cloudy share's e^−τ and 1.
        expect(result.transmittance).toBeGreaterThanOrEqual(Math.exp(-20))
        // Under a sun that does not fall along the ray every step adds its
        // own opacity's light, on any cut.
        expectLight(result, 1 - expected)
      })
    }
  })

  it('counts every step its own columns where a cell is a millimeter: the variant, which passes nothing', async () => {
    // A sight length under any step's run makes each step many columns, the
    // layer's clear half counted once a column: the mean medium, e^(−c·τ).
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [[SLAB.base, SLAB.top]],
      cell: 1e-3,
    })
    const march = probe(uniforms, slabMedium([halfClear]))
    const [mixed] = await march([{ direction: leaning(0.8) }])
    expect(mixed!.transmittance).toBeLessThan(0.05)
    expect(lawThrough(0.8, 0.5, halfClear.sigma)).toBeGreaterThan(0.4)
  })

  it('multiplies two levels’ crossings, each mixed by its own cover', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [
        [1000, 1400],
        [2500, 3000],
      ],
    })
    const lower = { base: 1000, top: 1400, sigma: 1.5 / 400, fraction: 0.6 }
    const upper = { base: 2500, top: 3000, sigma: 0.8 / 500, fraction: 0.3 }
    const march = probe(uniforms, slabMedium([lower, upper]))
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.25 }])
    const first = 0.4 + 0.6 * Math.exp(-1.5)
    const second = 0.7 + 0.3 * Math.exp(-0.8)
    expect(relative(result!.transmittance, first * second)).toBeLessThanOrEqual(
      MARCH,
    )
    expectLight(result!, 1 - first * second)
  })

  it('is Beer’s law at a cover of one whatever the crossing counts: a grazing ray through a resolved slab', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]], cell: 50 })
    // Thin enough that the longest chord, 16.7 km, stays over the 1% exit.
    const sigma = 1e-4
    const march = probe(uniforms, slabMedium([{ ...SLAB, sigma }]))
    const cosines = [0.3, 0.1, 0.03]
    const probed = await march(
      cosines.map((mu) => ({ direction: leaning(mu) })),
    )
    probed.forEach((result, i) => {
      const expected = Math.exp(
        -sigma * chord(0, cosines[i]!, SLAB.base, SLAB.top),
      )
      expect(relative(result.transmittance, expected)).toBeLessThanOrEqual(
        MARCH,
      )
    })
  })
})

describe('the kernel’s arithmetic against the CPU’s (`cloudOverlap.ts`)', () => {
  it('counts a crossing’s columns, spreads a column’s depth, mixes a step and integrates its source as the reference does', async () => {
    /*
     * The functions of `cloudMix.ts` run as a kernel over a table of
     * arguments, each drawn uniform in its logarithm over the range a march
     * meets, with the ends of each range among them: a wisp's depth of 10⁻⁴
     * and a cumulonimbus's of 500, a cover from a thousandth to one, a
     * gamma's shape from a half to past where depths do not spread, a
     * source that falls or grows by e^±40 along its step.
     */
    const count = 512
    const IN = 10
    const OUT = 6
    const draw = (() => {
      let state = 0x9e3779b9
      return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 2 ** 32
      }
    })()
    const logUniform = (low: number, high: number): number =>
      Math.exp(Math.log(low) + (Math.log(high) - Math.log(low)) * draw())
    const rows = Array.from({ length: count }, (_, k) => {
      const edge = k < 12
      return {
        run: edge ? [0, 1e2, 1e6][k % 3]! : logUniform(1, 1e6),
        sight: logUniform(200, 30_000),
        cover: edge ? [1, 1e-3, 0.5, 0.999999][k % 4]! : draw(),
        depth: edge ? [1e-4, 500][k % 2]! : logUniform(1e-4, 500),
        exponent: edge ? [1, 300][k % 2]! : logUniform(1, 300),
        // A half, the decks' few units, the join's two sides, and none.
        shape: edge
          ? [0.5, 3, 9999, 1e4, 1e5, 30][k % 6]!
          : logUniform(0.5, 2e4),
        start: logUniform(1e-6, 10),
        folds: edge ? [40, -40, 0][k % 3]! : -20 + 40 * draw(),
        y: -30 + 60 * draw(),
        // A level's vertical depth: its spread mean overflows past e⁸⁰.
        vertical: logUniform(1e-3, 30),
      }
    })
    const input = new StorageBufferAttribute(new Float32Array(count * IN), 1)
    const output = new StorageBufferAttribute(new Float32Array(count * OUT), 1)
    ;(input.array as Float32Array).set(
      rows.flatMap((row) => [
        row.run,
        row.sight,
        row.cover,
        row.depth,
        row.exponent,
        row.start,
        row.start * Math.exp(-row.folds),
        row.y,
        row.shape,
        row.vertical,
      ]),
    )
    const from = storage(input, 'float', count * IN)
    const into = storage(output, 'float', count * OUT)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const read = (k: number) => from.element(instanceIndex.mul(IN).add(k))
        const write = (k: number, value: Node<'float'>) =>
          into.element(instanceIndex.mul(OUT).add(k)).assign(value)
        write(0, crossingExponent(read(0), read(1)))
        const depth = crossingDepth(read(2), read(3), read(4), read(8)).toVar()
        write(1, depth)
        write(2, stepLight(vec3(read(5)), vec3(read(6)), depth).y)
        write(3, stepShare(read(7)))
        write(4, gammaDepth(read(3), read(8)))
        write(5, spreadDepth(read(9), read(8)))
      })
    })().compute(count)
    await gpu.compute(kernel)
    const got = new Float32Array(await gpu.readBuffer(output))
    kernel.dispose()
    const f32 = Math.fround
    rows.forEach((row, k) => {
      const what = JSON.stringify(row)
      const at = (slot: number): number => got[OUT * k + slot]!
      const n = crossingExponentOf(f32(row.run), f32(row.sight))
      expect(relative(at(0), n), what).toBeLessThan(1e-5)
      const depth = crossingDepthOf(
        f32(row.cover),
        f32(row.depth),
        f32(row.exponent),
        f32(row.shape),
      )
      // A cover a float's step under one loses its last bits to 1 − c.
      const loose = row.cover > 0.9999 && row.cover < 1 ? 0.2 : 2e-4
      expect(relative(at(1), depth), what).toBeLessThan(loose)
      const end = f32(f32(row.start) * Math.exp(-row.folds))
      const light = stepLightOf(f32(row.start), end, at(1))
      expect(relative(at(2), light), what).toBeLessThan(2e-4)
      expect(relative(at(3), stepShareOf(f32(row.y))), what).toBeLessThan(2e-5)
      const column = gammaDepthOf(f32(row.depth), f32(row.shape))
      expect(relative(at(4), column), what).toBeLessThan(1e-5)
      // The spread mean is k·(e^(τ/k) − 1): held where a float32 holds it.
      if (row.vertical / row.shape < 60)
        expect(
          relative(at(5), spreadDepthOf(f32(row.vertical), f32(row.shape))),
          what,
        ).toBeLessThan(2e-5)
    })
  })
})

describe('the march’s edge cases', () => {
  const finite = (result: Probed): boolean =>
    [
      ...result.light,
      result.transmittance,
      ...result.air,
      result.reproject,
      result.end,
      result.front,
      result.deviation,
      result.stopped,
    ].every(Number.isFinite)

  it('writes finite outputs where no cloud is lit', async () => {
    /*
     * No first-order light anywhere: the mean radius is 0/0, and must not
     * reach the phase table. The stand-in phase never reads its radius, so
     * this one does, as a table's coordinate would: a NaN radius is a NaN
     * phase, whose product with no light is NaN, not 0.
     */
    const droplets = (_nu: Node<'float'>, radius: Node<'float'>) =>
      vec3(radius.mul(0).add(ISOTROPIC))
    const reading: CloudPhaseNodes = {
      droplets,
      phase: (nu, _layers, _level, radius) => vec4(droplets(nu, radius), 1),
    }
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const unlit = probe(uniforms, slabMedium([{ ...SLAB, sigma: 0.002 }]), {
      sun: (field) => testSun(field, CLOUD_STAND_INS.sunDepth(), float(0)),
      phase: reading,
    })
    const [shaded] = await unlit([{ direction: [0, 1, 0] }])
    expect(finite(shaded!)).toBe(true)
    // The sky's placeholder light still reaches it; the sun's does not.
    const sky = 0.5 * ISOTROPIC * (1 - shaded!.transmittance)
    for (const band of shaded!.light)
      expect(relative(band, sky)).toBeLessThanOrEqual(MARCH)
  })

  it('writes finite outputs on a level ray from an eye on a boundary', async () => {
    // The base's crossings for an eye on it, looking exactly level, are
    // (0, 0), never 0/0.
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: SLAB.base, layers: [[SLAB.base, SLAB.top]] })
    const along = probe(uniforms, slabMedium([{ ...SLAB, sigma: 0.002 }]))
    const [level] = await along([{ direction: [1, 0, 0] }])
    expect(finite(level!)).toBe(true)
    expect(level!.start).toBe(0)
    expect(level!.transmittance).toBeLessThan(1)
  })
})

describe('past the fine march', () => {
  const sigma = 0.002
  /**
   * What a far field holding the slab exactly would hand back for a ray up
   * the vertical from the datum, where t is the height: the slab past
   * `from`, its light relative to there, and the opacity-weighted mean and
   * spread of its depth.
   */
  const slabFar: CloudFarFn = (ray, from) => {
    const enter = max(from, float(SLAB.base))
    const depth = max(ray.end.sub(enter), 0)
    const through = exp(depth.mul(-sigma))
    const opacity = max(oneMinus(through), 1e-30)
    const mean = float(1 / sigma).sub(depth.mul(through).div(opacity))
    const square = float(2 / sigma ** 2)
      .sub(
        through.mul(
          depth
            .mul(depth)
            .add(depth.mul(2 / sigma))
            .add(2 / sigma ** 2),
        ),
      )
      .div(opacity)
    return {
      light: vec3(oneMinus(through).mul(LIGHT_PER_OPACITY)),
      air: vec3(0),
      airLight: vec3(0),
      transmittance: through,
      depthMean: enter.add(mean),
      depthDeviation: sqrt(max(square.sub(mean.mul(mean)), 0)),
    }
  }
  /** The same moments over the whole slab, float64. */
  const thickness = SLAB.top - SLAB.base
  const through = Math.exp(-sigma * thickness)
  const wholeMean =
    SLAB.base + 1 / sigma - (thickness * through) / (1 - through)
  const wholeSquare =
    (2 / sigma ** 2 -
      through * (thickness ** 2 + (2 * thickness) / sigma + 2 / sigma ** 2)) /
    (1 - through)
  const wholeDeviation = Math.sqrt(wholeSquare - (wholeMean - SLAB.base) ** 2)

  async function handed(
    configure: (uniforms: CloudUniforms) => void,
    layers: Layers['layers'] = [[SLAB.base, SLAB.top]],
  ) {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers })
    configure(uniforms)
    const slab = slabMedium([{ ...SLAB, sigma }])
    const march = probe(uniforms, slab, { far: slabFar })
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.3 }])
    return result!
  }

  it('hands the rest of the span to the far march at the footprint’s distance, and merges what each saw', async () => {
    const result = await handed((uniforms) => {
      uniforms.trace.farDistance.value = 1300
    })
    expect(result.stopped).toBe(1300)
    expect(result.exhausted).toBe(0)
    expect(relative(result.transmittance, through)).toBeLessThanOrEqual(MARCH)
    expectLight(result, 1 - through)
    // The fine half's moments come from each step's midpoint, which sits
    // σΔ²/12 (under a meter) off the opacity-weighted centroid of its step.
    expect(Math.abs(result.reproject - wholeMean)).toBeLessThan(2)
    expect(Math.abs(result.deviation - wholeDeviation)).toBeLessThan(2)
  })

  it('reaches the handover on a budget of eight steps, where the schedule’s would run out short of the slab', async () => {
    // An empty layer under the slab starts the span at 100 m. Eight of the
    // schedule's 50 m steps end 500 m short of the slab; the budget's floor
    // lengthens them, and the ray still stops at the footprint's distance.
    const result = await handed(
      (uniforms) => {
        uniforms.trace.maxSteps.value = 8
        uniforms.trace.farDistance.value = 1300
      },
      [EMPTY_BELOW, [SLAB.base, SLAB.top]],
    )
    expect(result.exhausted).toBe(1)
    expect(result.stopped).toBe(1300)
    expect(relative(result.transmittance, through)).toBeLessThanOrEqual(MARCH)
    expectLight(result, 1 - through)
  })

  it('takes out of B the far air the slab it crossed hides, which the far march cannot see', async () => {
    /*
     * A clear far field holding air light alone, behind the slab, in an air
     * that carries no light of its own: all of B is then the far air the
     * slab hides, T_a·(T − 1)·L_far. The far march's own blocked air is
     * taken from where it starts, against its own cloud, and holds none of
     * it; summed alone, a nearly opaque near cloud lets the whole far air
     * through.
     */
    const airLight = [0.3, 0.2, 0.1] as const
    const clear: CloudFarFn = (_ray, from) => ({
      light: vec3(0),
      air: vec3(0),
      airLight: vec3(...airLight),
      transmittance: float(1),
      depthMean: from,
      depthDeviation: float(0),
    })
    const dark: CloudAirFn = () => ({
      extinction: vec3(0),
      single: vec3(0),
      multiple: vec3(0),
    })
    const uniforms = createCloudUniforms()
    // A layer the medium leaves empty carries the span past the handover.
    placeBody(uniforms, {
      eye: 0,
      layers: [
        [SLAB.base, SLAB.top],
        [3000, 4000],
      ],
    })
    uniforms.trace.farDistance.value = 2000
    const slab = slabMedium([{ ...SLAB, sigma }])
    const march = probe(uniforms, slab, { far: clear, air: dark })
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.3 }])
    expect(result!.stopped).toBe(2000)
    expect(relative(result!.transmittance, through)).toBeLessThanOrEqual(MARCH)
    result!.air.forEach((band, c) => {
      expect(relative(band, (through - 1) * airLight[c]!)).toBeLessThanOrEqual(
        MARCH,
      )
    })
  })
})

describe('the air in front of a cloud', () => {
  it('dims the cloud’s light by the air between t₀ and it', async () => {
    /*
     * An air that only extinguishes, at a rate that passes half the light
     * over the 900 m from the span's start, at an empty layer's base, to a
     * slab 100 m thick: the slab is lit through between e^−0.077 of a half
     * (its far side) and a half (its near side) of the air, whatever the
     * coarse schedule did inside it. The air before t₀ is the composite's.
     */
    const extinction = (Math.LN2 * R) / 900
    const air: CloudAirFn = () => ({
      extinction: vec3(extinction),
      single: vec3(0),
      multiple: vec3(0),
    })
    const thin = { base: 1000, top: 1100, sigma: 0.004 }
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [EMPTY_BELOW, [thin.base, thin.top]],
    })
    const march = probe(uniforms, slabMedium([thin]), { air })
    const [result] = await march([{ direction: [0, 1, 0] }])
    const cloud = Math.exp(-0.4)
    expect(relative(result!.transmittance, cloud)).toBeLessThanOrEqual(MARCH)
    const dimmed = result!.light[1] / (LIGHT_PER_OPACITY * (1 - cloud))
    expect(dimmed).toBeLessThanOrEqual(0.5 * (1 + MARCH))
    expect(dimmed).toBeGreaterThanOrEqual(0.5 * Math.exp(-Math.LN2 / 9))
  })
})

describe('the blocked air', () => {
  it('takes the sky’s beam on a sky texel and the cleared beam on a surface texel under Enhanced', async () => {
    /*
     * An air lit by exactly the beam it is handed, so B is that beam times
     * one factor the class does not move: the cloud in front of the air and
     * the air's own throughput. A transmittance table constant over its
     * texels makes the slant its own overhead, so the cleared beam is the
     * table mixed halfway to white (`clearedBeam` at cleared·ORBIT_AIRLIGHT).
     */
    const table = [0.5, 0.25, 0.125] as const
    const cleared = table.map((c) => c + (1 - c) * 0.5)
    const texelValues = Array.from({ length: 16 }, (_, k) =>
      DataUtils.toHalfFloat(k % 4 === 3 ? 1 : table[k % 4]!),
    )
    const transmittance = new DataTexture(
      new Uint16Array(texelValues),
      2,
      2,
      RGBAFormat,
      HalfFloatType,
    )
    transmittance.magFilter = LinearFilter
    transmittance.minFilter = LinearFilter
    transmittance.needsUpdate = true
    const air: CloudAirFn = (_air, _height, _muSun, _phases, sunT) => ({
      extinction: vec3(20),
      single: sunT.mul(5),
      multiple: vec3(0),
    })
    const blocked = async (sky: boolean): Promise<Vec3> => {
      const uniforms = createCloudUniforms()
      placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
      uniforms.served.air.transmittance.value = transmittance
      uniforms.served.cleared.value = 1
      const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
      const march = probe(uniforms, slab, { sky, air })
      const [result] = await march([{ direction: [0, 1, 0] }])
      return result!.air
    }
    const sky = await blocked(true)
    const surface = await blocked(false)
    sky.forEach((band, k) => {
      expect(band).toBeLessThan(0)
      const ratio = surface[k]! / band
      expect(relative(ratio, cleared[k]! / table[k]!)).toBeLessThanOrEqual(
        MARCH,
      )
    })
    transmittance.dispose()
  })
})

describe('the texel’s class', () => {
  it('is the composite’s own test at any compression: a ridge 3 km out is surface, the clamp is sky', async () => {
    /*
     * An air lit by exactly the beam it is handed makes B one factor times
     * that beam, so a texel's band ratios name its class whatever the
     * quadrature did: the table's 0.5 and 0.25 on a sky texel, the cleared
     * beam's 0.833 and 0.75 on a surface one. Compression 0.25 tells the
     * class's units from their reciprocal: as R·c/1000 a ridge 0.75 render
     * km out lies 1,194 sea-level units deep, past the air's wall at 0.0157,
     * and reads as sky.
     */
    const compression = 0.25
    const table = [0.5, 0.25, 0.125] as const
    const cleared = table.map((c) => c + (1 - c) * 0.5)
    const transmittance = new DataTexture(
      new Uint16Array(
        Array.from({ length: 16 }, (_, k) =>
          DataUtils.toHalfFloat(k % 4 === 3 ? 1 : table[k % 4]!),
        ),
      ),
      2,
      2,
      RGBAFormat,
      HalfFloatType,
    )
    transmittance.magFilter = LinearFilter
    transmittance.minFilter = LinearFilter
    transmittance.needsUpdate = true
    const air: CloudAirFn = (_air, _height, _muSun, _phases, sunT) => ({
      extinction: vec3(20),
      single: sunT.mul(5000),
      multiple: vec3(0),
    })
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const body = uniforms.served
    body.compression.value = compression
    body.cleared.value = 1
    body.air.top.value = 1 + 100_000 / R
    body.air.transmittance.value = transmittance
    lookUp(uniforms, 1e-3)
    sizeTrace(uniforms, 2, 1)
    // The left texel's history pixels read the ridge, the right one's the clamp.
    const depth = depthTexture(8, 4, (x) => (x < 4 ? 3 * compression : SKY_KM))
    const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
    const { deps } = standIns(uniforms, slab, () => depth)
    const trace = new CloudTrace({ ...deps, air })
    await trace.warm(renderer)
    trace.render(renderer, frameOf({ width: 2, height: 1 }), BUDGET)
    const aux = await texels(trace.outputs.aux, 4, 1)
    const shape = (b: readonly number[]) => [b[1]! / b[0]!, b[2]! / b[0]!]
    const [surface, sky] = [aux(0, 0), aux(2, 0)]
    expect(surface[0]).toBeLessThan(0)
    expect(sky[0]).toBeLessThan(0)
    // Two half floats a ratio, each to its step.
    const close = (got: number[], want: number[]) =>
      got.forEach((value, k) =>
        expect(relative(value, want[k]!)).toBeLessThanOrEqual(4 * HALF),
      )
    close(shape(surface), shape(cleared))
    close(shape(sky), shape(table))
    trace.dispose()
    depth.dispose()
    transmittance.dispose()
  })
})

/* ------------------------------------------------------------------------- */
/* The trace's kernels and outputs                                            */
/* ------------------------------------------------------------------------- */

interface Rig {
  readonly uniforms: CloudUniforms
  readonly trace: CloudTrace
  readonly depth: DataTexture
  dispose(): void
}

/** A trace over `medium` at `width` × `height`, warmed, its uniforms the test's. */
async function rig(
  medium: CloudMediumFn,
  width: number,
  height: number,
  place: Layers,
  options: {
    readonly km?: (x: number, y: number) => number
    readonly phase?: CloudPhaseNodes
    readonly spread?: number
    readonly jitter?: (uniforms: CloudUniforms) => CloudJitterNodes
  } = {},
): Promise<Rig> {
  const uniforms = createCloudUniforms()
  placeBody(uniforms, place)
  lookUp(uniforms, options.spread ?? 1)
  sizeTrace(uniforms, width, height)
  const depth = depthTexture(
    4 * width,
    4 * height,
    options.km ?? (() => SKY_KM),
  )
  const { deps } = standIns(uniforms, medium, () => depth, {
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    ...(options.jitter === undefined
      ? {}
      : { jitter: options.jitter(uniforms) }),
  })
  const trace = new CloudTrace(deps)
  await trace.warm(renderer)
  return {
    uniforms,
    trace,
    depth,
    dispose() {
      trace.dispose()
      depth.dispose()
    },
  }
}

/** The light, aux and knot textures, read back whole at `extent`. */
async function outputsOf(trace: CloudTrace, width: number, height: number) {
  const { light, aux, knotDepth, knotLight } = trace.outputs
  return {
    light: await texels(light, width, height),
    aux: await texels(aux, 2 * width, height),
    knotDepth: await texels(knotDepth, 2 * width, height),
    knotLight: await texels(knotLight, 2 * width, 2 * height),
  }
}

/** Waits out the counters' readback, which lands a few frames late. */
async function stepsOf(trace: CloudTrace): Promise<CloudTrace['steps']> {
  for (let turn = 0; turn < 200 && trace.steps === null; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  return trace.steps
}

describe('the outputs', () => {
  it('follow the frame’s extent, one level each, holding the 72 bytes a texel they declare', async () => {
    const traced = await rig(slabMedium([]), 4, 4, {
      eye: 1000,
      layers: [[100, 5000]],
    })
    const { trace, uniforms } = traced
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    for (const [width, height] of [
      [4, 4],
      [6, 2],
    ] as const) {
      sizeTrace(uniforms, width, height)
      trace.render(renderer, frameOf({ width, height }), BUDGET)
      // A resize disposes the four and three makes them again at the next
      // binding: the kernels write the new ones, not what was destroyed.
      const { light } = await outputsOf(trace, width, height)
      for (let k = 0; k < width * height; k += 1)
        expect(light(k % width, Math.floor(k / width))).toEqual([0, 0, 0, 1])
      const held = trace.textures().map((map) => {
        const gpuTexture = backend.get(map).texture
        return [gpuTexture.width, gpuTexture.height, gpuTexture.mipLevelCount]
      })
      expect(held).toEqual([
        [width, height, 1],
        [2 * width, height, 1],
        [2 * width, height, 1],
        [2 * width, 2 * height, 1],
      ])
      // RGBA16F: eight bytes a texel of each.
      const bytes = held.reduce((sum, [w, h]) => sum + w! * h! * 8, 0)
      expect(trace.bytes).toBe(bytes)
      expect(trace.bytes).toBe(width * height * 72)
    }
    traced.dispose()
    expect(trace.bytes).toBe(0)
    expect(trace.textures()).toEqual([])
  })
})

describe('the immediate regime', () => {
  it('traces every history pixel exactly once over its four dispatches, and stores nothing outside the extent', async () => {
    /*
     * The depth copy names each history pixel by its distance: the 2 × 2
     * render pixels under history pixel n hold 2 + n/64 km, exact in a half
     * float, and a ray that meets no cloud ends there, so each texel's d_end
     * says which history pixel it traced. The textures are a column wider
     * than the extent the kernels are told, and that column stays as WebGPU
     * made it.
     */
    const width = 4
    const height = 3
    const named = (x: number, y: number): number =>
      2 + (Math.floor(y / 2) * 2 * width + Math.floor(x / 2)) / 64
    const traced = await rig(
      slabMedium([]),
      width,
      height,
      { eye: 1000, layers: [[100, 5000]] },
      { km: named },
    )
    const frame = frameOf({ width: width + 1, height })
    const seen = new Map<number, number>()
    for (const [k, [px, py]] of CLOUD_TRACE_PHASES.entries()) {
      traced.trace.dispatchPhase(renderer, frame, k)
      const { light, aux, knotDepth, knotLight } = await outputsOf(
        traced.trace,
        width + 1,
        height,
      )
      for (let j = 0; j < height; j += 1) {
        for (let i = 0; i < width; i += 1) {
          const n = Math.round((aux(2 * i + 1, j)[0] - 2) * 64)
          expect([n % (2 * width), Math.floor(n / (2 * width))]).toEqual([
            2 * i + px,
            2 * j + py,
          ])
          seen.set(n, (seen.get(n) ?? 0) + 1)
          expect(light(i, j)).toEqual([0, 0, 0, 1])
        }
        const untouched = [0, 0, 0, 0]
        expect(light(width, j)).toEqual(untouched)
        for (const x of [2 * width, 2 * width + 1]) {
          expect(aux(x, j)).toEqual(untouched)
          expect(knotDepth(x, j)).toEqual(untouched)
          expect(knotLight(x, 2 * j)).toEqual(untouched)
          expect(knotLight(x, 2 * j + 1)).toEqual(untouched)
        }
      }
    }
    expect(seen.size).toBe(4 * width * height)
    expect([...seen.values()].every((times) => times === 1)).toBe(true)
    traced.dispose()
  })
})

describe('the knots', () => {
  const lower = { base: 1000, top: 1400, sigma: 1.2 / 400 }
  const upper = { base: 2500, top: 3000, sigma: 1 / 500 }
  const place: Layers = {
    eye: 0,
    layers: [
      [lower.base, lower.top],
      [upper.base, upper.top],
    ],
  }

  it.each(CLOUD_PHASE_MODES)(
    'sit at two slabs’ entries and exits, with the transmittance and light at each exit, the phase taken by %s',
    async (phaseMode) => {
      // Rays within a thousandth of the zenith: chords within 10⁻⁶ of the
      // slabs' thicknesses, under a half float's step.
      const traced = await rig(slabMedium([lower, upper]), 2, 2, place, {
        spread: 1e-3,
      })
      const frame = frameOf({ width: 2, height: 2 }, { phaseMode })
      traced.trace.render(renderer, frame, BUDGET)
      const { aux, knotDepth, knotLight } = await outputsOf(traced.trace, 2, 2)
      const first = Math.exp(-1.2)
      const both = Math.exp(-2.2)
      const expected = [
        [LIGHT_PER_OPACITY * (1 - first), first],
        [LIGHT_PER_OPACITY * (1 - both), both],
        [0, 1],
        [0, 1],
      ] as const
      const near = (value: number, reference: number): void => {
        expect(Math.abs(value - reference)).toBeLessThanOrEqual(
          HALF * Math.max(Math.abs(reference), 1e-2),
        )
      }
      for (let j = 0; j < 2; j += 1)
        for (let i = 0; i < 2; i += 1) {
          expect(aux(2 * i + 1, j)[3]).toBe(2)
          knotDepth(2 * i, j).forEach((km, k) => {
            near(km, [1, 1.4, 2.5, 3][k]!)
          })
          expect(knotDepth(2 * i + 1, j)).toEqual([
            SKY_KM,
            SKY_KM,
            SKY_KM,
            SKY_KM,
          ])
          expected.forEach(([band, transmittance], k) => {
            const [r, g, b, t] = knotLight(2 * i + (k & 1), 2 * j + (k >> 1))
            for (const value of [r, g, b]) near(value, band)
            near(t, transmittance)
          })
        }
      traced.dispose()
    },
  )

  it('are one a level’s crossing, for a layer thin in every column: of depth 0.16 over nine columns, where no column passes under 98%', async () => {
    /*
     * A layer 400 m thick crossed 10° over the horizon: 2.3 km of chord,
     * nine columns of 250 m, an optical depth of 0.16 in all and under
     * 0.018 a column, with a wisp over it that passes all but 0.04%. A knot
     * cut at each column's close finds no column under 98% and records
     * nothing, so an object behind the layer reads a transmittance of one
     * where 0.85 stands in front of it. A crossing's knot holds the layer
     * whole, and the wisp, over the knot's threshold, records none.
     */
    const mu = 0.17
    const thin = { base: 1000, top: 1400, sigma: 7e-5, column: 250 }
    const wisp = { base: 2500, top: 3000, sigma: 4e-4 / 2900, column: 250 }
    const traced = await rig(slabMedium([thin, wisp]), 2, 2, place, {
      spread: 1e-3,
    })
    const camera = traced.uniforms.camera
    camera.forward.value.set(Math.sqrt(1 - mu * mu), mu, 0)
    camera.right.value.set(0, 0, 1)
    camera.up.value.set(-mu, Math.sqrt(1 - mu * mu), 0)
    traced.trace.render(renderer, frameOf({ width: 2, height: 2 }), BUDGET)
    const read = await outputsOf(traced.trace, 2, 2)
    const columns = Math.sqrt(1 - mu * mu) * chord(0, mu, 1000, 1400)
    expect(columns / 250).toBeGreaterThan(9)
    expect(
      Math.exp((-thin.sigma * 250) / Math.sqrt(1 - mu * mu)),
    ).toBeGreaterThan(0.98)
    for (let j = 0; j < 2; j += 1)
      for (let i = 0; i < 2; i += 1) {
        expect(read.aux(2 * i + 1, j)[3]).toBe(1)
        const [entry, exit] = read.knotDepth(2 * i, j)
        const through = read.light(i, j)[3]
        const knot = read.knotLight(2 * i, 2 * j)[3]
        // The layer's own slant chord, from the knot's two depths.
        const layer = Math.exp(-thin.sigma * 1000 * (exit - entry))
        expect(Math.abs(knot - layer)).toBeLessThan(4 * HALF)
        expect(knot).toBeLessThan(0.87)
        // Behind it stands the wisp alone: within 0.01 of the ray's own.
        expect(Math.abs(knot - through)).toBeLessThan(0.01)
      }
    traced.dispose()
  })

  it('are recorded for a cloud that ends under its level’s top, where the march’s last steps are clear', async () => {
    // The level runs a kilometer over the cloud in it, and is the union's
    // top: the ray ends in clear air with no step waiting to be closed.
    const low = { base: 1000, top: 1400, sigma: 1.2 / 400 }
    const traced = await rig(
      slabMedium([low]),
      2,
      2,
      { eye: 0, layers: [[1000, 2400]] },
      { spread: 1e-3 },
    )
    traced.trace.render(renderer, frameOf({ width: 2, height: 2 }), BUDGET)
    const read = await outputsOf(traced.trace, 2, 2)
    for (let j = 0; j < 2; j += 1)
      for (let i = 0; i < 2; i += 1) {
        expect(read.aux(2 * i + 1, j)[3]).toBe(1)
        const [entry, exit] = read.knotDepth(2 * i, j)
        expect(Math.abs(entry - 1)).toBeLessThan(2 * HALF)
        // The cloud's own edge is no boundary a step ends on: the knot's
        // exit is the end of the step that held the edge, a depth of 0.3,
        // 100 m, past it at most.
        expect(exit).toBeGreaterThanOrEqual(1.4 * (1 - HALF))
        expect(exit).toBeLessThan(1.5)
        const knot = read.knotLight(2 * i, 2 * j)[3]
        expect(knot).toBeLessThanOrEqual(Math.exp(-1.2) * (1 + HALF))
        expect(knot).toBeGreaterThan(Math.exp(-1.5))
        expect(knot).toBe(read.light(i, j)[3])
      }
    traced.dispose()
  })

  it('are two for a level a grazing ray crosses twice, down through it and up again', async () => {
    /*
     * From 5 km, a ray whose lowest point is 2 km up passes down through a
     * layer at 3 to 4 km, under it, and up through it again 226 km on. The
     * level under it is empty and is never reached.
     */
    const deck = { base: 3000, top: 4000, sigma: 2e-5 }
    const eye = 5000
    const sine = (R + 2000) / (R + eye)
    const mu = -Math.sqrt(1 - sine * sine)
    const grazing: Layers = {
      eye,
      layers: [
        [500, 1000],
        [deck.base, deck.top],
      ],
    }
    const traced = await rig(
      slabMedium([{ base: 500, top: 1000, sigma: 0 }, deck]),
      2,
      2,
      grazing,
      { spread: 1e-4 },
    )
    const camera = traced.uniforms.camera
    camera.forward.value.set(Math.sqrt(1 - mu * mu), mu, 0)
    camera.right.value.set(0, 0, 1)
    camera.up.value.set(-mu, Math.sqrt(1 - mu * mu), 0)
    traced.trace.render(renderer, frameOf({ width: 2, height: 2 }), BUDGET)
    const read = await outputsOf(traced.trace, 2, 2)
    /** Where the central ray meets a height, km: the near and the far root. */
    const meets = (h: number): [number, number] => {
      const b = (R + eye) * mu
      const root = Math.sqrt(b * b - ((R + eye) ** 2 - (R + h) ** 2))
      return [(-b - root) / 1000, (-b + root) / 1000]
    }
    const [topNear, topFar] = meets(deck.top)
    const [baseNear, baseFar] = meets(deck.base)
    const down = Math.exp(-deck.sigma * 1000 * (baseNear - topNear))
    for (let j = 0; j < 2; j += 1)
      for (let i = 0; i < 2; i += 1) {
        expect(read.aux(2 * i + 1, j)[3]).toBe(2)
        // Rays a ten-thousandth apart graze at heights 30 m apart, and the
        // crossings move by a kilometer with them.
        read.knotDepth(2 * i, j).forEach((km, k) => {
          const expected = [topNear, baseNear, baseFar, topFar][k]!
          expect(Math.abs(km - expected), `knot depth ${k}`).toBeLessThan(2)
        })
        const first = read.knotLight(2 * i, 2 * j)[3]
        const second = read.knotLight(2 * i + 1, 2 * j)[3]
        expect(relative(first, down)).toBeLessThan(0.03)
        expect(relative(second, down * down)).toBeLessThan(0.06)
        expect(Math.abs(second - read.light(i, j)[3])).toBeLessThan(2 * HALF)
      }
    traced.dispose()
  })

  it('are written through finiteOr, where the light beside them is not', async () => {
    // A phase poisoned at run time: a NaN constant would be folded, or
    // refused, by the compiler.
    const poison = uniform(Number.NaN)
    const traced = await rig(slabMedium([lower, upper]), 2, 2, place, {
      spread: 1e-3,
      phase: CLOUD_STAND_INS.phase(poison),
    })
    traced.trace.render(renderer, frameOf({ width: 2, height: 2 }), BUDGET)
    const { light, knotLight } = await outputsOf(traced.trace, 2, 2)
    // The injection reaches the light, which the history guards…
    expect(light(0, 0).slice(0, 3).every(Number.isNaN)).toBe(true)
    // …and never the knots, which nothing guards after them.
    for (let y = 0; y < 4; y += 1)
      for (let x = 0; x < 4; x += 1)
        expect(knotLight(x, y)).toEqual([0, 0, 0, 1])
    traced.dispose()
  })
})

describe('the jitter', () => {
  it('under the gradient’s lever, places every ray by the numbers `at` gives its texel and its history pixel, byte for byte', async () => {
    /*
     * The trace reads one draw a ray. Under `'ign'` its step share and its
     * point inside the pixel are the two reads the gradient has always
     * given, `at(texel).x` and `at(2·texel + phase)`, so the picture under
     * the default lever is the gradient's whatever else the draw carries.
     * Two traces over one field, one drawing from the field's jitter and
     * one from a draw written out of `at`, store the same half floats in
     * all four outputs, at each phase of the interleave and at frame
     * indices from zero to the last a u32 holds. Rays spread a whole image
     * across a broken slab, so a first step or a sampling point a bit off
     * lands in the transmittance, the front and the knots' depths.
     */
    const slab = slabMedium([
      { ...SLAB, sigma: 0.004, fraction: 0.6, column: 300 },
    ])
    const place: Layers = { eye: 0, layers: [[SLAB.base, SLAB.top]] }
    const fromAt = (uniforms: CloudUniforms): CloudJitterNodes => ({
      at: traceJitter,
      draw: (texel, frame) =>
        vec4(
          traceJitter(texel, frame).x,
          traceJitter(
            texel.mul(uint(2)).add(uvec2(uniforms.trace.phase)),
            frame,
          ),
          0,
        ),
    })
    const [width, height] = [6, 4]
    const drawn = await rig(slab, width, height, place)
    const written = await rig(slab, width, height, place, { jitter: fromAt })
    expect(drawn.uniforms.trace.jitter.value).toBe(0)
    const frame = frameOf({ width, height })
    const seen = new Set<number>()
    for (const index of [0, 5, 2 ** 31 + 7, 2 ** 32 - 1])
      for (const k of [0, 1, 2, 3]) {
        const outputs: number[][] = []
        for (const traced of [drawn, written]) {
          traced.uniforms.trace.frame.value = index
          traced.trace.dispatchPhase(renderer, frame, k)
          const read = await outputsOf(traced.trace, width, height)
          const values: number[] = []
          for (let y = 0; y < 2 * height; y += 1)
            for (let x = 0; x < 2 * width; x += 1) {
              values.push(...read.knotLight(x, y))
              if (y < height) values.push(...read.aux(x, y))
              if (y < height) values.push(...read.knotDepth(x, y))
              if (y < height && x < width) values.push(...read.light(x, y))
            }
          outputs.push(values)
        }
        expect(outputs[0]).toEqual(outputs[1])
        // The control: the draws moved the rays, or equality says nothing.
        seen.add(outputs[0]!.reduce((sum, v) => sum + v, 0))
      }
    expect(seen.size).toBe(16)
    drawn.dispose()
    written.dispose()
  }, 120_000)

  it('draws one frame index alike every time, and moves the samples with the index', async () => {
    // Frames 5 and 9 share an interleave phase, so only the jitter differs.
    const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
    const traced = await rig(slab, 4, 4, {
      eye: 0,
      layers: [[SLAB.base, SLAB.top]],
    })
    const at = async (index: number): Promise<number[]> => {
      traced.uniforms.trace.frame.value = index
      const frame = frameOf({ width: 4, height: 4 }, {}, index)
      traced.trace.render(renderer, frame, BUDGET)
      const { light } = await outputsOf(traced.trace, 4, 4)
      return Array.from({ length: 16 }, (_, k) => light(k % 4, k >> 2)[3])
    }
    const once = await at(5)
    expect(await at(5)).toEqual(once)
    expect(await at(9)).not.toEqual(once)
    traced.dispose()
  })
})

describe('the step counters', () => {
  it('count each ray’s steps, its opacity and the central ray’s range under stats, and nothing without', async () => {
    // Standing under an overcast deck with a budget of four steps: every
    // ray's floor lengthens its steps, and every ray ends opaque.
    const sigma = 0.03
    const deck = slabMedium([{ base: 100, top: 1100, sigma }])
    const traced = await rig(deck, 4, 4, { eye: 2, layers: [[100, 1100]] })
    const off = frameOf({ width: 4, height: 4 }, { stats: false })
    traced.trace.render(renderer, off, BUDGET)
    expect(traced.trace.steps).toBeNull()
    traced.uniforms.trace.maxSteps.value = 4
    const fine = frameOf({ width: 4, height: 4 }, { stats: true })
    traced.trace.render(renderer, fine, BUDGET)
    const steps = (await stepsOf(traced.trace))!
    expect(steps.exhausted).toBe(16)
    // The budget, and a ray's first step and its one boundary beside it.
    expect(steps.max).toBeLessThanOrEqual(4 + 2)
    expect(steps.mean).toBeGreaterThan(1)
    expect(steps.opacity).toBeGreaterThan(0.99)
    expect(steps.opacity).toBeLessThanOrEqual(1)
    // The central texel looks up within 60° of the zenith through 98 m of
    // clear air: its range is that slant and ln 50/σ of cloud, whatever the
    // four steps were.
    const inCloud = Math.log(50) / sigma
    expect(steps.range).not.toBeNull()
    expect(steps.range!).toBeGreaterThan(98 + inCloud)
    expect(steps.range!).toBeLessThan(2 * 98 + inCloud * 1.001)
    traced.dispose()
  })

  it('answer no range where the central ray never reaches a depth of ln 50', async () => {
    const thin = slabMedium([{ base: 100, top: 1100, sigma: 1e-4 }])
    const traced = await rig(thin, 4, 4, { eye: 2, layers: [[100, 1100]] })
    const frame = frameOf({ width: 4, height: 4 }, { stats: true })
    traced.trace.render(renderer, frame, BUDGET)
    const steps = (await stepsOf(traced.trace))!
    expect(steps.range).toBeNull()
    expect(steps.exhausted).toBe(0)
    expect(steps.opacity).toBeGreaterThan(0.09)
    expect(steps.opacity).toBeLessThan(0.2)
    traced.dispose()
  })
})

/* ------------------------------------------------------------------------- */
/* First order, the schedule and the handover                                 */
/* ------------------------------------------------------------------------- */

describe('first order on a slab (the step’s integral, §5.4)', () => {
  /*
   * A slab of fair cumulus's extinction seen from straight above, under the
   * slab's own exact sun, with a gain on first order as the scaled medium's
   * atlas gives one. First order is then
   * p·gain·(1 − e^(−k·τ))/k with k = 1 + μ/μ₀, over the depth the march
   * crossed before it stopped under 1%. The step's depth grows with the
   * distance to the slab: 0.3 beside it, 1.16 from 8 km, 2 from 14.4 km and
   * 7.3 from 55 km, the far handover's. An empty level over the slab gives
   * the ray clear air to cross first, as a ray toward a far cloud has: the
   * out-of-cloud step has then grown past the in-cloud floor it caps, where
   * a ray that starts on the slab takes 50 m steps at any distance.
   */
  const slab = { base: 400, top: 1000, sigma: 0.035 }
  const GAIN = 1.9
  const DISTANCES = [10, 8000, 14_400, 55_000]
  const SUNS = [1, 0.5, 0.2]

  async function ratios(
    march: ProbeOptions['march'],
  ): Promise<{ distance: number; mu0: number; ratio: number }[]> {
    const out: { distance: number; mu0: number; ratio: number }[] = []
    for (const distance of DISTANCES)
      for (const mu0 of SUNS) {
        const uniforms = createCloudUniforms()
        placeBody(uniforms, {
          eye: slab.top + distance,
          layers: [
            [slab.base, slab.top],
            [slab.top + 0.05 * distance, slab.top + 0.9 * distance],
          ],
        })
        placeSun(uniforms, mu0)
        const probed = probe(uniforms, slabMedium([slab]), {
          sun: () => exactSlabSun([slab]),
          phase: CLOUD_STAND_INS.phase(ISOTROPIC, GAIN),
          ...(march === undefined ? {} : { march }),
        })
        const [r] = await probed([{ direction: [0, -1, 0], jitter: 1 }])
        const k = 1 + 1 / mu0
        const tau = slab.sigma * (r!.stopped - distance)
        const exact = (ISOTROPIC * GAIN * -Math.expm1(-k * tau)) / k
        // The sky's placeholder takes no gain: Ψ at a half, per opacity.
        const sky = 0.5 * ISOTROPIC * (1 - r!.transmittance)
        out.push({ distance, mu0, ratio: (r!.light[1] - sky) / exact })
      }
    return out
  }

  it.each(CLOUD_PHASE_MODES)(
    'is within 1% of the closed form at every step depth and sun, the phase taken by %s',
    async (phaseMode) => {
      for (const { distance, mu0, ratio } of await ratios({ phaseMode }))
        expect(
          Math.abs(ratio - 1),
          `${distance} m, μ₀ ${mu0}: ${ratio}`,
        ).toBeLessThan(0.01)
    },
    120_000,
  )

  it('is 15%, 52%, 76% and 100% high with the source held at each step’s start, under equal sun and view angles: the variant', async () => {
    const found = await ratios({ sourceAtStart: true })
    const at = (distance: number, mu0: number): number =>
      found.find((one) => one.distance === distance && one.mu0 === mu0)!.ratio
    // 2/(1 + e^−τ) a step of depth τ, which no step count sees.
    for (const [distance, depth] of [
      [10, 0.3],
      [8000, 1.155],
      [14_400, 1.995],
      [55_000, 7.3],
    ] as const)
      expect(at(distance, 1), `${distance} m`).toBeCloseTo(
        2 / (1 + Math.exp(-depth)),
        2,
      )
    // And toward a low sun, μ/μ₀ = 5: 86% high beside the slab, six times
    // the light from the handover.
    expect(at(10, 0.2)).toBeCloseTo(1.863, 2)
    expect(at(55_000, 0.2)).toBeGreaterThan(5.9)
  }, 120_000)
})

describe('a layer as its steps are split (the rubric’s row 5)', () => {
  it('keeps its transmittance, and its light within 1% of the 192-step value, as the budget runs from 16', async () => {
    /*
     * A broken layer and a whole one, each crossed on a slant from 100 m
     * under an exact sun 30° up, so the source falls along every step. The
     * budget's floor makes a step up to 3.2 km long at sixteen.
     */
    for (const fraction of [1, 0.6]) {
      // Thin enough that no ray falls under the 1% exit, where a step's
      // length decides how far under.
      const layer = { ...SLAB, sigma: 0.0012, fraction }
      const uniforms = createCloudUniforms()
      placeBody(uniforms, {
        eye: 0,
        layers: [EMPTY_BELOW, [SLAB.base, SLAB.top]],
      })
      placeSun(uniforms, 0.5)
      const march = probe(uniforms, slabMedium([layer]), {
        sun: () => exactSlabSun([layer]),
      })
      const at = async (maxSteps: number): Promise<Probed[]> => {
        uniforms.trace.maxSteps.value = maxSteps
        return march(
          [0.9, 0.4].flatMap((mu) =>
            [0.1, 0.8].map((jitter) => ({ direction: leaning(mu), jitter })),
          ),
        )
      }
      const reference = await at(192)
      for (const maxSteps of [16, 24, 48, 96]) {
        const found = await at(maxSteps)
        found.forEach((result, i) => {
          const what = `cover ${fraction}, ${maxSteps} steps, ray ${i}`
          expect(
            relative(result.transmittance, reference[i]!.transmittance),
            what,
          ).toBeLessThanOrEqual(MARCH)
          expect(
            relative(result.light[1], reference[i]!.light[1]),
            what,
          ).toBeLessThan(0.01)
        })
        // The control: at sixteen the floor did lengthen the steps.
        if (maxSteps === 16)
          expect(found.every((result) => result.exhausted === 1)).toBe(true)
      }
      expect(reference.every((result) => result.exhausted === 0)).toBe(true)
    }
  })
})

describe('the schedule and the handover (§5.8)', () => {
  it('takes its first steps at the schedule’s length inside a cloud, with a horizon 75 km out', async () => {
    /*
     * Level through a deck from inside it. The schedule's step is a depth
     * of 0.3, 8.6 m, so the ray is under 1% within sixteen of them, 137 m.
     * An even share of the distance to the handover would be 390 m a step,
     * one sample at the eye; the logarithm's share at 192 steps is 2 m
     * there, under the schedule.
     */
    const sigma = 0.035
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 1500, layers: [[100, 3000]] })
    uniforms.trace.farDistance.value = 75_000
    uniforms.trace.maxSteps.value = 192
    const march = probe(uniforms, slabMedium([{ base: 100, top: 3000, sigma }]))
    const [level] = await march([{ direction: [1, 0, 0], jitter: 1 }])
    expect(level!.exhausted).toBe(0)
    expect(level!.steps).toBeGreaterThanOrEqual(15)
    expect(level!.stopped).toBeLessThan(Math.log(100) / sigma + 0.3 / sigma)
    // On a budget of sixteen the floor does bind, and the ray still ends.
    uniforms.trace.maxSteps.value = 16
    const [short] = await march([{ direction: [1, 0, 0], jitter: 1 }])
    expect(short!.exhausted).toBe(1)
    expect(short!.transmittance).toBeLessThan(0.01)
  })

  it('stops every ray at its own place in the band, farDistance·band^ξ, on any budget and never short of it', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[100, 60_000]] })
    uniforms.trace.farDistance.value = 5000
    const xis = [0, 0.25, 0.5, 0.75, 0.999]
    // Clear air, and a haze thin enough that no ray exits before its stop.
    for (const sigma of [0, 2e-5]) {
      const medium = slabMedium([{ base: 100, top: 60_000, sigma }])
      const march = probe(uniforms, medium)
      for (const band of [2, 4, 1])
        for (const maxSteps of [6, 24, 192]) {
          uniforms.trace.handoverBand.value = band
          uniforms.trace.maxSteps.value = maxSteps
          const probed = await march(
            xis.map((handover) => ({
              direction: [0, 1, 0] as Vec3,
              jitter: 0.4,
              handover,
            })),
          )
          probed.forEach((result, i) => {
            const stop = 5000 * band ** xis[i]!
            const what = `σ ${sigma}, band ${band}, ${maxSteps} steps, ξ ${xis[i]}`
            expect(relative(result.stopped, stop), what).toBeLessThan(1e-5)
            expect(result.stopped, what).toBeGreaterThanOrEqual(
              5000 * (1 - 1e-6),
            )
            expect(result.stopped, what).toBeLessThanOrEqual(
              5000 * band * (1 + 1e-6),
            )
            // The first step and the base's crossing are not the budget's.
            expect(result.steps, what).toBeLessThanOrEqual(maxSteps + 2)
          })
        }
    }
  })
})

/* ------------------------------------------------------------------------- */
/* The sun's taps                                                             */
/* ------------------------------------------------------------------------- */

describe('the sun a sample sees (§5.4, §5.5)', () => {
  const slab = { base: 1000, top: 3000, sigma: 0.035 }
  const COUNT = 256

  /** The slab's own depths as a cache would hold them, read at a weight. */
  function slabCache(
    weight: Node<'float'>,
    holds: Node<'float'>,
  ): {
    readonly nodes: CloudSunDepthNodes
    readonly uniforms: CloudUniforms
  } {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[slab.base, slab.top]] })
    uniforms.served.climate.cover.value.set(1, 1, 1)
    const body = uniforms.served
    const exact = exactSlabSun([slab])
    const medium = slabMedium([slab])
    const nodes: CloudSunDepthNodes = {
      depths(offset) {
        const at: CloudSample = {
          offset,
          distance: length(offset),
          altitude: altitudeAt(body, offset),
          sunMu: sunMuAt(body, offset),
          footprint: float(0),
        }
        const depth = exact(at, medium(at, body), body).depth
        return {
          toSun: depth.x.mul(holds),
          whole: depth.y.mul(holds),
          weight,
          behind: float(1),
        }
      },
    }
    return { nodes, uniforms }
  }

  /**
   * `cloudSunFn` at samples `depths` meters under the slab's top on the
   * eye's vertical: (T_cloud, the depth to the sun, the ray's whole).
   */
  function sunAt(options: {
    readonly weight?: number
    /** The share of the slab's depth the cache holds: 0 is a cache that holds nothing. */
    readonly holds?: number
    /** The extinction the taps are spaced by, where it is not the slab's. */
    readonly spacedBy?: number
  }) {
    const weight = uniform(options.weight ?? 1)
    const { nodes, uniforms } = slabCache(weight, float(options.holds ?? 1))
    const body = uniforms.served
    const medium = slabMedium([slab])
    const sun = cloudSunFn({ uniforms, medium, depth: nodes })
    const input = new StorageBufferAttribute(new Float32Array(COUNT), 1)
    const output = new StorageBufferAttribute(new Float32Array(COUNT * 3), 1)
    const from = storage(input, 'float', COUNT)
    const into = storage(output, 'float', COUNT * 3)
    const count = uniform(0, 'uint')
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(count), () => {
        const offset = vec3(
          0,
          float(slab.top).sub(from.element(instanceIndex)),
          0,
        )
        const at: CloudSample = {
          offset,
          distance: length(offset),
          altitude: altitudeAt(body, offset),
          sunMu: sunMuAt(body, offset),
          footprint: float(0),
        }
        const here = medium(at, body)
        const seen = sun(
          at,
          options.spacedBy === undefined
            ? here
            : { ...here, sigma: float(options.spacedBy) },
          body,
        )
        const to = instanceIndex.mul(3)
        into.element(to).assign(seen.cloud)
        into.element(to.add(1)).assign(seen.depth.x)
        into.element(to.add(2)).assign(seen.depth.y)
      })
    })().compute(COUNT)
    return {
      uniforms,
      weight,
      async at(depths: readonly number[], taps: number) {
        ;(input.array as Float32Array).set(depths)
        input.needsUpdate = true
        count.value = depths.length
        uniforms.trace.lightTaps.value = taps
        await gpu.compute(kernel)
        const got = new Float32Array(await gpu.readBuffer(output))
        return depths.map((_, i) => ({
          cloud: got[3 * i]!,
          toSun: got[3 * i + 1]!,
          whole: got[3 * i + 2]!,
        }))
      },
    }
  }

  it('draws two, four, six and eight taps as different tap sets, the last cut at a kilometer', async () => {
    // A cache that holds nothing past the taps: what a sample 1.5 km deep
    // sees is the taps' own depth, 0.5·(2ⁿ − 1) for n of them until the
    // kilometer's reach cuts it at σ·1000.
    const sun = sunAt({ holds: 0 })
    for (const [taps, depth] of [
      [0, 0],
      [2, 1.5],
      [4, 7.5],
      [6, 31.5],
      [8, slab.sigma * 1000],
    ] as const) {
      const [seen] = await sun.at([1500], taps)
      expect(
        relative(seen!.cloud, Math.exp(-depth)),
        `${taps} taps`,
      ).toBeLessThan(1e-3)
    }
  })

  it('holds the depth to the sun and the ray’s whole within 2% where every tap is in cloud, and a face inside a tap within that tap’s half', async () => {
    const sun = sunAt({})
    const whole = slab.sigma * (slab.top - slab.base)
    for (const taps of [4, 6, 8]) {
      const reach = Math.min(0.5 * (2 ** taps - 1), slab.sigma * 1000)
      // Deeper than the taps reach, to 100 m over the slab's base: every
      // tap counts its own width.
      const reachMeters = reach / slab.sigma
      const deep = [1.05 * reachMeters, (reachMeters + 1900) / 2, 1900]
      for (const [i, seen] of (await sun.at(deep, taps)).entries()) {
        const exact = slab.sigma * deep[i]!
        expect(relative(seen.toSun, exact)).toBeLessThan(0.02)
        expect(relative(seen.whole, whole)).toBeLessThan(0.02)
        expect(relative(seen.cloud, Math.exp(-exact))).toBeLessThan(
          0.02 * exact,
        )
      }
    }
    // A face inside tap k is counted whole or not at all by the tap's
    // middle: off by at most half the tap, 0.25·2ᵏ of depth.
    const shallow = Array.from(
      { length: 200 },
      (_, i) => ((i + 0.5) / 200) * 7.4,
    )
    const found = await sun.at(
      shallow.map((depth) => depth / slab.sigma),
      4,
    )
    found.forEach((seen, i) => {
      const exact = shallow[i]!
      const tap = Math.floor(Math.log2(exact / 0.5 + 1))
      expect(
        Math.abs(seen.toSun - exact),
        `depth ${exact}`,
      ).toBeLessThanOrEqual(0.25 * 2 ** tap + 1e-3)
    })
  })

  it('is within 15% of exact over a lit face’s first depth, where taps spaced in meters are off by half again', async () => {
    /*
     * Samples spread evenly over the first optical depth under the face, 29
     * m of fair cumulus, and the mean of what each sees, which is what a
     * face that falls anywhere draws. Taps spaced by the sample's own
     * extinction put the first one's middle a quarter of a depth in. Taps
     * a quarter of a kilometer wide, which is the spacing of an extinction
     * of 0.002, put it 125 m in, past every one of these samples, so each
     * reads a clear sun.
     */
    const depths = Array.from({ length: 200 }, (_, i) => (i + 0.5) / 200)
    const meters = depths.map((depth) => depth / slab.sigma)
    const exact = 1 - Math.exp(-1)
    const mean = (seen: readonly { cloud: number }[]): number =>
      seen.reduce((sum, one) => sum + one.cloud, 0) / seen.length
    const spaced = mean(await sunAt({}).at(meters, 4))
    expect(Math.abs(spaced / exact - 1)).toBeLessThan(0.15)
    const fixed = mean(await sunAt({ spacedBy: 0.002 }).at(meters, 4))
    expect(fixed / exact).toBeGreaterThan(1.5)
  })

  it('reads the cache through its weight: the layers’ own statistics at none, a mix of the two transmittances between', async () => {
    // A cache that holds nothing, as after a change of field: at full
    // weight a deep sample is lit as though nothing stood past its taps.
    const empty = sunAt({ holds: 0 })
    const deep = [400, 900, 1500]
    const exact = deep.map((depth) => Math.exp(-slab.sigma * depth))
    const taps = Math.exp(-7.5)
    for (const [i, seen] of (await empty.at(deep, 4)).entries())
      expect(relative(seen.cloud, taps), `${deep[i]} m`).toBeLessThan(1e-3)
    // At no weight the statistics stand in: the sample's own column, less
    // what the taps crossed, which on a whole layer is the layer itself.
    empty.weight.value = 0
    for (const [i, seen] of (await empty.at(deep, 4)).entries())
      expect(relative(seen.cloud, exact[i]!)).toBeLessThan(0.02)
    empty.weight.value = 0.5
    for (const [i, seen] of (await empty.at(deep, 4)).entries())
      expect(relative(seen.cloud, 0.5 * taps + 0.5 * exact[i]!)).toBeLessThan(
        0.02,
      )
  })
})

/* ------------------------------------------------------------------------- */
/* The trace's cost                                                           */
/* ------------------------------------------------------------------------- */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const TIMESTAMPS = await adapterOffers('timestamp-query')
const COST_OUT = '.data/clouds/traceCost.json'

describe.skipIf(!MEASURE || !TIMESTAMPS)('the trace’s cost', () => {
  /*
   * GPU milliseconds a frame of the `cloud trace` pass on the timeline, in
   * the system's own chain, at two target sizes under three regimes and at
   * each tap count the lever admits from four up: the eye 100 m up, looking
   * straight up through a 60° lens, the air on, the converging regime, the
   * median of five runs of eight frames after 140 frames of settling. A
   * test's figure, of this stance on this adapter, beside the steps a ray
   * the same frames count; a campaign's stances and its protocol are not
   * these. Written to `.data/clouds/traceCost.json` and held to nothing but
   * being a number.
   */
  it('is timed at 1920 × 1080 and 2880 × 1800, under three regimes, at four, six and eight taps, and written', async () => {
    const rows: unknown[] = []
    for (const [width, height] of [
      [1920, 1080],
      [2880, 1800],
    ] as const)
      for (const weather of [
        'overcast',
        'fair-cumulus',
        'cirrus-over-cumulus',
      ] as const) {
        const own = await openGpu(width, height)
        const chain = cloudRig(own, width, height, {
          eye: 100,
          looking: LOOKING_UP,
          air: true,
          levers: { weather, on: true },
        })
        await chain.system!.warm()
        const stop = installPassTimeline(own.renderer)
        try {
          const timeline = passTimelineOf(own.renderer)!
          for (const lightTaps of [4, 6, 8] as const) {
            chain.levers = { ...chain.levers, lightTaps, stats: false }
            for (let k = 0; k < 140; k += 1) chain.frame()
            await own.read(chain.target)
            const runs: number[] = []
            for (let n = 0; n < 5; n += 1) {
              const read = await timeline.measure(() => chain.frame(), 8)
              const pass = read.passes.find((p) => p.label === 'cloud trace')
              runs.push(pass?.ms ?? Number.NaN)
            }
            chain.levers = { ...chain.levers, stats: true }
            for (let k = 0; k < 12; k += 1) {
              chain.frame()
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
            const report = chain.system!.report
            const median = [...runs].sort((a, b) => a - b)[2]!
            expect(Number.isFinite(median)).toBe(true)
            rows.push({
              render: [width, height],
              trace: report.extents.trace,
              weather,
              lightTaps,
              ms: median,
              runs,
              steps: report.steps,
            })
          }
        } finally {
          stop()
          chain.dispose()
          own.dispose()
        }
      }
    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      COST_OUT,
      `${JSON.stringify(
        {
          note: 'cloudTrace.gpu.test.ts: GPU ms a frame of the `cloud trace` pass on the timeline in the system’s chain; a test’s figure at one stance, not a campaign’s',
          stance:
            'eye 100 m, looking up, 60° lens, air on, converging, median of 5 runs of 8 frames after 140',
          rows,
        },
        null,
        2,
      )}\n`,
    )
  }, 900_000)
})
