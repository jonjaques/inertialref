import {
  type BufferAttribute,
  type InterleavedBufferAttribute,
  Matrix4,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  Sphere,
  Vector3,
} from 'three/webgpu'

/*
 * Whether a drawn model is under a point on screen, by its own triangles.
 *
 * A spacecraft's bounding sphere is no picture of it. The ISS's holds every
 * angle the arrays can reach, so it is far larger than the station inside
 * it, and a click on Earth between two wings lands inside it. What is tested
 * here is what the frame drew: every triangle, through the camera that drew
 * it, with the transforms the last frame left — the arrays where they were
 * turned, the station where it was placed.
 *
 * In screen space rather than along a ray, because the question has a reach.
 * A truss seen end-on is a pixel wide, and "within eight pixels of it" is the
 * distance from a point to a projected triangle, which no ray measures. Each
 * triangle is clipped to the near plane first: one reaching behind the eye
 * projects through infinity, and its far half lands on the wrong side of the
 * screen.
 *
 * No acceleration structure, because it runs on a click and never per frame.
 * A mesh whose bounding sphere is out of reach is passed over by its angle
 * from the line of sight, so a click across the screen from the station costs
 * 0.01 ms. The worst case is the pointer inside the station's sphere and off
 * the station, where every triangle is read: 8.6 ms for the ISS's 359,970 on
 * this M5, and 14 ms for the first click of a session, before the JIT has
 * seen the loop. At zero reach it agrees with three's `Raycaster` on all
 * 1,125 pixels of five poses, two of them from inside the sphere, where
 * triangles cross the near plane.
 */

/** The point, the reach and the screen, for the click being tested. */
const probe = {
  x: 0,
  y: 0,
  reach: 0,
  width: 0,
  height: 0,
  /** The near plane, in clip `w`: a perspective camera's `w` is view depth. */
  near: 0,
  /** The reach as an angle, at least as wide as the reach anywhere on screen. */
  slack: 0,
}
const aim = new Vector3()
const bounds = new Sphere()
const center = new Vector3()
const clipFromLocal = new Matrix4()
const viewFromClip = new Matrix4()
// A triangle's corners in clip space, then the polygon it clips to, in pixels.
const clipX = new Float64Array(3)
const clipY = new Float64Array(3)
const clipW = new Float64Array(3)
const screenX = new Float64Array(4)
const screenY = new Float64Array(4)

/**
 * Whether any triangle of `root`, as `camera` drew it, comes within `reach`
 * pixels of `point`.
 *
 * `point` and `size` are CSS pixels with the origin top left, as
 * `planetarium/project.ts` places a candidate. The matrices are the ones the
 * last frame rendered with, and that is the point: a click is aimed at the
 * picture on screen, not at a pose the next frame has not drawn.
 */
export function modelNear(
  root: Object3D,
  camera: PerspectiveCamera,
  point: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  reach: number,
): boolean {
  const [m0, , , , , m5] = camera.projectionMatrix.elements
  probe.x = point.x
  probe.y = point.y
  probe.reach = reach
  probe.width = size.width
  probe.height = size.height
  probe.near = camera.near
  // Pixels per radian where the projection magnifies least, at the principal
  // point: an angle of `reach / perRadian` covers `reach` pixels or more
  // wherever it falls, so a sphere culled by it is out of reach everywhere.
  const perRadian = Math.min(m0 * size.width, m5 * size.height) / 2
  probe.slack = perRadian > 0 ? reach / perRadian : Math.PI
  viewFromClip.copy(camera.projectionMatrix).invert()
  aim
    .set((point.x / size.width) * 2 - 1, 1 - (point.y / size.height) * 2, 0.5)
    .applyMatrix4(viewFromClip)
    .normalize()
  return objectNear(root, camera)
}

function objectNear(object: Object3D, camera: PerspectiveCamera): boolean {
  if (!object.visible) return false
  if ((object as Mesh).isMesh === true && meshNear(object as Mesh, camera))
    return true
  for (const child of object.children)
    if (objectNear(child, camera)) return true
  return false
}

function meshNear(mesh: Mesh, camera: PerspectiveCamera): boolean {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position') as
    BufferAttribute | InterleavedBufferAttribute | undefined
  if (position === undefined) return false
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere()
  if (geometry.boundingSphere === null) return false
  bounds.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld)
  center.copy(bounds.center).applyMatrix4(camera.matrixWorldInverse)
  const distance = center.length()
  if (distance > bounds.radius) {
    const off = Math.acos(Math.min(1, Math.max(-1, center.dot(aim) / distance)))
    if (off > Math.asin(bounds.radius / distance) + probe.slack) return false
  }
  clipFromLocal
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(mesh.matrixWorld)
  const [m0, m1, , m3, m4, m5, , m7, m8, m9, , m11, m12, m13, , m15] =
    clipFromLocal.elements
  const index = geometry.index
  const total = index === null ? position.count : index.count
  const start = Math.max(0, geometry.drawRange.start)
  const end = Math.min(total, start + geometry.drawRange.count)
  for (let first = start; first + 2 < end; first += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex =
        index === null ? first + corner : index.getX(first + corner)
      const x = position.getX(vertex)
      const y = position.getY(vertex)
      const z = position.getZ(vertex)
      clipX[corner] = m0 * x + m4 * y + m8 * z + m12
      clipY[corner] = m1 * x + m5 * y + m9 * z + m13
      clipW[corner] = m3 * x + m7 * y + m11 * z + m15
    }
    if (triangleNear()) return true
  }
  return false
}

/** The triangle in `clip*`, clipped to the near plane and tested in pixels. */
function triangleNear(): boolean {
  const near = probe.near
  let corners = 0
  for (let i = 0; i < 3; i += 1) {
    const j = i === 2 ? 0 : i + 1
    const wi = clipW[i]!
    const wj = clipW[j]!
    if (wi >= near) {
      onScreen(corners, clipX[i]!, clipY[i]!, wi)
      corners += 1
    }
    // An edge crossing the plane adds the point where it crosses.
    if (wi >= near !== wj >= near) {
      const t = (near - wi) / (wj - wi)
      onScreen(
        corners,
        clipX[i]! + t * (clipX[j]! - clipX[i]!),
        clipY[i]! + t * (clipY[j]! - clipY[i]!),
        near,
      )
      corners += 1
    }
  }
  return corners >= 3 && polygonNear(corners)
}

function onScreen(slot: number, x: number, y: number, w: number): void {
  screenX[slot] = ((x / w) * 0.5 + 0.5) * probe.width
  screenY[slot] = (0.5 - (y / w) * 0.5) * probe.height
}

/** Whether the probe is inside the convex polygon in `screen*`, or in reach of it. */
function polygonNear(corners: number): boolean {
  const { x, y, reach } = probe
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (let i = 0; i < corners; i += 1) {
    left = Math.min(left, screenX[i]!)
    right = Math.max(right, screenX[i]!)
    top = Math.min(top, screenY[i]!)
    bottom = Math.max(bottom, screenY[i]!)
  }
  if (
    x < left - reach ||
    x > right + reach ||
    y < top - reach ||
    y > bottom + reach
  )
    return false
  // Inside a polygon with area is the same side of every edge. One with none
  // — a triangle seen edge-on — has no inside, only edges to be near.
  let ahead = false
  let behind = false
  for (let i = 0; i < corners; i += 1) {
    const j = i + 1 === corners ? 0 : i + 1
    const side =
      (screenX[j]! - screenX[i]!) * (y - screenY[i]!) -
      (screenY[j]! - screenY[i]!) * (x - screenX[i]!)
    if (side > 0) ahead = true
    else if (side < 0) behind = true
  }
  if (ahead !== behind) return true
  for (let i = 0; i < corners; i += 1) {
    const j = i + 1 === corners ? 0 : i + 1
    if (
      segmentDistance(
        x,
        y,
        screenX[i]!,
        screenY[i]!,
        screenX[j]!,
        screenY[j]!,
      ) <= reach
    )
      return true
  }
  return false
}

function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t =
    length === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}
