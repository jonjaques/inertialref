/*
 * Where the IR menu sits: floating at the bottom center, or attached to the
 * top or bottom edge as a bar the full width of the display.
 *
 * Floating is the default and the design's own answer — the shortest travel
 * from anywhere in the frame, and the frame kept clear edge to edge. Attached
 * is for somebody who would rather the interface have a fixed place than a
 * floating one: the bar takes a band off the top or the bottom, and every
 * other piece of chrome is laid out in what is left (`index.css`, the
 * `data-dock-attached` rule), so nothing sits underneath it.
 *
 * One preference for every mode, unlike the panel layout. The layout is about
 * a mode's panels; this is about the person, who does not want the bar to
 * jump edges between the planetarium and flight.
 */

export const DOCK_PLACEMENTS = ['floating', 'top', 'bottom'] as const
export type DockPlacement = (typeof DOCK_PLACEMENTS)[number]

export const PLACEMENT_LABEL: Readonly<Record<DockPlacement, string>> = {
  floating: 'Floating',
  top: 'Attached to the top',
  bottom: 'Attached to the bottom',
}
