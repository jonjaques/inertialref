import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'
import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import { metadataForPath, SITE } from './src/site.ts'
import { gameVite } from './vite.config.ts'

/**
 * The soundtrack's delivery files, out of the build.
 *
 * `pnpm audio:build` writes them into `public/media/music/` so that the dev
 * server serves them by range, as it serves everything there — and the build
 * copies `public/` into `dist/` whole. A deploy must not carry them: the
 * static assets ignore `Range` and refuse any file over 25 MiB, and the
 * Worker serves the soundtrack from R2 instead (`apps/server/src/media.ts`,
 * docs/hosting.md H-8). Workers Builds never has the files, which are
 * gitignored; this is for a build on a machine that ran the audio pipeline,
 * whose deploy would otherwise try to upload 820 MB the platform refuses.
 */
const soundtrackOutOfDist: AstroIntegration = {
  name: 'inertialref:soundtrack-out-of-dist',
  hooks: {
    'astro:build:done': ({ dir }) => {
      rmSync(fileURLToPath(new URL('media/music', dir)), {
        recursive: true,
        force: true,
      })
    },
  },
}

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
    soundtrackOutOfDist,
  ],
  vite: gameVite(),
})
