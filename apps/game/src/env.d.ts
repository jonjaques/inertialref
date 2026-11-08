/// <reference types="vite/client" />

/*
 * The build-time public variables.
 *
 * `vite/client` types `import.meta.env` with an `any` index signature, so a
 * typo in a variable name is a silent `undefined` at runtime rather than an
 * error at the typecheck — which is the whole failure mode this file exists to
 * close. Declared `readonly` and optional because a fork builds without them.
 *
 * Values live in `apps/game/.env.production`. Nothing secret may go in one:
 * anything Vite substitutes is in the bundle and is readable by anyone.
 */
interface ImportMetaEnv {
  /** Clerk's publishable key, `pk_…`. See `src/account/accounts.ts`. */
  readonly PUBLIC_CLERK_PUBLISHABLE_KEY?: string
  /** PostHog's public project token, `phc_…`. See `src/telemetry/consent.ts`. */
  readonly PUBLIC_POSTHOG_PROJECT_TOKEN?: string
  /** PostHog's ingest host, `https://us.i.posthog.com`. See `src/telemetry/client.ts`. */
  readonly PUBLIC_POSTHOG_HOST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
