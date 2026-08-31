import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StorageBufferAttribute } from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  normalize,
  storage,
  uint,
  uvec4,
  vec3,
  vec4,
} from 'three/tsl'
import { pcg3d } from '@inertialref/procedural'
import { faceToDirection } from '@inertialref/universe'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The shape of Phase 5, with the tolerance test written first.
 *
 * `TERRAIN-PLAN.md` § 11 puts tile production on the GPU — a TSL compute
 * kernel per cell, into a cache the material samples — and makes one promise
 * about it: a GPU tile matches a CPU tile within a stated tolerance, checked
 * in the browser because CI has no GPU. This file is that check's home before
 * there is a producer to check, on the two primitives every tile is built
 * from. Both are ports of the CPU function, and the port is the thing under
 * test: nothing here mirrors a shader in scalar code, it runs the shader.
 *
 * The plan's line between the two is drawn here as well. **Placement is
 * integer and bit-identical everywhere** — which crater exists, which cell
 * holds a plate nucleus — while amplitude is float and allowed to differ by a
 * named amount. The hash asserts equality; the direction asserts a bound.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

describe('faceToDirection on the GPU', () => {
  it('agrees with the CPU to within f32 on every face', async () => {
    /*
     * A grid of (u, v) per face, at cell centers, so no sample sits on a
     * face edge where two faces would both be right. The CPU side computes
     * the same centers in float64; the difference is f32's `normalize` and
     * nothing else.
     *
     * Measured on an Apple M5, Metal 3: 1.2e-7 max absolute error per
     * component over 6 × 32² samples — one f32 ulp at the magnitude of a unit
     * vector's largest component. The bound is four ulps, named as such.
     */
    // 6 × 32² is 96 workgroups of 64 exactly, so this kernel needs no index
    // guard; the hash below is sized so that it does, and says why.
    const side = 32
    const perFace = side * side
    const count = 6 * perFace
    const out = new StorageBufferAttribute(new Float32Array(count * 4), 4)
    const cells = storage(out, 'vec4', count)

    const kernel = Fn(() => {
      const i = instanceIndex
      const face = i.div(uint(perFace))
      const within = i.mod(uint(perFace))
      const iu = within.mod(uint(side))
      const iv = within.div(uint(side))
      const u = float(iu).add(0.5).div(side).mul(2).sub(1)
      const v = float(iv).add(0.5).div(side).mul(2).sub(1)

      // The six cases of `faceToDirection`, in the same order.
      const direction = vec3(0).toVar()
      If(face.equal(uint(0)), () => {
        direction.assign(vec3(1, v, u.negate()))
      })
        .ElseIf(face.equal(uint(1)), () => {
          direction.assign(vec3(-1, v, u))
        })
        .ElseIf(face.equal(uint(2)), () => {
          direction.assign(vec3(u, 1, v.negate()))
        })
        .ElseIf(face.equal(uint(3)), () => {
          direction.assign(vec3(u, -1, v))
        })
        .ElseIf(face.equal(uint(4)), () => {
          direction.assign(vec3(u, v, 1))
        })
        .Else(() => {
          direction.assign(vec3(u.negate(), v, -1))
        })
      cells.element(i).assign(vec4(normalize(direction), 0))
    })().compute(count)

    await gpu.compute(kernel)
    const got = new Float32Array(await gpu.readBuffer(out))

    let worst = 0
    for (let i = 0; i < count; i += 1) {
      const face = Math.floor(i / perFace)
      const within = i % perFace
      const u = (((within % side) + 0.5) / side) * 2 - 1
      const v = ((Math.floor(within / side) + 0.5) / side) * 2 - 1
      const expected = faceToDirection(face, u, v)
      worst = Math.max(
        worst,
        Math.abs((got[i * 4] as number) - expected.x),
        Math.abs((got[i * 4 + 1] as number) - expected.y),
        Math.abs((got[i * 4 + 2] as number) - expected.z),
      )
    }
    expect(worst).toBeLessThan(4 * 1.2e-7)
  })
})

describe('pcg3d on the GPU', () => {
  it('is bit-identical to the CPU, negative cells included', async () => {
    /*
     * The promise `lattice.ts` makes in its header: the same cell produces
     * the same crater in Chrome, in a worker, in Node and on the GPU. It
     * holds because the function is specified over uint32 — `Math.imul` and
     * `>>> 0` on the CPU, `u32` arithmetic that wraps in WGSL — and this is
     * the first time the GPU half of that sentence has been run.
     *
     * The cells straddle zero because `x | 0` on the CPU and `u32(i32)` on
     * the GPU each have their own way of saying what −3 is as an unsigned
     * number, and they had better agree.
     */
    const nx = 17
    const ny = 13
    const nz = 7
    const count = nx * ny * nz
    const out = new StorageBufferAttribute(new Uint32Array(count * 4), 4)
    const cells = storage(out, 'uvec4', count)

    const multiplier = uint(1_664_525)
    const increment = uint(1_013_904_223)

    const kernel = Fn(() => {
      const i = instanceIndex
      /*
       * The guard is not optional, and 1,547 is chosen to prove it. A compute
       * node dispatches whole workgroups of 64, so this kernel runs 1,600
       * times; WGSL clamps an out-of-range index rather than faulting, so the
       * fifty-three excess invocations all write cell 1,546 — and the last
       * cell of the tile holds whichever of them ran last. Measured: exactly
       * one mismatch, always the last element. A tile producer whose cell
       * count happens to divide by 64 would never see it.
       */
      If(i.lessThan(uint(count)), () => {
        const x = int(i.mod(uint(nx))).sub(8)
        const y = int(i.div(uint(nx)).mod(uint(ny))).sub(6)
        const z = int(i.div(uint(nx * ny))).sub(3)

        const vx = uint(x).mul(multiplier).add(increment).toVar()
        const vy = uint(y).mul(multiplier).add(increment).toVar()
        const vz = uint(z).mul(multiplier).add(increment).toVar()

        vx.assign(vx.add(vy.mul(vz)))
        vy.assign(vy.add(vz.mul(vx)))
        vz.assign(vz.add(vx.mul(vy)))

        vx.assign(vx.bitXor(vx.shiftRight(uint(16))))
        vy.assign(vy.bitXor(vy.shiftRight(uint(16))))
        vz.assign(vz.bitXor(vz.shiftRight(uint(16))))

        vx.assign(vx.add(vy.mul(vz)))
        vy.assign(vy.add(vz.mul(vx)))
        vz.assign(vz.add(vx.mul(vy)))

        cells.element(i).assign(uvec4(vx, vy, vz, uint(0)))
      })
    })().compute(count)

    await gpu.compute(kernel)
    const got = new Uint32Array(await gpu.readBuffer(out))

    let mismatches = 0
    for (let i = 0; i < count; i += 1) {
      const x = (i % nx) - 8
      const y = (Math.floor(i / nx) % ny) - 6
      const z = Math.floor(i / (nx * ny)) - 3
      const expected = pcg3d(x, y, z)
      if (
        got[i * 4] !== expected.x ||
        got[i * 4 + 1] !== expected.y ||
        got[i * 4 + 2] !== expected.z
      ) {
        mismatches += 1
      }
    }
    expect(mismatches).toBe(0)
  })
})
