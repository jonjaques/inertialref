import { describe, expect, it } from 'vitest'
import { openSession, PICTURES } from '@inertialref/devtools'
import { loadStarCatalog } from './catalog.ts'

describe('the shipped photographs', () => {
  it('resolves every address and cinematic frame against the real catalog', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      for (const picture of PICTURES) {
        const result = session.harness.preset(picture.id)
        expect(result.status.target?.address, picture.id).toContain(
          picture.address.replace('s:', ''),
        )
        if (picture.framing.kind === 'cinematic') {
          const sample = session.harness.cutsceneSample(
            session.world.clock.renderTime,
          )
          expect(sample?.ship.visible, picture.id).toBe(true)
          expect(sample?.frame, picture.id).toBe(picture.framing.frame)
        } else {
          expect(result.fovDeg, picture.id).toBeGreaterThanOrEqual(20)
          expect(result.fovDeg, picture.id).toBeLessThanOrEqual(110)
        }
      }
    } finally {
      session.dispose()
    }
  })
})
