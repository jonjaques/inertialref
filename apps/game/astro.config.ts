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
  /*
   * The dev toolbar is a strip of chrome at the bottom of every dev page, and
   * a plate is a page photographed without chrome. The capture rig serves the
   * tree with this switch set; a person's own `astro dev` keeps the toolbar.
   */
  devToolbar: { enabled: process.env.ASTRO_DEV_TOOLBAR !== '0' },
  integrations: [
    react(),
    sitemap({ filter: (url) => metadataForPath(new URL(url).pathname).index }),
  ],
  vite: gameVite(),
})
