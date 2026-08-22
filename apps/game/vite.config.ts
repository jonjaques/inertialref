import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

/**
 * An identifier for this build, injected as `__BUILD_ID__` (see `src/build.ts`).
 *
 * The service worker names its cache after it, which is the whole reason it
 * exists: `public/sw.js` is copied verbatim and never compiled, so a constant
 * cannot be injected into it — it reads this off its own registration URL
 * instead. A build id that does not change means a cache that is never
 * replaced.
 *
 * Three sources, in order of how much they know:
 *
 *   1. Workers Builds, which states the commit and the branch outright. Asking
 *      git there is worse than asking the CI system: the checkout is detached
 *      and may be shallow, and for a review app the *branch* is the thing you
 *      want to read off the HUD to know which one you are looking at.
 *   2. git locally. `--dirty` matters more than it looks — a production build
 *      of uncommitted work is otherwise indistinguishable from the commit it
 *      sits on, and the two would share a cache.
 *   3. Wall clock, for a checkout with no git history at all: a tarball, or a
 *      shallow clone somewhere else. It is the one clock read in this
 *      repository that is allowed, because nothing derived from it ever enters
 *      the simulation; ADR-0006's ban is on canonical code.
 */
function buildId(): string {
  const sha = process.env['WORKERS_CI_COMMIT_SHA']
  if (sha !== undefined && sha !== '') {
    const branch = process.env['WORKERS_CI_BRANCH'] ?? ''
    const short = sha.slice(0, 8)
    return branch === '' || branch === 'main'
      ? short
      : `${slug(branch)}@${short}`
  }
  try {
    return execSync('git describe --always --dirty --abbrev=8', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return `t${Date.now().toString(36)}`
  }
}

/** Branch names carry slashes; this ends up in a URL and a Cache Storage key. */
const slug = (text: string): string =>
  text.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)

export default defineConfig({
  /*
   * `@/` is the one non-relative import specifier in this repository.
   *
   * Everything else here imports by relative path with its extension, and that
   * stays true for code written by hand. This alias exists because shadcn/ui's
   * registry emits components that import `@/lib/utils` and `@/components/ui/*`
   * literally — `pnpm dlx shadcn add <name>` writes those strings into the file
   * — so without it every added component is a file to hand-edit before it
   * compiles, and re-adding one to pick up an upstream fix undoes the edit.
   * `apps/game/tsconfig.json` carries the matching `paths` entry; they have to
   * agree or the build and the typecheck disagree about the same import.
   */
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    // React Compiler handles memoisation, so components here do not hand-write
    // useMemo/useCallback around render work.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  server: {
    /*
     * Two processes in development, deliberately (docs/hosting.md).
     *
     * `@cloudflare/vite-plugin` would run the Worker inside this dev server on
     * real workerd, which is nicer — and it takes over the client build, which
     * is Vite 8 with the Oxc transform, a Babel pass for the React Compiler and
     * Tailwind. That build is tuned and load-bearing; a proxy is not. Revisit
     * the plugin when the second terminal is more annoying than a build
     * regression with two suspects, and revisit it on its own.
     *
     * With `wrangler dev` not running, these fail and the client reports
     * `no server` — which is the offline path, exercised by default.
     */
    proxy: {
      '^/api($|/)': { target: 'http://127.0.0.1:8787' },
      '^/ws$': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  worker: {
    // The worker imports workspace packages as ES modules; the classic worker
    // format cannot.
    format: 'es',
  },
  build: {
    target: 'es2023',
  },
})
