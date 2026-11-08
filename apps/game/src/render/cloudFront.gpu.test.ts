import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AdditiveBlending,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector4,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  length,
  positionView,
  screenUV,
  textureStore,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { ATMOSPHERE_GAIN } from '@inertialref/rendering'
import { cloudFront } from './cloudFront.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import { createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The plan's transparent object between two cloud layers (§5.12). The knots
 * are written as the trace records them for two resolved slabs along every
 * ray — entry and exit depths, and at each exit the cloud's transmittance
 * and its light so far — and two configurations of them are drawn: the near
 * slab lit and the far one dark, then the reverse. Between the slabs an
 * additive object and an alpha-blended one are drawn through real blending
 * over a frame that already holds the cloud's light; each pixel is held to
 * the analytic two-slab value, and the two configurations to the analytic
 * difference in light, which a transmittance-only curve scores as zero.
 *
 * The knots past the second are padding — T = 1 at depth 0 — so a reading
 * that took padding for a knot would put every object back in clear air.
 */

const SIZE = 32
const TRACE = 8
const FOV = 60
const HALF_TAN = Math.tan((FOV / 2) * (Math.PI / 180))

/** km along every ray. */
const NEAR = { entry: 2, exit: 3, through: 0.5 }
const FAR = { entry: 6, exit: 8, through: 0.25 }
/** A color for the cloud's light, so a channel crossed with another shows. */
const TINT = [1, 0.5, 0.25] as const
const BACKGROUND = 0.1
const ADDED = [0.2, 0.4, 0.6] as const
const PAINTED = [0.8, 0.6, 0.4] as const
const ALPHA = 0.5
/** The knots are half floats: 2⁻¹¹ relative, and §5.12's bound is 2%. */
const WITHIN = 0.02

/** (T, L) at each knot's exit, for the slabs' own light scales. */
function knots(scaleNear: number, scaleFar: number) {
  const nearLight = scaleNear * (1 - NEAR.through)
  const first = { through: NEAR.through, light: nearLight }
  const second = {
    through: NEAR.through * FAR.through,
    light: nearLight + NEAR.through * scaleFar * (1 - FAR.through),
  }
  return { first, second }
}

/** What the knots put in front of a point `km` along the ray: §5.12's rule, analytically. */
function front(km: number, scaleNear: number, scaleFar: number) {
  const { first, second } = knots(scaleNear, scaleFar)
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f
  const share = (slab: typeof NEAR) =>
    Math.min(Math.max((km - slab.entry) / (slab.exit - slab.entry), 0), 1)
  const f1 = share(NEAR)
  const f2 = share(FAR)
  const through1 = lerp(1, first.through, f1)
  const light1 = lerp(0, first.light, f1)
  return {
    through: lerp(through1, second.through, f2),
    light: lerp(light1, second.light, f2),
  }
}

let gpu: GpuSession
const uniforms = createCloudUniforms()
const textures: CloudTraceTextures = {
  light: cloudStorageTexture(1, 1, 'rgba16float', 'trace light'),
  aux: cloudStorageTexture(1, 1, 'rgba16float', 'trace aux'),
  knotDepth: cloudStorageTexture(2 * TRACE, TRACE, 'rgba16float', 'knot depth'),
  knotLight: cloudStorageTexture(
    2 * TRACE,
    2 * TRACE,
    'rgba16float',
    'knot light',
  ),
  extent: { width: TRACE, height: TRACE },
}
const trace = () => textures

/** The knots' values, written by one kernel for every configuration. */
const written = {
  first: uniform(new Vector4()),
  second: uniform(new Vector4()),
  /** Times (i + 100·j)/1000, added to texel (i, j)'s light.x: the addressing check's code. */
  code: uniform(0),
}

const writer = Fn(() => {
  If(instanceIndex.lessThan(uint(TRACE * TRACE)), () => {
    const i = int(instanceIndex.mod(uint(TRACE)))
    const j = int(instanceIndex.div(uint(TRACE)))
    const tint = vec3(...TINT)
    const code = float(i).add(float(j).mul(100)).div(1000).mul(written.code)
    textureStore(
      textures.knotDepth,
      ivec2(i.mul(int(2)), j),
      vec4(NEAR.entry, NEAR.exit, FAR.entry, FAR.exit),
    )
    // Padding: depth 0, T = 1.
    textureStore(
      textures.knotDepth,
      ivec2(i.mul(int(2)).add(int(1)), j),
      vec4(0),
    )
    // The code rides in the light so far, so the second knot carries it too.
    const coded = vec3(code, 0, 0)
    const knotsAt = [
      vec4(tint.mul(written.first.y).add(coded), written.first.x),
      vec4(tint.mul(written.second.y).add(coded), written.second.x),
      vec4(0, 0, 0, 1),
      vec4(0, 0, 0, 1),
    ]
    knotsAt.forEach((value, k) => {
      textureStore(
        textures.knotLight,
        ivec2(i.mul(int(2)).add(int(k & 1)), j.mul(int(2)).add(int(k >> 1))),
        value,
      )
    })
  })
})().compute(TRACE * TRACE)

async function writeKnots(
  scaleNear: number,
  scaleFar: number,
  code = 0,
): Promise<void> {
  const { first, second } = knots(scaleNear, scaleFar)
  written.first.value.set(first.through, first.light, 0, 0)
  written.second.value.set(second.through, second.light, 0, 0)
  written.code.value = code
  await gpu.compute(writer)
}

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  uniforms.trace.size.value.set(TRACE, TRACE)
})

afterAll(() => {
  gpu.dispose()
})

/** The fragment's image point, y up, as the trace's texels are addressed. */
const fragmentScreen = (): Node<'vec2'> =>
  vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)))

/** A plane facing the camera `depth` meters down its axis, over the image rectangle [x0, x1] × [y0, y1], y up. */
function facing(
  depth: number,
  [x0, x1, y0, y1]: readonly [number, number, number, number],
  material: MeshBasicNodeMaterial,
): Mesh {
  const scale = depth * HALF_TAN
  const mesh = new Mesh(
    new PlaneGeometry((x1 - x0) * scale, (y1 - y0) * scale),
    material,
  )
  mesh.position.set(((x0 + x1) / 2) * scale, ((y0 + y1) / 2) * scale, -depth)
  return mesh
}

/** The objects at `depth` meters down the axis: additive over the left half, alpha over the right. */
function objectsAt(depth: number): Scene {
  const seen = () =>
    cloudFront(trace, uniforms, fragmentScreen(), length(positionView))
  const background = new MeshBasicNodeMaterial()
  background.colorNode = vec3(BACKGROUND)
  const additive = new MeshBasicNodeMaterial()
  additive.transparent = true
  additive.blending = AdditiveBlending
  additive.depthWrite = false
  additive.colorNode = vec3(...ADDED).mul(seen().transmittance)
  const alpha = new MeshBasicNodeMaterial()
  alpha.transparent = true
  alpha.blending = NormalBlending
  alpha.depthWrite = false
  const { transmittance, light } = seen()
  alpha.colorNode = vec3(...PAINTED)
    .mul(transmittance)
    .add(light)
  alpha.opacityNode = float(ALPHA)
  const scene = new Scene()
  scene.add(
    facing(20_000, [-1.5, 1.5, -1.5, 1.5], background),
    facing(depth, [-1.5, 0, -1.5, 1.5], additive),
    facing(depth, [0, 1.5, -1.5, 1.5], alpha),
  )
  scene.updateMatrixWorld(true)
  return scene
}

/** km along the ray through pixel (x, y)'s center to a plane `depth` meters down the axis. */
function kilometersAt(depth: number, x: number, y: number): number {
  const sx = ((2 * (x + 0.5)) / SIZE - 1) * HALF_TAN
  const sy = (1 - (2 * (y + 0.5)) / SIZE) * HALF_TAN
  return (depth * Math.hypot(1, sx, sy)) / 1000
}

/** Every pixel against the analytic two-slab value; the readback for the difference test. */
async function drawnAgainstAnalytic(
  depth: number,
  scaleNear: number,
  scaleFar: number,
) {
  await writeKnots(scaleNear, scaleFar)
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 1e8)
  camera.updateMatrixWorld()
  const pixels = await gpu.draw(objectsAt(depth), camera, { float: true })
  // Columns clear of the halves' seam, which crosses columns 15 and 16.
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) {
      if (x === 15 || x === 16) continue
      const { through, light } = front(
        kilometersAt(depth, x, y),
        scaleNear,
        scaleFar,
      )
      const got = pixels.at(x, y)
      for (let c = 0; c < 3; c += 1) {
        const expected =
          x < SIZE / 2
            ? BACKGROUND + through * ADDED[c]!
            : ALPHA *
                (through * PAINTED[c]! + light * TINT[c]! * ATMOSPHERE_GAIN) +
              (1 - ALPHA) * BACKGROUND
        expect(
          Math.abs(got[c]! - expected),
          `(${x}, ${y}) channel ${c}: ${got[c]} against ${expected}`,
        ).toBeLessThanOrEqual(WITHIN * Math.max(expected, BACKGROUND))
      }
    }
  return pixels
}

describe('a transparent object between two cloud layers', () => {
  it('sees the near layer lit in front of it and the far one dark behind', async () => {
    await drawnAgainstAnalytic(4_000, 1, 0)
  })

  it('sees the near layer dark in front of it and the far one lit behind', async () => {
    await drawnAgainstAnalytic(4_000, 0, 1)
  })

  it('differs between the two by the analytic light in front of it', async () => {
    const lit = await drawnAgainstAnalytic(4_000, 1, 0)
    const dark = await drawnAgainstAnalytic(4_000, 0, 1)
    // The alpha object's half: the near layer's own light, its alpha's share.
    const expected = ALPHA * (1 - NEAR.through) * ATMOSPHERE_GAIN
    for (const [x, y] of [
      [20, 4],
      [28, 16],
      [24, 30],
    ] as const) {
      const difference = lit.at(x, y)[0] - dark.at(x, y)[0]
      expect(Math.abs(difference - expected)).toBeLessThanOrEqual(
        WITHIN * expected,
      )
    }
    // The additive half sees the same transmittance in both: no light of
    // its own in front, which is the case a light curve cannot be read from.
    expect(Math.abs(lit.at(4, 16)[0] - dark.at(4, 16)[0])).toBeLessThan(1e-3)
  })

  it.each([
    ['in front of both layers', 1_000],
    ['inside the far layer, attenuated linearly through it', 5_600],
    ['behind both layers', 9_000],
  ] as const)('holds an object %s to the analytic value', async (_, depth) => {
    await drawnAgainstAnalytic(depth, 1, 1)
  })
})

describe('the knot lookup', () => {
  it('reads the trace texel nearest the object’s pixel, row 0 at the top', async () => {
    // Every texel's knots carry its own code in their light, the layers
    // themselves unlit; an object far behind both reads the code of the
    // texel it was looked up at.
    await writeKnots(0, 0, 1)
    const pixels = await gpu.drawGraph(
      cloudFront(trace, uniforms, uv().mul(2).sub(1), float(50_000)).light.div(
        ATMOSPHERE_GAIN,
      ),
      { float: true, width: TRACE, height: TRACE },
    )
    for (let j = 0; j < TRACE; j += 1)
      for (let i = 0; i < TRACE; i += 1) {
        const code = (i + 100 * j) / 1000
        const red = pixels.at(i, j)[0]
        expect(
          Math.abs(red - code),
          `texel (${i}, ${j}): ${red}`,
        ).toBeLessThanOrEqual(code * 2 ** -10 + 1e-6)
      }
  })
})
