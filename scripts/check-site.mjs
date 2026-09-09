import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  canonicalUrl,
  documentTitle,
  metadataForPath,
} from '../apps/game/src/site.ts'

const root = new URL('../apps/game/dist/', import.meta.url)
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
    entry === undefined
      ? undefined
      : JSON.parse(
          await readFile(
            new URL(`doc-content/page/${entry.asset}`, root),
            'utf8',
          ),
        )
  const html = await readFile(new URL(file, root), 'utf8')
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

for (const route of Object.keys(manifest.pages)) {
  await readFile(new URL(`${route.slice(1)}.html`, root))
}
console.log(
  `site: ${checked} rendered documents verified in ${fileURLToPath(root)}`,
)
