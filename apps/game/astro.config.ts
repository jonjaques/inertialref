import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import { SITE } from './src/site.ts'
import { gameVite } from './vite.config.ts'

/*
 * Astro owns `<html>`. The renderer is an island that arrives behind it.
 *
 * Five settings, and every one of them exists to keep something that already
 * works working. `docs/plans/astro-shell.md` is the argument; this file is the
 * values.
 *
 * `@astrojs/react` supplies the JSX transform. `gameVite()` must not also add
 * `@vitejs/plugin-react`, or JSX is transformed twice. The React Compiler pass
 * still runs: it is a Babel preset, not the JSX plugin.
 */
export default defineConfig({
  srcDir: './astro',
  site: SITE.origin,
  trailingSlash: 'never',
  output: 'static',
  build: {
    assets: 'assets',
    format: 'file',
  },
  server: { port: 5173 },
  integrations: [react()],
  vite: gameVite(),
})
