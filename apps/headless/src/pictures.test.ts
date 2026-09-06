import { describe, expect, it } from 'vitest'
import { openSession, PICTURES } from '@inertialref/devtools'
import { loadStarCatalog } from './catalog.ts'

describe('the shipped photographs', () => {
  it('resolves every planetarium shot against the real catalog', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      for (const picture of PICTURES) {
        const result = session.harness.preset(picture.id)
        expect(result.status.target?.address, picture.id).toContain(
          picture.address,
        )
        expect(session.harness.cutsceneStatus(), picture.id).toBeNull()
        expect(result.fovDeg, picture.id).toBeGreaterThan(0)
        expect(result.fovDeg, picture.id).toBeLessThanOrEqual(150)
      }
    } finally {
      session.dispose()
    }
  })
})
