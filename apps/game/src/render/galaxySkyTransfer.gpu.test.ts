import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  CubeRenderTarget,
  HalfFloatType,
  LinearFilter,
  Vector3,
} from 'three/webgpu'
import { cubeTexture, int, uniformArray, uv } from 'three/tsl'
import { readGalaxyCube, restoreGalaxyCube } from './galaxySkyTransfer.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(6, 1)
})
afterAll(() => gpu.dispose())
it.each([16, 32])(
  'copies every half-float cube face without padding or orientation changes at %ipx',
  async (size) => {
    const source = new CubeRenderTarget(size, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    })
    const restored = new CubeRenderTarget(size, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    })
    const faces = Array.from({ length: 6 }, (_, face) => {
      const data = new Uint16Array(size * size * 4)
      for (let i = 0; i < size * size; i++) {
        data[i * 4] = 0x3000 + face * 32 + (i % size)
        data[i * 4 + 1] = 0x3400 + Math.floor(i / size)
        data[i * 4 + 2] = 0x3800
        data[i * 4 + 3] = 0x3c00
      }
      return data
    })
    try {
      restoreGalaxyCube(gpu.renderer, source, faces)
      const copied = await readGalaxyCube(gpu.renderer, source)
      expect(copied).toEqual(faces)
      restoreGalaxyCube(gpu.renderer, restored, copied)
      expect(await readGalaxyCube(gpu.renderer, restored)).toEqual(faces)
      const directions = uniformArray<'vec3'>(
        [
          new Vector3(1, 0.2, 0.3),
          new Vector3(-1, 0.2, 0.3),
          new Vector3(0.2, 1, 0.3),
          new Vector3(0.2, -1, 0.3),
          new Vector3(0.2, 0.3, 1),
          new Vector3(0.2, 0.3, -1),
        ],
        'vec3',
      ).element(int(uv().x.mul(6)))
      const a = await gpu.drawGraph(cubeTexture(source.texture, directions), {
        float: true,
        width: 6,
        height: 1,
      })
      const b = await gpu.drawGraph(cubeTexture(restored.texture, directions), {
        float: true,
        width: 6,
        height: 1,
      })
      expect(b.data).toEqual(a.data)
    } finally {
      source.dispose()
      restored.dispose()
    }
  },
)
