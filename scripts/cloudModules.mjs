/*
 * The modules no page loads until `?clouds=1` asks for them, named once for
 * the two checks that hold it: `check-chunks.mjs` in the gate, over an
 * in-memory build of `App.tsx`, and `check-site-chunks.mjs` in the bundle
 * stage, over the site Astro wrote.
 *
 * The clouds load behind `import()`. A static edge into one of these from
 * anything a page loads at startup puts it, and through the march the mie
 * table (190 kB gzipped), on every page, and nothing else fails: the build
 * succeeds and the page draws the same.
 */
import { relative, resolve } from 'node:path'

export const root = new URL('..', import.meta.url).pathname

export const CLOUD_MODULES = [
  'apps/game/src/render/cloudSystem.ts',
  'apps/game/src/render/cloudTrace.ts',
  'apps/game/src/render/cloudMarch.ts',
  'packages/rendering/src/weatherField.ts',
  'packages/rendering/src/mieTable.ts',
  'packages/rendering/src/mieDroplets.generated.ts',
]

/**
 * A module id or a source map's source as a path from the repository root.
 * Vite marks a virtual module with a leading NUL and keeps an import's query
 * (`cloudMarch.ts?raw`, `?worker`) in the id, and the module is the same file
 * either way: compared whole, `cloudMarch.ts?review` read as no cloud module.
 */
export function sourcePath(id, from = root) {
  const path = id.replace(/^\0/, '').replace(/[?#].*$/, '')
  return relative(root, resolve(from, path))
}
