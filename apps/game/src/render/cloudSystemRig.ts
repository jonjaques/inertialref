import {
  DoubleSide,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import {
  DEFAULT_SENSOR_SETTINGS,
  lensForFov,
  type RenderBody,
  type RenderScene,
  type RenderStar,
} from '@inertialref/rendering'
import { type Quat, Quaternion as Q, type Vec3 } from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { type CloudSystem, createCloudSystem } from './cloudSystem.ts'
import type { GpuSession } from './gpuHarness.ts'
import { DEFAULT_PICTURE, type Picture } from './picture.ts'
import { sensorRadiance } from './radiance.ts'
import { sceneBackend, sceneLayout } from './sceneLayout.ts'
import { createSensor, type Sensor, type SensorFrame } from './sensor.ts'

/*
 * The cloud system's GPU tests' rig: the sensor's own chain built with the
 * system, over a scene that holds what the trace stops at, and a frame
 * closure that hands the system what `scene/Sensor.tsx` hands it — Earth's
 * record and a render body placed about the eye, the camera's pose, the
 * lens the camera draws through. Earth sits with its north up the render
 * +Y, the eye `eye` meters over its datum at the render origin, and the
 * camera looks straight up, the image's top toward +Z.
 */

const ROOT = rootSeed('inertialref')

function solRecords(): Map<string, Body> {
  const galaxy = galaxySeedOf(ROOT, MILKY_WAY)
  const stub = resolveSystem(galaxy, SOL_ONLY_CATALOG, systemId('SOL'))!
  const system = generateSystem(ROOT, MILKY_WAY, stub)
  return new Map(
    [...walkBodies(system)].map((body) => [formatAddress(body.address), body]),
  )
}

const SOL = /*@__PURE__*/ solRecords()
export const RIG_EARTH = 'g:milky-way/s:SOL/b:2'
const earth = SOL.get(RIG_EARTH)!

/** The vertical field the camera and the lens share. */
export const RIG_FOV = 60
/** Looking up: −Z turned onto +Y about +X. */
const LOOKING_UP: Quat = Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2)

function earthAt(eye: number, compression: number): RenderBody {
  const center: Vec3 = { x: 0, y: -(earth.radius + eye) * compression, z: 0 }
  return {
    sunlight: 0.85,
    address: RIG_EARTH,
    name: earth.name,
    kind: earth.kind,
    placement: {
      position: center,
      scale: earth.radius * compression,
      compression,
      distance: (earth.radius + eye) * compression,
      tier: 'surface',
      compressed: compression !== 1,
      angularRadius: 1.4,
    },
    orientation: Q.IDENTITY,
    hasAtmosphere: true,
    terminator: 0.1,
    atmosphereScale: 1.02,
    airTop: 1.015,
    airHeights: { rayleigh: 0.0013, aerosol: 0.0002 },
    limb: 0,
    limbFalloff: 0.004,
    trueRadius: earth.radius,
    rotationPeriod: earth.rotationPeriod,
    flattening: 1,
    figure: null,
    rings: null,
    appearance: earth.appearance,
  } as unknown as RenderBody
}

const sun: RenderStar = {
  luminance: 1.6e9,
  sunlight: 1,
  system: 'SOL',
  name: 'Sun',
  placement: {
    position: { x: -0.6e9, y: 1.2e9, z: 0.3e9 },
    scale: 1e6,
    compression: 1e-3,
    distance: 1.5e11,
    tier: 'billboard',
    compressed: true,
    angularRadius: 0.0047,
  },
  color: { r: 1, g: 0.96, b: 0.9 },
  brightness: 1,
} as unknown as RenderStar

function renderScene(body: RenderBody): RenderScene {
  return {
    camera: {
      position: { x: 0, y: 0, z: 0 },
      orientation: LOOKING_UP,
      up: { x: 0, y: 1, z: 0 },
    },
    horizon: null,
    bodies: [body],
    stars: [sun],
    entities: [],
    structures: [],
    stations: [],
    terrainCandidates: [],
  } as unknown as RenderScene
}

export interface CloudRigOptions {
  /** Meters over the datum; 100 by default, under overcast's 300 m base. */
  readonly eye?: number
  readonly compression?: number
  readonly picture?: Picture
  /** Build the chain with the system: the flag. True by default. */
  readonly clouds?: boolean
  /** A plane over the image's top at this render height, meters, or none. */
  readonly ceiling?: number | null
  /** The image height, −1 to 1, the ceiling's lower edge stands at: 0, the middle, by default. */
  readonly ceilingEdge?: number
  readonly levers?: Partial<CloudLevers>
}

export interface CloudRig {
  readonly sensor: Sensor
  readonly system: CloudSystem | null
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  /** What the frame closure hands the system; the test writes it. */
  levers: CloudLevers
  /** One frame through the chain, into `target`. */
  frame(delta?: number): void
  readonly target: RenderTarget
  dispose(): void
}

export function cloudRig(
  gpu: GpuSession,
  width: number,
  height: number,
  options: CloudRigOptions = {},
): CloudRig {
  const { renderer } = gpu
  const eye = options.eye ?? 100
  const compression = options.compression ?? 1
  const layout = sceneLayout(
    options.picture ?? DEFAULT_PICTURE,
    sceneBackend(renderer),
  )
  const scene = new Scene()
  const camera = new PerspectiveCamera(RIG_FOV, width / height, 0.05, 1e10)
  camera.quaternion.set(LOOKING_UP.x, LOOKING_UP.y, LOOKING_UP.z, LOOKING_UP.w)
  camera.updateMatrixWorld()
  const disposables: { dispose(): void }[] = []
  if (options.ceiling !== undefined && options.ceiling !== null) {
    const material = sensorRadiance(new MeshBasicNodeMaterial())
    material.colorNode = vec3(0.3)
    material.side = DoubleSide
    const reach = options.ceiling * 10
    // The image's y is tan(angle)/tan(fov/2) along +z, looking up.
    const edge =
      options.ceiling *
      Math.tan((RIG_FOV / 2) * (Math.PI / 180)) *
      (options.ceilingEdge ?? 0)
    const geometry = new PlaneGeometry(2 * reach, reach - edge)
    const plane = new Mesh(geometry, material)
    // Face down over z ≥ edge: the image above its edge.
    plane.rotation.x = Math.PI / 2
    plane.position.set(0, options.ceiling, (reach + edge) / 2)
    scene.add(plane)
    disposables.push(geometry, material)
  }
  scene.updateMatrixWorld(true)
  const body = earthAt(eye, compression)
  const view = renderScene(body)
  const lens = lensForFov(RIG_FOV)
  const rig = {
    levers: { ...DEFAULT_CLOUD_LEVERS, ...options.levers } as CloudLevers,
  }
  const sensorFrame = (): SensorFrame => ({
    lens,
    settings: DEFAULT_SENSOR_SETTINGS,
    time: 0,
    headroom: 1,
    pinned: null,
    noiseTick: 0,
    clouds: {
      levers: rig.levers,
      scene: view,
      record: (address) => SOL.get(address) ?? null,
      scattering: () => null,
      renderTime: 50_000,
      visibility: false,
      pictureEpoch: 0,
      historyKey: 'rig',
      camera: {
        position: { x: 0, y: 0, z: 0 },
        quaternion: LOOKING_UP,
      },
      lens,
    },
  })
  const sensor = createSensor(
    renderer,
    scene,
    camera,
    layout,
    sensorFrame,
    undefined,
    options.clouds === false ? {} : { clouds: createCloudSystem },
  )
  const target = new RenderTarget(width, height, {
    depthBuffer: false,
    type: FloatType,
  })
  return {
    sensor,
    system: sensor.clouds,
    scene,
    camera,
    get levers() {
      return rig.levers
    },
    set levers(levers: CloudLevers) {
      rig.levers = levers
    },
    frame(delta = 1 / 60) {
      sensor.render(target, delta)
    },
    target,
    dispose() {
      sensor.dispose()
      target.dispose()
      for (const held of disposables) held.dispose()
    },
  }
}
