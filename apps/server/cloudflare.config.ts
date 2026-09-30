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
export default defineConfig(({ isPreview }) => {
  /*
   * `cf previews deploy` evaluates this with `isPreview`, and a preview
   * differs from production in one thing: it has no custom domains (below).
   * Everything else is the same in a preview, in production and under
   * `cf dev`, whatever `--mode` says.
   *
   * Plain-text variables are declared here rather than set in the dashboard,
   * and it is not a preference. `cf` has no `keep_vars`: a deploy replaces the
   * Worker's variables with the ones declared. Secrets are the other way round
   * — never declared with a value, never removed by a deploy, and set per
   * environment: Production's from the command line, Previews Base's in the
   * dashboard.
   *
   * The production Worker is never changed from the dashboard — not a
   * variable, a secret, nor anything else. While its latest change came from
   * there, `cf deploy` compares the dashboard's configuration with this file's
   * in Wrangler's strict mode, which it always uses and has no flag to relax,
   * and in a build any difference that would remove something aborts the
   * upload ("Aborting the upload operation because of conflicts"; the
   * `--strict` it says to drop is not a flag `cf deploy` takes). There always
   * is one: the dashboard reports each custom domain's route with `zone_name`,
   * `enabled` and `previews_enabled`, which no local configuration produces,
   * so one dashboard change refuses every build after it however closely the
   * rest matches. docs/hosting.md says what ends it, and what does not.
   */

  return {
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
       * `src/log.ts` at the call and filtered in the query builder.
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
       *
       * Production's alone. A preview has its own `workers.dev` address, and
       * `cf previews deploy` refuses a config that names domains at all
       * ("Preview uploads from Build Output don't support the `domains`
       * field").
       */
      ...(isPreview
        ? {}
        : { domains: ['inertialref.app', 'inertialref.jonjaques.com'] }),

      env: {
        /*
         * The two switches, on everywhere. Turning either off is a change to
         * this file, reviewed like any other — a dashboard edit is no way
         * round that, and stops the next deploy from running at all (above).
         *
         *   TOUR_GUIDE_ENABLED  the Planetarium guide (`src/tour/routes.ts`).
         *   CLERK_ENABLED       accounts on the Worker (`src/account.ts`); off, it
         *                       answers every account question with "not
         *                       configured" and the guide admits nobody.
         *
         * On is not the same as answering everywhere. Which hosts offer
         * accounts is decided per request (`offersAccounts` in
         * `src/origins.ts`): in production only `inertialref.app`, the one
         * domain Clerk's production instance serves, while the second host
         * answers as a deployment without accounts and so without the guide.
         * Each still needs its secrets: without `CLERK_SECRET_KEY` accounts
         * are not configured, and without `OPENAI_API_KEY` the guide is
         * unavailable.
         */
        TOUR_GUIDE_ENABLED: bindings.text('true'),
        CLERK_ENABLED: bindings.text('true'),
        OPENAI_API_KEY: bindings.secret(),

        /*
         * Accounts (`src/account.ts`): how the Worker checks the session token
         * the browser presents, and — the secret key being also what reads a
         * user's private metadata — where the guide's grant comes from
         * (`src/tour/access.ts`). One name, two values: production holds the
         * production Clerk instance's key, Previews Base the development
         * instance's, and `pnpm dev` reads the development one from the root
         * `.env.local`.
         *
         * Required, like every declared secret: an environment without it fails
         * its upload, which makes a missing key a build failure instead of a
         * guide that silently admits nobody. That is also why there is no JWT
         * key here — it is optional, and a declared one would have to hold
         * something.
         *
         * The publishable key is not here. It is the browser's: a build variable
         * of the production build settings and of Previews Base
         * (`apps/game/.env.example`).
         */
        CLERK_SECRET_KEY: bindings.secret(),

        /*
         * Allowances (`src/limits.ts`). Counted per location and settled
         * eventually, so each is a bound on a script, not a meter on a person.
         * A namespace is any integer unique within the account.
         *
         *   ACCOUNT_LIMIT        per address, across `/api/account` and
         *                        `/api/tour/*`: every one asks who is calling,
         *                        and Clerk's API rate-limits the instance as a
         *                        whole.
         *   GUIDE_SESSION_LIMIT  per account, on creating a guide session:
         *                        each is minutes of the OpenAI project's
         *                        budget, and a granted token is the one caller
         *                        every other check admits.
         */
        ACCOUNT_LIMIT: bindings.rateLimit({
          namespace: '1002',
          simple: { limit: 120, period: 60 },
        }),
        GUIDE_SESSION_LIMIT: bindings.rateLimit({
          namespace: '1003',
          simple: { limit: 6, period: 60 },
        }),

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

        ASSETS: bindings.assets(),
      },

      /*
       * No `exports` block, and that is load-bearing twice over. The Worker
       * implements no Durable Object class: the guide (docs/hosting.md) is one
       * stateless route — create a voice session from the browser's SDP offer,
       * for an account granted the guide — because the browser owns its session through its
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
  }
})
