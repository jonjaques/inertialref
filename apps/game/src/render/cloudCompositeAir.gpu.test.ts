import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  Scene,
} from 'three/webgpu'
import {
  abs,
  exp,
  float,
  Fn,
  max,
  mix,
  oneMinus,
  saturate,
  texture,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { SOLAR_PLANETS } from '@inertialref/universe'
import {
  type AirUniforms,
  airMediumAt,
  createAirUniforms,
  marchAir,
  ORBIT_AIRLIGHT,
  phasesToward,
  psiTableAt,
} from './air.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import { CloudComposite } from './cloudComposite.ts'
import {
  type AirMediumFn,
  airSegment,
  outerSpan,
  SKY_SEGMENT_SAMPLES,
  SURFACE_SEGMENT_SAMPLES,
} from './cloudCompositeAir.ts'
import { CloudDepth } from './cloudDepth.ts'
import { CloudFrameNode } from './cloudFrameNode.ts'
import { CLOUD_STAND_INS, cloudStorageTexture } from './cloudNodes.ts'
import { createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { sceneBackend, sceneLayout } from './sceneLayout.ts'
import { warmTargetFor } from './sceneTarget.ts'
import { sensorMrt } from './sensorMrt.ts'

/*
 * The composite's split marches, held to `marchAir` itself. Each segment the
 * composite marches is `marchAir`'s accumulation over the same crowded
 * samples, with every table read named at level 0 because the class that
 * picks the march is chosen per pixel; drawn here in uniform control flow,
 * where `marchAir`'s implicit-derivative reads are legal, the two must agree
 * on the same segment to 10⁻⁵ — on the shell's rule (no clearing) and on
 * `airToward`'s (the beam cleared from orbit or not).
 *
 * Each sample's terms come from `airMediumAt`, which
 * `cloudLight.gpu.test.ts` holds to `marchAir`'s terms. The march is held
 * here twice: on a reproduction of those terms built below, node for node,
 * which stands whatever `airMediumAt` does, and on `airMediumAt` itself.
 *
 * Rays from 2 m, 1 km, 10 km and 400 km over Earth's datum, from 30° below
 * the horizon to the zenith, toward a sun 20° up, over segments from where
 * the ray enters the air to fractions of its far wall.
 */

const SIZE = 16

const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
const haze = earth.haze!
const TOP = 1 + haze.height / earth.radius
const HEIGHTS = {
  rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
  aerosol: haze.aerosolHeight / earth.radius,
}
const EYE_HEIGHTS = [2, 1_000, 10_000, 400_000] as const
const SUN_ELEVATION = (20 * Math.PI) / 180
/** The bound §5.11 sets, relative; identical arithmetic lands far inside it. */
const SAME = 1e-5

/** A tent in height, 1 at `peak` and nothing from `halfWidth` either side: `air.ts`'s. */
const tent = (
  height: Node<'float'>,
  peak: Node<'float'>,
  halfWidth: Node<'float'>,
): Node<'float'> =>
  max(float(1).sub(abs(height.sub(peak)).div(max(halfWidth, 1e-9))), 0)

/**
 * `marchAir`'s per-sample terms, node for node in its order: what
 * `airMediumAt` is specified to be, written apart from it.
 */
const marchAirTerms: AirMediumFn = (air, height, muSun, phases, sunT, read) => {
  const height01 = saturate(height.div(max(air.top.sub(1), 1e-6)))
  const fade = oneMinus(height01)
  const densityR = exp(height.div(air.hRayleigh).negate()).mul(fade)
  const densityM = exp(height.div(air.hMie).negate()).mul(fade)
  const densityO = tent(height, air.ozonePeak, air.ozoneHalfWidth)
  const densityD = tent(height, air.detachedPeak, air.detachedHalfWidth)
  const scatterD = air.detachedScatter.mul(densityD)
  const extinction = air.betaRayleigh
    .mul(densityR)
    .add(air.mieExtinction.mul(densityM))
    .add(air.ozone.mul(densityO))
    .add(air.detachedExtinction.mul(densityD))
  const psi = psiTableAt(air, muSun, height01, read)
  const scatterToward = mix(air.mieScatter, air.mieForward, phases.forward)
  const single = air.betaRayleigh
    .mul(densityR)
    .add(scatterD)
    .mul(phases.rayleigh)
    .add(scatterToward.mul(densityM).mul(phases.mie))
    .mul(sunT)
  const multiple = psi.mul(
    air.betaRayleigh
      .mul(densityR)
      .add(air.mieScatter.mul(densityM))
      .add(scatterD),
  )
  return { extinction, single, multiple }
}

let gpu: GpuSession
let air: AirUniforms

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  air = createAirUniforms()
  const tables = scatteringFor(haze, TOP, HEIGHTS)
  air.set(tables.recipe, tables.transmittance, tables.multiScatter)
})

afterAll(() => {
  gpu.dispose()
})

const SUN = vec3(Math.cos(SUN_ELEVATION), Math.sin(SUN_ELEVATION), 0)

/**
 * The ray through texel (u, v): its eye from v, its elevation from u, and a
 * segment from where it enters the air to `share` of the way to its far wall.
 */
function ray(share: number) {
  const coordinate = uv()
  const band = coordinate.y.mul(EYE_HEIGHTS.length).floor()
  const height = EYE_HEIGHTS.reduce<Node<'float'>>(
    (chosen, meters, k) =>
      band.equal(k).select(float(1 + meters / earth.radius), chosen),
    float(1),
  )
  const elevation = mix(float(-Math.PI / 6), float(Math.PI / 2), coordinate.x)
  const direction = vec3(elevation.cos(), elevation.sin(), 0.3).normalize()
  const eye = vec3(0, height, 0)
  const { near, wall } = outerSpan(air, eye, direction)
  return {
    eye,
    direction,
    near,
    far: mix(near, wall, share),
  }
}

/**
 * The largest relative difference over the channels of both outputs, for
 * every texel: the composite's segment against `marchAir`'s, and the size of
 * `marchAir`'s light, so a vacuum cannot pass for agreement.
 */
async function compared(
  samples: number,
  clearBeam: number | null,
  share: number,
  medium: AirMediumFn,
): Promise<{ worst: number; lit: number }> {
  const graph = Fn(() => {
    const { eye, direction, near, far } = ray(share)
    const strength = clearBeam === null ? null : float(clearBeam)
    const ours = airSegment(
      air,
      eye,
      direction,
      near,
      far,
      SUN,
      samples,
      strength,
      medium,
    )
    const theirs = marchAir(
      air,
      eye,
      direction,
      near,
      far,
      SUN,
      samples,
      strength ?? undefined,
    )
    const relative = (a: Node<'vec3'>, b: Node<'vec3'>): Node<'float'> => {
      const off = abs(a.sub(b))
      const size = max(abs(b), vec3(1e-12))
      const ratio = off.div(size)
      return max(max(ratio.x, ratio.y), ratio.z)
    }
    return vec4(
      relative(ours.inscatter, theirs.inscatter),
      relative(ours.transmittance, theirs.transmittance),
      theirs.inscatter.y,
      theirs.transmittance.y,
    )
  })()
  const pixels = await gpu.drawGraph(graph, { float: true })
  let worst = 0
  let lit = 0
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) {
      const [light, through, inscatter] = pixels.at(x, y)
      worst = Math.max(worst, light, through)
      if (inscatter > 1e-4) lit += 1
    }
  return { worst, lit }
}

const CASES = [
  ['the shell’s rule, six samples', SKY_SEGMENT_SAMPLES, null],
  ['the shell’s whole twelve', 2 * SKY_SEGMENT_SAMPLES, null],
  ['airToward’s rule, nothing cleared', SURFACE_SEGMENT_SAMPLES, 0],
  [
    'airToward’s rule, the beam cleared from orbit',
    SURFACE_SEGMENT_SAMPLES,
    ORBIT_AIRLIGHT,
  ],
] as const

describe('each split march', () => {
  it.each(CASES)(
    'equals marchAir over the same segment: %s',
    async (_, samples, clearBeam) => {
      for (const share of [0.15, 0.5, 1]) {
        const { worst, lit } = await compared(
          samples,
          clearBeam,
          share,
          marchAirTerms,
        )
        expect(worst, `share ${share}`).toBeLessThanOrEqual(SAME)
        // Most rays cross real air: a march of nothing agrees with anything.
        expect(lit, `share ${share}`).toBeGreaterThan((SIZE * SIZE) / 2)
      }
    },
  )

  it('equals marchAir with airMediumAt itself, which has air at sea level on Earth', async () => {
    const probe = await gpu.drawGraph(
      Fn(() => {
        const terms = airMediumAt(
          air,
          float(1e-4),
          float(0.5),
          phasesToward(vec3(0, 1, 0), SUN),
          vec3(1),
        )
        return vec4(terms.extinction, terms.single.y)
      })(),
      { float: true, width: 1, height: 1 },
    )
    const [extinction] = probe.at(0, 0)
    // A march of nothing agrees with anything.
    expect(extinction).toBeGreaterThan(0)
    for (const [, samples, clearBeam] of CASES) {
      const { worst } = await compared(samples, clearBeam, 0.5, airMediumAt)
      expect(worst).toBeLessThanOrEqual(SAME)
    }
  })
})

describe('the composite’s material', () => {
  /**
   * The composite as the system builds it, on stand-ins of every texture's
   * real format and kind, its fragment WGSL read with the scene pass's
   * layout bound.
   */
  async function fragment(
    which: 'passes' | 'split',
  ): Promise<{ readonly wgsl: string; dispose(): void }> {
    const layout = sceneLayout(DEFAULT_PICTURE, sceneBackend(gpu.renderer))
    const uniforms = createCloudUniforms()
    const history = {
      light: cloudStorageTexture(1, 1, 'rgba16float', 'history light'),
      air: cloudStorageTexture(1, 1, 'rgba16float', 'history air'),
      depth: cloudStorageTexture(1, 1, 'rgba16float', 'history depth'),
      extent: { width: 1, height: 1 },
    }
    const depth = new CloudDepth(uniforms, layout)
    const composite = new CloudComposite({
      uniforms,
      history: () => history,
      depth: () => depth.texture,
      far: CLOUD_STAND_INS.far(),
      phase: CLOUD_STAND_INS.phase(),
      frameNode: new CloudFrameNode({
        inFrame: false,
        placement: which,
        run() {},
      }),
    })
    composite.show(which)
    const mesh = which === 'passes' ? composite.passes : composite.split
    const camera = new PerspectiveCamera(60, 1, 0.05, 1e10)
    camera.layers.enableAll()
    camera.updateMatrixWorld()
    const scene = new Scene()
    scene.add(mesh)
    const renderer = gpu.renderer
    renderer.setRenderTarget(warmTargetFor(renderer, layout))
    renderer.setMRT(sensorMrt(layout))
    try {
      const { fragmentShader } = await gpu.shader(mesh, camera, scene)
      return {
        wgsl: fragmentShader,
        dispose() {
          composite.dispose()
          depth.dispose()
        },
      }
    } finally {
      renderer.setMRT(null)
      renderer.setRenderTarget(null)
    }
  }

  it.each(['split', 'passes'] as const)(
    'reads every texture at a named level or by load, in non-uniform control flow (%s)',
    async (which) => {
      const { wgsl, dispose } = await fragment(which)
      // The air's tables, through the class's branch.
      expect(wgsl).toMatch(/\btextureSampleLevel\(/)
      // The history and the depth copy.
      expect(wgsl).toMatch(/\btextureLoad\(/)
      expect(wgsl).not.toMatch(/\btextureSample\(/)
      // History 3, depth copy 1, both bodies' air 4, the far atlas 1: the
      // tenth, the phase, is the far field's own read once it is real.
      const bindings = wgsl.match(/:\s*texture_[a-z0-9_]+</g) ?? []
      expect(bindings.length).toBe(9)
      dispose()
    },
  )

  it('would show a plain read, so the assertion above can fail', async () => {
    const table = new DataTexture(
      new Uint16Array(4),
      1,
      1,
      RGBAFormat,
      HalfFloatType,
    )
    table.magFilter = LinearFilter
    table.minFilter = LinearFilter
    table.needsUpdate = true
    const material = new MeshBasicNodeMaterial()
    material.colorNode = texture(table).sample(uv()).rgb
    const mesh = new Mesh(new PlaneGeometry(2, 2), material)
    const camera = new PerspectiveCamera(60, 1, 0.05, 10)
    camera.position.z = 1
    camera.updateMatrixWorld()
    const scene = new Scene()
    scene.add(mesh)
    const target = new RenderTarget(4, 4, { depthBuffer: false })
    gpu.renderer.setRenderTarget(target)
    try {
      const { fragmentShader } = await gpu.shader(mesh, camera, scene)
      expect(fragmentShader).toMatch(/\btextureSample\(/)
    } finally {
      gpu.renderer.setRenderTarget(null)
      target.dispose()
      material.dispose()
    }
  })
})
