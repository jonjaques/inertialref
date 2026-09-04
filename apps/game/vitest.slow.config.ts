import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/*
 * The slow suite: `pnpm test:slow`.
 *
 * A second vitest project selected by the `.slow.test.ts` suffix, which the
 * root config excludes, for the tests that stream a landing: a whole-disk
 * selection's worth of bordered 65×65 heightfields generated serially through
 * an inline worker at 22 to 50 ms apiece — about a hundred seconds in one
 * `beforeAll`, against ten for everything else in the root suite together.
 * The root suite is what the Stop hook runs after every turn, so that hook
 * proves the rest of the engine in ten seconds, and this project proves the
 * landing once per pull request, from `pnpm check` and CI.
 *
 * It makes the same portability claim the root config does — plain Node, no
 * browser, no GPU — which is what lets it run on CI's Linux runner where the
 * GPU project (`vitest.gpu.config.ts`) cannot. What separates the two suites
 * is cost and nothing else. `design/plans/test-speed.md` has the accounting
 * and what would make the landing itself cheaper.
 */
export default defineConfig({
  // The same `define` and alias the root config carries, for the reasons it
  // gives: the engine reaches `build.ts` and `@/` imports through what it
  // imports, and this project does not go through the root.
  define: { __BUILD_ID__: JSON.stringify('test') },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // From the repository root, not from this file, as the GPU project's
    // header explains: vitest resolves `include` against the working directory
    // `pnpm test:slow` runs in.
    include: ['{apps,packages}/*/src/**/*.slow.test.ts'],
    /*
     * The root config's 20 s, and for its reason: a timeout guards against a
     * hang, not against cost. The descent itself carries its own five-minute
     * budget at the `beforeAll` call site, which is where a test that needs
     * more says so.
     */
    testTimeout: 20_000,
    reporters: ['dot'],
  },
})
