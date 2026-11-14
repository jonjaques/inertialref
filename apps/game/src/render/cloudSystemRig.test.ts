import { describe, expect, it } from 'vitest'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { LOOKING_UP, RIG_EARTH, rigEngineInputs } from './cloudSystemRig.ts'

describe('the cloud rig’s air', () => {
  it('carries the sky table a page with the clouds bakes, and none without the air', () => {
    const levers = { ...DEFAULT_CLOUD_LEVERS, on: true }
    const withAir = rigEngineInputs(
      { eye: 1500, looking: LOOKING_UP, air: true },
      levers,
    )
    const body = withAir.scene.bodies.find((one) => one.address === RIG_EARTH)!
    // The rig has no engine holding `?clouds=1`'s factory to say the sky is
    // wanted, so it asks for it: its systems' GPU tests bind a real table.
    expect(withAir.scattering(body)?.sky).toBeDefined()
    const without = rigEngineInputs({ eye: 1500, looking: LOOKING_UP }, levers)
    expect(without.scattering(body)).toBeNull()
  })
})
