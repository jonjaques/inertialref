import { execSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
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

/**
 * One line in the build log saying whether this build can measure anything.
 *
 * `VITE_GA_MEASUREMENT_ID` is a Workers Builds *build variable* and is
 * deliberately not in the repository (`src/analytics.ts`), which means the one
 * way it fails — not reaching the build environment — produces a bundle that is
 * correct, passes every check, deploys cleanly and silently measures nothing.
 * There is no error to notice. Grepping the deployed bundle is how it was
 * caught the first time; this is so the *build log* answers it instead.
 *
 * The id is not printed. It is public, but a build log is a bad habit to start.
 */
function reportAnalytics(mode: string): void {
  /*
   * Through `loadEnv`, not `process.env`, because the two sources are the whole
   * point: CI sets a real environment variable and a developer's machine has a
   * gitignored `.env.production`. Reading only the former reports "not set" on
   * a local build whose bundle does contain the id, which is a diagnostic that
   * lies in the direction that wastes the most time.
   */
  const fromEnvironment = (process.env['VITE_GA_MEASUREMENT_ID'] ?? '') !== ''
  const resolved =
    loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')[
      'VITE_GA_MEASUREMENT_ID'
    ] ?? ''
  console.log(
    resolved === ''
      ? `analytics: VITE_GA_MEASUREMENT_ID is NOT set — this build measures ` +
          `nothing, which is correct for a fork and wrong for production (${mode})`
      : `analytics: VITE_GA_MEASUREMENT_ID is set from ` +
          `${fromEnvironment ? 'the environment' : 'a .env file'} (${mode})`,
  )
}

/**
 * Fail the production build if it did not actually *deliver* source maps.
 *
 * `build.sourcemap: true` is the switch; this is the check that it took.
 * `hidden` writes `.map` files and omits the `sourceMappingURL` comment, so
 * DevTools never fetches them — a deployed site that looks debuggable from
 * the asset list and is not. The comment is the delivery; the sibling file
 * is the payload. Both have to exist for every hashed JS asset, including
 * the universe worker.
 *
 * CSS is not in this check. Vite 8 minifies it with lightningcss and strips
 * `sourceMap` from the options the user can set, so a production CSS file
 * has no map even when `build.sourcemap` is true. Dev CSS maps are
 * `css.devSourcemap`. Copied `public/` files (`sw.js`) are not compiled
 * and are not in `assets/`.
 */
/** As much of a rolled-up chunk as the check below needs to identify it. */
interface OutputEntry {
  readonly moduleIds?: readonly string[]
  readonly modules?: Readonly<Record<string, unknown>>
}

/**
 * A chunk with none of this repository's source in it.
 *
 * Two kinds turn up and neither is a regression in the build's settings.
 * **A dependency's own split**: Mermaid code-splits its diagram parsers, and the
 * pre-built ESM it publishes carries no `sourceMappingURL` at all, so nineteen
 * `architecture-*.js`-shaped files arrive already unmappable. **Vite's own
 * runtime helper**: `\0vite/preload-helper.js` is a virtual module the bundler
 * writes for dynamic imports, which the documentation section's lazy Mermaid
 * import is the first thing here to need.
 *
 * Neither is code anyone would set a breakpoint in, neither is fixable from
 * this repository, and the check exists so that *our* source stays mappable.
 *
 * Deliberately narrow, in three ways that each close a hole. One first-party
 * module in the chunk and it is ours again. A chunk whose module list is
 * unavailable counts as ours too, because the failure this guards against is
 * silent and the check is worth more than the false positive. And the virtual
 * prefix is `\0vite/` rather than `\0`: any plugin may emit a virtual module,
 * and the first one here that does would otherwise be first-party source in a
 * chunk this check had stopped looking at.
 */
function hasNoSourceOfOurs(chunk: OutputEntry | undefined): boolean {
  const ids = chunk?.moduleIds ?? Object.keys(chunk?.modules ?? {})
  return (
    ids.length > 0 &&
    ids.every((id) => id.includes('node_modules') || id.startsWith('\0vite/'))
  )
}

function requireSourceMaps() {
  return {
    name: 'inertialref:require-source-maps',
    apply: 'build' as const,
    /*
     * `writeBundle`, not `closeBundle`. Vite 8 closes an empty environment
     * before the client write, and throwing there aborts the real build
     * with "0 modules transformed". Skip a directory that does not exist
     * yet; the client write is the one that has files to check.
     */
    writeBundle(_options: unknown, bundle: Record<string, OutputEntry>) {
      const dir = fileURLToPath(new URL('./dist/assets', import.meta.url))
      if (!existsSync(dir)) return
      const names = readdirSync(dir)
      const scripts = names.filter(
        (name) => name.endsWith('.js') && !name.endsWith('.map'),
      )
      if (scripts.length === 0) return
      for (const name of scripts) {
        const text = readFileSync(`${dir}/${name}`, 'utf8')
        if (!text.includes('sourceMappingURL')) {
          if (hasNoSourceOfOurs(bundle[`assets/${name}`])) continue
          throw new Error(
            `dist/assets/${name} has no sourceMappingURL — the debugger ` +
              'cannot map it. build.sourcemap must be true, not hidden.',
          )
        }
        if (!names.includes(`${name}.map`))
          throw new Error(
            `dist/assets/${name} points at a source map that was not emitted`,
          )
      }
    },
  }
}

/**
 * Refuse to bundle a git-lfs pointer in place of a model.
 *
 * `render/shipModels.ts` pulls `data/models/*.glb` in through
 * `import.meta.glob`, and Vite copies an asset without looking inside it — so
 * on a checkout that skipped the smudge filter the build *succeeds* and ships
 * 130 bytes of pointer text where the hero ship should be. There is no error
 * anywhere; the renderer just falls back to the debug cone at runtime, which is
 * how this last went unnoticed on the Cloud Agent image (6dea1c7).
 *
 * Every environment that checks this repository out needs LFS and each one
 * fails its own way — GitHub Actions threw during test collection, Workers
 * Builds would not have complained at all. Rather than fix them one at a time,
 * the build itself declines: a glTF starts with the ASCII magic `glTF`, and
 * anything that does not is not a model.
 */
function requireRealModels() {
  return {
    name: 'inertialref:require-real-models',
    apply: 'build' as const,
    buildStart() {
      const dir = fileURLToPath(new URL('../../data/models', import.meta.url))
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
        const head = Buffer.alloc(4)
        const fd = openSync(`${dir}/${file}`, 'r')
        try {
          readSync(fd, head, 0, 4, 0)
        } finally {
          closeSync(fd)
        }
        if (head.toString('ascii') !== 'glTF')
          throw new Error(
            `data/models/${file} is not a glTF — most likely a git-lfs ` +
              'pointer. Run `git lfs pull` before building; a build that ' +
              'bundles the pointer ships a broken ship and says nothing.',
          )
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  reportAnalytics(mode)
  return {
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
      requireRealModels(),
      requireSourceMaps(),
      react(),
      // React Compiler handles memoisation, so components here do not hand-write
      // useMemo/useCallback around render work.
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    /*
     * Source maps in every mode. Vite's defaults are the opposite: JS maps in
     * `pnpm dev` only, nothing for CSS, and `build.sourcemap: false` — so a
     * production deploy, and `pnpm preview`, ship minified bundles the
     * debugger cannot map. `true` rather than `hidden` so the file carries
     * `sourceMappingURL` and DevTools actually fetches the sibling `.map`.
     * The repository is public; original source is not a secret the bundle
     * was keeping.
     */
    css: { devSourcemap: true },
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
      sourcemap: true,
    },
  }
})
