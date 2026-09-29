import { defineWranglerConfig } from 'wrangler/experimental-config'

/*
 * The half of the Worker's configuration that belongs to its bundler. `cf`
 * builds this project with Wrangler (there is no `@cloudflare/vite-plugin`
 * here: the client is Astro's build, and the Worker is a plain module), and
 * these are the settings `cloudflare.config.ts` does not carry.
 */
export default defineWranglerConfig({
  /*
   * Client source maps are files in `apps/game/dist` and ride with the asset
   * store. This flag is the *script*: the bundler uploads the Worker's own map
   * so Cloudflare can remap stack traces in logs. It is not the client maps;
   * those are already in the asset directory once Vite writes them.
   */
  uploadSourceMaps: true,

  /*
   * The dev inspector defaults to 9229, which is Node's `--inspect` default.
   * `pnpm sim` binds that port; Attach Node is aimed at it. workerd listens
   * here instead so the two can run together.
   */
  dev: { host: 'localhost', inspectorPort: 9230 },

  // `.cloudflare/types/index.d.ts` is committed and `cf workers types` is its
  // one writer (the package's `types` script). The bundler emitting it as well
  // would give a checked-in file a second, unscheduled author.
  types: { generate: false },

  assetsDirectory: '../game/dist',
})
