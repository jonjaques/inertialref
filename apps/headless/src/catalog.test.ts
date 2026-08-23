import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readCatalog } from '@inertialref/universe'

/*
 * The catalog states its version twice, and this is what holds the two together.
 *
 * `pnpm catalog:build` writes both — the version inside the packed `.irsc`, and
 * `data/catalog/manifest.json` beside it — so they agree by construction on the
 * day they are written. They are read by different things afterwards: the game
 * and the headless runner decode the packed file, and the Worker imports the
 * manifest, because a script that serves 460 KB of binary has no reason to
 * decode it to answer `/api/health`.
 *
 * That split is what makes this test necessary rather than pedantic. The health
 * record's whole job is to say which universe a deployment believes in, and a
 * manifest that had drifted from the file beside it would say so confidently
 * and wrongly — the exact failure `versionDrift` exists to catch, arriving
 * through the one path that reports the answer.
 */

const root = new URL('../../../', import.meta.url)
const packed = new URL('data/catalog/stars-150ly.irsc', root)
const manifest = new URL('data/catalog/manifest.json', root)

describe('the packed catalog and its manifest', () => {
  it('state the same version', () => {
    const declared: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    const version =
      typeof declared === 'object' &&
      declared !== null &&
      'version' in declared &&
      typeof declared.version === 'string'
        ? declared.version
        : null
    expect(version, 'manifest.json has no version string').not.toBeNull()
    expect(readCatalog(readFileSync(packed)).version).toBe(version)
  })

  it('finds a star the survey interface cannot reach', () => {
    /*
     * The question the split by question exists for. `travelTargets` is a star
     * sweep with a radius — the panels used a 16 ly one — so a search box that
     * filtered its result could not express "is there a star called Gacrux",
     * only "is there one called Gacrux within sixteen light years". Gacrux is
     * 88.6 ly out, which is inside the catalog and nowhere near any survey a
     * panel can afford to run per keystroke.
     */
    const catalog = readCatalog(readFileSync(packed))
    const gacrux = catalog.search('Gacrux', 1)[0]
    expect(gacrux?.id).toBe('HIP61084')
    expect(gacrux?.distanceLightYears).toBeGreaterThan(85)

    // And by its Bayer name, spelled and Greek, superscript or not.
    for (const query of ['Gamma Crucis', 'γ Cru', 'HIP 61084', 'HD 108903']) {
      expect(catalog.search(query, 1)[0]?.id, query).toBe('HIP61084')
    }
  })

  it('answers a query over the whole catalog inside a keystroke', () => {
    /*
     * The gate this was built behind. Measured on the real 7,123-star catalog:
     * the index costs 0.18 ms at decode (the loop already computes the keys for
     * `find`) and a query over all 16,537 of them takes 0.14–0.30 ms. The bound
     * here is loose against those numbers on purpose — it is guarding against
     * somebody turning `search` back into a scan of the star list, not
     * measuring this machine.
     */
    const catalog = readCatalog(readFileSync(packed))
    const started = performance.now()
    for (const query of ['sir', 'alpha', 'cen', 'hip', 'proc', 'vega']) {
      catalog.search(query)
    }
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('agree on how many systems there are', () => {
    // Cheap, and it catches the other half of the same mistake: a manifest
    // regenerated against one build of the catalog and a file from another
    // would share a version and disagree about everything else.
    const declared = JSON.parse(readFileSync(manifest, 'utf8')) as {
      systems: number
    }
    expect(readCatalog(readFileSync(packed)).stars.length).toBe(
      declared.systems,
    )
  })
})
