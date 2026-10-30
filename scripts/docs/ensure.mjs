#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * The documentation manifest, built when it is absent and left alone when it
 * is not.
 *
 * Every page of the site reads it, not only `/docs`: the catch-all route's
 * `getStaticPaths` lists the documentation routes beside the shell's, and
 * Astro's dev server calls it to match any URL at all. So a checkout without
 * `apps/game/public/doc-content/` — every fresh worktree, every clone — serves
 * "Run pnpm docs:build before rendering the site." on its first page, the game
 * included. The game package's `dev` script runs this before `astro dev`,
 * which covers `pnpm dev`, `pnpm dev:client` — what a worktree serves itself
 * with on a port of its own — and the driver's own start alike.
 *
 * Absence and not staleness, on purpose: the build is fifteen seconds and a
 * dev server that rebuilt the corpus on every start would charge that to every
 * restart for documents that change a few times a day. `pnpm docs:build`
 * refreshes it by hand, and `pnpm build` always does.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MANIFEST = fileURLToPath(
  new URL('../../apps/game/public/doc-content/manifest.json', import.meta.url),
)

if (!existsSync(MANIFEST)) {
  console.log('No documentation manifest in this checkout; building it once.')
  execFileSync('node', ['scripts/docs/build.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
}
