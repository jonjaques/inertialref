import { expect, it, vi } from 'vitest'
import {
  DataTexture,
  RenderTarget,
  SRGBColorSpace,
  Vector2,
  type NodeFrame,
  type NodeMaterial,
  type QuadMesh,
  type WebGPURenderer,
} from 'three/webgpu'
import { texture } from 'three/tsl'
import { DefocusNode } from './defocus.ts'
import { MotionNode } from './motion.ts'
import { PsfNode } from './psf.ts'

type Draw = { material: NodeMaterial; target: RenderTarget }
function recorder() {
  const initial = new RenderTarget()
  let target: RenderTarget = initial
  let mrt: object | null = {}
  let size = new Vector2(128, 80)
  const compiled: Draw[] = []
  const drawn: Draw[] = []
  const renderer = {
    toneMapping: 4,
    outputColorSpace: SRGBColorSpace,
    autoClear: false,
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
      compiled.push({ material: quad.material as NodeMaterial, target })
      return Promise.resolve()
    }),
    render: vi.fn((quad: QuadMesh) => {
      drawn.push({ material: quad.material as NodeMaterial, target })
    }),
  }
  return {
    renderer,
    compiled,
    drawn,
    initial,
    resize: () => {
      size = new Vector2(95, 61)
    },
  }
}

const cases = [
  {
    name: 'defocus',
    count: 4,
    create: (input: DataTexture) => {
      const pass = new DefocusNode(texture(input), texture(input))
      pass.enabled.value = 1
      return pass
    },
  },
  {
    name: 'motion',
    count: 3,
    create: (input: DataTexture) => {
      const pass = new MotionNode(texture(input), texture(input))
      pass.fraction.value = 1
      return pass
    },
  },
  {
    name: 'glare',
    count: 12,
    create: (input: DataTexture) => new PsfNode(texture(input)),
  },
]

it.each(cases)(
  '$name owns warming, resizing, and retirement',
  async ({ create, count }) => {
    const input = new DataTexture()
    const pass = create(input)
    const { renderer, compiled, drawn, initial, resize } = recorder()
    const frame = { renderer } as unknown as NodeFrame
    const mrt = renderer.getMRT()
    await pass.warm(renderer as unknown as WebGPURenderer)
    expect(compiled).toHaveLength(count)
    expect(renderer.getRenderTarget() === initial).toBe(true)
    expect(renderer.getMRT()).toBe(mrt)
    expect(renderer.toneMapping).toBe(4)
    expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
    pass.updateBefore(frame)
    resize()
    pass.updateBefore(frame)
    expect(drawn).toHaveLength(count * 2)
    expect(pass.outputTexture.value.image).toMatchObject({
      width: 95,
      height: 61,
    })
    for (const draw of drawn) {
      const warm = compiled.find((entry) => entry.material === draw.material)
      expect(warm).toBeDefined()
      expect(warm!.target.texture.type).toBe(draw.target.texture.type)
      expect(warm!.target.samples).toBe(draw.target.samples)
    }
    const retired = vi.fn()
    for (const { material, target } of compiled) {
      material.addEventListener('dispose', retired)
      target.addEventListener('dispose', retired)
    }
    pass.dispose()
    pass.dispose()
    expect(retired).toHaveBeenCalledTimes(count * 2)
    drawn.length = 0
    pass.updateBefore(frame)
    expect(drawn).toHaveLength(0)
    input.dispose()
    initial.dispose()
  },
)

it.each(cases)('$name restores the target when a draw fails', ({ create }) => {
  const input = new DataTexture()
  const pass = create(input)
  const { renderer, initial } = recorder()
  renderer.render.mockImplementation(() => {
    throw new Error('draw failed')
  })
  expect(() => pass.updateBefore({ renderer } as unknown as NodeFrame)).toThrow(
    'draw failed',
  )
  expect(renderer.getRenderTarget() === initial).toBe(true)
  expect(renderer.autoClear).toBe(false)
  pass.dispose()
  input.dispose()
  initial.dispose()
})
