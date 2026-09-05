import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
} from 'three/webgpu'
import {
  acos,
  atan,
  Break,
  clamp,
  Continue,
  cos,
  dot,
  exp2,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  ivec3,
  length,
  Loop,
  max,
  min,
  normalize,
  pow,
  round,
  saturate,
  sqrt,
  storage,
  uint,
  uniform,
  uvec2,
  vec3,
  vec4,
  wgslFn,
} from 'three/tsl'
import { DEFAULT_FBM } from '@inertialref/procedural'
import { maxInt } from './noiseNodes.ts'
import {
  ARC_MARGIN,
  ARC_SHAPE,
  BARE_COVER,
  BELT_MARGIN,
  BELT_SHAPE,
  BIOTA_WINDOW,
  CHAOS_SHAPE,
  COAST_SHAPE,
  COVER_SHAPE,
  COVER_WORDS,
  CRATER_SHAPE,
  DRAINAGE_SHAPE,
  DUNE_SHAPE,
  EJECTA_REACH,
  FROST_POINT,
  GATE_HI,
  GATE_LO,
  GRIT_FRAMES_AT,
  GRIT_OCTAVES,
  heightfieldStride,
  HOTSPOT_STRIDE,
  HOTSPOTS_AT,
  HYPSOMETRY_MARGIN,
  HYPSOMETRY_SHAPE,
  KERNEL_RECORDS,
  KERNEL_WORDS,
  LEVEL_DRAW_AT,
  LEVEL_STRIDE,
  LEVELS_AT,
  MARE_CYCLES,
  MINERAL_CYCLES,
  packCover,
  PLATE_MARGIN,
  PLATE_STRIDE,
  PLATES_AT,
  RAY_AGE,
  RAY_HARMONICS,
  RAY_ONSET,
  RAY_REACH,
  RAY_SHAPE,
  RAY_STRIDE,
  RAYS_AT,
  RELIEF_SHAPE,
  RIM_INNER,
  RIM_OUTER,
  SCALAR,
  SCALARS_AT,
  SHIELD_SHAPE,
  SLAB_AT,
  type StageId,
  stageOf,
  STRIPE_SHAPE,
  STRIPE_STRIDE,
  STRIPES_AT,
  SULCI_SHAPE,
  TILE_STRIDE,
  tileSamples,
  WORD,
} from '@inertialref/universe'

/*
 * The band stack, on the GPU.
 *
 * One invocation per bordered sample of a tile: the sample's direction, then
 * every band `evaluate` in `packages/universe/src/terrain.ts` sums — the plate
 * context, hypsometry, belts, volcanism, relief, ice, the crater ladder folded
 * through its soft ceiling, the presentational tail, the sea clamp — and, for
 * an interior sample, the four bytes of cover beside it. It reads what
 * `surfaceKernel` packed and writes what `generateHeightfield` returns, so the
 * producer around it hands the streamer the same `HeightfieldResponse` a
 * worker does. `terrainKernel.gpu.test.ts` holds the two to a stated
 * tolerance, body by body and level by level.
 *
 * **This is a port, and it is held rather than trusted.** Every number here is
 * imported from the module that spends it on the CPU — `HYPSOMETRY_SHAPE`,
 * `CRATER_SHAPE`, `COVER_SHAPE` and the rest — so there is no second copy of
 * `9` or `11.3` to drift. The structure around the bands is shared the same
 * way: which stage runs, in what order, behind which gate is `BAND_STACK` in
 * `packages/universe/src/bandStack.ts`, and every gate below is built from the
 * packed slot that table names beside the body's own spelling of it, so a
 * gate that moves in `evaluate` fails `bandStack.test.ts` in Node before it
 * reaches an adapter. What is left to drift is a band's own arithmetic — a
 * term gained, a shape misread — and the tolerance test is what notices that,
 * because nothing mechanical relates a TSL graph to a TypeScript function.
 *
 * **Placement is integer and bit-identical; amplitude is float and bounded.**
 * That is the line `docs/adr/0023-the-gpu-producer.md` draws, and it is drawn
 * here in two ways. The hashes — `mix32`, `hash3`, `pcg4d` — are `u32` arithmetic that
 * wraps exactly as `Math.imul` and `>>> 0` do, so which crater a cell holds
 * and which corner gradient a lattice point gets are the same bits on every
 * device. And every *decision* a hash feeds is taken in integers: a crater
 * exists when its draw is under a `u32` threshold the CPU computes from the
 * level's density (`LEVEL_DRAW_AT`), a complex crater has a peak when its draw
 * is under `PEAK_DRAW` — never `toUnit(draw) < density` in float32, where a
 * rounding would put one crater in ten million on one side of the line here
 * and the other there.
 *
 * **Fine lattice coordinates are never taken from an absolute direction.** A
 * float32 unit vector resolves 6e-8 of a radian, and the tail's finest rung is
 * a one-meter crater on a 1,700 km body — 3e-7. So each crater rung and each
 * grit octave reads its tile's *frame*: the cell the patch center falls in and
 * the fraction beside it, both from float64 (`writeTileFrame`), and adds only
 * `delta`, the sample's offset from that center. `delta` is exact to the
 * precision of the face coordinates, which are exact, because it is never a
 * difference of two unit vectors — `sampleOffset` has the arithmetic and
 * `terrainKernel.test.ts` holds it in float64. The coarse bands read `d`, an
 * absolute float32 direction, because at 1.6 to 5,000 cycles the same 6e-8 is
 * under a thousandth of a lattice cell.
 *
 * **The primitives are WGSL and the bands are TSL.** A hash is bit
 * manipulation and a noise octave is eight corner products; written as node
 * chains they are unreadable, and read beside `noise.ts` and `field.ts` they
 * are checkable line by line. The bands read buffers and branch on the body,
 * which is what TSL is for. `wgslFn` takes the code and `includes` takes the
 * dependencies; a function is called by the name in its declaration.
 *
 * **Every nested loop is named.** `Loop` calls a single-parameter loop's
 * variable `i` unless told otherwise, and a nested `Loop` declares its own `i`
 * in the inner scope — so the outer index, referenced inside, silently reads
 * the inner one. The crater walk is three loops deep with an early exit
 * between each pair.
 */

/* ------------------------------------------------------------------------- */
/* The WGSL primitives                                                        */
/* ------------------------------------------------------------------------- */

/*
 * Each is a port of the named CPU function and is meant to be read beside
 * it. Constants are interpolated from the exported names; a literal alone is
 * one the CPU spells the same way.
 */

/**
 * The functions a WGSL function calls, as `wgslFn`'s second argument.
 *
 * `nativeFn` unwraps the `functionNode` a callable carries, so passing the
 * callables is what the runtime expects; the typings ask for the node and do
 * not declare the property, which is what the cast is for.
 */
const uses = (...fns: readonly unknown[]): never[] => fns as never[]

const mix32Code = wgslFn(`
  fn mix32(value: u32) -> u32 {
    // hash.ts \`mix32\`: the MurmurHash3 finalizer over u32, which wraps as
    // \`Math.imul\` does.
    var h = value;
    h ^= h >> 16u;
    h *= 0x85ebca6bu;
    h ^= h >> 13u;
    h *= 0xc2b2ae35u;
    h ^= h >> 16u;
    return h;
  }
`)

const hash3Code = wgslFn(
  `
  fn hash3(a: u32, b: u32, c: u32) -> u32 {
    // hash.ts \`hash3\`.
    return mix32((a * 0x9e3779b1u) ^ (b * 0x85ebca6bu) ^ (c * 0xc2b2ae35u));
  }
`,
  uses(mix32Code),
)

const pcg4dCode = wgslFn(`
  fn pcg4d(x: u32, y: u32, z: u32, w: u32) -> vec4<u32> {
    // lattice.ts \`pcg4d\`: Jarzynski & Olano, in the same lane order.
    var v = vec4<u32>(x, y, z, w) * 1664525u + 1013904223u;
    v.x += v.y * v.w;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v.w += v.y * v.z;
    v ^= v >> vec4<u32>(16u);
    v.x += v.y * v.w;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v.w += v.y * v.z;
    return v;
  }
`)

const toUnitCode = wgslFn(`
  fn toUnit(value: u32) -> f32 {
    // lattice.ts \`toUnit\`. Where a hash becomes a float — and never where a
    // decision is taken; see LEVEL_DRAW_AT and PEAK_DRAW.
    return f32(value) / 4294967296.0;
  }
`)

const smoothstepCode = wgslFn(`
  fn smoothstepf(edge0: f32, edge1: f32, x: f32) -> f32 {
    // profile.ts \`smoothstep\`, with its own equal-edge case: WGSL's builtin
    // leaves \`low == high\` unspecified, and the cover calls this with the
    // edges the wrong way round on purpose.
    if (edge0 == edge1) {
      return select(1.0, 0.0, x < edge0);
    }
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
`)

const falloffCode = wgslFn(`
  fn falloff(t: f32) -> f32 {
    // profile.ts \`falloff\`: \`(1 - t²)²\`, flat at both ends.
    if (t >= 1.0) {
      return 0.0;
    }
    let s = 1.0 - t * t;
    return s * s;
  }
`)

const ringCode = wgslFn(
  `
  fn ring(t: f32, peak: f32) -> f32 {
    // profile.ts \`ring\`: 0 at the center, 1 at \`peak\`, 0 at 1.
    if (t <= 0.0 || t >= 1.0) {
      return 0.0;
    }
    if (t < peak) {
      return smoothstepf(0.0, peak, t);
    }
    return 1.0 - smoothstepf(peak, 1.0, t);
  }
`,
  uses(smoothstepCode),
)

const gradientOfCode = wgslFn(`
  fn gradientOf(g: u32) -> vec3<f32> {
    // noise.ts: the twelve cube-edge gradients, in the same order, picked by
    // the hash's residue.
    var gx = array<f32, 12>(1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 0.0, 0.0, 0.0, 0.0);
    var gy = array<f32, 12>(1.0, 1.0, -1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0, -1.0, 1.0, -1.0);
    var gz = array<f32, 12>(0.0, 0.0, 0.0, 0.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0);
    return vec3<f32>(gx[g], gy[g], gz[g]);
  }
`)

const fadeCode = wgslFn(`
  fn fade(t: f32) -> f32 {
    // noise.ts \`fade\`: the quintic.
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }
`)

const fadeSlopeCode = wgslFn(`
  fn fadeSlope(t: f32) -> f32 {
    // field.ts \`fadeSlope\`: \`30 t²(t − 1)²\`.
    return 30.0 * t * t * (t * (t - 2.0) + 1.0);
  }
`)

const noise3AtCode = wgslFn(
  `
  fn noise3At(seed: u32, cell: vec3<i32>, f: vec3<f32>) -> f32 {
    // noise.ts \`noise3\`, given its lattice cell and fraction rather than a
    // coordinate: the split is what lets the grit hand it a cell from a float64
    // frame. The seed is folded into each corner's own x, as \`gradientDot\`
    // folds it — \`(ix + 1) ^ seed\`, not \`(ix ^ seed) + 1\`.
    let x0 = u32(cell.x) ^ seed;
    let x1 = u32(cell.x + 1) ^ seed;
    let y0 = u32(cell.y);
    let y1 = u32(cell.y + 1);
    let z0 = u32(cell.z);
    let z1 = u32(cell.z + 1);
    let u = fade(f.x);
    let v = fade(f.y);
    let w = fade(f.z);
    let x1f = f.x - 1.0;
    let y1f = f.y - 1.0;
    let z1f = f.z - 1.0;
    let n000 = dot(gradientOf(hash3(x0, y0, z0) % 12u), vec3<f32>(f.x, f.y, f.z));
    let n100 = dot(gradientOf(hash3(x1, y0, z0) % 12u), vec3<f32>(x1f, f.y, f.z));
    let n010 = dot(gradientOf(hash3(x0, y1, z0) % 12u), vec3<f32>(f.x, y1f, f.z));
    let n110 = dot(gradientOf(hash3(x1, y1, z0) % 12u), vec3<f32>(x1f, y1f, f.z));
    let n001 = dot(gradientOf(hash3(x0, y0, z1) % 12u), vec3<f32>(f.x, f.y, z1f));
    let n101 = dot(gradientOf(hash3(x1, y0, z1) % 12u), vec3<f32>(x1f, f.y, z1f));
    let n011 = dot(gradientOf(hash3(x0, y1, z1) % 12u), vec3<f32>(f.x, y1f, z1f));
    let n111 = dot(gradientOf(hash3(x1, y1, z1) % 12u), vec3<f32>(x1f, y1f, z1f));
    return mix(
      mix(mix(n000, n100, u), mix(n010, n110, u), v),
      mix(mix(n001, n101, u), mix(n011, n111, u), v),
      w
    );
  }
`,
  uses(fadeCode, gradientOfCode, hash3Code),
)

const noise3Code = wgslFn(
  `
  fn noise3(seed: u32, p: vec3<f32>) -> f32 {
    // noise.ts \`noise3\` over a coordinate: \`Math.floor\` and the fraction.
    let cell = floor(p);
    return noise3At(seed, vec3<i32>(cell), p - cell);
  }
`,
  uses(noise3AtCode),
)

const gradientNoiseCode = wgslFn(
  `
  fn gradientNoise3(seed: u32, p: vec3<f32>) -> vec4<f32> {
    // field.ts \`gradientNoise3\`: the value and its gradient in the factored
    // trilinear form, as (value, dx, dy, dz).
    let cell = floor(p);
    let f = p - cell;
    let c = vec3<i32>(cell);
    let x0 = u32(c.x) ^ seed;
    let x1 = u32(c.x + 1) ^ seed;
    let y0 = u32(c.y);
    let y1 = u32(c.y + 1);
    let z0 = u32(c.z);
    let z1 = u32(c.z + 1);
    let u = fade(f.x);
    let v = fade(f.y);
    let w = fade(f.z);
    let du = fadeSlope(f.x);
    let dv = fadeSlope(f.y);
    let dw = fadeSlope(f.z);
    let g000 = gradientOf(hash3(x0, y0, z0) % 12u);
    let g100 = gradientOf(hash3(x1, y0, z0) % 12u);
    let g010 = gradientOf(hash3(x0, y1, z0) % 12u);
    let g110 = gradientOf(hash3(x1, y1, z0) % 12u);
    let g001 = gradientOf(hash3(x0, y0, z1) % 12u);
    let g101 = gradientOf(hash3(x1, y0, z1) % 12u);
    let g011 = gradientOf(hash3(x0, y1, z1) % 12u);
    let g111 = gradientOf(hash3(x1, y1, z1) % 12u);
    let x1f = f.x - 1.0;
    let y1f = f.y - 1.0;
    let z1f = f.z - 1.0;
    let a = dot(g000, vec3<f32>(f.x, f.y, f.z));
    let b = dot(g100, vec3<f32>(x1f, f.y, f.z));
    let cc = dot(g010, vec3<f32>(f.x, y1f, f.z));
    let d = dot(g110, vec3<f32>(x1f, y1f, f.z));
    let e = dot(g001, vec3<f32>(f.x, f.y, z1f));
    let ff = dot(g101, vec3<f32>(x1f, f.y, z1f));
    let g = dot(g011, vec3<f32>(f.x, y1f, z1f));
    let h = dot(g111, vec3<f32>(x1f, y1f, z1f));
    let k1 = b - a;
    let k2 = cc - a;
    let k3 = e - a;
    let k4 = a - b - cc + d;
    let k5 = a - b - e + ff;
    let k6 = a - cc - e + g;
    let k7 = -a + b + cc - d + e - ff - g + h;
    let uv = u * v;
    let uw = u * w;
    let vw = v * w;
    let uvw = uv * w;
    let value = a + k1 * u + k2 * v + k3 * w + k4 * uv + k5 * uw + k6 * vw + k7 * uvw;
    let gi = g000
      + (g100 - g000) * u
      + (g010 - g000) * v
      + (g001 - g000) * w
      + (g000 - g100 - g010 + g110) * uv
      + (g000 - g100 - g001 + g101) * uw
      + (g000 - g010 - g001 + g011) * vw
      + (-g000 + g100 + g010 - g110 + g001 - g101 - g011 + g111) * uvw;
    return vec4<f32>(
      value,
      gi.x + du * (k1 + k4 * v + k5 * w + k7 * vw),
      gi.y + dv * (k2 + k4 * u + k6 * w + k7 * uw),
      gi.z + dw * (k3 + k5 * u + k6 * v + k7 * uv)
    );
  }
`,
  uses(fadeCode, fadeSlopeCode, gradientOfCode, hash3Code),
)

const LACUNARITY = DEFAULT_FBM.lacunarity
const GAIN = DEFAULT_FBM.gain

const fbm3Code = wgslFn(
  `
  fn fbm3(seed: u32, p: vec3<f32>, octaves: u32) -> f32 {
    // noise.ts \`fbm3\` at the default lacunarity and gain, normalized.
    var sum = 0.0;
    var amplitude = 1.0;
    var norm = 0.0;
    var f = 1.0;
    for (var i = 0u; i < octaves; i++) {
      sum += amplitude * noise3(seed, p * f);
      norm += amplitude;
      amplitude *= ${GAIN};
      f *= ${LACUNARITY};
    }
    return select(sum / norm, 0.0, norm == 0.0);
  }
`,
  uses(noise3Code),
)

const ridged3Code = wgslFn(
  `
  fn ridged3(seed: u32, p: vec3<f32>, octaves: u32) -> f32 {
    // noise.ts \`ridged3\`: \`(1 − |n|)²\` per octave, remapped once at the end.
    var sum = 0.0;
    var amplitude = 1.0;
    var norm = 0.0;
    var f = 1.0;
    for (var i = 0u; i < octaves; i++) {
      let n = 1.0 - abs(noise3(seed, p * f));
      sum += amplitude * n * n;
      norm += amplitude;
      amplitude *= ${GAIN};
      f *= ${LACUNARITY};
    }
    return select((sum / norm) * 2.0 - 1.0, 0.0, norm == 0.0);
  }
`,
  uses(noise3Code),
)

const fbmFieldCode = wgslFn(
  `
  fn fbmField(seed: u32, p: vec3<f32>, octaves: u32, damping: f32) -> f32 {
    // field.ts \`fbmField\`, value only: the slope accumulated so far damps the
    // next octave, and the norm is the raw amplitude.
    var value = 0.0;
    var amplitude = 1.0;
    var norm = 0.0;
    var f = 1.0;
    var slope = vec3<f32>(0.0);
    for (var i = 0u; i < octaves; i++) {
      let n = gradientNoise3(seed, p * f);
      slope += amplitude * n.yzw * f;
      let damp = select(1.0 / (1.0 + damping * dot(slope, slope)), 1.0, damping == 0.0);
      value += amplitude * damp * n.x;
      norm += amplitude;
      amplitude *= ${GAIN};
      f *= ${LACUNARITY};
    }
    return select(value / norm, 0.0, norm == 0.0);
  }
`,
  uses(gradientNoiseCode),
)

const ridgedFieldCode = wgslFn(
  `
  fn ridgedField(seed: u32, p: vec3<f32>, octaves: u32, damping: f32) -> f32 {
    // field.ts \`ridgedField\`, value only: the noise's slope damps rather than
    // the fold's, and the remap is per octave.
    var value = 0.0;
    var amplitude = 1.0;
    var norm = 0.0;
    var f = 1.0;
    var slope = vec3<f32>(0.0);
    for (var i = 0u; i < octaves; i++) {
      let n = gradientNoise3(seed, p * f);
      let sgn = select(1.0, -1.0, n.x < 0.0);
      let r = 1.0 - sgn * n.x;
      slope += amplitude * n.yzw * f;
      let damp = select(1.0 / (1.0 + damping * dot(slope, slope)), 1.0, damping == 0.0);
      value += amplitude * damp * (2.0 * r * r - 1.0);
      norm += amplitude;
      amplitude *= ${GAIN};
      f *= ${LACUNARITY};
    }
    return select(value / norm, 0.0, norm == 0.0);
  }
`,
  uses(gradientNoiseCode),
)

/**
 * `peakDraw < CRATER_SHAPE.peakChance`, as the integer it is — the same
 * argument `LEVEL_DRAW_AT` makes for the existence test.
 */
const PEAK_DRAW = Math.ceil(CRATER_SHAPE.peakChance * 2 ** 32)

const craterDepthCode = wgslFn(`
  fn craterDepth(diameter: f32, complexDiameter: f32) -> f32 {
    // grammar.ts \`craterDepth\`.
    if (diameter <= complexDiameter) {
      return 0.2 * diameter;
    }
    return 0.2 * complexDiameter * pow(diameter / complexDiameter, 0.3);
  }
`)

const craterProfileCode = wgslFn(
  `
  fn craterProfile(
    t: f32,
    diameter: f32,
    complexDiameter: f32,
    relaxation: f32,
    age: f32,
    peakDraw: u32,
    typeDraw: f32
  ) -> f32 {
    // craters.ts \`craterProfile\`: bowl or flat floor, the peak, the rim ring,
    // the r⁻³ apron faded at both ends. \`peakDraw\` is the raw hash lane.
    let complex = diameter > complexDiameter;
    let depth = craterDepth(diameter, complexDiameter);
    var relaxed = 1.0;
    if (relaxation != 0.0) {
      relaxed = 1.0 - relaxation * age * smoothstepf(
        complexDiameter,
        complexDiameter * ${CRATER_SHAPE.relaxSpan},
        diameter
      );
    }
    let rimLife = pow(1.0 - age, ${CRATER_SHAPE.rimAge}) * relaxed;
    let floorLife = (1.0 - ${CRATER_SHAPE.floorAge} * age) * relaxed;
    var height = 0.0;
    if (t < 1.0) {
      let flat = select(0.0, ${CRATER_SHAPE.flatFloor}, complex);
      let u = select((t - flat) / (1.0 - flat), 0.0, t <= flat);
      height -= depth * floorLife * (1.0 - u * u);
      if (complex && peakDraw < ${PEAK_DRAW}u) {
        height += depth * ${CRATER_SHAPE.peakHeight} * floorLife
          * falloff(min(1.0, t / ${CRATER_SHAPE.peakWidth}));
      }
    }
    if (t > ${RIM_INNER} && t < ${RIM_OUTER}) {
      height += ${CRATER_SHAPE.rimHeight} * depth * rimLife * ring(
        (t - ${RIM_INNER}) / ${RIM_OUTER - RIM_INNER},
        ${(1 - RIM_INNER) / (RIM_OUTER - RIM_INNER)}
      );
    }
    if (t > 1.0) {
      let apron = (1.0 / (t * t * t))
        * smoothstepf(1.0, ${RIM_OUTER}, t)
        * (1.0 - smoothstepf(${CRATER_SHAPE.apronFade}, ${EJECTA_REACH}, t));
      height += ${CRATER_SHAPE.apron} * depth * rimLife
        * (${CRATER_SHAPE.apronBase} + ${CRATER_SHAPE.apronSpread} * typeDraw) * apron;
    }
    return height;
  }
`,
  uses(craterDepthCode, smoothstepCode, falloffCode, ringCode),
)

const softLimitCode = wgslFn(`
  fn softLimit(value: f32, limit: f32) -> f32 {
    // craters.ts \`softLimit\`: \`tanh\`, which TSL has no node for.
    if (limit <= 0.0) {
      return 0.0;
    }
    return limit * tanh(value / limit);
  }
`)

/*
 * The sphere test's integers. `SLAB_AT` in `packages/universe` says why the
 * decision cannot be taken in float32; these are what let it be taken exactly.
 * A cell corner `m` is under 2²⁴, so its square is under 2⁴⁸ and a sum of
 * three under 2⁵⁰ — two `u32` words with a carry.
 */

const square48Code = wgslFn(`
  fn square48(m: i32) -> vec2<u32> {
    // m² as (high, low), by splitting |m| into 12-bit halves so every partial
    // product fits a word: a² = p1·2²⁴ + p2·2¹³ + p3.
    let a = u32(abs(m));
    let ah = a >> 12u;
    let al = a & 4095u;
    let p1 = ah * ah;
    let p2 = ah * al;
    let p3 = al * al;
    let t2 = p2 << 13u;
    let lo1 = p3 + t2;
    let hi1 = (p2 >> 19u) + select(0u, 1u, lo1 < t2);
    let t1 = p1 << 24u;
    let lo2 = lo1 + t1;
    let hi2 = hi1 + (p1 >> 8u) + select(0u, 1u, lo2 < lo1);
    return vec2<u32>(hi2, lo2);
  }
`)

const add64Code = wgslFn(`
  fn add64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let lo = a.y + b.y;
    return vec2<u32>(a.x + b.x + select(0u, 1u, lo < a.y), lo);
  }
`)

const gt64Code = wgslFn(`
  fn gt64(a: vec2<u32>, b: vec2<u32>) -> bool {
    return a.x > b.x || (a.x == b.x && a.y > b.y);
  }
`)

const lt64Code = wgslFn(`
  fn lt64(a: vec2<u32>, b: vec2<u32>) -> bool {
    return a.x < b.x || (a.x == b.x && a.y < b.y);
  }
`)

const plateWeightCode = wgslFn(
  `
  fn plateWeight(excess: f32, width: f32) -> f32 {
    // sketch.ts \`plateWeight\`: \`(1 − s)/(1 + s)\` over a smoothstep.
    let s = smoothstepf(0.0, width, excess);
    return (1.0 - s) / (1.0 + s);
  }
`,
  uses(smoothstepCode),
)

const valleyFieldCode = wgslFn(
  `
  fn valleyField(seed: u32, d: vec3<f32>, cycles: f32, octaves: u32, warp: f32) -> f32 {
    // bands.ts \`valleyField\`: the strip where a warped fBm crosses zero,
    // sharpened. The three warp channels are one seed offset along x.
    var p = d * cycles;
    if (warp > 0.0) {
      let wc = cycles * ${DRAINAGE_SHAPE.warpCycles};
      let wx = noise3(seed, vec3<f32>(d.x * wc + 37.1, d.y * wc, d.z * wc));
      let wy = noise3(seed, vec3<f32>(d.x * wc + 71.3, d.y * wc, d.z * wc));
      let wz = noise3(seed, vec3<f32>(d.x * wc + 113.7, d.y * wc, d.z * wc));
      p += vec3<f32>(wx, wy, wz) * warp;
    }
    let n = fbm3(seed, p, octaves);
    return 1.0 - min(1.0, abs(n) * ${DRAINAGE_SHAPE.sharpness});
  }
`,
  uses(noise3Code, fbm3Code),
)

const valleyProfileCode = wgslFn(
  `
  fn valleyProfile(valley: f32) -> f32 {
    // bands.ts \`valleyProfile\`: a V in a floodplain, floored at the channel.
    let v = pow(valley, ${DRAINAGE_SHAPE.valleyPower}.0);
    let flood = ${DRAINAGE_SHAPE.floodGain} * pow(valley, ${DRAINAGE_SHAPE.floodPower});
    let bed = smoothstepf(${DRAINAGE_SHAPE.channelStart}, ${DRAINAGE_SHAPE.channelFull}, valley);
    return min(1.0, max(v + flood, bed));
  }
`,
  uses(smoothstepCode),
)

const drainageCarveCode = wgslFn(
  `
  fn drainageCarve(drainage: f32, valley: f32, tributary: f32, aboveDatum: f32, budget: f32) -> f32 {
    // bands.ts \`drainageCarve\`: the cut, capped smoothly by the budget's
    // share and by the ground's height above the datum.
    if (aboveDatum <= 0.0 || drainage <= 0.0) {
      return 0.0;
    }
    let deepest = ${DRAINAGE_SHAPE.depth} * budget * drainage;
    if (deepest <= 0.0) {
      return 0.0;
    }
    let cap = deepest * (1.0 - exp(-${DRAINAGE_SHAPE.headGain} * aboveDatum / deepest));
    let shape = min(1.0, valleyProfile(valley) + ${DRAINAGE_SHAPE.tributaryGain} * valleyProfile(tributary));
    return -cap * shape;
  }
`,
  uses(valleyProfileCode),
)

const channelWetnessCode = wgslFn(
  `
  fn channelWetness(valley: f32, tributary: f32) -> f32 {
    // bands.ts \`channelWetness\`.
    let trunk = smoothstepf(${DRAINAGE_SHAPE.channelStart}, ${DRAINAGE_SHAPE.channelFull}, valley);
    let branch = smoothstepf(${DRAINAGE_SHAPE.channelStart + DRAINAGE_SHAPE.tributaryOffset}, ${DRAINAGE_SHAPE.channelFull}, tributary);
    return max(trunk, ${DRAINAGE_SHAPE.tributaryWeight} * branch);
  }
`,
  uses(smoothstepCode),
)

const coastRemapCode = wgslFn(
  `
  fn coastRemap(elevation: f32, sea: f32, width: f32) -> f32 {
    // bands.ts \`coastRemap\`: the landform pulled toward the datum inside a
    // band on each side, C¹ at the band's edge.
    let x = elevation - sea;
    let below = x < 0.0;
    let w = width * select(${COAST_SHAPE.plainWidth}, ${COAST_SHAPE.shelfWidth}, below);
    let t = abs(x) / w;
    if (t >= 1.0 || w <= 0.0) {
      return elevation;
    }
    let flat = select(${COAST_SHAPE.plainFlat}, ${COAST_SHAPE.shelfFlat}, below);
    return sea + x * (flat + (1.0 - flat) * smoothstepf(0.0, 1.0, t));
  }
`,
  uses(smoothstepCode),
)

const biotaWindowCode = wgslFn(
  `
  fn biotaWindow(t: f32) -> f32 {
    // grammar.ts \`biotaWindow\`.
    return smoothstepf(${BIOTA_WINDOW.coldOff}.0, ${BIOTA_WINDOW.coldOn}.0, t)
      * (1.0 - smoothstepf(${BIOTA_WINDOW.hotOn}.0, ${BIOTA_WINDOW.hotOff}.0, t));
  }
`,
  uses(smoothstepCode),
)

/* ------------------------------------------------------------------------- */
/* The kernel                                                                 */
/* ------------------------------------------------------------------------- */

/*
 * Six node types, named, and the compiler holds each one: the typings declare
 * every operator on `Node<'float'>` and its kin rather than on `Node`, so a
 * float handed where an int belongs is an error here rather than a Tint
 * rejection off-console. What comes back untyped is a `wgslFn` call and a
 * lane of a packed word — those are `Node`, and the value *is* what the
 * alias says — so the casts below are the re-narrowings `noiseNodes.ts`
 * makes, for the reason it gives.
 */
type F = Node<'float'>
type U = Node<'uint'>
type I = Node<'int'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Bool = Node<'bool'>

const asF = (node: unknown): F => node as F
const asU = (node: unknown): U => node as U
const asI = (node: unknown): I => node as I
const asV3 = (node: unknown): V3 => node as V3
const asV4 = (node: unknown): V4 => node as V4
const asBool = (node: unknown): Bool => node as Bool

/**
 * `Loop` with the variable named, which the typings do not admit and the
 * runtime honors. See the header on why every nested loop needs one.
 */
function loop(
  name: string,
  bounds: { start: I | U | number; end: I | U | number; condition: string },
  type: 'int' | 'uint',
  body: (index: I) => void,
): void {
  Loop({ ...bounds, type, name } as never, (inputs: Record<string, I>) =>
    body(inputs[name] as I),
  )
}

/** The three kinds of plate property the bands read through the partition. */
const PLATE_BASE = 0
const PLATE_CONTINENTAL = 1
const PLATE_STEP = 2

const cube = (x: F): F => x.mul(x).mul(x)
const square = (x: F): F => x.mul(x)
const mixF = (a: F, b: F, t: F): F => a.add(b.sub(a).mul(t))

/** `packCover`'s byte: `Math.round(clamp01(x) · 255)`. */
const packByteNode = (value: F): U => uint(round(saturate(value).mul(255)))

/**
 * `BARE_COVER` as one little-endian word: the four bytes `packCover` writes
 * for it, so the ground of a body with no budget is the same constant on
 * both processors rather than a second reading of the same four numbers.
 */
const BARE_WORD = ((): number => {
  const bytes = new Uint8Array(4)
  packCover(BARE_COVER, bytes, 0)
  return new DataView(bytes.buffer).getUint32(0, true)
})()

/**
 * `faceRaw`: `faceToDirection` before the normalize, and with `one` at zero
 * the same map over a *difference* of face coordinates. The six cases in the
 * CPU's order.
 */
const faceRaw = (face: U, u: F, v: F, one: F): V3 => {
  const out = vec3(0).toVar()
  If(face.equal(uint(0)), () => {
    out.assign(vec3(one, v, u.negate()))
  })
    .ElseIf(face.equal(uint(1)), () => {
      out.assign(vec3(one.negate(), v, u))
    })
    .ElseIf(face.equal(uint(2)), () => {
      out.assign(vec3(u, one, v.negate()))
    })
    .ElseIf(face.equal(uint(3)), () => {
      out.assign(vec3(u, one.negate(), v))
    })
    .ElseIf(face.equal(uint(4)), () => {
      out.assign(vec3(u, v, one))
    })
    .Else(() => {
      out.assign(vec3(u.negate(), v, one.negate()))
    })
  return asV3(out)
}

export interface TerrainKernelLayout {
  /** Vertices per side of a patch, `HEIGHTFIELD_RESOLUTION`. */
  readonly resolution: number
  /** Rings outside it, `HEIGHTFIELD_BORDER`. */
  readonly border: number
  /** Tiles one dispatch may carry; the buffers are sized to it once. */
  readonly maxTiles: number
}

export interface TerrainKernel {
  readonly layout: TerrainKernelLayout
  /** Bordered samples per tile — invocations a tile costs. */
  readonly samples: number
  /** Interior samples per tile. A tile writes `COVER_WORDS` cover words each. */
  readonly interior: number
  readonly compute: ComputeNode
  /** `surfaceKernel(...).records`, uploaded with `needsUpdate`. */
  readonly records: StorageBufferAttribute
  /** `surfaceKernel(...).words`, likewise. */
  readonly words: StorageBufferAttribute
  /** `TILE_STRIDE` `vec4`s per tile, `writeTileFrame`'s output. */
  readonly tiles: StorageBufferAttribute
  /** `samples` floats per tile, row-major and bordered, as the CPU lays them. */
  readonly elevations: StorageBufferAttribute
  /** `interior · COVER_WORDS` words per tile, four cover bytes each, little-endian. */
  readonly cover: StorageBufferAttribute
  /** Invocations to run this dispatch: tiles times `samples`. */
  readonly total: { value: number }
  dispose(): void
}

export function createTerrainKernel(
  layout: TerrainKernelLayout,
): TerrainKernel {
  const { resolution, border, maxTiles } = layout
  const stride = heightfieldStride(layout)
  const samples = tileSamples(resolution, border)
  const interior = resolution * resolution
  const step = resolution - 1

  const recordsAttribute = new StorageBufferAttribute(
    new Float32Array(KERNEL_RECORDS * 4),
    4,
  )
  const wordsAttribute = new StorageBufferAttribute(
    new Uint32Array(KERNEL_WORDS),
    4,
  )
  const tilesAttribute = new StorageBufferAttribute(
    new Float32Array(maxTiles * TILE_STRIDE * 4),
    4,
  )
  const elevationsAttribute = new StorageBufferAttribute(
    new Float32Array(maxTiles * samples),
    1,
  )
  const coverAttribute = new StorageBufferAttribute(
    new Uint32Array(maxTiles * interior * COVER_WORDS),
    1,
  )

  const records = storage(recordsAttribute, 'vec4', KERNEL_RECORDS).toReadOnly()
  const words = storage(wordsAttribute, 'uvec4', KERNEL_WORDS / 4).toReadOnly()
  const tiles = storage(
    tilesAttribute,
    'vec4',
    maxTiles * TILE_STRIDE,
  ).toReadOnly()
  const elevations = storage(elevationsAttribute, 'float', maxTiles * samples)
  const cover = storage(
    coverAttribute,
    'uint',
    maxTiles * interior * COVER_WORDS,
  )
  // A float, compared against `float(instanceIndex)`: exact below 2²⁴, which
  // is 3,500 tiles of 4,761 samples.
  const total = uniform(0)

  /* --- readers over the packed body ---------------------------------------- */

  const record = (slot: number | U): V4 =>
    asV4(records.element(typeof slot === 'number' ? uint(slot) : slot))
  const component = <T>(node: { x: T; y: T; z: T; w: T }, index: number): T =>
    index === 0 ? node.x : index === 1 ? node.y : index === 2 ? node.z : node.w
  const scalar = (index: number): F =>
    asF(component(record(SCALARS_AT + (index >> 2)), index & 3))
  const word = (index: number): U =>
    asU(component(words.element(uint(index >> 2)), index & 3))
  /**
   * A stage's gate, from the slot `BAND_STACK` names for it — the one place
   * the kernel's spelling of "does this stage run" is written, so the table
   * and not this file decides which scalar or word means what.
   */
  const gate = (id: StageId) => {
    const packed = stageOf(id).packed
    if (packed === null) throw new Error(`${id} always runs; it has no gate`)
    return 'word' in packed
      ? word(WORD[packed.word]).greaterThan(uint(0))
      : scalar(SCALAR[packed.scalar]).greaterThan(packed.above)
  }
  /** A word at a runtime index: the rung's existence threshold. */
  const wordAt = (index: U): U => {
    const slot = words.element(index.div(uint(4)))
    const lane = index.mod(uint(4))
    return asU(
      lane
        .equal(uint(0))
        .select(
          slot.x,
          lane
            .equal(uint(1))
            .select(slot.y, lane.equal(uint(2)).select(slot.z, slot.w)),
        ),
    )
  }

  const plateSlot = (i: U): U => uint(PLATES_AT).add(i.mul(uint(PLATE_STRIDE)))
  const plateAxis = (i: U): V3 => asV3(record(plateSlot(i)).xyz)
  const plateMotion = (i: U): V3 => asV3(record(plateSlot(i).add(uint(1))).xyz)
  const plateContinental = (i: U): F => asF(record(plateSlot(i)).w)
  const plateBase = (i: U): F => asF(record(plateSlot(i).add(uint(1))).w)
  const plateStep = (i: U): F => asF(record(plateSlot(i).add(uint(2))).x)
  const plateOf = (kind: number, i: U): F =>
    kind === PLATE_BASE
      ? plateBase(i)
      : kind === PLATE_CONTINENTAL
        ? plateContinental(i)
        : plateStep(i)

  const lift = (value: F | number): F =>
    typeof value === 'number' ? float(value) : value
  const smoothstepf = (edge0: F | number, edge1: F | number, x: F): F =>
    asF(smoothstepCode({ edge0: lift(edge0), edge1: lift(edge1), x }))
  const noise3 = (seed: U, p: V3): F => asF(noise3Code({ seed, p }))
  const fbm3 = (seed: U, p: V3, octaves: U): F =>
    asF(fbm3Code({ seed, p, octaves }))
  const ridged3 = (seed: U, p: V3, octaves: U): F =>
    asF(ridged3Code({ seed, p, octaves }))
  const fbmField = (seed: U, p: V3, octaves: U, damping: F): F =>
    asF(fbmFieldCode({ seed, p, octaves, damping }))
  const ridgedField = (seed: U, p: V3, octaves: U, damping: F): F =>
    asF(ridgedFieldCode({ seed, p, octaves, damping }))
  const falloff = (t: F): F => asF(falloffCode({ t }))
  const toUnit = (value: U): F => asF(toUnitCode({ value }))
  const plateWeight = (excess: F, width: F): F =>
    asF(plateWeightCode({ excess, width }))
  const softLimit = (value: F, limit: F): F =>
    asF(softLimitCode({ value, limit }))
  const valleyField = (seed: U, p: V3, cycles: F, octaves: U, warp: F): F =>
    asF(valleyFieldCode({ seed, d: p, cycles, octaves, warp }))
  const drainageCarve = (
    drainage: F,
    valley: F,
    tributary: F,
    aboveDatum: F,
    budget: F,
  ): F =>
    asF(drainageCarveCode({ drainage, valley, tributary, aboveDatum, budget }))
  const channelWetness = (valley: F, tributary: F): F =>
    asF(channelWetnessCode({ valley, tributary }))
  const coastRemap = (elevation: F, sea: F, width: F): F =>
    asF(coastRemapCode({ elevation, sea, width }))
  const biotaWindow = (t: F): F => asF(biotaWindowCode({ t }))
  const clamp11 = (value: F): F => clamp(value, -1, 1)
  const pcg4d = (x: U, y: U, z: U, w: U): { x: U; y: U; z: U; w: U } =>
    pcg4dCode({ x, y, z, w }) as unknown as { x: U; y: U; z: U; w: U }

  /* --- the plate partition -------------------------------------------------- */

  /**
   * `plateAt`'s first pass: the arc to the nearest plate, the arc to the
   * second, the cosine below which a plate is outside `PLATE_MARGIN` of the
   * nearest, and the nearest's index. Returns `(near, far, limit, index)`.
   */
  const plateSearch = Fn(([d]: [V3]) => {
    const count = word(WORD.PLATES)
    const best = float(-2).toVar()
    const second = float(-2).toVar()
    const bestIndex = uint(0).toVar()
    loop('p', { start: uint(0), end: count, condition: '<' }, 'uint', (i) => {
      const cosine = dot(d, plateAxis(asU(i)))
      If(cosine.greaterThan(best), () => {
        second.assign(best)
        best.assign(cosine)
        bestIndex.assign(asU(i))
      }).ElseIf(cosine.greaterThan(second), () => {
        second.assign(cosine)
      })
    })
    const near = acos(clamp(best, -1, 1))
    const far = acos(clamp(second, -1, 1))
    const limit = cos(min(float(Math.PI), near.add(PLATE_MARGIN)))
    return vec4(near, far, limit, float(bestIndex))
  }).setLayout({
    name: 'plateSearch',
    type: 'vec4',
    inputs: [{ name: 'd', type: 'vec3' }],
  })

  /**
   * `plateProperty`: a property read as a weighted mean over every plate
   * within the margin, the weight going to zero before a plate can leave.
   * `kind` is a JavaScript constant, so three functions are emitted rather
   * than a switch inside one.
   */
  const plateProperty = (kind: number, name: string) =>
    Fn(([d, near, limit, width, bestIndex]: [V3, F, F, F, U]) => {
      const count = word(WORD.PLATES)
      const sum = float(0).toVar()
      const weight = float(0).toVar()
      loop('p', { start: uint(0), end: count, condition: '<' }, 'uint', (i) => {
        const cosine = dot(d, plateAxis(asU(i)))
        If(cosine.greaterThanEqual(limit), () => {
          const excess = acos(clamp(cosine, -1, 1)).sub(near)
          const share = plateWeight(excess, width)
          If(share.greaterThan(0), () => {
            sum.addAssign(share.mul(plateOf(kind, asU(i))))
            weight.addAssign(share)
          })
        })
      })
      return weight
        .lessThanEqual(0)
        .select(plateOf(kind, bestIndex), sum.div(weight))
    }).setLayout({
      name,
      type: 'float',
      inputs: [
        { name: 'd', type: 'vec3' },
        { name: 'near', type: 'float' },
        { name: 'limit', type: 'float' },
        { name: 'width', type: 'float' },
        { name: 'bestIndex', type: 'uint' },
      ],
    })

  const plateBaseAt = plateProperty(PLATE_BASE, 'plateBaseAt')
  const plateContinentalAt = plateProperty(
    PLATE_CONTINENTAL,
    'plateContinentalAt',
  )
  const plateStepAt = plateProperty(PLATE_STEP, 'plateStepAt')

  /**
   * `pairConvergence`: the component of two plates' relative motion across
   * the line between them, made tangent at the sample.
   */
  const pairConvergence = Fn(([a, b, d]: [U, U, V3]) => {
    const toward = plateAxis(b).sub(plateAxis(a))
    const radial = dot(toward, d)
    const normal = toward.sub(d.mul(radial))
    const lengthSquared = dot(normal, normal)
    const unit = normal.div(sqrt(max(lengthSquared, float(1e-30))))
    const relative = plateMotion(a).sub(plateMotion(b))
    return lengthSquared
      .lessThan(1e-18)
      .select(float(0), clamp(dot(relative, unit), -1, 1))
  }).setLayout({
    name: 'pairConvergence',
    type: 'float',
    inputs: [
      { name: 'a', type: 'uint' },
      { name: 'b', type: 'uint' },
      { name: 'd', type: 'vec3' },
    ],
  })

  /** `convergence`: weighted over pairs, so no rank identity enters. */
  const convergence = Fn(([d, near, limit, width]: [V3, F, F, F]) => {
    const count = word(WORD.PLATES)
    const sum = float(0).toVar()
    const weight = float(0).toVar()
    loop('p', { start: uint(0), end: count, condition: '<' }, 'uint', (i) => {
      const cosineI = dot(d, plateAxis(asU(i)))
      If(cosineI.greaterThanEqual(limit), () => {
        const mine = plateWeight(acos(clamp(cosineI, -1, 1)).sub(near), width)
        If(mine.greaterThan(0), () => {
          loop(
            'q',
            { start: asU(i).add(uint(1)), end: count, condition: '<' },
            'uint',
            (j) => {
              const cosineJ = dot(d, plateAxis(asU(j)))
              If(cosineJ.greaterThanEqual(limit), () => {
                const theirs = plateWeight(
                  acos(clamp(cosineJ, -1, 1)).sub(near),
                  width,
                )
                If(theirs.greaterThan(0), () => {
                  const share = mine.mul(theirs)
                  sum.addAssign(share.mul(pairConvergence(asU(i), asU(j), d)))
                  weight.addAssign(share)
                })
              })
            },
          )
        })
      })
    })
    return weight
      .lessThanEqual(0)
      .select(float(0), clamp(sum.div(weight), -1, 1))
  }).setLayout({
    name: 'convergence',
    type: 'float',
    inputs: [
      { name: 'd', type: 'vec3' },
      { name: 'near', type: 'float' },
      { name: 'limit', type: 'float' },
      { name: 'width', type: 'float' },
    ],
  })

  /* --- chaos ----------------------------------------------------------------- */

  /**
   * `blockField`: Worley blocks on a cube lattice, the wall from `F2 − F1`.
   * The ±1 window is the CPU's, and `bands.ts` says why it suffices.
   */
  const blockField = Fn(([d, cells]: [V3, F]) => {
    const seedA = word(WORD.SEED_CHAOS_A)
    const seedB = word(WORD.SEED_CHAOS_B)
    const size = float(1).div(cells)
    const base = ivec3(floor(d.mul(cells)))
    const nearest = float(1e30).toVar()
    const second = float(1e30).toVar()
    const winner = uint(0).toVar()
    loop('bx', { start: -1, end: 1, condition: '<=' }, 'int', (dx) => {
      loop('by', { start: -1, end: 1, condition: '<=' }, 'int', (dy) => {
        loop('bz', { start: -1, end: 1, condition: '<=' }, 'int', (dz) => {
          const ix = asI(base.x).add(dx)
          const iy = asI(base.y).add(dy)
          const iz = asI(base.z).add(dz)
          const hash = pcg4d(uint(ix).bitXor(seedA), uint(iy), uint(iz), seedB)
          const px = float(ix).add(toUnit(hash.x)).mul(size).sub(d.x)
          const py = float(iy).add(toUnit(hash.y)).mul(size).sub(d.y)
          const pz = float(iz).add(toUnit(hash.z)).mul(size).sub(d.z)
          const distance = square(px).add(square(py)).add(square(pz))
          If(distance.lessThan(nearest), () => {
            second.assign(nearest)
            nearest.assign(distance)
            winner.assign(hash.w)
          }).ElseIf(distance.lessThan(second), () => {
            second.assign(distance)
          })
        })
      })
    })
    const wall = sqrt(second).sub(sqrt(nearest)).div(size)
    return toUnit(winner)
      .mul(2)
      .sub(1)
      .mul(smoothstepf(0, CHAOS_SHAPE.wall, wall))
  }).setLayout({
    name: 'blockField',
    type: 'float',
    inputs: [
      { name: 'd', type: 'vec3' },
      { name: 'cells', type: 'float' },
    ],
  })

  /* --- the crater ladder ----------------------------------------------------- */

  /**
   * `ladderField` over one run of rungs, in the tile's frame.
   *
   * The walk is `levelContribution`'s — the same bounds per axis from the
   * reach and the radial slop, the same slab rejection with the same early
   * exits, the same two hashes — with the two substitutions the header
   * explains: the sample's lattice coordinate is the frame's cell and
   * fraction plus `delta · cells`, and the chord to a crater is a difference
   * of small vectors rather than `2 − 2 cos θ`, which cancels in float32 at
   * every rung and in float64 at the tail's.
   *
   * `d` is the absolute direction, for the slab test and the per-axis spans;
   * `d0` and `delta` are the frame; `tile` picks the frames.
   */
  const ladder = Fn(
    ([d, d0, delta, tile, first, count, radius]: [V3, V3, V3, U, U, U, F]) => {
      const seed = word(WORD.LATTICE_SEED)
      const complexDiameter = scalar(SCALAR.COMPLEX_DIAMETER)
      const relaxation = scalar(SCALAR.RELAXATION)
      const along = vec3(d.x.abs(), d.y.abs(), d.z.abs())
      const spread = vec3(
        sqrt(max(float(0), float(1).sub(square(d.x)))),
        sqrt(max(float(0), float(1).sub(square(d.y)))),
        sqrt(max(float(0), float(1).sub(square(d.z)))),
      )
      const slop = along.x.add(along.y).add(along.z)
      const total = float(0).toVar()

      loop(
        'r',
        { start: first, end: first.add(count), condition: '<' },
        'uint',
        (rungNode) => {
          const rung = asU(rungNode)
          const level = record(
            uint(LEVELS_AT).add(rung.mul(uint(LEVEL_STRIDE))),
          )
          const cells = asF(level.x)
          const largest = asF(level.y)
          const density = asF(level.z)
          const rungIndex = uint(asF(level.w))
          const maxDraw = wordAt(uint(LEVEL_DRAW_AT).add(rung))
          const size = float(1).div(cells)
          const reach = largest.mul(EJECTA_REACH).div(radius.mul(2)).mul(cells)
          const bend = square(reach).mul(size).div(2)
          const curve = slop.mul(reach).mul(size)
          const spanX = reach
            .mul(spread.x)
            .add(slop.add(bend).mul(along.x))
            .add(curve)
          const spanY = reach
            .mul(spread.y)
            .add(slop.add(bend).mul(along.y))
            .add(curve)
          const spanZ = reach
            .mul(spread.z)
            .add(slop.add(bend).mul(along.z))
            .add(curve)

          // The frame: the cell the tile's center is in, and where in it.
          const frameAt = tile
            .mul(uint(TILE_STRIDE))
            .add(uint(1))
            .add(rung.mul(uint(2)))
          const c0 = ivec3(asV3(tiles.element(frameAt).xyz))
          const f0 = asV3(tiles.element(frameAt.add(uint(1))).xyz)
          // The sample's coordinate relative to the corner of that cell.
          const q = f0.add(delta.mul(cells))
          const fromX = int(floor(q.x.sub(spanX)))
          const toX = int(floor(q.x.add(spanX)))
          const fromY = int(floor(q.y.sub(spanY)))
          const toY = int(floor(q.y.add(spanY)))
          const fromZ = int(floor(q.z.sub(spanZ)))
          const toZ = int(floor(q.z.add(spanZ)))

          /*
           * The sphere test, in integers. `lo > 0 ? lo² : hi < 0 ? hi² : 0`
           * over `lo = c/cells`, `hi = (c + 1)/cells` is the nearest corner's
           * square; `max(lo², hi²)` the farthest's; and `> 1` against
           * `cells²` is `Σ m² > floor(cells²)` for the corner indices `m`
           * themselves. See `SLAB_AT`.
           */
          // One slot a rung: `SLAB_AT` is a `uvec4` boundary and a rung's
          // four words are one `uvec4`, so the limits are a single load
          // rather than four lane selects.
          const limits = words.element(uint(SLAB_AT / 4).add(rung))
          const nearLimit = uvec2(asU(limits.x), asU(limits.y))
          const farLimit = uvec2(asU(limits.z), asU(limits.w))
          const nearCorner = (c: I): I =>
            asI(
              c
                .greaterThan(0)
                .select(c, c.add(1).lessThan(0).select(c.add(1), int(0))),
            )
          const farCorner = (c: I): I => maxInt(c.abs(), c.add(1).abs())
          const squared = (m: I): Node => square48Code({ m })
          const summed = (a: Node, b: Node): Node => add64Code({ a, b })
          const beyond = (sum: Node, limit: Node): Bool =>
            asBool(gt64Code({ a: sum, b: limit }))
          const within = (sum: Node, limit: Node): Bool =>
            asBool(lt64Code({ a: sum, b: limit }))

          loop(
            'lx',
            { start: fromX, end: toX, condition: '<=' },
            'int',
            (ix) => {
              const cx = asI(c0.x).add(ix)
              const nearX = squared(nearCorner(cx))
              If(beyond(nearX, nearLimit), () => {
                If(cx.greaterThanEqual(0), () => {
                  Break()
                })
                Continue()
              })
              const farX = squared(farCorner(cx))
              loop(
                'ly',
                { start: fromY, end: toY, condition: '<=' },
                'int',
                (iy) => {
                  const cy = asI(c0.y).add(iy)
                  const nearXY = summed(nearX, squared(nearCorner(cy)))
                  If(beyond(nearXY, nearLimit), () => {
                    If(cy.greaterThanEqual(0), () => {
                      Break()
                    })
                    Continue()
                  })
                  const farXY = summed(farX, squared(farCorner(cy)))
                  loop(
                    'lz',
                    { start: fromZ, end: toZ, condition: '<=' },
                    'int',
                    (iz) => {
                      const cz = asI(c0.z).add(iz)
                      const nearXYZ = summed(nearXY, squared(nearCorner(cz)))
                      If(beyond(nearXYZ, nearLimit), () => {
                        If(cz.greaterThanEqual(0), () => {
                          Break()
                        })
                        Continue()
                      })
                      const farXYZ = summed(farXY, squared(farCorner(cz)))
                      If(within(farXYZ, farLimit), () => {
                        Continue()
                      })

                      const hash = pcg4d(
                        uint(cx).bitXor(seed),
                        uint(cy),
                        uint(cz),
                        rungIndex,
                      )
                      // The existence test, in integers. See `LEVEL_DRAW_AT`.
                      If(hash.x.greaterThan(maxDraw), () => {
                        Continue()
                      })
                      const draw = toUnit(hash.x)
                      const diameter = largest.mul(
                        draw
                          .mul(1 - CRATER_SHAPE.sizeFloor)
                          .div(density)
                          .add(CRATER_SHAPE.sizeFloor),
                      )
                      const angularRadius = diameter.div(radius.mul(2))
                      // The jittered center, relative to the tile's own center.
                      const j = vec3(
                        float(ix).add(toUnit(hash.y)).sub(f0.x),
                        float(iy).add(toUnit(hash.z)).sub(f0.y),
                        float(iz).add(toUnit(hash.w)).sub(f0.z),
                      ).mul(size)
                      const w = dot(d0, j).mul(2).add(dot(j, j))
                      If(float(1).add(w).lessThan(1e-24), () => {
                        Continue()
                      })
                      const n = sqrt(float(1).add(w))
                      // `d − Ĵ = δ − j/n + d0 · w/(n(1 + n))`, exactly.
                      const difference = delta
                        .sub(j.div(n))
                        .add(d0.mul(w.div(n.mul(n.add(1)))))
                      const away = dot(difference, difference)
                      const reachAngle = angularRadius.mul(EJECTA_REACH)
                      If(away.greaterThan(square(reachAngle)), () => {
                        Continue()
                      })
                      const distance = sqrt(max(float(0), away))
                      const shape = pcg4d(
                        uint(cy),
                        uint(cz),
                        uint(cx).bitXor(seed),
                        rungIndex.add(uint(8_191)),
                      )
                      total.addAssign(
                        asF(
                          craterProfileCode({
                            t: distance.div(angularRadius),
                            diameter,
                            complexDiameter,
                            relaxation,
                            age: toUnit(shape.x),
                            peakDraw: shape.y,
                            typeDraw: toUnit(shape.z),
                          }),
                        ),
                      )
                    },
                  )
                },
              )
            },
          )
        },
      )
      return total
    },
  ).setLayout({
    name: 'ladder',
    type: 'float',
    inputs: [
      { name: 'd', type: 'vec3' },
      { name: 'd0', type: 'vec3' },
      { name: 'delta', type: 'vec3' },
      { name: 'tile', type: 'uint' },
      { name: 'first', type: 'uint' },
      { name: 'count', type: 'uint' },
      { name: 'radius', type: 'float' },
    ],
  })

  /* --- one sample ------------------------------------------------------------- */

  const kernel = Fn(() => {
    const index = instanceIndex
    If(float(index).lessThan(total), () => {
      const tile = index.div(uint(samples))
      const sample = index.mod(uint(samples))
      const row = int(sample.div(uint(stride))).sub(int(border))
      const col = int(sample.mod(uint(stride))).sub(int(border))
      const isInterior: Bool = row
        .greaterThanEqual(0)
        .and(col.greaterThanEqual(0))
        .and(row.lessThan(resolution))
        .and(col.lessThan(resolution))

      /* --- the direction, and the offset it is taken from ---------------- */

      const header = asV4(tiles.element(tile.mul(uint(TILE_STRIDE))))
      const face = uint(asF(header.x))
      const span = exp2(asF(header.y))
      const u0 = asF(header.z).add(0.5).div(span).mul(2).sub(1)
      const v0 = asF(header.w).add(0.5).div(span).mul(2).sub(1)
      const du = float(col).div(step).sub(0.5).mul(2).div(span)
      const dv = float(row).div(step).sub(0.5).mul(2).div(span)
      const raw0 = faceRaw(face, u0, v0, float(1))
      const draw = faceRaw(face, du, dv, float(0))
      const len0 = length(raw0)
      const w = dot(raw0, draw).mul(2).add(dot(draw, draw)).div(square(len0))
      const n = sqrt(float(1).add(w))
      const d0 = raw0.div(len0)
      const delta = draw
        .div(len0.mul(n))
        .sub(raw0.mul(w.div(n.mul(n.add(1))).div(len0)))
      const d = normalize(d0.add(delta))

      const elevation = float(0).toVar()
      const coverWord = uint(0).toVar()
      // The second word starts at zero, which is `BARE_COVER`'s second four
      // bytes: nothing wet and nothing growing.
      const coverWord2 = uint(0).toVar()
      const budget = scalar(SCALAR.BUDGET)

      If(budget.lessThanEqual(0), () => {
        coverWord.assign(uint(BARE_WORD))
      }).Else(() => {
        const radius = scalar(SCALAR.MEAN_RADIUS)
        const hasPlates = word(WORD.PLATES).greaterThanEqual(uint(2))
        const search = asV4(plateSearch(d))
        const near = asF(search.x)
        const far = asF(search.y)
        const limit = asF(search.z)
        const bestIndex = uint(asF(search.w))
        const boundary = far.sub(near)

        /* --- hypsometry ---------------------------------------------------- */

        const swell = fbm3(
          word(WORD.SEED_HYPSOMETRY),
          d.mul(HYPSOMETRY_SHAPE.cycles),
          word(WORD.OCTAVES_HYPSOMETRY),
        )
        const hypsometry = float(0).toVar()
        If(hasPlates, () => {
          const base = plateBaseAt(
            d,
            near,
            limit,
            float(HYPSOMETRY_MARGIN),
            bestIndex,
          )
          hypsometry.assign(
            clamp11(base.add(swell.mul(HYPSOMETRY_SHAPE.swell))),
          )
        }).Else(() => {
          hypsometry.assign(clamp11(swell))
        })

        /* --- belts ---------------------------------------------------------- */

        const erosion = scalar(SCALAR.EROSION)
        const eroded = word(WORD.ERODED).equal(uint(1))
        const belts = float(0).toVar()
        const edge = float(0).toVar()
        // `plateContext.across`: the belts' convergence, where there is an
        // edge for it to matter on.
        const across = float(0).toVar()
        If(hasPlates, () => {
          edge.assign(float(1).sub(smoothstepf(0, BELT_MARGIN, boundary)))
          If(boundary.lessThan(BELT_MARGIN), () => {
            across.assign(convergence(d, near, limit, float(BELT_MARGIN)))
          })
        })
        If(hasPlates.not().or(edge.greaterThan(0)), () => {
          const p = d.mul(BELT_SHAPE.cycles)
          const octaves = word(WORD.OCTAVES_BELTS)
          const seed = word(WORD.SEED_BELTS)
          const raw = float(0).toVar()
          If(eroded, () => {
            raw.assign(ridgedField(seed, p, octaves, erosion))
          }).Else(() => {
            raw.assign(ridged3(seed, p, octaves))
          })
          const ranges = raw.mul(0.5).add(0.5)
          If(hasPlates, () => {
            const converging = max(float(0), across)
            const diverging = max(float(0), across.negate())
            const sliding = float(1).sub(across.abs())
            const continental = plateContinentalAt(
              d,
              near,
              limit,
              float(BELT_MARGIN),
              bestIndex,
            )
            const stepping = plateStepAt(
              d,
              near,
              limit,
              float(BELT_MARGIN),
              bestIndex,
            )
            const uplift = converging.mul(
              mixF(ranges.mul(BELT_SHAPE.oceanicUplift), ranges, continental),
            )
            const opening = diverging.mul(
              mixF(
                ranges.mul(BELT_SHAPE.oceanicOpening),
                ranges.mul(BELT_SHAPE.continentalOpening),
                continental,
              ),
            )
            const scarp = sliding
              .mul(BELT_SHAPE.scarp)
              .mul(stepping)
              .mul(ranges)
            belts.assign(clamp11(edge.mul(uplift.add(opening).add(scarp))))
          }).Else(() => {
            belts.assign(
              clamp11(
                cube(float(1).sub(ranges))
                  .mul(BELT_SHAPE.lidGain)
                  .add(BELT_SHAPE.lidOffset),
              ),
            )
          })
        })

        /* --- volcanism ------------------------------------------------------ */

        const volcanic = float(0).toVar()
        loop(
          'h',
          { start: uint(0), end: word(WORD.HOTSPOTS), condition: '<' },
          'uint',
          (i) => {
            const slot = uint(HOTSPOTS_AT).add(asU(i).mul(uint(HOTSPOT_STRIDE)))
            const first = record(slot)
            const rest = record(slot.add(uint(1)))
            const axis = asV3(first.xyz)
            const hotspotRadius = asF(first.w)
            const strength = asF(rest.x)
            const caldera = asF(rest.y)
            const t = length(d.sub(axis)).div(hotspotRadius)
            If(t.lessThan(1), () => {
              const flank = strength.mul(
                pow(falloff(t), float(SHIELD_SHAPE.flankPower)),
              )
              const notch = t
                .lessThan(caldera)
                .select(
                  strength
                    .mul(SHIELD_SHAPE.calderaDepth)
                    .mul(falloff(t.div(caldera))),
                  float(0),
                )
              volcanic.addAssign(flank.sub(notch))
            })
          },
        )
        If(hasPlates, () => {
          const arcEdge = float(1).sub(smoothstepf(0, ARC_MARGIN, boundary))
          If(arcEdge.greaterThan(0), () => {
            const continental = plateContinentalAt(
              d,
              near,
              limit,
              float(ARC_MARGIN),
              bestIndex,
            )
            If(continental.greaterThan(0), () => {
              const arcAcross = max(
                float(0),
                convergence(d, near, limit, float(ARC_MARGIN)),
              )
              const cones = ridged3(
                word(WORD.SEED_BELTS),
                d.mul(ARC_SHAPE.cycles).add(vec3(ARC_SHAPE.offset, 0, 0)),
                word(WORD.OCTAVES_ARC),
              )
                .mul(0.5)
                .add(0.5)
              volcanic.addAssign(
                arcEdge
                  .mul(continental)
                  .mul(arcAcross)
                  .mul(cube(cones))
                  .mul(ARC_SHAPE.gain),
              )
            })
          })
        })
        const volcanism = clamp11(volcanic)

        /* --- relief --------------------------------------------------------- */

        const reliefCycles = scalar(SCALAR.RELIEF_CYCLES)
        const warped = d.mul(scalar(SCALAR.WARP_CYCLES))
        const warpOctaves = uint(RELIEF_SHAPE.warpOctaves)
        const wx = fbm3(word(WORD.SEED_WARP_X), warped, warpOctaves)
        const wy = fbm3(word(WORD.SEED_WARP_Y), warped, warpOctaves)
        const wz = fbm3(word(WORD.SEED_WARP_Z), warped, warpOctaves)
        const bent = d
          .add(vec3(wx, wy, wz).mul(scalar(SCALAR.WARP_AMOUNT)))
          .mul(reliefCycles)
        const rolling = float(0).toVar()
        If(eroded, () => {
          rolling.assign(
            fbmField(
              word(WORD.SEED_RELIEF),
              bent,
              word(WORD.OCTAVES_RELIEF),
              erosion,
            ),
          )
        }).Else(() => {
          rolling.assign(
            fbm3(word(WORD.SEED_RELIEF), bent, word(WORD.OCTAVES_RELIEF)),
          )
        })
        const dunesAmount = scalar(SCALAR.DUNES)
        const relief = float(0).toVar()
        If(dunesAmount.lessThanEqual(DUNE_SHAPE.floor), () => {
          relief.assign(clamp11(rolling))
        }).Else(() => {
          const duneCycles = scalar(SCALAR.DUNE_CYCLES)
          const dunes = ridged3(
            word(WORD.SEED_DUNES),
            vec3(
              d.x.mul(duneCycles).mul(DUNE_SHAPE.stretch),
              d.y.mul(duneCycles),
              d.z.mul(duneCycles),
            ),
            word(WORD.OCTAVES_DUNES),
          )
          relief.assign(
            clamp11(rolling.add(dunesAmount.mul(DUNE_SHAPE.gain).mul(dunes))),
          )
        })

        /* --- ice ------------------------------------------------------------ */

        const shareIce = scalar(SCALAR.SHARE_ICE)
        const ice = float(0).toVar()
        If(gate('ice'), () => {
          const chaos = scalar(SCALAR.CHAOS)
          const sulci = scalar(SCALAR.SULCI)
          const stripes = scalar(SCALAR.STRIPES)
          const icy = float(0).toVar()
          If(chaos.greaterThan(CHAOS_SHAPE.floor), () => {
            icy.addAssign(chaos.mul(blockField(d, scalar(SCALAR.CHAOS_CELLS))))
          })
          If(sulci.greaterThan(SULCI_SHAPE.floor), () => {
            const grooves = ridged3(
              word(WORD.SEED_SULCI),
              vec3(
                d.x.mul(SULCI_SHAPE.cycles * SULCI_SHAPE.stretch),
                d.y.mul(SULCI_SHAPE.cycles),
                d.z.mul(SULCI_SHAPE.cycles),
              ),
              word(WORD.OCTAVES_SULCI),
            )
            icy.addAssign(sulci.mul(SULCI_SHAPE.gain).mul(grooves))
          })
          loop(
            's',
            { start: uint(0), end: word(WORD.STRIPES), condition: '<' },
            'uint',
            (i) => {
              const slot = uint(STRIPES_AT).add(asU(i).mul(uint(STRIPE_STRIDE)))
              const first = record(slot)
              const pole = asV3(first.xyz)
              const halfWidth = asF(first.w)
              const offset = asF(record(slot.add(uint(1))).x)
              const away = dot(d, pole).abs()
              const reach = halfWidth.add(offset.mul(STRIPE_SHAPE.reach))
              If(away.lessThanEqual(reach), () => {
                const trough = falloff(min(float(1), away.div(halfWidth)))
                const shoulderCenter = halfWidth.add(offset)
                const shoulder = falloff(
                  min(
                    float(1),
                    away
                      .sub(shoulderCenter)
                      .abs()
                      .div(offset.mul(STRIPE_SHAPE.shoulderWidth)),
                  ),
                ).mul(STRIPE_SHAPE.shoulder)
                icy.addAssign(stripes.mul(shoulder.sub(trough)))
              })
            },
          )
          ice.assign(clamp11(icy))
        })

        /* --- the sum, and the craters ------------------------------------- */

        const height = scalar(SCALAR.SHARE_HYPSOMETRY)
          .mul(hypsometry)
          .add(scalar(SCALAR.SHARE_BELTS).mul(belts))
          .add(scalar(SCALAR.SHARE_VOLCANISM).mul(volcanism))
          .add(scalar(SCALAR.SHARE_RELIEF).mul(relief))
          .add(shareIce.mul(ice))
        elevation.assign(height.mul(budget))

        /* --- the valleys ----------------------------------------------------- */

        // `evaluate`'s drainage block: the two valley fields kept for the
        // cover, and the ground's height above the datum once cut.
        const drainageAmount = scalar(SCALAR.DRAINAGE)
        const valley = float(0).toVar()
        const tributary = float(0).toVar()
        const aboveDatum = float(0).toVar()
        If(gate('drainage'), () => {
          const datum = scalar(SCALAR.DRAINAGE_DATUM)
          valley.assign(
            valleyField(
              word(WORD.SEED_DRAINAGE),
              d,
              float(DRAINAGE_SHAPE.cycles),
              uint(DRAINAGE_SHAPE.octaves),
              float(DRAINAGE_SHAPE.warpAmount),
            ),
          )
          tributary.assign(
            valleyField(
              word(WORD.SEED_TRIBUTARY),
              d,
              float(DRAINAGE_SHAPE.cycles * DRAINAGE_SHAPE.tributaryCycles),
              uint(DRAINAGE_SHAPE.tributaryOctaves),
              float(0),
            ),
          )
          elevation.addAssign(
            drainageCarve(
              drainageAmount,
              valley,
              tributary,
              elevation.sub(datum),
              budget,
            ),
          )
          aboveDatum.assign(elevation.sub(datum))
        })

        const craterLevels = word(WORD.CRATER_LEVELS)
        const craterLimit = scalar(SCALAR.CRATER_LIMIT)
        const craters = float(0).toVar()
        If(gate('craters'), () => {
          craters.assign(
            ladder(d, d0, delta, tile, uint(0), craterLevels, radius),
          )
          elevation.addAssign(softLimit(craters, craterLimit))
        })

        /* --- the coast ------------------------------------------------------- */

        // `evaluate`'s last term: after the craters, before the tail. The
        // gate is the width, which the packer zeroes where the stage is off.
        const coast = scalar(SCALAR.COAST_WIDTH)
        If(gate('coast'), () => {
          elevation.assign(
            coastRemap(elevation, scalar(SCALAR.SEA_DATUM), coast),
          )
        })

        /* --- the tail: sub-floor craters and the grit ----------------------- */

        const microCeiling = scalar(SCALAR.MICRO_CEILING)
        If(gate('tail'), () => {
          const tail = ladder(
            d,
            d0,
            delta,
            tile,
            craterLevels,
            word(WORD.MICRO_LEVELS),
            radius,
          )
          elevation.addAssign(softLimit(tail, microCeiling))
        })
        // An amplitude guard, not a stage gate: the grit is always on inside
        // the stack (`BAND_STACK` says why), and this skips its octaves only
        // where the packer wrote a zero, which is the bare body the outer
        // branch already took.
        const gritAmplitude = scalar(SCALAR.GRIT_RELIEF)
        If(gritAmplitude.greaterThan(0), () => {
          // `fbm3` over the grit's frames: each octave has its own cell and
          // fraction, because at eight meters of wavelength it is as fine as
          // the tail's craters.
          const seed = word(WORD.SEED_GRIT)
          const base = scalar(SCALAR.GRIT_CYCLES)
          const sum = float(0).toVar()
          let amplitude = 1
          let norm = 0
          let frequency = 1
          for (let k = 0; k < GRIT_OCTAVES; k += 1) {
            const frameAt = tile
              .mul(uint(TILE_STRIDE))
              .add(uint(1 + (GRIT_FRAMES_AT + k) * 2))
            const c0 = ivec3(asV3(tiles.element(frameAt).xyz))
            const f0 = asV3(tiles.element(frameAt.add(uint(1))).xyz)
            const q = f0.add(delta.mul(base.mul(frequency)))
            const cell = floor(q)
            const value = asF(
              noise3AtCode({
                seed,
                cell: c0.add(ivec3(cell)),
                f: q.sub(cell),
              }),
            )
            sum.addAssign(value.mul(amplitude))
            norm += amplitude
            amplitude *= GAIN
            frequency *= LACUNARITY
          }
          elevation.addAssign(gritAmplitude.mul(sum.div(norm)))
        })

        /* --- the sea -------------------------------------------------------- */

        /*
         * `groundCoverAt`'s clamp, under the same flag. The packer zeroes it
         * for a seabed tile — `drawnGroundElevation`, with the sea a sheet the
         * renderer lays over it at the datum — and sets it where no sheet is
         * drawn: a mapped body's photograph is its sea, and the ground under
         * the photograph is the datum, not the trench.
         */
        If(gate('clamp'), () => {
          elevation.assign(max(elevation, scalar(SCALAR.SEA_DATUM)))
        })

        /* --- the cover, for an interior sample ----------------------------- */

        If(isInterior, () => {
          // `rayBrightness`.
          const weather = float(1).sub(scalar(SCALAR.AIR))
          const bright = float(0).toVar()
          If(weather.greaterThan(0), () => {
            const sum = float(0).toVar()
            loop(
              'k',
              { start: uint(0), end: word(WORD.RAYS), condition: '<' },
              'uint',
              (i) => {
                const slot = uint(RAYS_AT).add(asU(i).mul(uint(RAY_STRIDE)))
                const a = record(slot)
                const b = record(slot.add(uint(1)))
                const c = record(slot.add(uint(2)))
                const phasesA = record(slot.add(uint(3)))
                const phasesB = record(slot.add(uint(4)))
                const axis = asV3(a.xyz)
                const angularRadius = asF(a.w)
                const tangent = asV3(b.xyz)
                const age = asF(b.w)
                const bitangent = asV3(c.xyz)
                const cosReach = asF(c.w)
                const cosine = dot(d, axis)
                If(cosine.greaterThan(cosReach), () => {
                  const theta = acos(min(float(1), cosine))
                  const t = theta.div(angularRadius)
                  const fresh = square(float(1).sub(age.div(RAY_AGE)))
                  const value = float(RAY_SHAPE.halo)
                    .mul(
                      float(1).sub(
                        smoothstepf(
                          RIM_INNER,
                          EJECTA_REACH,
                          max(t, float(RIM_INNER)),
                        ),
                      ),
                    )
                    .toVar()
                  If(t.greaterThan(RAY_ONSET), () => {
                    const azimuth = atan(dot(d, bitangent), dot(d, tangent))
                    const wave = float(0).toVar()
                    const phases = [
                      asF(phasesA.x),
                      asF(phasesA.y),
                      asF(phasesA.z),
                      asF(phasesA.w),
                      asF(phasesB.x),
                      asF(phasesB.y),
                    ]
                    RAY_HARMONICS.forEach((harmonic, k) => {
                      wave.addAssign(
                        cos(azimuth.mul(harmonic).add(phases[k] as F)).div(
                          RAY_HARMONICS.length,
                        ),
                      )
                    })
                    const reach = t.div(RAY_REACH)
                    const cut = reach
                      .mul(RAY_SHAPE.cutSlope)
                      .add(RAY_SHAPE.cutBase)
                    const filament = smoothstepf(
                      cut,
                      min(float(1), cut.add(RAY_SHAPE.cutWidth)),
                      wave,
                    )
                    const radial = smoothstepf(
                      RAY_ONSET,
                      RAY_ONSET + RAY_SHAPE.onsetWidth,
                      t,
                    )
                      .mul(
                        float(1).sub(
                          smoothstepf(RAY_SHAPE.fadeStart, 1, reach),
                        ),
                      )
                      .div(pow(t, float(RAY_SHAPE.thinning)))
                    value.addAssign(
                      filament.mul(radial).mul(RAY_SHAPE.filament),
                    )
                  })
                  sum.addAssign(value.mul(fresh))
                })
              },
            )
            bright.assign(min(float(1), sum.mul(weather)))
          })

          // `mareCover`.
          const icyness = scalar(SCALAR.ICY)
          const melt = saturate(
            scalar(SCALAR.SHARE_VOLCANISM).mul(COVER_SHAPE.meltGain),
          ).mul(float(1).sub(icyness))
          const dark = float(0).toVar()
          If(melt.greaterThan(0).and(craterLimit.greaterThan(0)), () => {
            const basin = smoothstepf(
              craterLimit.mul(COVER_SHAPE.basinShallow),
              craterLimit.mul(COVER_SHAPE.basinDeep),
              craters,
            )
            If(basin.greaterThan(0), () => {
              const mareAxis = vec3(
                scalar(SCALAR.MARE_AXIS_X),
                scalar(SCALAR.MARE_AXIS_Y),
                scalar(SCALAR.MARE_AXIS_Z),
              )
              const gate = dot(d, mareAxis).add(
                noise3(word(WORD.SEED_MARE), d.mul(MARE_CYCLES)).mul(
                  COVER_SHAPE.mareNoise,
                ),
              )
              dark.assign(
                saturate(
                  basin.mul(smoothstepf(GATE_LO, GATE_HI, gate)).mul(melt),
                ),
              )
            })
          })

          // `mineralCover`.
          const province = noise3(
            word(WORD.SEED_MINERAL),
            d.mul(MINERAL_CYCLES),
          )
          const felsic = float(0.5).toVar()
          If(hasPlates, () => {
            felsic.assign(
              plateContinentalAt(
                d,
                near,
                limit,
                float(PLATE_MARGIN),
                bestIndex,
              ),
            )
          })
          const mineral = saturate(
            float(0.5)
              .add(province.mul(COVER_SHAPE.provinceGain))
              .add(felsic.sub(0.5).mul(COVER_SHAPE.felsicGain)),
          )

          // `iceCover`.
          const shell = saturate(
            icyness.sub(COVER_SHAPE.shellStart).div(COVER_SHAPE.shellSpan),
          )
          const supply = max(
            shell,
            saturate(scalar(SCALAR.AIR_MASS).div(COVER_SHAPE.airSupply)),
          )
          const frost = float(0).toVar()
          If(supply.greaterThan(0), () => {
            const cosZenith = max(
              float(COVER_SHAPE.zenithFloor),
              sqrt(max(float(0), float(1).sub(square(d.y)))),
            )
            const local = scalar(SCALAR.GROUND_TEMPERATURE).mul(
              pow(cosZenith, float(COVER_SHAPE.zenithPower)),
            )
            const ragged = noise3(
              word(WORD.SEED_FROST),
              d.mul(COVER_SHAPE.frostCycles),
            ).mul(COVER_SHAPE.frostRagged)
            const cap = smoothstepf(
              FROST_POINT + COVER_SHAPE.capWarm,
              FROST_POINT + COVER_SHAPE.capCold,
              local.add(ragged),
            )
            frost.assign(saturate(min(cap, supply)))
          })

          coverWord.assign(
            packByteNode(bright)
              .bitOr(packByteNode(dark).shiftLeft(uint(8)))
              .bitOr(packByteNode(mineral).shiftLeft(uint(16)))
              .bitOr(packByteNode(frost).shiftLeft(uint(24))),
          )

          // `wetCover`.
          const liquid = scalar(SCALAR.LIQUID)
          const wet = float(0).toVar()
          If(liquid.greaterThan(0).and(aboveDatum.greaterThan(0)), () => {
            wet.assign(saturate(channelWetness(valley, tributary).mul(liquid)))
          })

          // `biotaCover`.
          const biotaAmount = scalar(SCALAR.BIOTA)
          const biota = float(0).toVar()
          // `biotaCover` floors its budget at a meter; the port does the same.
          const biotaBudget = max(budget, float(1))
          If(biotaAmount.greaterThan(0), () => {
            const cosZenith = max(
              float(COVER_SHAPE.zenithFloor),
              sqrt(max(float(0), float(1).sub(square(d.y)))),
            )
            const local = scalar(SCALAR.GROUND_TEMPERATURE).mul(
              pow(cosZenith, float(COVER_SHAPE.zenithPower)),
            )
            const warmth = biotaWindow(local)
            If(warmth.greaterThan(0), () => {
              const treeline = float(1).sub(
                smoothstepf(
                  biotaBudget.mul(COVER_SHAPE.treelineStart),
                  biotaBudget.mul(COVER_SHAPE.treelineEnd),
                  aboveDatum,
                ),
              )
              const ashore = smoothstepf(
                0,
                biotaBudget.mul(COVER_SHAPE.shoreRise),
                aboveDatum,
              )
              const rain = noise3(
                word(WORD.SEED_RAIN),
                d.mul(COVER_SHAPE.rainCycles),
              )
                .mul(0.5)
                .add(0.5)
              const damp = min(
                float(1),
                rain.add(
                  max(square(valley), square(tributary)).mul(
                    COVER_SHAPE.dampReach,
                  ),
                ),
              )
              const moisture = float(COVER_SHAPE.rainFloor).add(
                damp.mul(1 - COVER_SHAPE.rainFloor),
              )
              const patch = noise3(
                word(WORD.SEED_RAIN),
                d
                  .mul(COVER_SHAPE.patchCycles)
                  .add(vec3(COVER_SHAPE.patchOffset, 0, 0)),
              )
                .mul(0.5)
                .add(0.5)
              const patchy = float(COVER_SHAPE.patchFloor).add(
                square(patch).mul(1 - COVER_SHAPE.patchFloor),
              )
              biota.assign(
                saturate(
                  biotaAmount
                    .mul(warmth)
                    .mul(treeline)
                    .mul(ashore)
                    .mul(moisture)
                    .mul(patchy)
                    .mul(float(1).sub(wet)),
                ),
              )
            })
          })

          coverWord2.assign(
            packByteNode(wet).bitOr(packByteNode(biota).shiftLeft(uint(8))),
          )
        })
      })

      elevations.element(index).assign(elevation)
      If(isInterior, () => {
        const at = tile
          .mul(uint(interior))
          .add(uint(row.mul(int(resolution)).add(col)))
          .mul(uint(COVER_WORDS))
        cover.element(at).assign(coverWord)
        cover.element(at.add(uint(1))).assign(coverWord2)
      })
    })
  })

  const compute = kernel().compute(maxTiles * samples)

  return {
    layout,
    samples,
    interior,
    compute,
    records: recordsAttribute,
    words: wordsAttribute,
    tiles: tilesAttribute,
    elevations: elevationsAttribute,
    cover: coverAttribute,
    total,
    dispose() {
      compute.dispose()
    },
  }
}
