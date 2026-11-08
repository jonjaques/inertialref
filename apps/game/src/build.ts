/*
 * Which build this is, and which checkout serves it.
 *
 * Substituted textually by Vite's `define` (see vite.config.ts) rather than
 * read from `import.meta.env`, so each is a plain constant with a real type
 * rather than an index into an `any`-shaped record.
 *
 * The id answers "am I running the code I think I am", in three places: the
 * service worker names its cache after it, the HUD prints it next to the
 * server's own revision, and `ir.build()` hands it to a driver. When the first
 * two disagree, the browser is holding an old bundle, which is otherwise a
 * genuinely hard thing to establish from the outside.
 *
 * The tree answers the question the id cannot: sibling worktrees cut from one
 * commit share an id, so a rig pointed at a port needs the served checkout's
 * root to know it is photographing the tree it means to. It is the dev
 * server's alone and null in a production build, because a shipped bundle
 * must not carry a filesystem path.
 */
declare const __BUILD_ID__: string
declare const __SERVED_TREE__: string | null

export const BUILD_ID: string = __BUILD_ID__

export const SERVED_TREE: string | null = __SERVED_TREE__
