---
paths:
  - 'apps/game/src/dock/**'
---

# The workspace — panes, panels and the menu

Reasoning: ADR-0012, `AGENTS.md` § "The rules that actually matter", DESIGN.md § Layout.

- **Never move a panel by splicing an array at a call site.** `dock/layout.ts` owns every
  move and preserves one invariant: _every known panel is in exactly one zone, exactly
  once._ The zones are `left`, `right`, `float`, `hidden` — the last two are places a
  panel _is_, not absences. It is property-tested; keep it that way.
- **A float position is a decoration, never part of the census.** `dock/floating.ts` owns
  coordinates, and a panel in `float` with no entry there is not broken — `cascade`
  answers for it. Every position is clamped inside the viewport and re-clamped on resize:
  a panel that is open, listed as open, and off-screen has no gesture that reaches it.
- **Use the updater form of the setter.** One gesture can deliver two drops, and two moves
  composed against the same captured snapshot discard the first.
- **A drop index is measured against the panels on screen, which still include the dragged
  one.** `dropIndex` translates it into the index `movePanel` reads. Skip it and a
  downward drag inside one pane lands a slot past the line the indicator drew.
- **The float field renders _before_ the panes, and a floating panel carries `z-10`.** DOM
  order is hit-testing order, which is the whole arbitration between "dock it" and "float
  it"; the z-index is what stops a floated panel being painted behind the pane it just
  left.
- **React DnD drives the gesture and nothing else.** What a drop _means_ is arithmetic.
  The backend is chosen once at mount from `(pointer: coarse)` because `DndProvider`
  cannot be handed a different one afterwards.
- **`defaultOpen: false` is not `zone: 'hidden'`.** The first says where a panel starts;
  the second would also say where reopening puts it, making the menu toggle a no-op.
- **The compact arrangement carries the way out of the mode.** Below 900px `Workspace`
  renders `CompactDock` _instead of_ the IR menu, so the mark, the place and the settings
  have to be on that bar — they were not, and a phone in the planetarium had no route home
  and no settings at all. Panels live in the sheet, where they wrap; a row that scrolls
  horizontally hides its own contents.
- **Type comes from a named step**, never a size plus a weight plus a tracking at the call
  site: `type-heading` for a panel title, `type-label` for a section, `type-readout` for a
  value, `type-ui` for a control. DESIGN.md § Typography has all nine.
