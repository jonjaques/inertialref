import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('the documentation manifest on a fresh checkout', () => {
  /*
   * Every route of the site reads the manifest, so a server started without it
   * answers its first page with "Run pnpm docs:build before rendering the
   * site." `pnpm dev`, `pnpm dev:client` and the driver all start Astro through
   * this one script, which is why the build lives in it and not beside one of
   * them.
   */
  it('builds it before Astro starts, in the script every dev server runs', () => {
    const pkg = JSON.parse(
      readFileSync(
        new URL('../../apps/game/package.json', import.meta.url),
        'utf8',
      ),
    )
    const steps = pkg.scripts.dev.split('&&').map((step) => step.trim())
    const ensure = steps.findIndex((step) =>
      step.includes('scripts/docs/ensure.mjs'),
    )
    const astro = steps.findIndex((step) => /\bastro dev\b/.test(step))
    expect(ensure).toBeGreaterThanOrEqual(0)
    expect(astro).toBeGreaterThan(ensure)
  })
})
