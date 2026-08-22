import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests live beside the code they cover, and every one of them must be runnable
// in plain Node — that is the check that the simulation core stays free of DOM,
// React, and WebGL. Nothing here registers a browser environment on purpose.
export default defineConfig({
  /*
   * `apps/game/src/build.ts` reads a constant that Vite's `define` substitutes
   * at build time (see apps/game/vite.config.ts). Tests do not go through that
   * config, so without this the HUD smoke test fails on a bare
   * `__BUILD_ID__ is not defined` — an error about a build system, thrown by a
   * test about an overlay.
   */
  define: { __BUILD_ID__: JSON.stringify('test') },
  /*
   * `apps/game`'s `@/` alias, repeated.
   *
   * Tests do not go through that app's Vite config (see `define` above for the
   * other half of the same problem), and vitest resolves imports itself rather
   * than through tsconfig `paths`. Without this, the HUD smoke test fails to
   * resolve the `@/lib/utils` import that shadcn/ui writes into every component
   * it generates — an error about module resolution, thrown by a test about an
   * overlay. It is scoped to that app because nothing else in the repository
   * has an alias; `packages/*` import each other by workspace name.
   */
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/game/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    reporters: ['dot'],
  },
})
