import { expect, it, vi } from 'vitest'
import {
  RenderTarget,
  SRGBColorSpace,
  Vector2,
  type NodeFrame,
  type NodeMaterial,
  type QuadMesh,
  type WebGPURenderer,
} from 'three/webgpu'
import { createGalaxyField } from '@inertialref/universe'
import { rootSeed } from '@inertialref/procedural'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { GALAXY_VIEWS } from '@inertialref/rendering'
import { GalaxyVolumeNode, GALAXY_SETTLE_SUBMISSIONS } from './galaxyVolume.ts'

function recorder() {
  const initial = new RenderTarget()
  let target = initial,
    mrt: object | null = {}
  const size = new Vector2(1920, 1080)
  const compiled: { target: RenderTarget; material: NodeMaterial }[] = []
  const renderer = {
    toneMapping: 4,
    outputColorSpace: SRGBColorSpace,
    autoClear: false,
    depth: true,
    stencil: true,
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget) => {
      target = next
    },
    getMRT: () => mrt,
    setMRT: (next: object | null) => {
      mrt = next
    },
    getDrawingBufferSize: (into: Vector2) => into.copy(size),
    compileAsync: vi.fn((quad: QuadMesh) => {
      compiled.push({ target, material: quad.material as NodeMaterial })
      return Promise.resolve()
    }),
    render: vi.fn(),
  }
  return { renderer, initial, size, compiled }
}
const field = createGalaxyField(rootSeed('inertialref'))
const view = GALAXY_VIEWS['face-on']

it('settles to fine transport, tolerates local drift, and resets after accumulated travel', async () => {
  const volume = new GalaxyVolumeNode(field)
  const { renderer, initial } = recorder()
  const frame = { renderer } as unknown as NodeFrame
  await volume.warm(renderer as unknown as WebGPURenderer)
  for (let i = 0; i <= GALAXY_SETTLE_SUBMISSIONS; i++) {
    volume.configure(
      {
        ...view.pose,
        position: UV.translate(view.pose.position, vec3(i * 1000, 0, 0)),
      },
      view.lens,
    )
    volume.updateBefore(frame)
  }
  expect(volume.diagnostics).toMatchObject({
    maxStepParsecs: 100,
    dustStepParsecs: 10,
    settled: true,
    emissionOnly: false,
    dustScale: 1,
    resolvedStarExtinction: false,
  })
  const pose = {
    ...view.pose,
    position: UV.translate(view.pose.position, vec3(0.02 * PARSEC, 0, 0)),
  }
  volume.configure(pose, view.lens)
  volume.updateBefore(frame)
  expect(volume.diagnostics).toMatchObject({
    maxStepParsecs: 100,
    settled: false,
  })
  for (let i = 0; i < GALAXY_SETTLE_SUBMISSIONS; i++) {
    volume.configure(pose, view.lens)
    volume.updateBefore(frame)
  }
  expect(volume.diagnostics.settled).toBe(true)
  volume.configure(
    pose,
    view.lens,
    createGalaxyField(field.seed, { dustScale: 0 }),
  )
  expect(volume.diagnostics).toMatchObject({
    settled: false,
    emissionOnly: true,
    dustScale: 0,
  })
  volume.dispose()
  initial.dispose()
})

it('draws once per change of view and once more to settle, and holds the target between', async () => {
  const volume = new GalaxyVolumeNode(field)
  const { renderer, initial } = recorder()
  const frame = { renderer } as unknown as NodeFrame
  await volume.warm(renderer as unknown as WebGPURenderer)
  volume.configure(view.pose, view.lens)
  for (let i = 0; i < GALAXY_SETTLE_SUBMISSIONS; i++) volume.updateBefore(frame)
  // Eight submissions at one pose: the observer draw, then the target held.
  expect(renderer.render).toHaveBeenCalledTimes(1)
  expect(volume.diagnostics).toMatchObject({
    submissions: GALAXY_SETTLE_SUBMISSIONS,
    draws: 1,
    held: true,
    settled: false,
  })
  // The ninth settles, and nothing after it draws.
  for (let i = 0; i < 20; i++) {
    volume.configure(
      {
        ...view.pose,
        position: UV.translate(view.pose.position, vec3(i * 1000, 0, 0)),
      },
      view.lens,
    )
    volume.updateBefore(frame)
  }
  expect(renderer.render).toHaveBeenCalledTimes(2)
  expect(volume.diagnostics).toMatchObject({
    submissions: GALAXY_SETTLE_SUBMISSIONS + 20,
    draws: 2,
    held: true,
    settled: true,
  })
  // A change of view draws at once, at travel quality.
  const moved = {
    ...view.pose,
    position: UV.translate(view.pose.position, vec3(0.02 * PARSEC, 0, 0)),
  }
  volume.configure(moved, view.lens)
  volume.updateBefore(frame)
  expect(renderer.render).toHaveBeenCalledTimes(3)
  expect(volume.diagnostics).toMatchObject({
    draws: 3,
    held: false,
    settled: false,
  })
  // So does a field change at the same pose.
  volume.configure(
    moved,
    view.lens,
    createGalaxyField(field.seed, { dustScale: 0 }),
  )
  volume.updateBefore(frame)
  expect(renderer.render).toHaveBeenCalledTimes(4)
  expect(volume.diagnostics).toMatchObject({
    draws: 4,
    held: false,
    emissionOnly: true,
  })
  volume.dispose()
  initial.dispose()
})

it('owns the same target for warming, quarter-size updates, resize, and retirement', async () => {
  const volume = new GalaxyVolumeNode(field)
  const { renderer, initial, size, compiled } = recorder()
  const frame = { renderer } as unknown as NodeFrame
  volume.configure(view.pose, view.lens)
  volume.updateBefore(frame)
  expect(renderer.render).not.toHaveBeenCalled()
  await volume.warm(renderer as unknown as WebGPURenderer)
  expect(compiled).toHaveLength(1)
  const mrt = renderer.getMRT()
  volume.updateBefore(frame)
  expect(volume.diagnostics).toMatchObject({
    width: 480,
    height: 270,
    targetBytes: 1036800,
    submissions: 1,
    draws: 1,
    held: false,
  })
  size.set(953, 617)
  volume.updateBefore(frame)
  expect(volume.diagnostics).toMatchObject({
    width: 239,
    height: 155,
    targetBytes: 296360,
    submissions: 2,
    draws: 2,
  })
  expect(renderer.getRenderTarget()).toBe(initial)
  expect(renderer.getMRT()).toBe(mrt)
  expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
  expect(renderer.toneMapping).toBe(4)
  expect(renderer.autoClear).toBe(false)
  expect(renderer.depth).toBe(true)
  expect(renderer.stencil).toBe(true)
  const disposed = vi.fn()
  compiled[0]!.target.addEventListener('dispose', disposed)
  compiled[0]!.material.addEventListener('dispose', disposed)
  volume.dispose()
  volume.dispose()
  expect(disposed).toHaveBeenCalledTimes(2)
  volume.updateBefore(frame)
  expect(volume.diagnostics).toMatchObject({
    active: false,
    ready: false,
    targetBytes: 0,
    submissions: 2,
  })
  initial.dispose()
})

it('a failed volume draw restores scene attachments and renderer state', async () => {
  const volume = new GalaxyVolumeNode(field)
  const { renderer, initial } = recorder()
  const mrt = renderer.getMRT()
  await volume.warm(renderer as unknown as WebGPURenderer)
  volume.configure(view.pose, view.lens)
  renderer.render.mockImplementation(() => {
    throw new Error('draw failed')
  })
  expect(() =>
    volume.updateBefore({ renderer } as unknown as NodeFrame),
  ).toThrow('draw failed')
  expect(renderer.getRenderTarget()).toBe(initial)
  expect(renderer.getMRT()).toBe(mrt)
  expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
  expect(renderer.toneMapping).toBe(4)
  expect(renderer.autoClear).toBe(false)
  expect(renderer.depth).toBe(true)
  expect(renderer.stencil).toBe(true)
  volume.dispose()
  initial.dispose()
})

it('a warm-up completing after disposal cannot revive the volume', async () => {
  const volume = new GalaxyVolumeNode(field)
  const { renderer, initial } = recorder()
  let release = () => {}
  renderer.compileAsync.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const warming = volume.warm(renderer as unknown as WebGPURenderer)
  volume.dispose()
  release()
  await warming
  expect(volume.ready).toBe(false)
  expect(volume.diagnostics.targetBytes).toBe(0)
  volume.configure(view.pose, view.lens)
  volume.updateBefore({ renderer } as unknown as NodeFrame)
  expect(renderer.render).not.toHaveBeenCalled()
  initial.dispose()
})
