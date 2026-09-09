import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocManifest, DocPage } from '../src/docs/content.ts'

/** Astro bundles this module before rendering; staged data stays at the project root. */
function contentDirectory(): string {
  const candidates = [
    join(process.cwd(), 'public/doc-content'),
    join(process.cwd(), 'apps/game/public/doc-content'),
  ]
  const directory = candidates.find((path) =>
    existsSync(join(path, 'manifest.json')),
  )
  if (directory === undefined)
    throw new Error('Run pnpm docs:build before rendering the site.')
  return directory
}

export async function stagedManifest(): Promise<DocManifest> {
  return JSON.parse(
    await readFile(join(contentDirectory(), 'manifest.json'), 'utf8'),
  )
}

export async function stagedPage(
  manifest: DocManifest,
  route: string,
): Promise<DocPage> {
  const entry = manifest.pages[route]
  if (entry === undefined) throw new Error(`No documentation page at ${route}`)
  return JSON.parse(
    await readFile(join(contentDirectory(), 'page', entry.asset), 'utf8'),
  )
}
