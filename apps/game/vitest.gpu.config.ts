import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/*
 * The GPU suite: `pnpm test:gpu`.
 *
 * A second vitest project rather than a pattern in the root one, because the
 * root config's header makes a portability claim — every test runs in plain
 * Node, nothing registers a browser — and this suite makes a different one. It
 * registers no browser either, but it needs a physical GPU: `webgpu` is Dawn as
 * a Node addon, and on a machine without a Metal, Vulkan or D3D adapter every
 * file here fails at `requestAdapter`. That is a claim about the machine, not
 * the code, so it sits behind its own command and outside `pnpm check`.
 *
 * What it buys is the one feedback loop the browser rig cannot give: a TSL
 * graph compiled to a Metal pipeline, its WGSL read back, and its pixels
 * asserted against arithmetic — in milliseconds, from a test file. How to write
 * a bound that survives that pipeline is `docs/guides/testing.md`; what is still
 * unanswered about running it in CI is `design/plans/headless-webgpu.md`.
 */
export default defineConfig({
  // The same `define` and alias the root config carries, and for the same
  // reasons it gives: a material module can reach `build.ts` or a `@/` import
  // through what it imports, and this project does not go through the root.
  define: { __BUILD_ID__: JSON.stringify('test') },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    /*
     * From the repository root, not from this file: vitest resolves `include`
     * and `setupFiles` against its `root`, which is the working directory
     * `pnpm test:gpu` runs in. Written relative to this file they match
     * nothing, and the run exits 1 with "No test files found".
     */
    /*
     * Every workspace, not just this app. The root config excludes the
     * `.gpu.test.ts` suffix repository-wide, so a file this project does not
     * also collect runs in neither suite and reports nothing — and
     * `packages/*` is where a kernel worth testing on the GPU would live.
     */
    include: ['{apps,packages}/*/src/**/*.gpu.test.ts'],
    /*
     * The globals `three/webgpu` reads at import time, installed before any
     * test file's imports run. A test cannot do this itself: a module's imports
     * evaluate before its body, so `three/webgpu` would already have read an
     * absent `self` by the time a test's first line ran.
     */
    setupFiles: ['apps/game/src/render/gpuSetup.ts'],
    /*
     * Processes, not threads. Dawn is a native addon holding a Metal device,
     * and a worker thread sharing the addon with its siblings is a question
     * nobody needs answered by a test run.
     *
     * Forks are pooled and reused up to `maxForks`, so "one process per file"
     * is what a machine with cores to spare gives and not what this option
     * promises: at `--maxWorkers=1` all four files run in one process, each
     * calling `create([])` again, and the suite costs 2.2 s rather than the
     * 0.6 s four of them cost in parallel on a ten-core M5. Four Dawn
     * instances in one process is fine; the figure quoted for this suite is
     * about the machine.
     */
    pool: 'forks',
    /*
     * The root config's budgets, and for the reason its header gives: under
     * contention a timeout stops measuring the code and starts measuring how
     * busy the machine is. This suite is 0.6 s idle and every file's
     * `beforeAll` pays a `dlopen` of a native addon, an adapter request and a
     * device creation before it runs a line — on a machine also running the
     * 103 s root suite that is a false red at vitest's 10 s hook default.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['dot'],
  },
})
