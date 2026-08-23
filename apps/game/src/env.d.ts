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
  /** GA4 measurement id, `G-XXXXXXXXXX`. See `src/analytics.ts`. */
  readonly VITE_GA_MEASUREMENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
