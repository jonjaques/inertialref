# ADR-0009: Body indices are issue ordinals, not orbital ordinals

Status: accepted · 2026-08-19

## Context

[ADR-0004](0004-entity-addressing.md) makes identity a path through containment,
and body segments are written `b:2` for the third planet. Today that index _is_
the orbital index: bodies are generated in order of semi-major axis and numbered
as they come out.

That works for a universe generated from a seed alone. It does not survive the
[catalog](../design/galaxy.md) becoming a second generation input.

Real astronomy changes. A star with no known planets today may have three
confirmed next year; an orbit gets refined; a candidate is retracted. When a
newly confirmed planet lands interior to everything else in a system, an orbital
index renumbers **every body outward of it**. `b:2` was the third planet and is
now the fourth. Every save that referenced it, every Almanac entry that described
it, and every discovery record attributing it to a player now points at a
different world, silently and with no error anywhere.

ADR-0004 already names the failure mode it was avoiding — identity must not
derive from array ordering — and then, in its own consequences section, admits
the one place it does:

> Bodies are addressed by _orbital index_, so changing how a system lays out its
> orbits renames its planets.

It treated that as acceptable because a rename would be deliberate and detectable
through algorithm versioning. That reasoning holds for _our_ changes to the
generator. It does not hold for the catalog, because the catalog changes on
someone else's schedule, continuously, forever, and a version bump that renames
half the galaxy every few weeks is not a version bump anybody can act on.

**The window to fix this is now.** There is no deployed save corpus, no player
data, no discovery records, and no published build — so the change costs a
generator edit and a test. Once any of those exist it costs a migration that has
to rewrite references it cannot validate, because the thing that would tell you
whether `b:2` meant the old body or the new one is exactly the information the
old encoding threw away.

## Decision

**A body's index is the ordinal at which it was issued into the system's
manifest, not its position in the orbital sequence.** Orbital order is computed
for display and is never an identity.

A system therefore carries an ordered, **append-only** body manifest:

```
{ index: 0, provenance: 'observed',  status: 'active'  }
{ index: 1, provenance: 'projected', status: 'active'  }
{ index: 2, provenance: 'projected', status: 'retired',
  retiredIn: 'hyg-4.2', supersededBy: 4 }
{ index: 3, provenance: 'projected', status: 'active'  }
{ index: 4, provenance: 'observed',  status: 'active', semiMajorAxis: 0.04 }
```

Four rules govern it:

1. **The catalog version is an explicit generation input.** `bodies(system,
seed, catalogueVersion)` — same three inputs, same universe, forever, on any
   machine, offline. Determinism is unchanged; it now has three inputs instead of
   two, and the catalog version joins `algorithm()` in the generation manifest
   ([ADR-0005](0005-procedural-seeds.md)).
2. **Indices are never reused and never reordered.** A new body takes the next
   free index, wherever it sits in the orbital sequence.
3. **Retirement is a tombstone, not a deletion.** A retired body stops being
   generated and stops being rendered. Its address stays valid, resolvable and
   meaningful forever, so a save that references it loads and an Almanac entry
   that describes it still describes something.
4. **Projections yield to observations, never the reverse.** When a revision
   confirms a real body whose orbit overlaps a generated one — within a factor of
   1.5 in semi-major axis — the projection is retired and the observation is
   issued at a new index.

`b:2.0` for a moon follows the same rule within its parent's own manifest.

## Alternatives considered

- **Keep orbital indices, and version the whole catalog as an algorithm bump.**
  Honest and already implemented. But it renames bodies on a schedule set by the
  astronomical community rather than by us, and a save-breaking bump every few
  weeks is indistinguishable from having no stable identity at all.
- **Address bodies by their catalog designation instead** (`b:Proxima-b`).
  Works beautifully for the ~6,000 confirmed exoplanets and not at all for the
  millions of generated ones, which have no designation to use. It also makes
  identity depend on a name that gets revised.
- **Address by orbital elements** — semi-major axis to some precision. Refining
  an orbit, which is the single most common kind of revision, changes the
  identity of the thing whose orbit was refined.
- **A translation table from old index to new, per revision.** Preserves the
  pretty encoding and moves the problem into a growing side table that has to be
  persisted, versioned, replicated to clients, and consulted on every address
  resolution — including inside the generator, which must stay a pure function.
- **Sort the manifest by orbit and accept renumbering, but emit a rename map.**
  A rename map is only actionable if something can apply it to data it does not
  own. Discovery records in a shared universe are exactly that data.

## Consequences

- **`b:2` no longer means "the third planet".** It means "the third body this
  system ever issued", and nothing in the UI should present it as an ordinal.
  Display uses computed orbital position; the address is for machines, saves,
  logs and the harness.
- **Generation must consult the manifest before assigning slots**, which is the
  first time generation depends on anything but seed and address. It stays a pure
  function — the manifest is derived from `(seed, catalogueVersion)` and is not
  mutable state — but the dependency is real and `universe` grows a concept it
  did not have.
- **Systems accumulate tombstones.** A well-studied system revised many times
  carries dead indices forever. They cost a few bytes each and they are the price
  of never lying about what an address meant.
- **Sparse indices are visible.** A system may have active bodies `0, 1, 3, 4`
  and a gap at `2`. That looks like a bug and is not; it wants a comment in the
  generator and a note in the debug overlay.
- **Golden vectors must cover it.** The manifest for a given
  `(seed, catalogueVersion)` needs locking the same way PRNG output is locked, or
  the property this ADR exists to guarantee is guaranteed by intent rather than
  by a test.
- **This is free today and expensive tomorrow.** Adopted in pre-alpha with no
  save corpus, no player data and no published build, it is a generator change and
  a test. The cost curve is the whole argument for doing it now.

## Related

- [ADR-0004](0004-entity-addressing.md) — the addressing model this amends
- [ADR-0005](0005-procedural-seeds.md) — the versioning machinery the catalog version rides on
- [ADR-0007](0007-persistence.md) — why a save is a reference, and what a tombstone protects
- [Design: galaxy](../design/galaxy.md#catalog-revisions) — the mechanic this enables
