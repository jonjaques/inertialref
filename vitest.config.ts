import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

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
    /*
     * `scripts/` is here for the two build scripts that decide something rather
     * than only emitting it: the gate on `index.html`, which is the only
     * public-surface artifact `pnpm brand` checks rather than generates, and the
     * route table the documentation build maps every file and every link
     * through. Both are `.mjs` — they import `site.ts` under Node's type
     * stripping — so their tests are too, and the pattern stays narrow rather
     * than `scripts/**\/*.test.*`.
     */
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    /*
     * The GPU suite is `apps/game/vitest.gpu.config.ts` and `pnpm test:gpu`.
     * The app glob above would collect it, and on a machine with no GPU — CI's
     * Linux runner, a cloud session — every one of those files fails at
     * `requestAdapter` for a reason that has nothing to do with the change
     * under test. Excluded here so `pnpm test` keeps the claim in the header.
     */
    exclude: [...configDefaults.exclude, '**/*.gpu.test.ts'],
    /*
     * 20 seconds, not vitest's default 5.
     *
     * The default was ample while nothing in the suite took more than a couple
     * of hundred milliseconds. Several things now legitimately take a second or
     * more of pure CPU — 128-body Solar Systems stepped for thousands of ticks,
     * fast-check properties over a quarter of a million noise samples, a
     * uniformity test over an Rng's whole output distribution — and the runner
     * puts sixty-four files across every core at once. Measured under that
     * contention: tests that finish in 1.1 s standalone were being killed at 5,
     * and the ones that failed were mostly *not* the new ones. Nothing was
     * wrong with them; the timeout had stopped measuring the code and started
     * measuring how busy the machine was.
     *
     * A timeout is a guard against a hang, and 20 s is still an order of
     * magnitude below any of these. Individual tests that need more say so at
     * the call site with their own reason.
     */
    testTimeout: 20_000,
    reporters: ['dot'],
    /*
     * `pnpm test:coverage`. Off unless asked for — the v8 provider costs about
     * a third of the run.
     *
     * `include` is the whole source tree, and that is the entire point of the
     * block. Vitest reports only the files a test *loaded* unless the globs say
     * otherwise, so the default denominator is "the code that has tests" and
     * the number it prints is a statement about nothing: 85.9% measured that
     * way, 57.2% over the tree it is measuring. A file no test imports has to
     * count as zero or the figure rewards deleting the test.
     *
     * The figure is still not the whole story, because the render layer's
     * tests are `pnpm test:gpu`, which this config excludes by suffix and which
     * writes its own report. Nine modules under `apps/game/src/render` read 0%
     * here and 46-100% there. `docs/plans/complexity.md` carries the merged
     * numbers and the commands that produce them.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.gpu.test.ts', '**/*.d.ts'],
    },
  },
})
