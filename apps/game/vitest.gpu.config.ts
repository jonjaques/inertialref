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
 * asserted against arithmetic — in milliseconds, from a test file. The
 * reasoning and the measurements are `docs/plans/headless-webgpu.md`.
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
    include: ['apps/game/src/**/*.gpu.test.ts'],
    /*
     * The globals `three/webgpu` reads at import time, installed before any
     * test file's imports run. A test cannot do this itself: a module's imports
     * evaluate before its body, so `three/webgpu` would already have read an
     * absent `self` by the time a test's first line ran.
     */
    setupFiles: ['apps/game/src/render/gpuSetup.ts'],
    /*
     * One process per file, not one thread. Dawn is a native addon holding a
     * Metal device, and a worker thread sharing the addon with its siblings is
     * a question nobody needs answered by a test run. Each file gets its own
     * device and the OS reclaims it when the fork exits.
     */
    pool: 'forks',
    reporters: ['dot'],
  },
})
