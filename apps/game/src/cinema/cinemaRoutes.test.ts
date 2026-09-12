import { expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { shellPaths } from '../../astro/siteRoutes.ts'
import { cinemaScene } from '../pages/paths.ts'

it('serves a cold URL for every scene the Cinema director offers', () => {
  const session = openSession()
  for (const script of session.harness.cutscenes())
    expect(shellPaths).toContain(cinemaScene(script.id))
  session.dispose()
})
