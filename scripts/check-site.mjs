import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  canonicalUrl,
  documentTitle,
  metadataForPath,
} from '../apps/game/src/site.ts'
import { docHtmlRoutes, docRedirects, isApiRoute } from './docs/prerender.mjs'

const root = new URL('../apps/game/dist/', import.meta.url)
/*
 * This checkout's path, which a shipped bundle must not carry. The dev server
 * defines `__SERVED_TREE__` as it so a rig can tell sibling worktrees apart,
 * and a build defines it as null (apps/game/vite.config.ts); a define that
 * took the wrong branch would hand every visitor a path on this machine and
 * pass every other assertion here. Every page and every script is searched.
 */
const tree = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')
const leaks = (text, file) =>
  assert(!text.includes(tree), `${file}: carries this checkout's path, ${tree}`)
const manifest = JSON.parse(
  await readFile(new URL('doc-content/manifest.json', root), 'utf8'),
)
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const visibleText = (html) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) =>
      entity.startsWith('#')
        ? String.fromCodePoint(
            entity[1].toLowerCase() === 'x'
              ? Number.parseInt(entity.slice(2), 16)
              : Number(entity.slice(1)),
          )
        : entities[entity.toLowerCase()],
    )
    .replace(/\s+/g, ' ')
    .trim()
let checked = 0

for (const file of await readdir(root, { recursive: true })) {
  if (!file.endsWith('.html')) continue
  const route = file === 'index.html' ? '/' : `/${file.slice(0, -5)}`
  const entry = manifest.pages[route]
  const page =
    entry === undefined ||
    (manifest.prerenderApi === false && isApiRoute(route))
      ? undefined
      : JSON.parse(
          await readFile(
            new URL(`doc-content/page/${entry.asset}`, root),
            'utf8',
          ),
        )
  const html = await readFile(new URL(file, root), 'utf8')
  leaks(html, file)
  const meta = metadataForPath(route, page)
  assert(
    html.includes(`<title>${escape(documentTitle(meta))}</title>`),
    `${route}: missing rendered title`,
  )
  assert(
    html.includes(`href="${escape(canonicalUrl(meta.path))}"`),
    `${route}: missing canonical URL`,
  )
  assert(
    !html.includes('client="only"'),
    `${route}: shell skips server rendering`,
  )
  const body = html
    .slice(html.indexOf('<body'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  assert(/<h1\b/.test(body), `${route}: missing visible page heading`)
  if (page !== undefined) {
    assert(/<article\b/.test(body), `${route}: missing article HTML`)
    assert(/<nav\b/.test(body), `${route}: missing documentation navigation`)
    const heading = body.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0] ?? ''
    assert(
      visibleText(heading) === page.title.replace(/\s+/g, ' ').trim(),
      `${route}: missing visible document title`,
    )
  }
  checked += 1
}

let scripts = 0
for (const file of await readdir(root, { recursive: true })) {
  if (!file.endsWith('.js')) continue
  leaks(await readFile(new URL(file, root), 'utf8'), file)
  scripts += 1
}

for (const route of docHtmlRoutes(manifest)) {
  await readFile(new URL(`${route.slice(1)}.html`, root))
}
assert.equal(
  await readFile(new URL('_redirects', root), 'utf8'),
  docRedirects(manifest),
)
for (const entry of Object.values(manifest.pages)) {
  await readFile(new URL(`doc-content/page/${entry.asset}`, root))
}
console.log(
  `site: ${checked} rendered documents verified, and ${scripts} scripts carry no path of this checkout, in ${fileURLToPath(root)}`,
)
