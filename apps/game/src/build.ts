/*
 * Which build this is.
 *
 * Substituted textually by Vite's `define` (see vite.config.ts) rather than
 * read from `import.meta.env`, so it is a plain string constant with a real
 * type rather than an index into an `any`-shaped record.
 *
 * Two things use it, and they are the two halves of the same question — "am I
 * running the code I think I am": the service worker names its cache after it,
 * and the HUD prints it next to the server's own revision. When those two
 * disagree, the browser is holding an old bundle, which is otherwise a
 * genuinely hard thing to establish from the outside.
 */
declare const __BUILD_ID__: string

export const BUILD_ID: string = __BUILD_ID__
