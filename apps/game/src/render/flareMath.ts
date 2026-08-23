/*
 * The lens flare's geometry, kept free of Three.js so it runs under Node.
 *
 * A flare is a property of the *camera*, not the sky, and the two questions it
 * asks every frame are pure arithmetic: is the star actually visible from
 * here, and is it about to slip behind a limb. Answering them by reading the
 * depth buffer back is the classic approach and is a pipeline stall on WebGPU;
 * answering them against the scene description is exact, free, and testable —
 * the renderer already knows where every body is and how big it is.
 */

export interface FlareVector {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface FlareOccluder {
  /** Body center, render space. */
  readonly position: FlareVector
  /** Drawn radius, render space. */
  readonly radius: number
}

/**
 * The body actually in front of the star, when one is.
 *
 * A star does not stop existing when a planet crosses it: its corona and the
 * light bent around the limb outline the occluder, which is the whole picture
 * of an eclipse and the one thing the visibility ramp alone cannot say. The
 * flare needs the occluder's *own* position and size to draw that ring, so the
 * visibility test — which already has both in hand — hands them back.
 */
export interface FlareEclipse {
  /** The occluder's center, render space. */
  readonly position: FlareVector
  /** Its drawn radius, render space. */
  readonly radius: number
  /** Its distance from the camera, render space. */
  readonly distance: number
  /** How deep the eclipse is: 0 at first contact, 1 at full occultation. */
  readonly depth: number
}

export interface FlareVisibility {
  /**
   * How much of the flare survives, 0..1. Zero behind a body, one in the
   * clear, and a smooth ramp across the limb — the ramp is the sunset: a
   * finite solar disk does not blink out, it slides under the horizon.
   */
  readonly visibility: number
  /**
   * How close the sight line grazes the nearest limb, 1 at the limb rising to
   * 0 away from it. This drives the flare's reddening: a star seen just over
   * a limb is seen through the deepest possible slant of that body's air,
   * whatever color that body reddens light to.
   */
  readonly graze: number
  /** The body in front of the star, deepest first; null in the clear. */
  readonly eclipse: FlareEclipse | null
}

/** Below this the flare is fully eclipsed; above the outer edge, untouched. */
const ECLIPSE_INNER = 0.985
const ECLIPSE_OUTER = 1.03
/** The graze band: how far past the limb the reddening reaches. */
const GRAZE_OUTER = 1.3

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Visibility of `sun` from `camera` past a set of spherical occluders.
 *
 * Each body's contribution comes from the closest approach of the sight
 * *segment* to its center — the segment, not the line, because a body behind
 * the camera or beyond the star occludes nothing however well aligned it is.
 */
export function sunVisibility(
  camera: FlareVector,
  sun: FlareVector,
  occluders: readonly FlareOccluder[],
): FlareVisibility {
  const dx = sun.x - camera.x
  const dy = sun.y - camera.y
  const dz = sun.z - camera.z
  const span = Math.hypot(dx, dy, dz)
  if (span === 0) return { visibility: 1, graze: 0, eclipse: null }

  let visibility = 1
  let graze = 0
  let eclipse: FlareEclipse | null = null
  for (const body of occluders) {
    if (body.radius <= 0) continue
    const ox = body.position.x - camera.x
    const oy = body.position.y - camera.y
    const oz = body.position.z - camera.z
    const along = (ox * dx + oy * dy + oz * dz) / span
    // Behind the camera, or beyond the star: out of the sight line entirely.
    const t = Math.min(Math.max(along, 0), span)
    const cx = ox - (dx / span) * t
    const cy = oy - (dy / span) * t
    const cz = oz - (dz / span) * t
    const closest = Math.hypot(cx, cy, cz)
    const ratio = closest / body.radius

    visibility *= smooth(ECLIPSE_INNER, ECLIPSE_OUTER, ratio)
    // Only a body actually in front of the camera can put its limb in the
    // shot. The graze band is one-sided: inside the eclipse it is the
    // eclipse's problem.
    if (along > 0) {
      graze = Math.max(graze, 1 - smooth(1, GRAZE_OUTER, ratio))
      const depth = 1 - smooth(ECLIPSE_INNER, ECLIPSE_OUTER, ratio)
      if (depth > 0 && (eclipse === null || depth > eclipse.depth)) {
        eclipse = {
          position: body.position,
          radius: body.radius,
          distance: Math.hypot(ox, oy, oz),
          depth,
        }
      }
    }
  }
  return { visibility, graze, eclipse }
}

/**
 * Where each flare element sits on screen: on the line from the star's image
 * through the frame's center, at parameter `t` — 0 on the star, 1 at the
 * center, beyond 1 mirrored past it. That line is the axis of symmetry of a
 * real lens, which is why every photographed ghost lies on it.
 */
export const ghostPosition = (
  sunNdcX: number,
  sunNdcY: number,
  t: number,
): { readonly x: number; readonly y: number } => ({
  x: sunNdcX * (1 - t),
  y: sunNdcY * (1 - t),
})

/** Fade as the star's image leaves the frame; a lens flares what it sees. */
export function edgeFade(sunNdcX: number, sunNdcY: number): number {
  const edge = Math.max(Math.abs(sunNdcX), Math.abs(sunNdcY))
  return 1 - smooth(1.1, 1.5, edge)
}
