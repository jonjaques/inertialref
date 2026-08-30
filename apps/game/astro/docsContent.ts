import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocManifest, DocPage } from '../src/docs/content.ts'
import { docsParam, docsRoute } from '../src/docs/urls.ts'

/*
 * The staged documentation, as the Astro build sees it.
 *
 * `scripts/docs/build.mjs` writes `apps/game/.doc-content/`. This is the
 * only thing that reads it. A missing directory is a missing `pnpm docs:build`,
 * and that is a build failure rather than a sentence on a page — the
 * document cannot be emitted without the body that is supposed to be in it.
 *
 * Node `fs`, not `fetch`. This module is imported from `getStaticPaths` and
 * from the page's frontmatter, both of which run at build time. A client
 * island that imported it would pull `node:fs` into the browser graph.
 *
 * **`process.cwd()`, not `import.meta.url`.** Astro bundles this module
 * into `dist/.prerender/chunks/` before `getStaticPaths` runs, so a path
 * relative to the module would look for the manifest next to the chunk.
 * The build is invoked from `apps/game` (`pnpm --filter @inertialref/game
 * build`) or from the workspace root (`pnpm build`); both are listed.
 */

export { docsParam, docsRoute }

function stagedDir(): string {
  const candidates = [
    join(process.cwd(), '.doc-content'),
    join(process.cwd(), 'apps/game/.doc-content'),
  ]
  return (
    candidates.find((dir) => existsSync(join(dir, 'manifest.json'))) ??
    candidates[0]!
  )
}

/** The manifest, or a build failure naming the fix. */
export async function stagedManifest(): Promise<DocManifest> {
  try {
    const raw = await readFile(join(stagedDir(), 'manifest.json'), 'utf8')
    return JSON.parse(raw) as DocManifest
  } catch (cause: unknown) {
    const error = new Error(
      'This build carries no documentation. Run `pnpm docs:build` to generate it — ' +
        '`pnpm build` runs it first, so a deployed build always has it.',
    )
    error.cause = cause
    throw error
  }
}

/** One page's body, from the asset name the manifest already verified. */
export async function stagedPage(
  manifest: DocManifest,
  route: string,
): Promise<DocPage> {
  const entry = manifest.pages[route]
  if (entry === undefined) {
    throw new Error(`Nothing in this build answers to ${route}.`)
  }
  const raw = await readFile(join(stagedDir(), 'page', entry.asset), 'utf8')
  return JSON.parse(raw) as DocPage
}

/**
 * `getStaticPaths` entries, one per manifest route.
 *
 * The index is `{ params: { route: undefined } }`, which is how a rest
 * param names `/docs` rather than `/docs/undefined`.
 */
export function staticDocsPaths(manifest: DocManifest) {
  return Object.keys(manifest.pages).map((route) => ({
    params: { route: docsParam(route) },
  }))
}
