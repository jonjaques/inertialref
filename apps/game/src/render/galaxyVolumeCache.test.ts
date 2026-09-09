import { expect, it, vi } from 'vitest'
import {
  RenderTarget,
  SRGBColorSpace,
  Vector2,
  type NodeFrame,
  type WebGPURenderer,
} from 'three/webgpu'
import { PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV, vec3 } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField, SUN_POSITION } from '@inertialref/universe'
import { LENS_PRESETS } from '@inertialref/rendering'
import { GalaxyVolumeNode } from './galaxyVolume.ts'

function recorder() {
  let target: RenderTarget | null = new RenderTarget()
  const initial = target
  let mrt: object | null = {},
    face = 0,
    mip = 0
  let scissorTest = false
  const size = new Vector2(1920, 1080)
  const renderer = {
    toneMapping: 4,
    outputColorSpace: SRGBColorSpace,
    autoClear: true,
    depth: true,
    stencil: true,
    getRenderTarget: () => target,
    setRenderTarget: (value: RenderTarget | null, f = 0, m = 0) => {
      target = value
      face = f
      mip = m
    },
    getScissorTest: () => scissorTest,
    setScissorTest: (value: boolean) => {
      scissorTest = value
    },
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    getMRT: () => mrt,
    setMRT: (value: object | null) => {
      mrt = value
    },
    getDrawingBufferSize: (value: Vector2) => value.copy(size),
    compileAsync: vi.fn(() => Promise.resolve()),
    render: vi.fn(),
  }
  return { renderer, initial, size }
}

it('bounds a cold frame, then reuses the physical cube during free look and resize', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const volume = new GalaxyVolumeNode(field, { cache: {} })
  const { renderer, initial, size } = recorder()
  const frame = { renderer } as unknown as NodeFrame
  const pose = {
    position: SUN_POSITION,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  }
  volume.configure(pose, LENS_PRESETS.flight)
  await volume.warm(renderer as unknown as WebGPURenderer)
  volume.updateBefore(frame)
  expect(volume.diagnostics.width).toBe(64)
  expect(volume.diagnostics.height).toBe(36)
  expect(volume.diagnostics.cache).toMatchObject({ tiles: 1, using: false })
  for (let i = 1; i < 408; i++) volume.updateBefore(frame)
  const baked = volume.diagnostics.cache!
  expect(baked).toMatchObject({
    ready: true,
    tiles: 408,
    published: 2,
    using: true,
  })
  expect(volume.diagnostics.width).toBe(480)
  expect(volume.diagnostics.height).toBe(270)
  for (let i = 1; i < 10; i++) {
    volume.configure(
      { ...pose, orientation: Q.fromAxisAngle(vec3(0, 1, 0), i / 10) },
      LENS_PRESETS.flight,
    )
    volume.updateBefore(frame)
  }
  expect(volume.diagnostics.cache).toMatchObject({
    tiles: 408,
    liveDraws: baked.liveDraws,
    samplingDraws: baked.samplingDraws + 9,
  })
  size.set(2880, 1800)
  volume.updateBefore(frame)
  expect(volume.diagnostics.cache!.tiles).toBe(408)
  expect(volume.diagnostics.width).toBe(720)
  expect(renderer.getRenderTarget()).toBe(initial)
  expect(renderer.autoClear).toBe(true)
  volume.dispose()
  expect(volume.diagnostics.targetBytes).toBe(0)
  initial.dispose()
})

it('cancels a stale bake during travel, restores renderer state on failure, and cannot revive after retirement', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const volume = new GalaxyVolumeNode(field, { cache: {} })
  const { renderer, initial } = recorder()
  const frame = { renderer } as unknown as NodeFrame
  const pose = {
    position: SUN_POSITION,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  }
  volume.configure(pose, LENS_PRESETS.flight)
  await volume.warm(renderer as unknown as WebGPURenderer)
  volume.updateBefore(frame)
  volume.configure(
    { ...pose, position: UV.translate(SUN_POSITION, vec3(PARSEC, 0, 0)) },
    LENS_PRESETS.flight,
  )
  expect(volume.diagnostics.cache!.cancellations).toBe(1)
  const mrt = renderer.getMRT()
  renderer.render.mockImplementationOnce(() => {
    throw new Error('tile failure')
  })
  expect(() => volume.updateBefore(frame)).toThrow('tile failure')
  expect(renderer.getRenderTarget()).toBe(initial)
  expect(renderer.getMRT()).toBe(mrt)
  expect(renderer.autoClear).toBe(true)
  expect(volume.diagnostics.cache!.completedTiles).toBe(0)
  volume.dispose()
  await volume.warm(renderer as unknown as WebGPURenderer)
  volume.configure(pose, LENS_PRESETS.flight)
  volume.updateBefore(frame)
  expect(volume.diagnostics.cache!.ready).toBe(false)
  expect(volume.diagnostics.targetBytes).toBe(0)
  initial.dispose()
})
