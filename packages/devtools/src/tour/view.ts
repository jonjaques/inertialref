import {
  angularRadius,
  LENS_PRESETS,
  verticalFov,
  type Lens,
} from '@inertialref/rendering'
import { Quaternion as Q, UV, Vec, type Vec3 } from '@inertialref/spatial'
import {
  bodyFrameId,
  formatAddress,
  systemFrameId,
  walkBodies,
} from '@inertialref/universe'
import type { GameHarness } from '../harness.ts'

/*
 * The scene, as things on screen, without a renderer.
 *
 * This is the guide's eyes. `describe_view` answers "what is that bright point
 * to the left of Saturn?" from the same geometry the planetarium draws its
 * labels from — the observatory's pose and the frame graph at the picture
 * time — but it runs headlessly, because a tool the drive script and a Node
 * test cannot execute is a tool nobody can prove. `planetarium/project.ts`
 * projects the rendered scene through the Three.js camera for the labels and
 * the hit test; this projects the same bodies through the same pose with the
 * same lens, and the two agree to within the render origin's rebase window.
 *
 * Nothing here samples, eases or writes. `pose()` is a read of the pose the
 * next frame would be drawn from, and `frames.pose(id, t)` is a read of the
 * frame graph at an instant. The world's hash is the same after a call as
 * before, which `view.test.ts` asserts.
 */

/** Where a body sits in the frame, in the words a guide would use. */
export interface ViewSubject {
  readonly name: string
  readonly address: string
  readonly kind: string
  /** Normalized screen position: x to the right, y up, each in [−1, 1]. */
  readonly x: number
  readonly y: number
  readonly place: string
  /** The disk's diameter as a fraction of the frame height. */
  readonly size: number
  readonly extent: 'fills' | 'large' | 'small' | 'point'
  /** Fraction of the visible disk that is sunlit, 0 to 1. */
  readonly lit: number
  readonly distanceMeters: number
}

export interface ViewDescription {
  readonly subject: {
    readonly name: string
    readonly address: string
    readonly kind: string
  } | null
  readonly system: { readonly id: string; readonly name: string } | null
  readonly standing: {
    readonly site: string | null
    readonly headingDeg: number
    readonly pitchDeg: number
    readonly heightMeters: number
    /** The sun's angle above the local horizon; negative is night. */
    readonly sunAltitudeDeg: number | null
    readonly daylight: 'day' | 'twilight' | 'night' | 'unknown'
  } | null
  readonly traveling: boolean
  readonly motion: boolean
  /** Seconds from J2000, the instant the picture depicts. */
  readonly pictureTime: number
  readonly timeMode: 'live' | 'held' | 'paused' | 'rate'
  readonly timeScale: number
  readonly distanceRadii: number | null
  readonly fill: number
  readonly verticalFovDegrees: number
  /** Largest first, bounded. */
  readonly onScreen: readonly ViewSubject[]
}

export interface ViewOptions {
  /** The lens the frame is composed through. Headlessly, the flight lens. */
  readonly lens?: Lens
  /** Width over height of the frame. Headlessly, the 16:9 default window. */
  readonly aspect?: number
  readonly limit?: number
}

/** Words for a normalized position, coarse on purpose: the guide speaks them. */
export function placeWord(x: number, y: number): string {
  const edge = 0.85
  const near = 0.18
  const horizontal =
    Math.abs(x) < near
      ? ''
      : `${x < 0 ? 'left' : 'right'}${Math.abs(x) > edge ? ' edge' : ''}`
  const vertical = Math.abs(y) < near ? '' : y > 0 ? 'upper' : 'lower'
  if (!horizontal && !vertical) return 'center'
  if (!horizontal) return vertical === 'upper' ? 'top' : 'bottom'
  return vertical ? `${vertical} ${horizontal}` : horizontal
}

function extentWord(size: number): ViewSubject['extent'] {
  if (size >= 0.9) return 'fills'
  if (size >= 0.25) return 'large'
  if (size >= 0.02) return 'small'
  return 'point'
}

interface Candidate {
  readonly name: string
  readonly address: string
  readonly kind: string
  readonly direction: Vec3
  readonly range: number
  readonly angular: number
  readonly x: number
  readonly y: number
  readonly lit: number
}

export function describeView(
  harness: GameHarness,
  options: ViewOptions = {},
): ViewDescription {
  const eye = harness.observatory
  const status = eye.status()
  const lens = options.lens ?? LENS_PRESETS.flight
  const fov = verticalFov(lens)
  const aspect = options.aspect ?? 16 / 9
  const halfV = fov / 2
  const halfH = Math.atan(Math.tan(halfV) * aspect)
  const target = status.target
  const timeMode: ViewDescription['timeMode'] =
    status.heldTime === null
      ? 'live'
      : status.timePaused
        ? 'paused'
        : status.timeScale !== 1
          ? 'rate'
          : 'held'
  const base = {
    traveling: status.traveling,
    motion: status.motion !== null,
    pictureTime: status.time,
    timeMode,
    timeScale: status.timeScale,
    fill: status.fill,
    verticalFovDegrees: (fov * 180) / Math.PI,
  }
  const pose = eye.pose()
  const system =
    target === null ? undefined : harness.world.system(target.system)
  if (target === null || pose === null || system === undefined)
    return {
      ...base,
      subject: null,
      system: null,
      standing: null,
      distanceRadii: null,
      onScreen: [],
    }
  const world = harness.world
  const time = status.time
  const star = world.frames.pose(systemFrameId(system.id), time).position
  const toStarFrom = (position: typeof star): Vec3 =>
    Vec.normalize(UV.difference(star, position))
  const candidates: Candidate[] = []
  const consider = (
    name: string,
    address: string,
    kind: string,
    position: typeof star,
    radius: number,
    lit: number,
  ): void => {
    const relative = UV.difference(position, pose.position)
    const range = Vec.length(relative)
    if (!(range > 0)) return
    const camera = Q.rotateInverse(pose.orientation, relative)
    // −Z is forward. Behind the eye projects to a plausible pair of screen
    // coordinates, so the depth check comes before anything else.
    const depth = -camera.z
    const angular = angularRadius(radius, range)
    if (depth <= 0) return
    const x = Math.atan2(camera.x, depth) / halfH
    const y = Math.atan2(camera.y, depth) / halfV
    // A disk may overlap the edge while its center is outside the frame.
    if (Math.abs(x) > 1 + angular / halfH || Math.abs(y) > 1 + angular / halfV)
      return
    candidates.push({
      name,
      address,
      kind,
      direction: Vec.scale(relative, 1 / range),
      range,
      angular,
      x,
      y,
      lit,
    })
  }
  consider(
    system.star.name,
    formatAddress(system.address),
    'star',
    star,
    system.star.radius,
    1,
  )
  for (const body of walkBodies(system)) {
    let position: typeof star
    try {
      position = world.frames.pose(bodyFrameId(body.address), time).position
    } catch {
      continue
    }
    const toEye = Vec.normalize(UV.difference(pose.position, position))
    const phase = Vec.dot(toStarFrom(position), toEye)
    consider(
      body.name,
      formatAddress(body.address),
      body.kind,
      position,
      body.radius,
      (1 + phase) / 2,
    )
  }
  // A body behind a nearer disk is not on screen, whatever its projection
  // says. Nearer first, so each body is tested against what can hide it.
  candidates.sort((a, b) => a.range - b.range)
  const visible: Candidate[] = []
  for (const candidate of candidates) {
    const hidden = visible.some((nearer) => {
      const separation = Math.acos(
        Math.min(
          1,
          Math.max(-1, Vec.dot(nearer.direction, candidate.direction)),
        ),
      )
      return separation + candidate.angular * 0.5 < nearer.angular
    })
    if (!hidden) visible.push(candidate)
  }
  const onScreen = visible
    .map((candidate): ViewSubject => {
      const size = (2 * candidate.angular) / fov
      return {
        name: candidate.name,
        address: candidate.address,
        kind: candidate.kind,
        x: round(candidate.x),
        y: round(candidate.y),
        place: placeWord(candidate.x, candidate.y),
        size: round(size, 4),
        extent: extentWord(size),
        lit: round(candidate.lit),
        distanceMeters: candidate.range,
      }
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, options.limit ?? 12)
  const surface = status.surface
  // The observatory's target says planet or moon; the record says gas giant
  // or ice, which is what the guide should call it.
  const body = [...walkBodies(system)].find(
    (item) => formatAddress(item.address) === target.address,
  )
  let standing: ViewDescription['standing'] = null
  if (surface !== null) {
    let sunAltitudeDeg: number | null = null
    if (body !== undefined) {
      try {
        const center = world.frames.pose(
          bodyFrameId(body.address),
          time,
        ).position
        const up = Vec.normalize(UV.difference(pose.position, center))
        sunAltitudeDeg =
          (Math.asin(
            Math.min(1, Math.max(-1, Vec.dot(up, toStarFrom(center)))),
          ) *
            180) /
          Math.PI
      } catch {
        sunAltitudeDeg = null
      }
    }
    standing = {
      site: surface.site,
      headingDeg: round((surface.stance.heading * 180) / Math.PI, 1),
      pitchDeg: round((surface.stance.pitch * 180) / Math.PI, 1),
      heightMeters: surface.stance.height,
      sunAltitudeDeg: sunAltitudeDeg === null ? null : round(sunAltitudeDeg, 1),
      daylight:
        sunAltitudeDeg === null
          ? 'unknown'
          : sunAltitudeDeg > 6
            ? 'day'
            : sunAltitudeDeg > -12
              ? 'twilight'
              : 'night',
    }
  }
  return {
    ...base,
    subject: {
      name: target.name,
      address: target.address,
      kind: body?.kind ?? target.kind,
    },
    system: { id: system.id, name: system.name },
    standing,
    distanceRadii:
      surface !== null || target.radius <= 0
        ? null
        : round(status.state.distance / target.radius, 2),
    onScreen,
  }
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
