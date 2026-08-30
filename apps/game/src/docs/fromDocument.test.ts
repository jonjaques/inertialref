import { describe, expect, it } from 'vitest'
import type { DocPage } from './content.ts'
import { readDocPage, type DocSource } from './fromDocument.ts'
import { DOC_PAGE_SCRIPT_ID, DOC_SSR_ID, encodeJsonScript } from './urls.ts'

const META: Omit<DocPage, 'html'> = {
  route: '/docs/concepts/frames',
  title: 'Reference frames',
  lead: 'How a body-fixed frame relates to an inertial one.',
  kind: 'prose',
  headings: [{ id: 'the-chain', text: 'The chain', depth: 2 }],
  words: 400,
  diagrams: 1,
  source: null,
  packageName: null,
  memberKind: null,
}

const HTML = '<h2 id="the-chain">The chain</h2><p>A frame is a stance.</p>'

function fake(parts: {
  script?: string | null
  html?: string | null
}): DocSource {
  const nodes = new Map<
    string,
    { textContent: string | null; innerHTML: string }
  >()
  if (parts.script !== undefined && parts.script !== null) {
    nodes.set(DOC_PAGE_SCRIPT_ID, {
      textContent: parts.script,
      innerHTML: '',
    })
  }
  if (parts.html !== undefined && parts.html !== null) {
    nodes.set(DOC_SSR_ID, { textContent: parts.html, innerHTML: parts.html })
  }
  return { getElementById: (id) => nodes.get(id) ?? null }
}

describe('JSON that sits inside a script tag', () => {
  it('round-trips a heading that would close the tag', () => {
    const value = { text: 'Use </script> in a heading' }
    const encoded = encodeJsonScript(value)
    expect(encoded).not.toMatch(/<\/script>/i)
    expect(JSON.parse(encoded)).toEqual(value)
  })
})

describe('the page this document was built to be', () => {
  it('joins the metadata script with the served article', () => {
    const page = readDocPage(
      fake({ script: encodeJsonScript(META), html: HTML }),
    )
    expect(page).toEqual({ ...META, html: HTML })
  })

  it('is a miss when the script or the article is absent', () => {
    expect(readDocPage(fake({ script: encodeJsonScript(META) }))).toBeNull()
    expect(readDocPage(fake({ html: HTML }))).toBeNull()
    expect(readDocPage(fake({}))).toBeNull()
  })

  it('is a miss when the script is not JSON, rather than a throw', () => {
    expect(readDocPage(fake({ script: '{', html: HTML }))).toBeNull()
  })
})
