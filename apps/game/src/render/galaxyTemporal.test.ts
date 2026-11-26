import { expect, it, vi } from 'vitest'
import { Scene, WebGPURenderer, type Camera, type Object3D } from 'three/webgpu'
import { vec4 } from 'three/tsl'
import { GalaxyTemporalVolume } from './galaxyTemporal.ts'

it('builds the physical history resolve with the real WebGL shader builder', async () => {
  // Building GLSL needs neither a canvas context nor a GPU. Keep this fallback
  // regression in the plain Node suite so WebGPU-only CI cannot miss it.
  const renderer = new WebGPURenderer({
    forceWebGL: true,
    canvas: { width: 64, height: 48 } as HTMLCanvasElement,
  })
  // r187's builder shares a bind group through `renderer._bindings` and skips
  // that only when the field is `undefined`. Before `init()` it is `null`, so
  // a builder over a renderer that never initialized throws in
  // `getSharedBindGroup`. Sharing dedupes bind groups between draws, and
  // this test asks only whether the fallback's GLSL builds.
  const internals = renderer as unknown as { _bindings: unknown }
  if (internals._bindings === null) internals._bindings = undefined
  const failures: unknown[] = []
  const compiled: string[] = []
  // The concrete backends expose this factory, but their shared declaration
  // omits it. Use the live backend's factory to retain Three's one TSL stack.
  const backend = renderer.backend as typeof renderer.backend & {
    createNodeBuilder(
      object: Object3D,
      renderer: WebGPURenderer,
    ): {
      scene: Scene
      camera: Camera
      build(): unknown
      fragmentShader: string | null
    }
  }
  const compile = vi
    .spyOn(renderer, 'compileAsync')
    .mockImplementation(async (object, camera, scene) => {
      const builder = backend.createNodeBuilder(object, renderer)
      builder.scene = scene ?? new Scene()
      builder.camera = camera
      try {
        builder.build()
        compiled.push(builder.fragmentShader ?? '')
      } catch (error) {
        // warmCompile intentionally swallows a rejection. Record the builder
        // failure here, at the same boundary the GPU harness observes.
        failures.push(error)
      }
    })
  const volume = new GalaxyTemporalVolume((_origin, direction) =>
    vec4(direction.normalize().mul(0.2).add(0.3), 1000),
  )
  try {
    await volume.warm(renderer)
    expect(failures).toEqual([])
    expect(compiled).toHaveLength(2)
    expect(compiled.every((shader) => shader.includes('void main()'))).toBe(
      true,
    )
  } finally {
    volume.dispose()
    compile.mockRestore()
  }
})
