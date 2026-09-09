import { afterEach, expect, it, vi } from 'vitest'
import { PerspectiveCamera, Scene } from 'three/webgpu'
import {
  createRenderOrigin,
  fromRenderSpace,
  Quaternion as Q,
  UV,
  vec3,
} from '@inertialref/spatial'
import { LENS_PRESETS } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { CameraRig } from './CameraRig.tsx'
import { GalaxyVolume } from './GalaxyVolume.tsx'

const rig = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  frames: new Map<string, { callback: () => void; priority: number }>(),
  configure: vi.fn(),
  cleanups: [] as (() => void)[],
}))

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect()
    if (cleanup !== undefined) rig.cleanups.push(cleanup)
  },
}))
vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: Record<string, unknown>) => unknown) =>
    select(rig.state),
}))
vi.mock('./useTimedFrame.ts', () => ({
  useTimedFrame: (name: string, callback: () => void, priority = 0) =>
    rig.frames.set(name, { callback, priority }),
}))
vi.mock('../render/galaxyVolume.ts', async () => {
  const { Mesh, PlaneGeometry, MeshBasicMaterial } =
    await import('three/webgpu')
  return {
    GalaxyVolumeNode: class {
      configure = rig.configure
      active = true
      ready = true
      dispose() {}
    },
    createGalaxyBackdrop: () =>
      new Mesh(new PlaneGeometry(), new MeshBasicMaterial()),
  }
})
vi.mock('../render/galaxyStructure.ts', () => ({
  acquireGalaxyStructure: () => ({ table: null, release() {} }),
}))
vi.mock('../render/warmup.ts', () => ({
  warmAtMount() {},
  warmCompile() {},
  warmRenderer() {},
}))

afterEach(() => {
  for (const cleanup of rig.cleanups.splice(0)) cleanup()
  rig.frames.clear()
  rig.configure.mockClear()
})

function mount() {
  const camera = new PerspectiveCamera()
  const origin = createRenderOrigin(
    UV.fromMeters(1e12, 2e12, 3e12),
    Q.fromAxisAngle(vec3(0, 1, 0), 0.7),
  )
  const engine = {
    world: { galaxySeed: 1n },
    origin,
    galaxyPose: {
      position: origin.position,
      orientation: Q.fromAxisAngle(vec3(1, 0, 0), 0.2),
    },
    lens: LENS_PRESETS.flight,
    starField: { resolved: undefined },
    galaxyRenderer: null,
  } as unknown as GameEngine
  camera.position.set(17, 23, -31)
  const orientation = Q.fromAxisAngle(vec3(0, 0, 1), 0.4)
  camera.quaternion.set(
    orientation.x,
    orientation.y,
    orientation.z,
    orientation.w,
  )
  rig.state = {
    camera,
    scene: new Scene(),
    gl: { backend: { isWebGPUBackend: false } },
  }
  GalaxyVolume({ engine })
  return {
    camera,
    engine,
    origin,
    frame: () => rig.frames.get('galaxy')!.callback(),
    configured: () => rig.configure.mock.lastCall?.[0],
  }
}

it('keeps the galaxy on the rendered camera when the ship turns under an orbit view', () => {
  const { camera, engine, origin, frame, configured } = mount()
  frame()
  const expected = {
    position: fromRenderSpace(origin, camera.position),
    orientation: Q.normalize(Q.multiply(origin.orientation, camera.quaternion)),
  }
  expect(configured()).toEqual(expected)

  Object.assign(engine, {
    galaxyPose: {
      ...engine.galaxyPose,
      orientation: Q.fromAxisAngle(vec3(1, 0, 0), 1.1),
    },
  })
  frame()
  expect(configured()).toEqual(expected)

  const turned = Q.fromAxisAngle(vec3(0, 0, 1), -0.3)
  camera.quaternion.set(turned.x, turned.y, turned.z, turned.w)
  frame()
  expect(configured().orientation).toEqual(
    Q.normalize(Q.multiply(origin.orientation, turned)),
  )
  expect(configured().orientation).not.toEqual(expected.orientation)
})

it('keeps the sampled sky gate for a cutscene or hidden diffuse layer', () => {
  const { engine, frame, configured } = mount()
  Object.assign(engine, { galaxyPose: null })
  frame()
  expect(configured()).toBeNull()
})

it('places the camera update between the engine tick and sky consumers', () => {
  const { engine } = mount()
  CameraRig({ engine })
  const cameraPriority = rig.frames.get('cameraRig')!.priority
  expect(cameraPriority).toBeGreaterThan(-1)
  expect(cameraPriority).toBeLessThan(rig.frames.get('galaxy')!.priority)
})
