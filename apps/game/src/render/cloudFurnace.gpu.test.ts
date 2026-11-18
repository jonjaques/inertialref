import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BANDS, type SlabRig, slabRig, viewOf } from './cloudSlabRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The furnace (rubric row 4), on the fine march: under a sky of one
 * radiance on every side, with no sun and no air, a conservative medium
 * returns that radiance at any density, so a ray through cloud of
 * transmittance T adds L̄·(1 − T), and over a background of L̄ the pixel is
 * L̄ (design §5.6). It holds the sky's term to its mean at every depth,
 * cover and footprint, and it holds everything else out of the sky's light:
 * a term that leaked the sun's source, or the factor of the sun, into a
 * march with no sun would move it.
 *
 * The march reads the sky from its table here (`CloudMarchOptions.skyTable`),
 * which the system's kernel does not: the placeholder it draws is no
 * furnace. The far march's furnace is the far march's package's.
 */

let gpu: GpuSession
let rig: SlabRig

/** L̄, in every band. */
const SKY = 0.37

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  rig = await slabRig(gpu, { sun: 'none', phase: true, sky: SKY })
}, 120_000)

afterAll(() => {
  rig.dispose()
  gpu.dispose()
})

describe('a cloud under a uniform sky and no sun', () => {
  it('returns the sky’s radiance to a thousandth at every depth, cover, footprint and view, the factor of the sun on', async () => {
    const views = (side: 'reflected' | 'transmitted') =>
      [0.15, 0.6, 1].map((mu) => viewOf(side, mu, 40))
    let worst = 0
    let opaque = 0
    for (const depth of [0.5, 5, 50, 400])
      for (const cover of [1, 0.4])
        for (const pixelAngle of [0, 1e6])
          for (const side of ['reflected', 'transmitted'] as const)
            for (const convective of [0, 1]) {
              rig.place(10, depth, 0.5, side)
              rig.cover(cover)
              rig.share(convective)
              rig.uniforms.trace.maxSteps.value = 192
              // A footprint of nothing reads the slab resolved, and one a
              // thousand cells wide reads its level's statistics.
              rig.uniforms.camera.pixelAngle.value = pixelAngle
              for (const { light, transmittance } of await rig.marched(
                views(side),
              )) {
                expect(transmittance).toBeGreaterThanOrEqual(0)
                expect(transmittance).toBeLessThanOrEqual(1)
                if (transmittance < 0.01) opaque += 1
                for (const band of BANDS) {
                  const pixel = light[band] + transmittance * SKY
                  worst = Math.max(worst, Math.abs(pixel / SKY - 1))
                }
              }
            }
    console.info(
      `cloudFurnace: the pixel over a background of the sky's radiance, worst ${worst.toExponential(2)} of it; ${opaque} rays left the march under 1%`,
    )
    // The exit under 1% is among them: the light behind it is the sun's
    // alone, and adds nothing here.
    expect(opaque).toBeGreaterThan(20)
    expect(worst).toBeLessThan(1e-3)
  }, 600_000)
})
