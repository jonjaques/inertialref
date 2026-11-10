import type { Node } from 'three/webgpu'
import {
  abs,
  atan,
  clamp,
  dot,
  float,
  floor,
  ivec2,
  max,
  min,
  normalize,
  select,
  sqrt,
  vec2,
  vec3,
} from 'three/tsl'
import { CUBE_FACES } from '@inertialref/rendering'
import type { CloudRay, CloudSample } from './cloudNodes.ts'
import type {
  CloudBodyUniforms,
  CloudCameraUniforms,
  CloudLevelUniforms,
} from './cloudUniforms.ts'

/*
 * The arithmetic every cloud pass forms its rays and heights with, in TSL:
 * where a texel looks, where a ray meets a shell, how high a point is, and
 * where a point falls in a level's plane or the weather cube's atlas.
 *
 * Every height comes from heights. A shell crossing is a quadratic whose
 * constant term is the eye's height over the boundary times a sum of radii,
 * formed on the CPU in float64 (`eyeOver`); an altitude is §5.3's quotient
 * over the eye's own `h_e·(2R + h_e)` (`eyeTerm`). Nothing here subtracts two
 * radii (rule 52): one float32 step at Earth's radius is half a meter, and
 * `length(eye + o) − R` would quantize every cloud base to it and walk it
 * across the steps as the eye moved. Nothing reads an absolute direction for
 * a level either (rule 58): a level's plane coordinate is the eye's, from the
 * CPU, plus a difference formed from the offset.
 */

/**
 * The image point of trace texel `pixel`, row 0 at the top:
 * x = 2(i + ½ + jx)/W − 1, y = 1 − 2(j + ½ + jy)/H.
 *
 * `jitter` is an offset from the texel's center, in [−½, ½)²; (0, 0) is the
 * center. Every reader of a trace, history or depth texel goes through this
 * and `screenTexel`, so none of them flips: a compute pass has no quad to put
 * `v = 0` at the top for it.
 */
export function traceScreen(
  pixel: Node<'uvec2'>,
  jitter: Node<'vec2'>,
  extent: Node<'vec2'>,
): Node<'vec2'> {
  const point = vec2(pixel).add(0.5).add(jitter)
  return vec2(
    point.x.mul(2).div(extent.x).sub(1),
    float(1).sub(point.y.mul(2).div(extent.y)),
  )
}

/** An image point → the integer texel of a texture of `extent`, row 0 at the top. */
export function screenTexel(
  screen: Node<'vec2'>,
  extent: Node<'vec2'>,
): Node<'ivec2'> {
  const x = screen.x.add(1).mul(0.5).mul(extent.x)
  const y = float(1).sub(screen.y).mul(0.5).mul(extent.y)
  return ivec2(
    vec2(
      clamp(floor(x), 0, extent.x.sub(1)),
      clamp(floor(y), 0, extent.y.sub(1)),
    ),
  )
}

/**
 * The body-fixed unit direction through an image point:
 * normalize(forward + right·x·plane.x + up·y·plane.y), the basis rotated on
 * the CPU.
 */
export function viewDirection(
  camera: CloudCameraUniforms,
  screen: Node<'vec2'>,
): Node<'vec3'> {
  return normalize(
    camera.forward
      .add(camera.right.mul(screen.x.mul(camera.plane.x)))
      .add(camera.up.mul(screen.y.mul(camera.plane.y))),
  )
}

/** Two crossings, sorted, and whether the sphere is met at all. */
export interface ShellCrossing {
  readonly near: Node<'float'>
  readonly far: Node<'float'>
  readonly hit: Node<'bool'>
}

/*
 * t² + 2bt + c = 0 by the stable form: q = −(b + σ√D), roots q and c/q.
 * σ is a select and not `sign`, whose 0 at b = 0 would make an exactly level
 * ray's q zero and its second root c/0; and the second root is 0 where q is,
 * which happens only for a level ray from an eye on the boundary, whose two
 * crossings are both 0. No −b + √D: that cancels to nothing on every ray that
 * meets a shell near the eye.
 */
function stableRoots(b: Node<'float'>, c: Node<'float'>): ShellCrossing {
  const d = b.mul(b).sub(c)
  const sigma = select(b.greaterThanEqual(0), float(1), float(-1))
  const q = b.add(sigma.mul(sqrt(max(d, 0)))).negate()
  const nonzero = q.notEqual(0)
  const other = select(nonzero, c.div(select(nonzero, q, float(1))), float(0))
  return {
    near: min(q, other),
    far: max(q, other),
    hit: d.greaterThanEqual(0),
  }
}

/** r_e = R + h_e: float32 here, and only ever multiplied, never subtracted from. */
const eyeRadius = (body: CloudBodyUniforms): Node<'float'> =>
  body.datumRadius.add(body.eye)

/**
 * A boundary's crossings for a ray of up-cosine `mu` from the eye (§5.2):
 * b = r_e·μ and c = (h_e − h_s)(2R + h_e + h_s), with `eyeOver` = h_e − h_s
 * formed on the CPU, so a level ray from an eye on a boundary is (0, 0) and
 * never 0/0.
 */
export function shellCrossing(
  body: CloudBodyUniforms,
  mu: Node<'float'>,
  eyeOver: Node<'float'>,
  boundary: Node<'float'>,
): ShellCrossing {
  const c = eyeOver.mul(body.datumRadius.mul(2).add(body.eye).add(boundary))
  return stableRoots(eyeRadius(body).mul(mu), c)
}

/**
 * The same quadratic for a ray from an eye-relative origin `o₀` along `d̂`:
 * s² + 2s·[r_e(up·d̂) + o₀·d̂] + [c₀ + 2r_e(up·o₀) + o₀·o₀] = 0, with
 * c₀ = (h_e − h_b)(2R + h_e + h_b). The sun grid's bake and the far atlas's
 * sun rays, which do not pass through the eye. h_e − h_b is two heights, not two radii.
 */
export function shellCrossingFrom(
  body: CloudBodyUniforms,
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  boundary: Node<'float'>,
): ShellCrossing {
  const re = eyeRadius(body)
  const b = re.mul(dot(body.up, direction)).add(dot(origin, direction))
  const c0 = body.eye
    .sub(boundary)
    .mul(body.datumRadius.mul(2).add(body.eye).add(boundary))
  const c = c0.add(re.mul(dot(body.up, origin)).mul(2)).add(dot(origin, origin))
  return stableRoots(b, c)
}

/** Farther than any span: a ray with no ground ahead of it. */
const NO_GROUND = 1e30

/**
 * The ray through `direction`: μ, ν, and its span inside the shell union,
 * clipped to [0, stop] (true meters) and to the datum ahead, from heights.
 * `hit` false when the span is empty.
 *
 * The union is the lowest base's sphere to the highest top's: an eye inside
 * starts at 0, an eye below starts where it leaves the base's sphere, an eye
 * above where it enters the top's. A ray that dips under the base and comes
 * back up is held to its first interval.
 */
export function cloudRay(
  direction: Node<'vec3'>,
  body: CloudBodyUniforms,
  stop: Node<'float'>,
): CloudRay & { readonly hit: Node<'bool'> } {
  const mu = dot(direction, body.up)
  const nu = dot(direction, body.sun)
  const base = shellCrossing(body, mu, body.eyeOver.x, body.boundaries.x)
  const top = shellCrossing(body, mu, body.eyeOverHigh.y, body.boundariesHigh.y)
  const ground = shellCrossing(body, mu, body.eye, float(0))
  const belowBase = body.eyeOver.x.lessThan(0)
  const insideTop = body.eyeOverHigh.y.lessThanEqual(0)
  const entry = select(
    belowBase,
    base.far,
    select(insideTop, float(0), top.near),
  )
  const exit = select(
    base.hit.and(base.near.greaterThan(entry)),
    base.near,
    top.far,
  )
  // The datum ahead of an eye above it: under it, the scene's own depth stops
  // the ray at the ground it stands on.
  const floorAhead = body.eye
    .greaterThan(0)
    .and(ground.hit)
    .and(ground.near.greaterThan(0))
  const start = max(entry, 0)
  const end = min(
    min(exit, stop),
    select(floorAhead, ground.near, float(NO_GROUND)),
  )
  return {
    direction,
    mu,
    nu,
    start,
    end,
    hit: insideTop.or(top.hit).and(end.greaterThan(start)),
  }
}

/*
 * h = (h_e(2R + h_e) + 2r_e·u + l²)/(r + R) with r² = R² + that numerator:
 * u is μ·t along a ray and up·o at a point, l² is t² or o·o. The numerator
 * reaches 1.3 × 10¹³ m² for Earth from 400 km toward the limb, where float32
 * resolves 10⁶, so the quotient by about 2R carries a decimeter; r enters
 * only the denominator, where its half-meter float32 step is 10⁻⁷ of it.
 */
function heightFrom(
  body: CloudBodyUniforms,
  up: Node<'float'>,
  lengthSquared: Node<'float'>,
): { readonly height: Node<'float'>; readonly radius: Node<'float'> } {
  const R = body.datumRadius
  const numerator = body.eyeTerm
    .add(eyeRadius(body).mul(up).mul(2))
    .add(lengthSquared)
  const radius = sqrt(max(R.mul(R).add(numerator), 0))
  return { height: numerator.div(radius.add(R)), radius }
}

/** Height over the datum at distance t along a ray of up-cosine mu (§5.3). */
export function altitudeAlong(
  body: CloudBodyUniforms,
  mu: Node<'float'>,
  t: Node<'float'>,
): Node<'float'> {
  return heightFrom(body, mu.mul(t), t.mul(t)).height
}

/**
 * Height over the datum of an eye-relative point: §5.3 with μ·t → up·o and
 * t² → o·o. The light taps, the sun grid's bake and the volume bake all
 * take their heights here (rule 52); none forms length(eye + o) − R.
 */
export function altitudeAt(
  body: CloudBodyUniforms,
  offset: Node<'vec3'>,
): Node<'float'> {
  return heightFrom(body, dot(body.up, offset), dot(offset, offset)).height
}

/**
 * The sun's cosine over the horizontal at an eye-relative point:
 * (r_e·μ_sun,e + o·ŝ)/r(o), from heights rather than normalize(eye + o).
 */
export function sunMuAt(
  body: CloudBodyUniforms,
  offset: Node<'vec3'>,
): Node<'float'> {
  const { radius } = heightFrom(body, dot(body.up, offset), dot(offset, offset))
  return eyeRadius(body)
    .mul(body.sunUp)
    .add(dot(offset, body.sun))
    .div(max(radius, 1))
}

/** The sample at distance t along a ray, with its footprint, pixelAngle·t. */
export function cloudSample(
  ray: CloudRay,
  t: Node<'float'>,
  body: CloudBodyUniforms,
  pixelAngle: Node<'float'>,
): CloudSample {
  const { height, radius } = heightFrom(body, ray.mu.mul(t), t.mul(t))
  return {
    offset: ray.direction.mul(t),
    distance: t,
    altitude: height,
    sunMu: eyeRadius(body)
      .mul(body.sunUp)
      .add(t.mul(ray.nu))
      .div(max(radius, 1)),
    footprint: pixelAngle.mul(t),
  }
}

/**
 * A level's gnomonic plane coordinates of an eye-relative point, formed
 * eye-relatively (§3.9): u(e + o) = u(e) + Δu with
 * Δu = R/(e·A + o·A)·[o·E − (e·E)(o·A)/(e·A)], the eye's u(e) and
 * (e·A, e·E, e·N) from the CPU in float64. Never from an absolute direction
 * (rule 58): normalizing `eyeDirection·R + offset` in float32 carries 0.4 m
 * on Earth, 1% of a 50 m volume texel and moving with the eye. `body` gives
 * R, the plane's distance from the center.
 */
export function levelPlane(
  level: CloudLevelUniforms,
  offset: Node<'vec3'>,
  body: CloudBodyUniforms,
): Node<'vec2'> {
  const oA = dot(offset, level.anchor)
  const eA = level.along.x
  const scale = body.datumRadius.div(eA.add(oA))
  const du = dot(offset, level.east).sub(level.along.y.mul(oA).div(eA))
  const dv = dot(offset, level.north).sub(level.along.z.mul(oA).div(eA))
  return level.eye.add(vec2(du, dv).mul(scale))
}

/**
 * Plane coordinates → the level's continuous texel coordinates, texel (i, j)
 * covering [i, i + 1) × [j, j + 1) and stored at (i mod size, j mod size):
 * divided by the level's size this is the uv a repeat-wrapped read takes, so
 * a read across the window's wrap filters as it does anywhere else. The
 * window holds a coordinate c when origin ≤ c < origin + size.
 */
export function levelTexel(
  level: CloudLevelUniforms,
  plane: Node<'vec2'>,
): Node<'vec2'> {
  return plane.div(level.texel)
}

/**
 * The inverse, for a bake: the eye-relative offset of the point at `plane`
 * and `height` over the datum. With ρ = √(R² + u² + v²) and s = (R + h)/ρ,
 * o = A·[(h − h_e) − (R + h)(u² + v²)/((ρ + R)ρ) + ((e·E)² + (e·N)²)/(r_e + e·A)]
 *   + E·(s·u − e·E) + N·(s·v − e·N),
 * every term formed without subtracting two radii (rules 52, 58).
 */
export function levelOffset(
  level: CloudLevelUniforms,
  plane: Node<'vec2'>,
  height: Node<'float'>,
  body: CloudBodyUniforms,
): Node<'vec3'> {
  const R = body.datumRadius
  const u = plane.x
  const v = plane.y
  const spread = u.mul(u).add(v.mul(v))
  const rho = sqrt(R.mul(R).add(spread))
  const lifted = R.add(height)
  const s = lifted.div(rho)
  const eA = level.along.x
  const eE = level.along.y
  const eN = level.along.z
  const along = height
    .sub(body.eye)
    .sub(lifted.mul(spread).div(rho.add(R).mul(rho)))
    .add(eE.mul(eE).add(eN.mul(eN)).div(eyeRadius(body).add(eA)))
  return level.anchor
    .mul(along)
    .add(level.east.mul(s.mul(u).sub(eE)))
    .add(level.north.mul(s.mul(v).sub(eN)))
}

const facesAxis = (axis: 'normal' | 'a' | 'b'): Node<'vec3'>[] =>
  CUBE_FACES.map((face) => vec3(face[axis].x, face[axis].y, face[axis].z))

const FACE_NORMALS = /*@__PURE__*/ facesAxis('normal')
const FACE_A = /*@__PURE__*/ facesAxis('a')
const FACE_B = /*@__PURE__*/ facesAxis('b')

/**
 * A body-fixed direction → the atlas uv of its face tile, gutters included
 * (`cubeSphere.ts`'s faces and warp). For the cube and the far atlases, whose
 * texels are 19.6 km and up: a coarse lookup, not a lattice.
 *
 * Face f is the tile at column f mod `columns` and row ⌊f/columns⌋, its
 * warped a along the atlas's x and b down its rows; a tile is `tile` texels
 * and a `gutter` each side, so texel i of a tile has its center at warped
 * coordinate −1 + (2(i − gutter) + 1)/tile. uv (0, 0) is texel (0, 0), the
 * first row in memory, which a `QuadMesh`'s `uv()` addresses alike. A
 * direction belongs to the face of its largest component, ties to the
 * earlier axis, as `CUBE_FACES` says.
 */
export function cubeAtlasUv(
  direction: Node<'vec3'>,
  tile: number,
  gutter: number,
  columns: number,
  rows: number,
): Node<'vec2'> {
  const ax = abs(direction.x)
  const ay = abs(direction.y)
  const az = abs(direction.z)
  const xMajor = ax.greaterThanEqual(ay).and(ax.greaterThanEqual(az))
  const yMajor = ay.greaterThanEqual(az)
  /*
   * Each face's own value, chosen by the face rule. No integer face index:
   * r185 emits `float(i32)` of a select as the bare i32, which WGSL refuses
   * to divide by a float, and the face's column and row are as easily chosen
   * as its axes.
   */
  function onFace<T extends Node<'vec3'> | Node<'float'>>(
    values: readonly T[],
  ): T {
    return select(
      xMajor,
      select(direction.x.greaterThanEqual(0), values[0]!, values[1]!),
      select(
        yMajor,
        select(direction.y.greaterThanEqual(0), values[2]!, values[3]!),
        select(direction.z.greaterThanEqual(0), values[4]!, values[5]!),
      ),
    ) as T
  }
  const depth = dot(direction, onFace(FACE_NORMALS))
  const toWarped = 4 / Math.PI
  const a = atan(dot(direction, onFace(FACE_A)).div(depth)).mul(toWarped)
  const b = atan(dot(direction, onFace(FACE_B)).div(depth)).mul(toWarped)
  const span = tile + 2 * gutter
  const faces = CUBE_FACES.map((_, f) => f)
  const column = onFace(faces.map((f) => float(f % columns)))
  const row = onFace(faces.map((f) => float(Math.floor(f / columns))))
  const x = column
    .mul(span)
    .add(gutter)
    .add(a.add(1).mul(0.5 * tile))
  const y = row
    .mul(span)
    .add(gutter)
    .add(b.add(1).mul(0.5 * tile))
  return vec2(x.div(columns * span), y.div(rows * span))
}
