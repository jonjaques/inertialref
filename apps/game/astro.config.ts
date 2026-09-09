import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import { metadataForPath, SITE } from './src/site.ts'
import { gameVite } from './vite.config.ts'

export default defineConfig({
  srcDir: './astro',
  site: SITE.origin,
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file', assets: 'assets' },
  server: { port: 5173 },
  integrations: [
    react(),
    sitemap({ filter: (url) => metadataForPath(new URL(url).pathname).index }),
  ],
  vite: gameVite(),
})
