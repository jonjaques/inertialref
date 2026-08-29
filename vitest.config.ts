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
     * 5 seconds, not vitest's default 300 ms.
     *
     * The dot reporter says nothing about a test until the run ends, so the only
     * live sign of a slow one is the running panel — and the panel is only worth
     * reading if what it lists is remarkable. At 300 ms it names a dozen honest
     * tests, at 5 s it names the descent in `gameEngine.test.ts` and nothing
     * else. That is how a test grown into a minute gets noticed while it is
     * still under its own timeout, rather than on the day the timeout starts
     * measuring how busy the machine is.
     */
    slowTestThreshold: 5_000,
  },
})
