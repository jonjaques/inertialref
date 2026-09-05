import { useEffect, useRef } from 'react'
import {
  type Quat,
  Quaternion as Q,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  attitudeOf,
  horizonDirection,
  hullInHorizon,
  INERTIAL_HORIZON,
  onBall,
} from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { formatDegrees, formatHeading } from './navCluster.ts'
import { useDevicePixelRatio } from './viewport.ts'

/*
 * The attitude indicator: a sphere painted with the horizon, seen from
 * inside the hull.
 *
 * ## Why it is a canvas in a rAF loop
 *
 * The ball turns with the hull, which is every frame, and what it draws is
 * sixteen hundred points of a lattice projected through one quaternion. A
 * React tree of SVG paths would reconcile that at the display rate for a
 * picture that never changes shape, only pose — the same argument
 * `TrackOverlay.tsx` makes for its boxes, at a hundred times the point count.
 * And the 8 Hz sampler that feeds every other readout is a rate a horizon
 * cannot be drawn at: eight poses a second of a hull rolling through a flip
 * is a ball that jumps rather than turns. So this reads `engine.scene()`
 * directly — the pose the frame was drawn from, one frame behind at worst —
 * and owns nothing: the horizon is the scene's, the attitude is arithmetic in
 * `packages/rendering`, and the three figures under the ball are written
 * into text nodes when they change and not otherwise.
 *
 * ## What is painted
 *
 * Sky above the horizon in the accent at low alpha, ground below in
 * graphite; a pitch ladder every ten degrees, meridians every thirty with
 * the compass points lettered where they cross the horizon; the velocity
 * mark — a ring with a dot for where the ship is going, a ring with a cross
 * for where it came from — and a fixed level mark in the middle, which is
 * the nose. Clear of every body the horizon is the render axes themselves,
 * which is the inertial reference the game is named for, and the ball says
 * so instead of pretending a ground.
 */

/** Points along one painted line of the sphere, in horizon axes. */
type Line = readonly Vec3[]

const STEP = (5 * Math.PI) / 180

/** The pitch ladder, every ten degrees, the horizon last so it draws on top. */
const LADDER: readonly { readonly pitch: number; readonly line: Line }[] = [
  -80, -70, -60, -50, -40, -30, -20, -10, 10, 20, 30, 40, 50, 60, 70, 80, 0,
].map((degrees) => {
  const pitch = (degrees * Math.PI) / 180
  const line: Vec3[] = []
  for (let i = 0; i <= 72; i += 1) line.push(horizonDirection(i * STEP, pitch))
  return { pitch, line }
})

/** The meridians, every thirty degrees of heading, pole to pole. */
const MERIDIANS: readonly { readonly heading: number; readonly line: Line }[] =
  Array.from({ length: 12 }, (_, i) => {
    const heading = (i * Math.PI) / 6
    const line: Vec3[] = []
    for (let j = -17; j <= 17; j += 1)
      line.push(horizonDirection(heading, j * STEP))
    return { heading, line }
  })

/** What the compass says at each meridian's foot. */
const COMPASS = [
  'N',
  '030',
  '060',
  'E',
  '120',
  '150',
  'S',
  '210',
  '240',
  'W',
  '300',
  '330',
]

/** The one horizon, a whole turn at the step, for the sky's edge. */
const HORIZON = LADDER[LADDER.length - 1]?.line ?? []

const UP = vec3(0, 1, 0)

// The system's own inks, as the canvas needs them written out.
const SKY = 'rgba(14, 165, 233, 0.32)'
const GROUND = 'rgba(30, 41, 59, 0.92)'
const LADDER_INK = 'rgba(203, 213, 225, 0.55)'
const HORIZON_INK = 'rgba(241, 245, 249, 0.9)'
const MERIDIAN_INK = 'rgba(148, 163, 184, 0.35)'
const LABEL_INK = 'rgba(226, 232, 240, 0.9)'
const MARK_INK = 'rgb(186, 230, 253)'
const LEVEL_INK = 'rgb(224, 242, 254)'
const RIM = 'rgba(2, 6, 23, 0.85)'

export function NavBall({
  engine,
  size,
  /** Which velocity the mark is drawn from: against the ground, or the frame. */
  velocity,
}: {
  engine: GameEngine
  /** The ball's diameter in CSS pixels. */
  size: number
  velocity: 'surface' | 'orbit'
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const heading = useRef<HTMLSpanElement>(null)
  const pitch = useRef<HTMLSpanElement>(null)
  const roll = useRef<HTMLSpanElement>(null)
  const reference = useRef<HTMLSpanElement>(null)
  const ratio = useDevicePixelRatio()
  // The mode, for the loop, without restarting it on every change.
  const mark = useRef(velocity)
  useEffect(() => {
    mark.current = velocity
  }, [velocity])

  useEffect(() => {
    const node = canvas.current
    if (node === null) return
    const context = node.getContext('2d')
    if (context === null) return
    node.width = Math.round(size * ratio)
    node.height = Math.round(size * ratio)

    /** Written when it differs; a text node set every frame relayouts. */
    const write = (
      ref: { current: HTMLSpanElement | null },
      text: string,
    ): void => {
      const span = ref.current
      if (span !== null && span.textContent !== text) span.textContent = text
    }

    let handle = 0
    const tick = (): void => {
      handle = window.requestAnimationFrame(tick)
      const scene = engine.scene()
      const ship = scene?.entities.find((entity) => entity.isCamera)
      if (scene === undefined || scene === null || ship === undefined) {
        context.clearRect(0, 0, node.width, node.height)
        return
      }
      const horizon = scene.horizon ?? INERTIAL_HORIZON
      const local = hullInHorizon(ship.orientation, horizon)
      const attitude = attitudeOf(ship.orientation, horizon)
      write(heading, formatHeading(attitude.heading))
      write(pitch, formatDegrees(attitude.pitch))
      write(roll, formatDegrees(attitude.roll))
      write(
        reference,
        scene.horizon === null ? 'inertial' : shortName(scene.horizon.body),
      )

      const relative =
        mark.current === 'surface' && scene.horizon !== null
          ? Vec.sub(ship.velocity, scene.horizon.groundVelocity)
          : ship.velocity
      const speed = Vec.length(relative)
      // The mark is a direction in the hull's own axes, so it goes through
      // the ship's pose rather than the horizon's: `onBall` is the same
      // projection either way, and a ship not moving has no mark.
      const prograde =
        speed > 0.05
          ? onBall(ship.orientation, Vec.scale(relative, 1 / speed))
          : null

      draw(context, size, ratio, local, prograde, scene.horizon !== null)
    }
    tick()
    return () => window.cancelAnimationFrame(handle)
  }, [engine, size, ratio])

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="type-figure flex items-baseline gap-1 rounded border border-slate-700/60 bg-slate-950/85 px-2 py-0.5 text-slate-200 tabular-nums backdrop-blur">
        <span className="type-label text-sky-400/80">Hdg</span>
        <span ref={heading}>—</span>
      </div>
      <canvas
        ref={canvas}
        style={{ width: size, height: size }}
        className="rounded-full"
        role="img"
        aria-label="Attitude indicator"
      />
      <div className="type-readout flex items-baseline gap-2 rounded border border-slate-700/60 bg-slate-950/85 px-2 py-0.5 text-slate-300 tabular-nums backdrop-blur">
        <span className="type-label text-sky-400/80">Pitch</span>
        <span ref={pitch}>—</span>
        <span className="type-label text-sky-400/80">Bank</span>
        <span ref={roll}>—</span>
        <span className="type-label text-sky-400/80">Ref</span>
        <span ref={reference} className="max-w-24 truncate">
          —
        </span>
      </div>
    </div>
  )
}

/** The last segment of an address — `b:3.1` of `g:…/s:SOL/b:3.1`. */
const shortName = (address: string): string =>
  address.slice(address.lastIndexOf('/') + 1)

/** A projected point: pixels from the centre, and how much it faces us. */
interface Projected {
  readonly x: number
  readonly y: number
  readonly depth: number
}

/** A direction in horizon axes, on the face, in pixels about the centre. */
function project(local: Quat, direction: Vec3, radius: number): Projected {
  const on = onBall(local, direction)
  return { x: on.x * radius, y: -on.y * radius, depth: on.depth }
}

/**
 * Where a line leaves the visible face, between the last point on it and
 * the first behind it: the depth crosses zero there.
 */
function rimCrossing(a: Projected, b: Projected): Projected {
  const t = a.depth / (a.depth - b.depth)
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, depth: 0 }
}

function draw(
  context: CanvasRenderingContext2D,
  size: number,
  ratio: number,
  local: Quat,
  prograde: {
    readonly x: number
    readonly y: number
    readonly depth: number
  } | null,
  grounded: boolean,
): void {
  const radius = size / 2 - 1.5
  context.setTransform(
    ratio,
    0,
    0,
    ratio,
    (size / 2) * ratio,
    (size / 2) * ratio,
  )
  context.clearRect(-size / 2, -size / 2, size, size)
  context.save()
  context.beginPath()
  context.arc(0, 0, radius, 0, Math.PI * 2)
  context.clip()

  /*
   * The ground and the sky.
   *
   * The horizon is a great circle, and a great circle always meets the
   * visible hemisphere in exactly half of itself — so its visible part is
   * one arc from rim to rim, and the sky is that arc closed by the rim on
   * the side the horizon's up projects to. Looking straight up or down the
   * arc collapses onto the rim, and the face is all one or all the other.
   */
  context.fillStyle = grounded ? GROUND : RIM
  context.fillRect(-size / 2, -size / 2, size, size)
  if (grounded) {
    const up = project(local, UP, radius)
    const points = HORIZON.map((direction) => project(local, direction, radius))
    // Start the walk at a point behind the face, so the visible run is one
    // contiguous arc rather than two ends of one.
    const start = points.findIndex((point) => point.depth <= 0)
    if (start < 0) {
      context.fillStyle = up.depth > 0 ? SKY : GROUND
      context.fillRect(-size / 2, -size / 2, size, size)
    } else {
      const arc: Projected[] = []
      const n = points.length - 1 // the last point repeats the first
      for (let k = 1; k <= n; k += 1) {
        const i = (start + k) % n
        const previous = points[(start + k - 1) % n] as Projected
        const point = points[i] as Projected
        if (point.depth > 0) {
          if (previous.depth <= 0) arc.push(rimCrossing(point, previous))
          arc.push(point)
        } else if (previous.depth > 0) {
          arc.push(rimCrossing(previous, point))
        }
      }
      if (arc.length >= 2) {
        const first = arc[0] as Projected
        const last = arc[arc.length - 1] as Projected
        const a1 = Math.atan2(first.y, first.x)
        const a2 = Math.atan2(last.y, last.x)
        const au = Math.atan2(up.y, up.x)
        // Close along the rim through the side up projects to.
        const clockwise = (a1 - a2 + Math.PI * 4) % (Math.PI * 2)
        const toUp = (au - a2 + Math.PI * 4) % (Math.PI * 2)
        context.beginPath()
        context.moveTo(first.x, first.y)
        for (const point of arc) context.lineTo(point.x, point.y)
        context.arc(0, 0, radius, a2, a1, toUp > clockwise)
        context.closePath()
        context.fillStyle = SKY
        context.fill()
      } else {
        context.fillStyle = up.depth > 0 ? SKY : GROUND
        context.fillRect(-size / 2, -size / 2, size, size)
      }
    }
  }

  /* The lattice: meridians under the ladder, the horizon on top of both. */
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const stroke = (line: Line, ink: string, width: number): void => {
    context.strokeStyle = ink
    context.lineWidth = width
    context.beginPath()
    let pen = false
    for (const direction of line) {
      const point = project(local, direction, radius)
      if (point.depth <= 0.02) {
        pen = false
        continue
      }
      if (pen) context.lineTo(point.x, point.y)
      else context.moveTo(point.x, point.y)
      pen = true
    }
    context.stroke()
  }
  for (const { line } of MERIDIANS) stroke(line, MERIDIAN_INK, 1)
  for (const { pitch, line } of LADDER)
    stroke(line, pitch === 0 ? HORIZON_INK : LADDER_INK, pitch === 0 ? 1.5 : 1)

  /* The compass, where each meridian meets the horizon. */
  context.font = `500 ${Math.max(8, size / 20)}px "IBM Plex Mono", ui-monospace, monospace`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = LABEL_INK
  for (let i = 0; i < MERIDIANS.length; i += 1) {
    const at = project(local, horizonDirection((i * Math.PI) / 6, 0), radius)
    if (at.depth < 0.25) continue
    context.globalAlpha = Math.min(1, (at.depth - 0.25) * 2)
    context.fillText(COMPASS[i] ?? '', at.x, at.y - size / 18)
  }
  /* The ladder's figures, on the meridian nearest the nose. */
  const forward = Q.rotate(local, vec3(0, 0, -1))
  const facing = Math.round(Math.atan2(forward.x, -forward.z) / (Math.PI / 6))
  for (const { pitch } of LADDER) {
    if (pitch === 0) continue
    const at = project(
      local,
      horizonDirection((facing * Math.PI) / 6, pitch),
      radius,
    )
    if (at.depth < 0.35) continue
    context.globalAlpha = Math.min(1, (at.depth - 0.35) * 2)
    context.fillText(String(Math.round((pitch * 180) / Math.PI)), at.x, at.y)
  }
  context.globalAlpha = 1

  /* Where the ship is going, and where it came from. */
  if (prograde !== null) {
    const r = Math.max(5, size / 28)
    context.strokeStyle = MARK_INK
    context.fillStyle = MARK_INK
    context.lineWidth = 1.5
    if (prograde.depth > 0) {
      const x = prograde.x * radius
      const y = -prograde.y * radius
      context.beginPath()
      context.arc(x, y, r, 0, Math.PI * 2)
      context.stroke()
      context.beginPath()
      context.arc(x, y, 1.5, 0, Math.PI * 2)
      context.fill()
      for (const angle of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
        context.beginPath()
        context.moveTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r)
        context.lineTo(
          x + Math.cos(angle) * r * 1.8,
          y + Math.sin(angle) * r * 1.8,
        )
        context.stroke()
      }
    } else {
      const x = -prograde.x * radius
      const y = prograde.y * radius
      context.beginPath()
      context.arc(x, y, r, 0, Math.PI * 2)
      context.stroke()
      const d = r * 0.6
      context.beginPath()
      context.moveTo(x - d, y - d)
      context.lineTo(x + d, y + d)
      context.moveTo(x - d, y + d)
      context.lineTo(x + d, y - d)
      context.stroke()
    }
  }

  /* The nose: a fixed level mark in the middle of the face. */
  const wing = size / 9
  context.strokeStyle = LEVEL_INK
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(-wing * 2, 0)
  context.lineTo(-wing * 0.6, 0)
  context.lineTo(-wing * 0.3, wing * 0.35)
  context.lineTo(0, 0)
  context.lineTo(wing * 0.3, wing * 0.35)
  context.lineTo(wing * 0.6, 0)
  context.lineTo(wing * 2, 0)
  context.stroke()
  context.beginPath()
  context.arc(0, 0, 1.5, 0, Math.PI * 2)
  context.fillStyle = LEVEL_INK
  context.fill()

  /* The rim's shading, so the face reads as a sphere. */
  const shade = context.createRadialGradient(0, 0, radius * 0.55, 0, 0, radius)
  shade.addColorStop(0, 'rgba(2, 6, 23, 0)')
  shade.addColorStop(1, 'rgba(2, 6, 23, 0.55)')
  context.fillStyle = shade
  context.fillRect(-size / 2, -size / 2, size, size)
  context.restore()

  context.strokeStyle = 'rgba(51, 65, 85, 0.8)'
  context.lineWidth = 1
  context.beginPath()
  context.arc(0, 0, radius, 0, Math.PI * 2)
  context.stroke()
}
