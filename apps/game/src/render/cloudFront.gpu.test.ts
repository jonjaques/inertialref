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
import {
  ATMOSPHERE_GAIN,
  scenarioCoverage,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import { Quaternion as Q, type Vec3, Vec } from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { cloudFront, cloudFrontThrough } from './cloudFront.ts'
import { KNOT_TRANSMITTANCE } from './cloudKnots.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  depthTexture,
  lookUp,
  marchLight,
  NO_BUDGET,
  placeBody,
  readTexels,
  sizeTrace,
  SKY_KM,
  testSun,
  traceFrame,
} from './cloudMarchRig.ts'
import {
  CLOUD_STAND_INS,
  cloudStorageTexture,
  slabMedium,
} from './cloudNodes.ts'
import {
  RIG_EARTH_RADIUS,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import { createCloudFrontHandle } from './cloudSystem.ts'
import { CloudTrace, type CloudTraceTextures } from './cloudTrace.ts'
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

describe('the front handle, as the materials drawn over the clouds read it', () => {
  /*
   * A material is built before the first cloud frame, so its texture nodes
   * compile against the handle's stand-in and are pointed at the trace by
   * the follower when the system takes the handle. These hold the swap both
   * ways on one program, through the trace textures the system writes:
   * clear air before, the knots the bare `cloudFront` reads once it follows,
   * and clear air again after a frame with no clouds.
   */
  const handle = createCloudFrontHandle()
  const seen = cloudFrontThrough(handle, float(4_000))
  const direct = cloudFront(trace, uniforms, fragmentScreen(), float(4_000))
  const packed = (front: typeof seen) =>
    vec4(front.transmittance, front.light.div(ATMOSPHERE_GAIN).x, 0, 1)
  const graph = packed(seen)

  it('reads clear air before the handle follows a trace', async () => {
    await writeKnots(1, 0)
    handle.follow(null)
    const pixels = await gpu.drawGraph(graph, { float: true })
    for (const [x, y] of [
      [0, 0],
      [16, 16],
      [31, 31],
    ] as const) {
      expect(pixels.at(x, y)[0]).toBe(1)
      expect(pixels.at(x, y)[1]).toBe(0)
    }
  })

  it('reads what `cloudFront` reads once it follows one, and clear air again after', async () => {
    await writeKnots(1, 0)
    handle.screen.traceSize.value.set(TRACE, TRACE)
    handle.follow(trace)
    const through = await gpu.drawGraph(graph, { float: true })
    const bare = await gpu.drawGraph(packed(direct), { float: true })
    const { through: expected } = front(4, 1, 0)
    for (let y = 0; y < SIZE; y += 1)
      for (let x = 0; x < SIZE; x += 1) {
        expect(through.at(x, y)[0]).toBe(bare.at(x, y)[0])
        expect(through.at(x, y)[1]).toBe(bare.at(x, y)[1])
      }
    // Not a vacuous equality: the point is behind the lit near layer.
    expect(Math.abs(through.at(16, 16)[0] - expected)).toBeLessThan(
      WITHIN * expected,
    )
    expect(through.at(16, 16)[1]).toBeGreaterThan(0.1)
    handle.follow(null)
    const after = await gpu.drawGraph(graph, { float: true })
    expect(after.at(16, 16)[0]).toBe(1)
    expect(after.at(16, 16)[1]).toBe(0)
  })
})

/* ------------------------------------------------------------------------- */
/* The knots the trace records                                                */
/* ------------------------------------------------------------------------- */

/*
 * `cloudFront` over knots the trace wrote, where the cases above write their
 * own: a knot is one crossing of a level (phase 1 design §4.9), so between
 * two layers the reader is flat at the nearer layer's transmittance, behind
 * a layer thin in every column it is that layer's and not one, and at the
 * ray's end it is the trace's own (T, L).
 *
 * The two-layer cases are on the real field, under cirrus over cumulus,
 * looking 30° over the horizon: slabs have one crossing a level and no
 * column to end, so every definition of a knot agrees on them.
 */

/** What `cloudFront` puts in front of a point `meters` along every trace texel's ray: (L per unit sun, T). */
async function frontAt(
  outputs: () => CloudTraceTextures,
  over: ReturnType<typeof createCloudUniforms>,
  meters: number,
) {
  const { x: width, y: height } = over.trace.size.value
  const seen = cloudFront(outputs, over, uv().mul(2).sub(1), float(meters))
  const pixels = await gpu.drawGraph(vec4(seen.light, seen.transmittance), {
    float: true,
    width,
    height,
  })
  const { r, g, b } = over.served.dayColor.value
  const scale = [r, g, b].map((c) => c * ATMOSPHERE_GAIN)
  return (i: number, j: number): [number, number, number, number] => {
    const [lr, lg, lb, t] = pixels.at(i, j)
    return [lr / scale[0]!, lg / scale[1]!, lb / scale[2]!, t]
  }
}

describe('a point behind a layer thin in every column', () => {
  /** The trace over a layer of vertical depth `depth`, and `cloudFront` behind and before it. */
  async function thinLayer(depth: number) {
    const over = createCloudUniforms()
    placeBody(over, { eye: 0, layers: [[1000, 1400]] })
    lookUp(over, 0.5)
    sizeTrace(over, TRACE, TRACE)
    const copy = depthTexture(4 * TRACE, 4 * TRACE, () => SKY_KM)
    const field = CLOUD_STAND_INS.field(
      slabMedium([{ base: 1000, top: 1400, sigma: depth / 400 }]),
    )
    const thin = new CloudTrace({
      uniforms: over,
      medium: field,
      sun: testSun(field, CLOUD_STAND_INS.sunDepth()),
      phase: CLOUD_STAND_INS.phase(),
      far: CLOUD_STAND_INS.far(),
      depth: () => copy,
      ...marchLight(over),
    })
    await thin.warm(gpu.renderer)
    const frame = traceFrame({ width: TRACE, height: TRACE })
    thin.render(gpu.renderer, frame, NO_BUDGET)
    const found = {
      marched: await readTexels(gpu, thin.outputs.light, TRACE, TRACE),
      behind: await frontAt(() => thin.outputs, over, 20_000),
      before: await frontAt(() => thin.outputs, over, 500),
    }
    thin.dispose()
    copy.dispose()
    over.dispose()
    return found
  }

  it('reads the layer’s transmittance within 0.01 of the march’s, and not one', async () => {
    const { marched, behind, before } = await thinLayer(0.1)
    for (let j = 0; j < TRACE; j += 1)
      for (let i = 0; i < TRACE; i += 1) {
        const through = marched(i, j)[3]
        // A depth of 0.1 up the vertical, 0.11 at the image's corner.
        expect(through).toBeLessThan(0.91)
        expect(Math.abs(behind(i, j)[3] - through)).toBeLessThan(0.01)
        expect(before(i, j)[3]).toBe(1)
      }
  }, 60_000)

  it('reads a knot recorded just under the trace’s own threshold, which half a percent of headroom would take for padding', async () => {
    /*
     * The trace records a crossing that passes under `KNOT_TRANSMITTANCE`,
     * and the reader tells a recorded knot from padding by its
     * transmittance. A layer that passes 99.85% is recorded: read with a
     * threshold of 0.995, an object behind it stands in clear air.
     */
    const { marched, behind } = await thinLayer(0.0015)
    for (let j = 0; j < TRACE; j += 1)
      for (let i = 0; i < TRACE; i += 1) {
        const through = marched(i, j)[3]
        expect(through).toBeLessThan(KNOT_TRANSMITTANCE)
        expect(through).toBeGreaterThan(0.995)
        expect(behind(i, j)[3]).toBe(through)
      }
  }, 60_000)
})

describe('on the real field, under cirrus over cumulus, looking up 30°', () => {
  const SCENARIO = 'cirrus-over-cumulus'
  const CSS = { width: 256, height: 144 } as const
  const [W, H] = [CSS.width / 4, CSS.height / 4]
  const R = RIG_EARTH_RADIUS
  const EYE = 2
  /** The camera's −Z turned 30° up about +X. */
  const LOOKING = Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 6)
  const cumulus = WEATHER_SCENARIOS[SCENARIO].layers[0]!
  const cirrus = WEATHER_SCENARIOS[SCENARIO].layers[1]!
  /** Meters the gap's edges are stood off by: a ray's own jitter inside its pixel moves its height by tens of meters. */
  const MARGIN = 300
  /** Meters along a ray the point in the gap is tried at. */
  const DISTANCES = [8000, 11_000, 14_000]

  let field: CloudField
  let levers: CloudLevers
  let previous: CloudFrame | null = null

  beforeAll(async () => {
    field = createCloudField()
    for (const bake of field.bakes) await bake.warm(gpu.renderer)
    // A budget no ray's floor reaches: a march stopped at a point and one
    // that runs on then take the same steps as far as the point, and differ
    // there by the one step the point cuts.
    levers = {
      ...DEFAULT_CLOUD_LEVERS,
      on: true,
      weather: SCENARIO,
      maxSteps: 4096,
    }
  }, 120_000)

  afterAll(() => {
    field?.dispose()
  })

  /** A frame of the field at a stance, as the system builds and bakes one. */
  function frameAt(stance: RigStance): CloudFrame {
    const frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
    if (frame === null) throw new Error('no frame: nothing served')
    previous = frame
    field.write(frame)
    field.render(gpu.renderer, frame, {
      slices: levers.sunSlices,
      tiles: 1,
      jump: frame.jump,
      sunSlices: levers.sunSlices,
    })
    return frame
  }

  /** Frames until every bake has rested eight in a row with nothing owed. */
  function settled(stance: RigStance): CloudFrame {
    let frame = frameAt(stance)
    // The maps' own frames first: the cube's faces, then the clipmap's levels.
    for (let n = 0; n < 64; n += 1) frame = frameAt(stance)
    for (let n = 0, rest = 0; n < 400 && rest < 8; n += 1) {
      frame = frameAt(stance)
      rest = field.bakes.some((bake) => bake.pending) ? 0 : rest + 1
    }
    return frame
  }

  /** A body-fixed direction the regime's two layers both hold their mean cover over, the n-th a seed draws between 60° S and 60° N. */
  function places(): Vec3[] {
    const { terminator: _, ...pattern } = WEATHER_SCENARIOS[SCENARIO]
    let state = 0x5eed
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 2 ** 32
    }
    const found: Vec3[] = []
    for (let n = 0; n < 100_000 && found.length < 6; n += 1) {
      const y = (2 * next() - 1) * Math.sin(Math.PI / 3)
      const longitude = 2 * Math.PI * next()
      const ring = Math.sqrt(1 - y * y)
      const d = {
        x: Math.cos(longitude) * ring,
        y,
        z: Math.sin(longitude) * ring,
      }
      const held = pattern.layers.every(
        (layer, k) =>
          scenarioCoverage(pattern, k, d, 50_000) >= layer.coverage - 1e-9,
      )
      if (held) found.push(d)
    }
    return found
  }

  /** The turn that carries a body-fixed direction onto the render's +Y, over which the rig's eye stands. */
  function turnOnto(direction: Vec3) {
    const up = { x: 0, y: 1, z: 0 }
    const axis = Vec.cross(direction, up)
    const sine = Vec.length(axis)
    return sine < 1e-12
      ? Q.IDENTITY
      : Q.fromAxisAngle(
          Vec.scale(axis, 1 / sine),
          Math.atan2(sine, Vec.dot(direction, up)),
        )
  }

  /** Height over the datum `meters` along the ray through trace texel (i, j)'s center. */
  function heightAlong(
    frame: CloudFrame,
    i: number,
    j: number,
    meters: number,
  ) {
    const { right, up, forward, halfTan, aspect } = frame.camera
    const x = ((2 * (i + 0.5)) / W - 1) * halfTan * aspect
    const y = (1 - (2 * (j + 0.5)) / H) * halfTan
    const ray = Vec.normalize(
      Vec.add(forward, Vec.add(Vec.scale(right, x), Vec.scale(up, y))),
    )
    const mu = Vec.dot(ray, Vec.normalize(frame.served.eye))
    const re = R + EYE
    return Math.sqrt(re * re + meters * meters + 2 * re * meters * mu) - R
  }

  /** A trace of the field with the scene `km` along every ray, and its outputs. */
  async function traced(frame: CloudFrame, km: number) {
    const depth = depthTexture(CSS.width, CSS.height, () => km)
    const trace = new CloudTrace({
      uniforms: field.uniforms,
      medium: field.medium,
      sun: field.sun,
      phase: field.phase,
      far: field.farAtlas.far,
      depth: () => depth,
      sky: field.sky,
      source: field.source,
      jitter: field.jitter,
    })
    await trace.warm(gpu.renderer)
    trace.render(gpu.renderer, frame, NO_BUDGET)
    const light = await readTexels(gpu, trace.outputs.light, W, H)
    return {
      trace,
      light,
      dispose() {
        trace.dispose()
        depth.dispose()
      },
    }
  }

  it('reads the cumulus’s transmittance at a point in the gap within 2% of a march stopped there, and the trace’s own (T, L) at the ray’s end within 1%', async () => {
    let gap = 0
    let behindCirrus = 0
    let ends = 0
    for (const place of places()) {
      const stance: RigStance = {
        eye: EYE,
        looking: LOOKING,
        turn: turnOnto(place),
        sun: { x: 0.3, y: 0.8, z: -0.5 },
      }
      const frame = settled(stance)
      const open = await traced(frame, SKY_KM)
      const whole = await frontAt(() => open.trace.outputs, field.uniforms, 5e7)
      /*
       * The trace's own (T, L). A crossing that passes over 99.9% records
       * no knot, so up to a thousandth of opacity a crossing, and its
       * light, stand in no knot: the light is held to 1% of the frame's
       * brightest texel, which is what a hundredth of the picture is.
       */
      let brightest = 0
      for (let j = 0; j < H; j += 1)
        for (let i = 0; i < W; i += 1)
          brightest = Math.max(brightest, ...open.light(i, j).slice(0, 3))
      expect(brightest).toBeGreaterThan(0)
      for (let j = 0; j < H; j += 1)
        for (let i = 0; i < W; i += 1) {
          const [r, g, b, through] = open.light(i, j)
          const seen = whole(i, j)
          expect(Math.abs(seen[3] - through)).toBeLessThan(0.01)
          for (const [c, band] of [r, g, b].entries())
            expect(
              Math.abs(seen[c]! - band),
              `texel (${i}, ${j}): ${seen[c]} against ${band} of ${brightest}`,
            ).toBeLessThanOrEqual(0.01 * Math.max(band, brightest))
          if (through < 0.98) ends += 1
        }
      for (const meters of DISTANCES) {
        const stopped = await traced(frame, meters / 1000)
        const front = await frontAt(
          () => open.trace.outputs,
          field.uniforms,
          meters,
        )
        for (let j = 0; j < H; j += 1)
          for (let i = 0; i < W; i += 1) {
            const height = heightAlong(frame, i, j, meters)
            const inGap =
              height > cumulus.top + MARGIN && height < cirrus.base - MARGIN
            const marched = stopped.light(i, j)[3]
            if (!inGap || marched > 0.98) continue
            gap += 1
            if (open.light(i, j)[3] < marched - 0.02) behindCirrus += 1
            expect(
              Math.abs(front(i, j)[3] - marched),
              `texel (${i}, ${j}) at ${meters} m, ${height.toFixed(0)} m up`,
            ).toBeLessThanOrEqual(0.02 * Math.max(marched, 0.05))
          }
        stopped.dispose()
      }
      open.dispose()
      if (gap >= 200 && behindCirrus >= 50) break
    }
    // The controls: points in the gap behind cumulus, some of them with
    // cirrus past them that a knot of columns would have shared out, and
    // rays that end in cloud.
    expect(gap).toBeGreaterThanOrEqual(200)
    expect(behindCirrus).toBeGreaterThanOrEqual(50)
    expect(ends).toBeGreaterThanOrEqual(200)
  }, 300_000)
})
