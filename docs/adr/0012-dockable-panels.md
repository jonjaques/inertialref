# ADR-0012: Dockable panels, with the layout as arithmetic

Status: accepted · 2026-08-22

## Context

The [planetarium](../design/planetarium.md) is a tool rather than a screen: a
catalog, an inspector, view switches, presets and a clock, all of which a
person wants in different places depending on whether they are hunting for a
system, composing a shot, or watching a moon transit. The dev dock's answer —
one fixed panel of tabs, top right — is right for a debug overlay and wrong for
a workspace, because it can show exactly one thing at a time.

The same interface has to work on a phone, where "left" and "right" mean
nothing, and it has to survive the thing every persisted layout eventually meets:
a build that renamed a panel.

## Decision

**Panels move between zones by dragging. The layout is a value, the moves are
pure functions over it, and the drag library is only an input device.**

- **Four zones**: `left`, `right`, `bottom`, `hidden`. `hidden` is a _zone_
  rather than an absence, which is what makes the invariant expressible at all —
  closing a panel and reopening it is a move, not a deletion followed by an
  invention.
- **One invariant, and everything preserves it**: _every known panel appears in
  exactly one zone, exactly once._ A panel in two zones renders twice and its
  state diverges; a panel in none is unreachable and there is no UI for opening
  it. Both were real in the first version, which spliced arrays at call sites.
- **`apps/game/src/dock/layout.ts` is pure and tested in Node.** `movePanel`,
  `hidePanel`, `showPanel`, `togglePanel`, `normalizeLayout`, `insertionIndex`.
  The invariant is asserted with property tests over random sequences of moves,
  because the ways to break it are _combinations_ — move a panel to the zone it
  is already in, at an index past the end, twice — which is exactly what a hand
  produces during a real drag and what a test author does not think to write.
- **React DnD supplies the gesture and nothing else.** The backend is chosen
  once at mount from `(pointer: coarse)`: `HTML5Backend` where the pointer is
  fine, `TouchBackend` where it is not. Once, because `DndProvider` builds its
  manager from the backend and cannot be handed another — swapping it is a
  remount of every panel.
- **`normalizeLayout` reconciles a stored layout with the panels this build
  has.** Unknown ids are dropped, unseen ones are placed at their own declared
  zone, duplicates collapse. It is a fixpoint, which is what makes it safe to run
  on every render.
- **Updates are functional.** `usePersistentState`'s setter takes a value _or_
  an updater, and the dock always uses the updater. One pointer gesture can
  deliver more than one drop, and two `movePanel` calls composed against the same
  captured snapshot silently discard the first — a failure that is invisible in
  review and presents as a panel snapping back.
- **On a compact viewport the zones stop being read**, and the same panel _set_
  becomes a bottom sheet with a tab strip. Docking is not offered: a drag whose
  effect is invisible is worse than no drag. Nothing is discarded, so rotating a
  tablet back restores the columns exactly.

## Alternatives considered

**`@dnd-kit`.** Newer, better documented, and more capable — sortable presets,
built-in keyboard support, no HTML5 drag-image quirks. The directive named React
DnD, and the decision costs little either way _because of the shape above_: the
layout algebra has no dependency on the drag library, so replacing it is
replacing two hooks in one file. That property is the point of the split, and it
is worth more than the choice of library.

**A floating window manager** (draggable, resizable, z-ordered panels). More
powerful and much worse here: floating windows cover the thing being looked at,
which in a planetarium is the entire content. Zones keep the middle of the frame
clear by construction.

**A fixed layout with no docking at all.** Cheapest, and it fails the actual
use: a catalog wants a tall column, a transport wants a wide bar, and which of
those is on screen depends on what you are doing.

**Layout in a store rather than a value plus a pure reducer.** A store would
have been fewer lines and would have put the ordering rules inside React, where
the only way to test them is to render something. The bugs here are all in the
_ordering_ — the pure form is the one that can be property-tested.

**Persisting the zone a panel was closed from, so reopening restores it.**
Considered and rejected: the slot it left is very likely occupied, and a panel
reappearing in the middle of an arrangement the user made is more surprising
than one appearing at the end.

## Consequences

**Good.**

- The part with the bugs in it is 150 lines of arithmetic with property tests,
  and none of it needs a DOM.
- The drag library is swappable in one file.
- A layout written by an older build is repaired rather than discarded, so a
  workspace survives a rename.
- The phone gets the same panels rather than a cut-down set, and the desktop
  arrangement survives the round trip.

**Costs, honestly.**

- Two React DnD backends means two behaviors to keep in mind: `HTML5Backend`
  gives a native drag image and `TouchBackend` does not, and the touch path needs
  a `delayTouchStart` so a scroll inside a panel is not claimed as a drag.
- Choosing the backend once means a device whose primary pointer changes
  mid-session (a tablet with a keyboard attached) keeps the one it started with
  until a reload. That is the better failure: the alternative resets every panel
  when someone brushes a trackpad.
- Drop-index measurement reads the DOM on each hover. It is bounded by the
  panels in one zone — three or four — and the alternative is a cache that goes
  stale the instant the drag reflows the stack it is measuring.

## Related

- [ADR-0011](0011-application-shell-and-modes.md) — the shell these live in
- [`docs/design/ux.md`](../design/ux.md#dockable-panels) — the design-facing view
- [`docs/design/planetarium.md`](../design/planetarium.md) — the mode made of them
