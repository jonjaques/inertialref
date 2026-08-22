/*
 * The routed pages, as data.
 *
 * Its own module for the same reason `hud/tabs.ts` is: three files need these
 * strings for different reasons — the route table declares them, the links
 * point at them, and the page shell returns to `HOME` — and a `routes.tsx` that
 * exported both a constant and a component is a file Fast Refresh gives up on.
 */

/** Flying. No page open; the overlay routes render nothing. */
export const HOME = '/'

/** Render and camera settings, over a running simulation. */
export const SETTINGS = '/settings'
