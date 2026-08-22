/*
 * The dock's five panels, as data.
 *
 * Its own module because two files need the list and they need it for different
 * reasons: `HudDock` draws the tablist from it, and `App` validates the
 * remembered `dock.tab` against it — a tab name that survived a rename is the
 * one stored value that renders an empty dock. Keeping it here rather than in
 * `HudDock.tsx` is also what stops that file exporting a constant alongside its
 * components, which is a file Fast Refresh gives up on.
 */

export const TABS = [
  'navigate',
  'graphics',
  'camera',
  'telemetry',
  'perf',
] as const

export type HudTab = (typeof TABS)[number]
