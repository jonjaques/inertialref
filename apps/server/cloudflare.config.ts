import { bindings, defineConfig } from 'cf/config'

/*
 * The Worker's platform configuration, read by `cf dev`, `cf deploy`,
 * `cf workers versions create` and `cf workers types`. What Wrangler still owns
 * as the bundler under `cf` — the dev inspector, the asset directory, source
 * maps — is `wrangler.config.ts` beside it.
 *
 * Nothing in this file may ever be a credential — it is committed. Secrets are
 * declared with `bindings.secret()` and their values set on the Worker, never
 * written as `bindings.text()`. The GA measurement id is not a credential and
 * is still not here: it is a *build* variable, set in Workers Builds, because
 * this repository is public and a fork should not measure into somebody else's
 * property. `apps/game/src/analytics.ts`.
 */
export default defineConfig({
  worker: {
    name: 'inertialrefd',
    compatibilityDate: '2026-08-20',
    entrypoint: 'src/index.ts',

    // Version previews identify one build; workers.dev does not track production.
    workersDev: false,
    previewUrls: true,

    /*
     * Everything the platform will record, unsampled. The guide is a few
     * requests an hour from a handful of trusted alpha visitors, so the volume
     * that makes sampling a question elsewhere does not exist here, and the
     * request worth reading is always the one that failed. There is no level
     * knob on this side: Workers Logs keeps every console record and takes
     * its level from the console method, so the level is chosen in
     * `src/tour/log.ts` at the call and filtered in the query builder.
     *
     *   logs    — every console record, plus one invocation log per request
     *             with the method, path, status, colo, ray and version. A 503
     *             from the guide is an `error` record beside it naming the
     *             provider's status and error code.
     *   traces  — a span per request, the `fetch` to the provider as a child
     *             with its status, and the route's own span around both, so a
     *             slow or refused session shows where the time and the
     *             failure sat. `traces.enabled` turns tracing on regardless
     *             of the compatibility date.
     *   persist — both stay queryable in the dashboard; a destination would
     *             forward them somewhere else, and there is nowhere else yet.
     *
     * Live: `pnpm --filter @inertialref/server run tail`.
     */
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
        persist: true,
      },
      traces: { enabled: true, headSamplingRate: 1, persist: true },
    },

    /*
     * One Worker is the whole front door (docs/hosting.md H-1): it serves the
     * client bundle, answers `/api/*`, and will route `/ws` to a Durable Object.
     *
     * Same origin means no CORS preflight on every API call, no second hostname
     * for the socket, and no SameSite gymnastics around whatever eventually
     * identifies a player. It costs nothing, because static asset requests are
     * free, unlimited, and never invoke the script at all.
     *
     * The directory is `assetsDirectory` in `wrangler.config.ts`, the bundler's
     * half of the configuration.
     */
    assets: {
      // Astro writes one HTML file per route. Unknown paths serve 404.html with
      // a 404 status; the home document cannot hydrate another page's address.
      notFoundHandling: '404-page',
      htmlHandling: 'drop-trailing-slash',
      /*
       * Static pages and assets never invoke the script. Only the live API,
       * reserved socket and media allow-list need the host adapter. `/api` is
       * separate because `/api/*` does not match the bare path.
       */
      runWorkerFirst: ['/api', '/api/*', '/ws', '/media/*'],
    },

    /* Both hosts serve the same app without a redirect. Service workers and
     * IndexedDB saves belong to their origin, so the legacy host must keep
     * answering /sw.js and existing installs. Metadata names inertialref.app.
     * Custom domains provision DNS and certificates in both account zones.
     */
    domains: ['inertialref.app', 'inertialref.jonjaques.com'],

    env: {
      TOUR_GUIDE_ENABLED: bindings.text('true'),
      OPENAI_API_KEY: bindings.secret(),
      TOUR_GUIDE_PASSWORD: bindings.secret(),

      /*
       * The site's object storage (docs/hosting.md H-8).
       *
       * It holds what the repository will not carry: today, one piece of
       * copyrighted reference audio whose use here is a claim worth making in
       * a deployment and not in a permanent, forkable, indexed git history.
       * The allow-list of what is actually served — and why it is an
       * allow-list and not a key prefix — is `src/media.ts`.
       *
       * The bucket is shared with anything else the site ever stores, so the
       * binding is *not* a license for the Worker to serve it.
       * `runWorkerFirst` routes `/media/*` here; `mediaFor` decides whether a
       * name exists at all.
       *
       * Biome material sets, when they exist, are the other planned tenant.
       */
      MEDIA: bindings.r2({ name: 'inertialrefd-storage' }),

      /*
       * Which deployment answered, for the health record. It is diagnostic
       * only and never compared against anything: "am I talking to the build
       * I just shipped" is a question that otherwise costs a log dive.
       */
      CF_VERSION_METADATA: bindings.versionMetadata(),

      /*
       * The one piece of state the guide keeps, and it is not the Worker's: a
       * counter the platform holds per key. Sign-in is a shared alpha password
       * behind a constant-time compare, and without a bound on attempts that
       * is a password an offline guess list would eventually walk. Ten a
       * minute per source is generous to a person and useless to a script.
       * The namespace is any integer unique within the account.
       */
      TOUR_LOGIN_LIMIT: bindings.rateLimit({
        namespace: '1001',
        simple: { limit: 10, period: 60 },
      }),

      ASSETS: bindings.assets(),
    },

    /*
     * No `exports` block, and that is load-bearing twice over. The Worker
     * implements no Durable Object class: the guide (docs/hosting.md) is two
     * stateless routes — sign in, and create a voice session from the
     * browser's SDP offer — because the browser owns its session through its
     * own peer connection and executes every tool itself; a server-side object
     * would hold a second copy of state it cannot see. And Cloudflare does not
     * issue version preview URLs for a Worker that implements a Durable Object,
     * so `cf workers versions create` produces a URL only while this stays
     * empty. The deployed Worker's `tour-v2` migration already deleted the two
     * classes `tour-v1` created, so there is no lifecycle left to declare.
     *
     * Deliberately absent until the milestone that needs them (docs/hosting.md):
     *
     *   exports.durableObject({ storage: 'sqlite' })
     *                        H4 — one PartitionAuthority per partition key,
     *                        with hibernating sockets. SQLite storage is what
     *                        makes the object SQLite-backed; say so here.
     *   bindings.d1(…)       H2 — accounts, catalog revisions and
     *                        first-discovery claims, which are the writes
     *                        needing a galaxy-wide uniqueness guarantee rather
     *                        than a per-partition ordering one.
     */
  },
})
