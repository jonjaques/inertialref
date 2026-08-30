import { describe, expect, it } from 'vitest'
import type { ConfigEnv } from 'vite'
import astro from '../astro.config.ts'
import load from '../vite.config.ts'

/*
 * Source maps are a delivered artifact, not a local-only nicety. Vite's default
 * is `build.sourcemap: false` and `css.devSourcemap: false` — a production
 * build with neither set ships minified bundles that DevTools cannot map, and
 * a CSS change in `pnpm dev` has no mapping at all. The debugger configs in
 * `.vscode/` assume these are on; a config that silently dropped them would
 * still launch Chrome and still look like it was debugging, against the
 * generated file.
 */

const ENVIRONMENTS: readonly ConfigEnv[] = [
  { command: 'serve', mode: 'development' },
  { command: 'build', mode: 'production' },
]

describe('the game delivers source maps', () => {
  it.each(ENVIRONMENTS)('enables them for $command ($mode)', async (env) => {
    const config = await load(env)
    expect(config.build?.sourcemap).toBe(true)
    expect(config.css?.devSourcemap).toBe(true)
  })
})

describe('Astro emits the document the existing Worker knows how to serve', () => {
  it('keeps hashed assets under /assets and the harness on 5173', () => {
    // `public/sw.js`'s `isImmutable` matches `/assets/`, and `requireSourceMaps`
    // reads `dist/assets`. Both would silently stop applying under `_astro`.
    // `scripts/drive.mjs` and every page of the harness documentation name 5173.
    expect(astro.build?.assets).toBe('assets')
    // `server` is `ServerConfig | (({ command }) => ServerConfig)`. The config
    // we ship is the object form; a function here would not bind 5173 for
    // `astro preview` and would silently move the harness.
    const server = astro.server
    expect(
      server && typeof server !== 'function' ? server.port : undefined,
    ).toBe(5173)
    expect(astro.srcDir).toBe('./astro')
    expect(astro.output).toBe('static')
  })
})
