import { describe, expect, it } from 'vitest'
import type { ConfigEnv } from 'vite'
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
