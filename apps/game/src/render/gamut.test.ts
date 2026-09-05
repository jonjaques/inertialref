import { afterEach, expect, it, vi } from 'vitest'
import type { WebGPURenderer } from 'three/webgpu'
import { configureGamut } from './gamut.ts'

afterEach(() => vi.unstubAllGlobals())

it('retains sRGB when an extended canvas cannot report its configuration', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      getContext: () => ({ configure: vi.fn() }),
    },
  }
  expect(configureGamut(renderer as unknown as WebGPURenderer, true)).toBe(
    false,
  )
})

it('restores the sRGB declaration when P3 configuration fails', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const original = { colorSpace: 'srgb' }
  const configure = vi.fn((config: { colorSpace: string }) => {
    if (config.colorSpace === 'display-p3') throw new Error('unsupported')
  })
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      getContext: () => ({ getConfiguration: () => original, configure }),
    },
  }
  expect(configureGamut(renderer as unknown as WebGPURenderer, true)).toBe(
    false,
  )
  expect(configure).toHaveBeenLastCalledWith(original)
})
