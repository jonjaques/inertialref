import {
  SITE,
  canonicalUrl,
  documentTitle,
  robotsContent,
  type PageMeta,
} from './site.ts'

/** Escape text for both quoted attributes and text nodes. */
const escape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

/** The same renderer feeds Astro and the brand gate without a production build. */
export function renderDocumentHead(page: PageMeta): string {
  const title = documentTitle(page)
  const canonical = canonicalUrl(page.path)
  const image = `${SITE.origin}${SITE.socialImage}`
  const meta = (name: string, content: string, property = false): string =>
    `<meta ${property ? 'property' : 'name'}="${name}" content="${escape(content)}" />`
  const structured = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': page.path === '/' ? 'WebSite' : 'WebPage',
        '@id': `${canonical}#page`,
        url: canonical,
        name: title,
        description: page.description,
        inLanguage: 'en',
        publisher: { '@id': `${SITE.origin}/#author` },
      },
      {
        '@type': 'Person',
        '@id': `${SITE.origin}/#author`,
        name: SITE.author,
        url: new URL('.', SITE.repository).href.replace(/\/$/, ''),
      },
      {
        '@type': ['SoftwareApplication', 'VideoGame'],
        '@id': `${SITE.origin}/#app`,
        name: SITE.name,
        url: SITE.origin,
        applicationCategory: 'GameApplication',
        applicationSubCategory: 'Space flight simulator',
        operatingSystem: 'Any modern web browser with WebGPU',
        browserRequirements: 'Requires WebGPU for the simulation',
        description: SITE.description,
        image,
        screenshot: image,
        author: { '@id': `${SITE.origin}/#author` },
        codeRepository: SITE.repository,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        genre: ['Simulation', 'Space flight'],
        gamePlatform: 'Web browser',
      },
    ],
  }
  // An article title can contain </script>; JSON escaping alone cannot keep it
  // inside an HTML script element. Escaping '<' also protects inline hydration.
  const json = JSON.stringify(structured).replaceAll('<', '\\u003c')
  return [
    '<meta charset="UTF-8" />',
    meta(
      'viewport',
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content',
    ),
    meta('color-scheme', 'dark'),
    `<title>${escape(title)}</title>`,
    meta('description', page.description),
    `<link rel="canonical" href="${escape(canonical)}" />`,
    meta('author', SITE.author),
    meta('robots', robotsContent(page)),
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    '<link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="48x48" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    meta('theme-color', SITE.background),
    meta('mobile-web-app-capable', 'yes'),
    meta('apple-mobile-web-app-capable', 'yes'),
    meta('apple-mobile-web-app-title', SITE.name),
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent'),
    meta('og:type', 'website', true),
    meta('og:site_name', SITE.name, true),
    meta('og:title', title, true),
    meta('og:description', page.description, true),
    meta('og:url', canonical, true),
    meta('og:image', image, true),
    meta('og:image:type', 'image/png', true),
    meta('og:image:width', '1200', true),
    meta('og:image:height', '630', true),
    meta(
      'og:image:alt',
      'The InertialRef mark and wordmark over a sunlit planet limb.',
      true,
    ),
    meta('og:locale', 'en', true),
    meta('twitter:card', 'summary_large_image'),
    meta('twitter:title', title),
    meta('twitter:description', page.description),
    meta('twitter:image', image),
    `<script type="application/ld+json">${json}</script>`,
  ].join('\n')
}
