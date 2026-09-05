import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Mesh, PerspectiveCamera, Scene, SphereGeometry } from 'three/webgpu'
import { StorageBufferAttribute, MeshBasicNodeMaterial } from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  sin,
  storage,
  uint,
  uv,
  vec4,
  wgslFn,
} from 'three/tsl'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The rig proving itself, before anything is proved with it.
 *
 * Each of these is a fact the other GPU suites lean on without checking: that
 * the adapter is the physical GPU and not a software one, that a readback comes
 * back unpadded and the right way up, what an 8-bit target and a float target
 * each quantize to, and that a shader Tint rejects is a red test rather than a
 * black frame. A rig that had any of them wrong would let every test built on
 * it pass for the wrong reason.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

describe('the device', () => {
  it('is the physical GPU, not a software adapter', async () => {
    /*
     * `renderer.backend.adapter` is not a public path and r185 sets none,
     * so the proof comes from the API the setup file installed. A
     * software adapter is not the thing under test: a graph that compiles on
     * SwiftShader and not on Metal is exactly the class of failure this suite
     * exists to catch.
     */
    const adapter = await navigator.gpu.requestAdapter()
    expect(adapter).not.toBeNull()
    const info = adapter!.info
    /*
     * Dawn names the hardware here — `apple` / `metal-3` on this machine.
     * `.not.toBe('')` is not the assertion: it is satisfied by `undefined`,
     * which is what a renamed field reads as, and the fields are accessors so
     * a typo enumerates as nothing. And a software adapter is not blank —
     * lavapipe says `mesa` / `llvmpipe`, WARP says `microsoft` — so the named
     * ones are excluded by name rather than by emptiness.
     */
    expect(info.vendor).toMatch(/\S/)
    expect(info.architecture).toMatch(/\S/)
    const software = /mesa|llvmpipe|swiftshader|warp|microsoft basic/i
    expect(`${info.vendor} ${info.architecture} ${info.device}`).not.toMatch(
      software,
    )
  })

  it('refuses to draw anywhere but a render target', () => {
    // The canvas stub's swap chain throws on purpose: a test that forgot
    // `setRenderTarget` would otherwise read zeros back from a target it never
    // drew into, and pass if zero was the expected answer.
    const scene = new Scene()
    scene.add(new Mesh(new SphereGeometry(1), new MeshBasicNodeMaterial()))
    const camera = new PerspectiveCamera(60, 1, 0.1, 10)
    camera.position.z = 3
    expect(() => gpu.renderer.render(scene, camera)).toThrow(/no swap chain/)
  })
})

describe('a readback', () => {
  it('is unpadded, with row 0 at the top and v up', async () => {
    /*
     * 8 wide is the case that catches padding: an RGBA8 row is 32 bytes and
     * WebGPU aligns it to 256, so the raw buffer holds the second row at
     * element 256. Read naively, every row past the first is zeros — which
     * is what the first probe of this rig reported for the bottom-left pixel.
     */
    const width = 8
    const height = 4
    const pixels = await gpu.drawGraph(vec4(uv(), 0, 1), { width, height })
    expect(pixels.data).toHaveLength(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [r, g, b, a] = pixels.at(x, y)
        // Pixel centers, quantized by the target: each channel is the value
        // times 255, rounded, and nothing else — no transfer function.
        expect(r).toBe(Math.round(((x + 0.5) / width) * 255))
        expect(g).toBe(Math.round((1 - (y + 0.5) / height) * 255))
        expect(b).toBe(0)
        expect(a).toBe(255)
      }
    }
  })

  it('quantizes to the target: 1/255 on RGBA8, f32 on a float target', async () => {
    /*
     * The same graph on both targets, against `Math.sin`. The two bounds are
     * the two honest ones for the two paths, and naming both is the point:
     * a bound of ~1e-3 written against a float target would be a statement
     * about the shader's arithmetic that the shader does not deserve, and a
     * bound of 1e-6 against RGBA8 could never pass.
     *
     * The float figure is measured on an Apple M5, Metal 3: 2.4e-7 max
     * absolute error over 256 samples — a couple of f32 ulps on a value near
     * one. The bound below is four times that, so a driver's `sin` a little
     * worse than Metal's stays green and a graph that stopped computing a sine
     * does not.
     */
    const width = 256
    const graph = vec4(sin(uv().x.mul(Math.PI * 2)), 0, 0, 1)

    const bytes = await gpu.drawGraph(graph, { width, height: 1 })
    let worstByte = 0
    for (let x = 0; x < width; x += 1) {
      const expected = Math.max(0, Math.sin(((x + 0.5) / width) * Math.PI * 2))
      const error = Math.abs(bytes.at(x, 0)[0] / 255 - expected)
      worstByte = Math.max(worstByte, error)
    }
    // Half a step on either side of the rounding, and the target clamps the
    // negative half of the wave at zero — which is why the expectation does.
    expect(worstByte).toBeLessThanOrEqual(0.5 / 255 + 1e-9)

    const floats = await gpu.drawGraph(graph, { width, height: 1, float: true })
    expect(floats.data).toBeInstanceOf(Float32Array)
    let worstFloat = 0
    for (let x = 0; x < width; x += 1) {
      const expected = Math.sin(((x + 0.5) / width) * Math.PI * 2)
      const error = Math.abs(floats.at(x, 0)[0] - expected)
      worstFloat = Math.max(worstFloat, error)
    }
    expect(worstFloat).toBeLessThan(4 * 2.4e-7)
  })
})

describe('a shader that will not build', () => {
  it('is a rejection with the compiler’s message in it', async () => {
    /*
     * The backend does not reject: it pushes a validation scope around
     * `createRenderPipeline`, pops it, and routes the message through
     * three's console sink while `compileAsync` resolves. In the browser that
     * is `[Invalid ShaderModule "fragment"] … due to a previous error` on a
     * channel the page console does not carry, and a canvas that never
     * presents. Here it has to be a red test.
     */
    const broken = wgslFn('fn broken() -> vec4<f32> { return nope; }')
    await expect(gpu.drawGraph(broken())).rejects.toThrow(
      /unresolved value 'nope'/,
    )
  })
})

describe('a compute kernel', () => {
  it('writes a storage buffer the test can read back', async () => {
    /*
     * The shape `docs/adr/0023-the-gpu-producer.md` needs — a kernel per cell
     * into a buffer — with the arithmetic bound named for the same reason as the
     * float target's above. Measured on the M5: 3.7e-7 over 256 samples.
     */
    const count = 256
    const out = new StorageBufferAttribute(new Float32Array(count), 1)
    const cells = storage(out, 'float', count)
    const kernel = Fn(() => {
      // Guarded, though 256 is four whole workgroups and could not show it.
      // This is the kernel a tile producer gets copied from, and the guard is
      // the part that is invisible until the count stops dividing by 64.
      If(instanceIndex.lessThan(uint(count)), () => {
        const x = float(instanceIndex)
          .div(count)
          .mul(Math.PI * 2)
        cells.element(instanceIndex).assign(sin(x))
      })
    })().compute(count)

    await gpu.compute(kernel)
    const values = new Float32Array(await gpu.readBuffer(out))
    expect(values).toHaveLength(count)
    let worst = 0
    for (let i = 0; i < count; i += 1) {
      const expected = Math.sin((i / count) * Math.PI * 2)
      worst = Math.max(worst, Math.abs((values[i] as number) - expected))
    }
    expect(worst).toBeLessThan(4 * 3.7e-7)
  })
})
