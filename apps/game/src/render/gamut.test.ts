import { afterEach, expect, it, vi } from 'vitest'
import {
  EventDispatcher,
  SRGBColorSpace,
  type WebGPURenderer,
} from 'three/webgpu'
import { createCanvasGamut, DISPLAY_P3 } from './gamut.ts'

afterEach(() => vi.unstubAllGlobals())

function canvas() {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const events = new EventDispatcher<{ resize: object }>()
  let configuration = { colorSpace: 'srgb' }
  let acceptsP3 = true
  const context = {
    getConfiguration: () => configuration,
    configure: vi.fn((next: typeof configuration) => {
      if (!acceptsP3 && next.colorSpace === DISPLAY_P3)
        throw new Error('unsupported')
      configuration = next
    }),
  }
  const renderer = {
    outputColorSpace: SRGBColorSpace,
    backend: { isWebGPUBackend: true, getContext: () => context },
    getCanvasTarget: () => events,
  }
  return {
    renderer: renderer as unknown as WebGPURenderer,
    context,
    resize: (supported = true) => {
      acceptsP3 = supported
      configuration = { colorSpace: 'srgb' }
      events.dispatchEvent({ type: 'resize' })
    },
  }
}

it('keeps the declared canvas and encoder together through resize failure and recovery', () => {
  const { renderer, context, resize } = canvas()
  const gamut = createCanvasGamut(renderer, true)
  expect(gamut.colorSpace).toBe(DISPLAY_P3)
  expect(renderer.outputColorSpace).toBe(context.getConfiguration().colorSpace)
  resize(false)
  expect(gamut.colorSpace).toBe(SRGBColorSpace)
  expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
  expect(context.getConfiguration().colorSpace).toBe(SRGBColorSpace)
  // Post-mount setup must use the current negotiation, even after a failure.
  renderer.outputColorSpace = DISPLAY_P3
  gamut.commit()
  expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
  resize()
  expect(gamut.colorSpace).toBe(DISPLAY_P3)
  expect(renderer.outputColorSpace).toBe(context.getConfiguration().colorSpace)
  gamut.dispose()
})

it('restores the negotiated encoder after the renderer host configures it', () => {
  const { renderer } = canvas()
  const gamut = createCanvasGamut(renderer, true)
  renderer.outputColorSpace = SRGBColorSpace
  gamut.commit()
  expect(renderer.outputColorSpace).toBe(DISPLAY_P3)
  gamut.dispose()
})

it('removes its resize subscription on disposal', () => {
  const { renderer, context, resize } = canvas()
  const gamut = createCanvasGamut(renderer, true)
  gamut.dispose()
  gamut.dispose()
  context.configure.mockClear()
  resize()
  expect(context.configure).not.toHaveBeenCalled()
})

it('uses sRGB when an extended canvas cannot report its configuration', () => {
  const { renderer, context } = canvas()
  Object.assign(context, { getConfiguration: undefined })
  const gamut = createCanvasGamut(renderer, true)
  expect(gamut.colorSpace).toBe(SRGBColorSpace)
  expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
  expect(context.configure).not.toHaveBeenCalled()
  gamut.dispose()
})

it('keeps standard output in sRGB even on a P3 display', () => {
  const { renderer, context, resize } = canvas()
  const gamut = createCanvasGamut(renderer, false)
  resize()
  expect(gamut.colorSpace).toBe(SRGBColorSpace)
  expect(renderer.outputColorSpace).toBe(SRGBColorSpace)
  expect(context.getConfiguration().colorSpace).toBe(SRGBColorSpace)
  gamut.dispose()
})
