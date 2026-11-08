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
  type Extent,
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
import { scatteringOf } from './atmosphereLuts.ts'
import { OVER_CLOUDS_LAYER } from './cloudLayers.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudFrameInputs } from './cloudFrame.ts'
import {
  type CloudEngineInputs,
  type CloudSystem,
  createCloudSystem,
} from './cloudSystem.ts'
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
/** Meters: Earth's datum, the record's own, for geometry a test forms on the CPU. */
export const RIG_EARTH_RADIUS = earth.radius

/** The vertical field the camera and the lens share. */
export const RIG_FOV = 60
/** Looking up: −Z turned onto +Y about +X, the image's top toward +Z. */
export const LOOKING_UP: Quat = Q.fromAxisAngle(
  { x: 1, y: 0, z: 0 },
  Math.PI / 2,
)
/** Looking down: −Z turned onto −Y, the image's top toward −Z. */
export const LOOKING_DOWN: Quat = Q.fromAxisAngle(
  { x: 1, y: 0, z: 0 },
  -Math.PI / 2,
)

function earthAt(
  eye: number,
  compression: number,
  orientation: Quat = Q.IDENTITY,
): RenderBody {
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
    orientation,
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

/**
 * The key star at `position`, render meters. The frame's sun is the
 * direction from the body's center to it, which `starToward` makes exact.
 */
function star(position: Vec3): RenderStar {
  return {
    luminance: 1.6e9,
    sunlight: 1,
    system: 'SOL',
    name: 'Sun',
    placement: {
      position,
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
}

/** Up and a little west of the eye: the star every test that names no sun stands under. */
const STAR = { x: -0.6e9, y: 1.2e9, z: 0.3e9 }

/**
 * The star `toward` a body-fixed sun from `body`'s center: Earth sits
 * unturned, so its own axes are the render's, and a star placed from the
 * eye instead would tilt the sun by the eye's height over the star's
 * distance, a degree from 20,000 km.
 */
function starToward(body: RenderBody, toward: Vec3): RenderStar {
  const reach = 1e12 / Math.hypot(toward.x, toward.y, toward.z)
  const center = body.placement.position
  return star({
    x: center.x + toward.x * reach,
    y: center.y + toward.y * reach,
    z: center.z + toward.z * reach,
  })
}

function renderScene(
  body: RenderBody,
  looking: Quat,
  sun: RenderStar,
): RenderScene {
  return {
    camera: {
      position: { x: 0, y: 0, z: 0 },
      orientation: looking,
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

/** Where the rig stands over Earth, and its sun. */
export interface RigStance {
  /** Meters over the datum. */
  readonly eye: number
  readonly compression?: number
  /** The camera's orientation, render axes. */
  readonly looking: Quat
  /** Toward the sun from Earth's center, render axes; the rig's own star when absent. */
  readonly sun?: Vec3
  /** Earth's own air; none when absent (see `CloudRigOptions.air`). */
  readonly air?: boolean
  /**
   * Earth's orientation, its own axes into the render's; unturned when
   * absent. The eye stands over the body-fixed direction this turn carries
   * onto the render's +Y, so a test picks the place it measures over.
   */
  readonly turn?: Quat
}

/**
 * The engine's half of a frame's inputs at a stance: what `scene/Sensor.tsx`
 * hands the system, with Earth's record and a render body placed about the
 * eye at the render origin.
 */
export function rigEngineInputs(
  stance: RigStance,
  levers: CloudLevers,
): CloudEngineInputs {
  const body = earthAt(stance.eye, stance.compression ?? 1, stance.turn)
  const lens = lensForFov(RIG_FOV)
  return {
    levers,
    scene: renderScene(
      body,
      stance.looking,
      stance.sun === undefined ? star(STAR) : starToward(body, stance.sun),
    ),
    record: (address) => SOL.get(address) ?? null,
    scattering: (drawn) =>
      stance.air === true ? scatteringOf({ pool: () => null }, drawn) : null,
    renderTime: 50_000,
    visibility: false,
    pictureEpoch: 0,
    historyKey: 'rig',
    camera: { position: { x: 0, y: 0, z: 0 }, quaternion: stance.looking },
    lens,
  }
}

/**
 * A frame's whole inputs at a stance, the sensor's fields filled in as the
 * system fills them: photographic processing, `css` the render's extent, a
 * sixtieth of a second. What an instrument builds frames from without a
 * sensor (`cloudFrame(rigFrameInputs(…), previous)`).
 */
export function rigFrameInputs(
  stance: RigStance,
  levers: CloudLevers,
  css: Extent,
): CloudFrameInputs {
  return {
    ...rigEngineInputs(stance, levers),
    enhanced: false,
    css,
    render: css,
    delta: 1 / 60,
  }
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
  /** The camera's orientation, render axes: up by default. */
  readonly looking?: Quat
  /**
   * Earth's own air, its haze's tables baked on the CPU as `scatteringOf`
   * bakes them with no pool. None by default: the trace's blocked air and the
   * composite's air are then exactly zero, which most tests want.
   */
  readonly air?: boolean
  /** Toward the sun from Earth's center, render axes; up and a little west of the eye by default. */
  readonly sun?: Vec3
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
  const looking = options.looking ?? LOOKING_UP
  const camera = new PerspectiveCamera(RIG_FOV, width / height, 0.05, 1e10)
  camera.quaternion.set(looking.x, looking.y, looking.z, looking.w)
  // As `App.tsx`'s `onCreated` marks the camera under the flag, before any
  // warm-up: pass B's composite is on layer 1.
  if (options.clouds !== false) camera.layers.enable(OVER_CLOUDS_LAYER)
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
  const stance: RigStance = {
    eye,
    compression,
    looking,
    ...(options.sun === undefined ? {} : { sun: options.sun }),
    ...(options.air === undefined ? {} : { air: options.air }),
  }
  const lens = lensForFov(RIG_FOV)
  const rig = {
    levers: { ...DEFAULT_CLOUD_LEVERS, ...options.levers } as CloudLevers,
  }
  const sensorFrame = (): SensorFrame => ({
    lens,
    settings: DEFAULT_SENSOR_SETTINGS,
    time: 0,
    headroom: 1,
    // A pinned exposure: two chains compared frame for frame do not wait on
    // their meters' readbacks landing alike.
    pinned: 0,
    noiseTick: 0,
    clouds: rigEngineInputs(stance, rig.levers),
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
