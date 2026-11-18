import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SLAB_REFERENCE } from '@inertialref/rendering'
import { type SlabRig, slabRig, viewOf } from './cloudSlabRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The glory through the whole march (rubric row 8, the ring's contrast): a
 * deck of one radius seen from straight above under a sun straight above,
 * first order through the committed phase and the reference's sun, the
 * light after first order beside it.
 *
 * The ring's peak over the trough inside it is the scaled medium's, 1.139
 * by the oracle, where the true medium's is 1.060: first order keeps the
 * whole phase's ring while the light under it is the scaled phase's. The
 * rubric states that contrast and does not bound it; the gate is that the
 * march draws the scaled medium's own, within a tenth. The ring's angle
 * and the cloudbow's are first order's and the phase atlas's, held where
 * the atlas is (`cloudLight.gpu.test.ts`).
 */

let gpu: GpuSession
let rig: SlabRig

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  rig = await slabRig(gpu, { sun: 'exact', phase: true })
}, 120_000)

afterAll(() => {
  rig.dispose()
  gpu.dispose()
})

describe('the glory on a deck', () => {
  it('draws the red ring over its trough within a tenth of the scaled medium’s 1.139', async () => {
    const { glory } = SLAB_REFERENCE
    rig.place(glory.radius, glory.depth, 1, 'reflected')
    rig.uniforms.trace.maxSteps.value = 192
    // Degrees from the antisolar point, which under a sun straight above
    // is straight down.
    const at = (degrees: number) =>
      viewOf('reflected', Math.cos((degrees * Math.PI) / 180), 0)
    const [trough, ring] = await rig.light([at(glory.trough), at(glory.ring)])
    const contrast = ring![glory.band] / trough![glory.band]
    // The profile, for the record: where the march's own ring stands.
    const angles = Array.from({ length: 31 }, (_, k) => 0.4 + 0.1 * k)
    const profile = (await rig.light(angles.map(at))).map(
      (light) => light[glory.band],
    )
    const peak = profile.indexOf(Math.max(...profile.slice(8)))
    const dip = profile.indexOf(Math.min(...profile.slice(0, peak)))
    console.info(
      `cloudGlory: the red ring over its trough ${contrast.toFixed(4)} at the reference's angles, against ${glory.scaled} on the scaled medium and ${glory.oracle} on the true one; the march's ring at ${angles[peak]!.toFixed(1)}° and trough at ${angles[dip]!.toFixed(1)}°, ${(profile[peak]! / profile[dip]!).toFixed(4)} between them`,
    )
    expect(Math.abs(contrast / glory.scaled - 1)).toBeLessThan(0.1)
    expect(contrast).toBeGreaterThan(1)
  }, 600_000)
})
