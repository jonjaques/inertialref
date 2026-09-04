import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  cos,
  cross,
  dot,
  exp,
  float,
  Fn,
  instancedBufferAttribute,
  length,
  mix,
  modelNormalMatrix,
  modelViewMatrix,
  normalize,
  normalLocal,
  oneMinus,
  positionLocal,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import type { ThrusterLayout } from '@inertialref/rendering'
import { asField, asVector, noiseFetch, noiseSampler } from './noiseNodes.ts'
import { noiseTexture } from './noiseTexture.ts'

/*
 * The plumes: what a maneuvering valve and the main drive leave behind.
 *
 * Three drawables, all additive in colour and silent in alpha on the flare's
 * and the warp's blending discipline — an alpha-writing additive surface
 * stamps rectangles into the extended-range canvas — and all depth-tested
 * against the hull, so a jet on the far side of the ship is behind the ship.
 *
 * **The jets are one draw.** Every valve on the hull is an instance of one
 * shell — a short bell, open at the tip, capped at the mouth — placed by four
 * instanced attributes: where the mouth is, which way the gas goes, how big,
 * and how hard it is firing this frame. Only the last is written per frame,
 * and it is a float per valve. The shell is not a billboard on purpose: a
 * quad reads as a card the moment the camera passes beside it, and the
 * orbit view exists so the camera can pass beside it. A shell seen edge-on
 * shows its silhouette softened by the facing term below; seen down the
 * axis its cap is the burning disk of the mouth.
 *
 * **The drive is two.** A disk at the exit plane, inside the skirt's mouth,
 * carrying the turbulent white-blue core the reference plates show filling
 * the cone; and a long sheath behind it, the same shell as a jet at a
 * different profile, with filaments scrolling aft and a crown of spikes
 * where the sheath meets the rim. There is no light: a point light on the
 * skirt would be a second program for every material in the scene, and the
 * boot warm-up compiles the one it has.
 *
 * Nothing here decides *whether* a valve fires — `packages/rendering`'s
 * `nozzleFiring` does, from the demand the tick integrated — and nothing
 * here reads the clock: the flicker runs on the frame's own delta, which is
 * a presentation filter like the observatory's ease, so a paused tick with
 * a held key still shows a burning drive rather than a frozen one.
 */

/** Hull axes, meters. */
export interface ThrusterPlumes {
  readonly group: Group
  /** How many jet instances there are — the length `update` expects. */
  readonly nozzleCount: number
  /**
   * Write this frame. `firing` is one 0..1 per nozzle in layout order, or
   * null for none; `throttle` is the drive's 0..1; `delta` is the frame's
   * seconds, which drives the flicker and the valves' own rise and fall.
   */
  update(firing: Float32Array | null, throttle: number, delta: number): void
  dispose(): void
}

/*
 * How long a plume is, in mouth radii, and how wide it ends.
 *
 * A reaction jet is a puff: long for its size and fast to vanish. A pod is
 * a flame: broader, not much longer than it is wide at the tip. The drive is
 * a torch, and its length is the one that reads at a distance — nine radii
 * on a 3.55 m mouth is thirty-two meters, two thirds of the hull, which is
 * where the reference plates put the visible sheath at full burn.
 */
const JET_LENGTH = 14
const POD_LENGTH = 9
const DRIVE_LENGTH = 9

/** Seconds to close 63% of the gap: valves snap open and linger shut. */
const VALVE_RISE = 0.03
const VALVE_FALL = 0.09
/** The drive lights over a quarter second and dies over a third. */
const DRIVE_RISE = 0.25
const DRIVE_FALL = 0.35

/** Below this a plume is not drawn at all — the fragments are not free. */
const DARK = 0.004

/**
 * A shell of revolution about +Y from the mouth at y=0 to the tip at y=1,
 * with `profile(t)` its radius in mouth radii, capped at the mouth.
 *
 * `uv.x` runs once around and `uv.y` runs 0 at the mouth to 1 at the tip,
 * which is what every fragment below reads. The cap's normal is −Y, out of
 * the mouth: seen from downstream it faces the camera squarely, which is what
 * makes the mouth read as a disk rather than the inside of a tube.
 */
function plumeShell(
  profile: (t: number) => number,
  rings: number,
  segments: number,
): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  for (let r = 0; r <= rings; r += 1) {
    const t = r / rings
    const radius = profile(t)
    // The slope of the profile, for the normal: a cone's normal leans by
    // the same angle its wall does.
    const slope = (profile(Math.min(1, t + 1e-3)) - profile(t)) / 1e-3
    const normalY = -slope / Math.hypot(1, slope)
    const normalR = 1 / Math.hypot(1, slope)
    for (let s = 0; s <= segments; s += 1) {
      const a = (s / segments) * Math.PI * 2
      positions.push(Math.cos(a) * radius, t, Math.sin(a) * radius)
      normals.push(Math.cos(a) * normalR, normalY, Math.sin(a) * normalR)
      uvs.push(s / segments, t)
    }
  }
  const stride = segments + 1
  for (let r = 0; r < rings; r += 1)
    for (let s = 0; s < segments; s += 1) {
      const a = r * stride + s
      const b = a + stride
      index.push(a, b, a + 1, a + 1, b, b + 1)
    }
  // The cap: a fan from the mouth's centre.
  const centre = positions.length / 3
  positions.push(0, 0, 0)
  normals.push(0, -1, 0)
  uvs.push(0.5, 0)
  for (let s = 0; s < segments; s += 1) index.push(centre, s, s + 1)

  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(positions), 3),
  )
  geometry.setAttribute(
    'normal',
    new BufferAttribute(new Float32Array(normals), 3),
  )
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(index)
  return geometry
}

/** A puff: widens to nearly three mouths and closes at the tip. */
const jetProfile = (t: number): number =>
  (1 + 1.4 * t) * Math.sqrt(Math.max(0, 1 - t ** 3))
/** A flame: a little wider, closing sooner. */
const podProfile = (t: number): number =>
  (1 + 0.9 * t) * Math.sqrt(Math.max(0, 1 - t ** 2.5))
/** A torch: bulges past the rim, then draws to a point. */
const driveProfile = (t: number): number =>
  (1.02 + 0.45 * t) * Math.sqrt(Math.max(0, 1 - t ** 2.2))

/** The blending every plume draws with: add colour, leave alpha alone. */
function additive(material: MeshBasicNodeMaterial): void {
  material.transparent = true
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  material.depthTest = true
  material.depthWrite = false
}

type Shading = 'jet' | 'pod' | 'drive'

/**
 * One material for a set of shells placed by instanced attributes.
 *
 * The vertex stage builds a basis about each instance's axis and stands the
 * unit shell on it; the facing term — how squarely this bit of shell faces
 * the lens — is taken here, where the normal is, and carried down as a
 * varying. Naming: every attribute is `plume*` and every varying `v*`, and
 * they must stay disjoint (see `.claude/rules/rendering.md`).
 */
function shellMaterial(
  shading: Shading,
  origin: InstancedBufferAttribute,
  axis: InstancedBufferAttribute,
  size: InstancedBufferAttribute,
  fire: InstancedBufferAttribute,
  clock: ReturnType<typeof uniform>,
): MeshBasicNodeMaterial {
  const vFacing = varying(float(), 'vPlumeFacing')
  const vFire = varying(float(), 'vPlumeFire')

  const material = new MeshBasicNodeMaterial()
  material.positionNode = Fn(() => {
    const mouth = instancedBufferAttribute(origin)
    const along = normalize(instancedBufferAttribute(axis))
    const extent = instancedBufferAttribute(size)
    // A basis about the exhaust axis. The helper is whichever world axis
    // the exhaust is least aligned with, so the cross product never
    // degenerates; which one is chosen only rotates the shell about its
    // own axis, which a surface of revolution cannot show.
    const helper = select(
      abs(along.y).lessThan(0.9),
      vec3(0, 1, 0),
      vec3(1, 0, 0),
    )
    const u = normalize(cross(helper, along))
    const w = cross(along, u)
    const p = positionLocal
    const radius = extent.x
    const local = mouth
      .add(u.mul(p.x.mul(radius)))
      .add(w.mul(p.z.mul(radius)))
      .add(along.mul(p.y.mul(extent.y)))
    const n = normalLocal
    const normal = u.mul(n.x).add(w.mul(n.z)).add(along.mul(n.y))
    const normalView = normalize(modelNormalMatrix.mul(normal))
    const view = normalize(modelViewMatrix.mul(vec4(local, 1)).xyz)
    vFacing.assign(abs(dot(normalView, view)))
    vFire.assign(instancedBufferAttribute(fire))
    return local
  })()

  const noise = noiseSampler(noiseTexture())
  material.colorNode = Fn(() => {
    const along = uv().y
    const around = uv().x.mul(Math.PI * 2)
    // Noise read on a cylinder about the axis, so the seam at u=0 is not a
    // seam: the sampled point is the same on both sides of it.
    const ring = (scale: number) =>
      vec3(cos(around).mul(scale), float(0), sin(around).mul(scale))
    const flow = (scale: number, stretch: number, speed: number) =>
      asField(
        noiseFetch(
          noise,
          asVector(
            ring(scale).add(
              vec3(0, along.mul(stretch).sub(clock.mul(speed)), 0),
            ),
          ),
        ),
      ).x

    switch (shading) {
      case 'jet':
      case 'pod': {
        const puff = shading === 'jet'
        // Hot at the mouth, dying along the length, and the whole thing
        // breathing with one octave of scrolling noise.
        const core = exp(along.mul(-5))
        const body = pow(oneMinus(along), puff ? 2.2 : 1.8)
        const turbulence = flow(1.6, 3, 9).mul(0.35).add(0.65)
        /*
         * The facing floor is what keeps a plume from reading as a white
         * rod. Both walls of the shell add — it is double-sided — so the
         * centre of a side view is already twice the rim, and a floor much
         * above a tenth flattens that back into a cylinder. The gains are
         * set so the core just clears the tone curve's knee: at twice these
         * every valve was a flat white shape with no blue in it.
         */
        const rim = mix(float(0.1), float(1), pow(vFacing, 0.55))
        const intensity = body
          .mul(turbulence)
          .add(core.mul(0.7))
          .mul(rim)
          .mul(vFire)
          .mul(puff ? 0.85 : 0.8)
        // A jet is the pale blue-white of cold gas; a pod's flame is the
        // same with a warmer core.
        const sheath = vec3(0.45, 0.68, 1.4)
        const hot = puff ? vec3(1.2, 1.2, 1.15) : vec3(1.35, 1.2, 1.0)
        return mix(sheath, hot, core).mul(intensity)
      }
      case 'drive': {
        const sheath = pow(oneMinus(along), 1.3)
        const coarse = flow(2.2, 2.5, 6)
        const fine = flow(5, 9, 14)
        const filaments = coarse.mul(0.3).add(fine.mul(0.25)).add(0.55)
        // The crown: spikes standing off the rim, drawn by high-frequency
        // noise that turns slowly rather than scrolling — the reference's
        // frost stands still while the sheath streams past it.
        const crown = pow(
          saturate(
            asField(
              noiseFetch(
                noise,
                asVector(ring(7).add(vec3(0, clock.mul(0.7), 0))),
              ),
            )
              .x.mul(0.5)
              .add(0.5),
          ),
          4,
        )
          .mul(exp(along.mul(-10)))
          .mul(1.5)
        const rim = mix(float(0.1), float(1), pow(vFacing, 0.45))
        const intensity = sheath
          .mul(filaments)
          .add(crown)
          .mul(rim)
          .mul(vFire)
          .mul(0.9)
        // The sheath's blue is deep on purpose: through the additive blend
        // and the tone curve a paler one reads as lavender, and the
        // reference torch is the colour of a gas flame.
        const colour = mix(
          vec3(0.22, 0.5, 1.6),
          vec3(1.2, 1.35, 1.6),
          exp(along.mul(-3)).mul(0.75),
        )
        return colour.mul(intensity)
      }
    }
  })()
  material.side = DoubleSide
  additive(material)
  return material
}

/**
 * The disk at the drive's exit plane: the core the sheath streams from.
 *
 * Two octaves of the baked noise, drifting rather than scrolling, over a
 * radial profile that saturates to white through the tone curve at the
 * centre and falls to the sheath's blue at the rim. The rim itself fades
 * out inside the geometry's edge, or the disk shows as a polygon against
 * the skirt's wall.
 */
function diskMaterial(
  throttle: ReturnType<typeof uniform>,
  clock: ReturnType<typeof uniform>,
): MeshBasicNodeMaterial {
  const noise = noiseSampler(noiseTexture())
  const material = new MeshBasicNodeMaterial()
  material.colorNode = Fn(() => {
    const centred = uv().sub(0.5).mul(2)
    const r = length(centred)
    const drift = clock.mul(0.8)
    const coarse = asField(
      noiseFetch(
        noise,
        asVector(vec3(centred.x.mul(3), centred.y.mul(3), drift)),
      ),
    ).x
    const fine = asField(
      noiseFetch(
        noise,
        asVector(
          vec3(centred.x.mul(9), centred.y.mul(9), drift.mul(1.7).add(11)),
        ),
      ),
    ).x
    const turbulence = coarse.mul(0.6).add(fine.mul(0.4))
    const core = exp(r.mul(r).mul(-2.2))
    const edge = oneMinus(smoothstep(float(0.88), float(1), r))
    // Just over the knee at the centre and under it at the rim, so the
    // structure survives the tone curve: at three times this the whole disk
    // was one white ellipse.
    const intensity = core
      .mul(1.2)
      .add(0.35)
      .add(turbulence.mul(0.35))
      .mul(edge)
      .mul(throttle)
    const colour = mix(
      vec3(0.4, 0.72, 1.55),
      vec3(1.5, 1.6, 1.7),
      saturate(core.mul(0.9).add(turbulence.mul(0.25))),
    )
    return colour.mul(intensity)
  })()
  additive(material)
  return material
}

/** A geometry sharing a shell's buffers, drawn `count` times. */
function instanced(
  shell: BufferGeometry,
  count: number,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.index = shell.index
  for (const name of ['position', 'normal', 'uv'])
    geometry.setAttribute(name, shell.getAttribute(name))
  geometry.instanceCount = count
  return geometry
}

/** Exponential approach, frame-rate independent: `tau` is the 63% time. */
const approach = (
  held: number,
  target: number,
  delta: number,
  tau: number,
): number => held + (target - held) * (1 - Math.exp(-delta / tau))

// Module-level, like the warp's quad: a Fast Refresh re-evaluation reuses
// the shells rather than leaking a set per edit.
const JET_SHELL = /*@__PURE__*/ plumeShell(jetProfile, 6, 14)
const POD_SHELL = /*@__PURE__*/ plumeShell(podProfile, 6, 18)
const DRIVE_SHELL = /*@__PURE__*/ plumeShell(driveProfile, 24, 48)
const DISK = /*@__PURE__*/ new CircleGeometry(1, 48)

export function createThrusterPlumes(layout: ThrusterLayout): ThrusterPlumes {
  const group = new Group()
  group.name = 'plumes'
  group.renderOrder = 10
  const clock = uniform(0)
  const disposers: (() => void)[] = []

  /*
   * The jets and the pods are two draws rather than one, because they are
   * two shells and two shadings; each is one draw for every valve of its
   * kind. The valves are split here and the caller's firing array is read
   * through the index lists, so the caller still speaks in layout order.
   */
  const kinds = (['jet', 'pod'] as const).map((shading) => {
    const indices: number[] = []
    layout.nozzles.forEach((nozzle, i) => {
      if ((nozzle.kind === 'rcs') === (shading === 'jet')) indices.push(i)
    })
    const count = indices.length
    const origin = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
    const axis = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
    const size = new InstancedBufferAttribute(new Float32Array(count * 2), 2)
    const fire = new InstancedBufferAttribute(new Float32Array(count), 1)
    fire.setUsage(DynamicDrawUsage)
    indices.forEach((n, i) => {
      const nozzle = layout.nozzles[n]
      if (nozzle === undefined) return
      origin.setXYZ(i, nozzle.position.x, nozzle.position.y, nozzle.position.z)
      axis.setXYZ(i, nozzle.exhaust.x, nozzle.exhaust.y, nozzle.exhaust.z)
      size.setXY(
        i,
        nozzle.radius,
        nozzle.radius * (shading === 'jet' ? JET_LENGTH : POD_LENGTH),
      )
    })
    const material = shellMaterial(shading, origin, axis, size, fire, clock)
    const geometry = instanced(shading === 'jet' ? JET_SHELL : POD_SHELL, count)
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.visible = false
    mesh.renderOrder = 10
    if (count > 0) group.add(mesh)
    disposers.push(() => {
      geometry.dispose()
      material.dispose()
    })
    return { indices, fire, mesh, held: new Float32Array(count) }
  })

  // The drive: the sheath is one instance of the drive shell on the axis,
  // and the disk sits on the exit plane facing aft, which is the circle
  // geometry's own +Z.
  const drive = layout.drive
  const throttle = uniform(0)
  let driveMeshes: {
    sheath: Mesh
    disk: Mesh
    size: InstancedBufferAttribute
    fire: InstancedBufferAttribute
  } | null = null
  if (drive !== null) {
    const origin = new InstancedBufferAttribute(
      new Float32Array([drive.position.x, drive.position.y, drive.position.z]),
      3,
    )
    const axis = new InstancedBufferAttribute(new Float32Array([0, 0, 1]), 3)
    const size = new InstancedBufferAttribute(
      new Float32Array([drive.radius, drive.radius * DRIVE_LENGTH]),
      2,
    )
    size.setUsage(DynamicDrawUsage)
    const fire = new InstancedBufferAttribute(new Float32Array([0]), 1)
    fire.setUsage(DynamicDrawUsage)
    const sheathMaterial = shellMaterial(
      'drive',
      origin,
      axis,
      size,
      fire,
      clock,
    )
    const sheathGeometry = instanced(DRIVE_SHELL, 1)
    const sheath = new Mesh(sheathGeometry, sheathMaterial)
    sheath.frustumCulled = false
    sheath.visible = false
    sheath.renderOrder = 10
    const diskMat = diskMaterial(throttle, clock)
    const disk = new Mesh(DISK, diskMat)
    disk.position.set(drive.position.x, drive.position.y, drive.position.z)
    disk.scale.setScalar(drive.radius)
    disk.visible = false
    disk.renderOrder = 9
    group.add(sheath, disk)
    disposers.push(() => {
      sheathGeometry.dispose()
      sheathMaterial.dispose()
      diskMat.dispose()
    })
    driveMeshes = { sheath, disk, size, fire }
  }

  let driveHeld = 0

  return {
    group,
    nozzleCount: layout.nozzles.length,
    update(firing, target, delta) {
      clock.value += delta
      for (const kind of kinds) {
        let brightest = 0
        kind.indices.forEach((n, i) => {
          const want = firing === null ? 0 : (firing[n] ?? 0)
          const had = kind.held[i] ?? 0
          const now = approach(
            had,
            want,
            delta,
            want > had ? VALVE_RISE : VALVE_FALL,
          )
          kind.held[i] = now
          kind.fire.setX(i, now)
          if (now > brightest) brightest = now
        })
        kind.fire.needsUpdate = true
        kind.mesh.visible = brightest > DARK
      }
      driveHeld = approach(
        driveHeld,
        target,
        delta,
        target > driveHeld ? DRIVE_RISE : DRIVE_FALL,
      )
      throttle.value = driveHeld
      if (driveMeshes !== null && drive !== null) {
        const lit = driveHeld > DARK
        driveMeshes.sheath.visible = lit
        driveMeshes.disk.visible = lit
        driveMeshes.fire.setX(0, driveHeld)
        driveMeshes.fire.needsUpdate = true
        // The torch grows with the burn: half throttle is not half as long
        // but it is shorter, as a throttled engine's plume is.
        driveMeshes.size.setXY(
          0,
          drive.radius,
          drive.radius * DRIVE_LENGTH * (0.35 + 0.65 * Math.sqrt(driveHeld)),
        )
        driveMeshes.size.needsUpdate = true
      }
    },
    dispose() {
      for (const dispose of disposers) dispose()
      group.removeFromParent()
    },
  }
}
