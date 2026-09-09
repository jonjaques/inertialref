import { describe, expect, it } from 'vitest'
import { renderDocumentHead } from './documentHead.ts'
import { metadataForPath } from './site.ts'

describe('the document head', () => {
  it('escapes article text in tags and structured data', () => {
    const head = renderDocumentHead(
      metadataForPath('/docs/test', {
        title: '</script><img src=x onerror="alert(1)">',
        lead: 'Quotes " and ampersands & remain text in a document description.',
      }),
    )
    expect(head).not.toContain('<img')
    expect(head).toContain('&lt;/script&gt;&lt;img')
    expect(head).toContain('Quotes &quot; and ampersands &amp;')
    expect(head.match(/<\/script>/g)).toHaveLength(1)
    const body = head.match(
      /<script type="application\/ld\+json">([\s\S]*)<\/script>/,
    )?.[1]
    expect(JSON.parse(body ?? '')['@graph']).toBeDefined()
  })

  it('includes noindex for a missing page before any JavaScript runs', () => {
    const head = renderDocumentHead(metadataForPath('/missing'))
    expect(head).toContain('<meta name="robots" content="noindex, follow" />')
    expect(head).toContain('<title>Page Not Found · InertialRef</title>')
  })
})
