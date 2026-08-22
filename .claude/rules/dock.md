---
paths:
  - 'apps/game/src/dock/**'
---

# The dockable panels

Reasoning: ADR-0012, and `AGENTS.md` § "The rules that actually matter".

- **Never move a panel by splicing an array at a call site.** `dock/layout.ts` owns every
  move and preserves one invariant: _every known panel is in exactly one zone, exactly
  once._ It is property-tested; keep it that way.
- **Use the updater form of the setter.** One gesture can deliver two drops, and two moves
  composed against the same captured snapshot discard the first.
- **A drop index is measured against the panels on screen, which still include the dragged
  one.** `dropIndex` translates it into the index `movePanel` reads. Skip it and a
  downward drag inside one zone lands a slot past the line the indicator drew.
- **React DnD drives the gesture and nothing else.** What a drop _means_ is pure
  arithmetic in `layout.ts`. The backend is chosen once at mount from `(pointer: coarse)`
  because `DndProvider` cannot be handed a different one afterwards.
