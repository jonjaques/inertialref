# Invariant map

The rules themselves live in [`AGENTS.md`](../../AGENTS.md). This page maps
each one to the technical document that explains it, so you can read the _why_
without reconstructing it from a one-liner.

Path-scoped copies in [`.claude/rules/`](../../.claude/rules/README.md) carry
only the imperative. If a copy disagrees, `AGENTS.md` wins.

`branching.md`, `writing.md` and `browser.md` are the three exceptions and have
no row here. They are unscoped process rules, not invariants about the code, and
they mirror [`working.md`](working.md) § "Starting work",
[`STYLE.md`](../../STYLE.md) and the
[`drive` skill](../../.claude/skills/drive/SKILL.md). A rule missing from this
table is one of those three, not drift.

| Invariant                                                                                     | Technical home                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| No absolute position in a `Vec3`                                                              | [Coordinates](../concepts/coordinates.md) · [ADR-0001](../adr/0001-universe-coordinates.md)                            |
| No wall-clock or `Math.random` in canonical code                                              | [Determinism](../concepts/determinism.md) · [ADR-0005](../adr/0005-procedural-seeds.md)                                |
| Never hold an algorithm version because the draw order is intact                              | [Determinism](../concepts/determinism.md) · [ADR-0027](../adr/0027-the-rings.md)                                       |
| Generation does not depend on order                                                           | [Determinism](../concepts/determinism.md) · [Identity](../concepts/identity.md)                                        |
| The three emit APIs live only in the sink                                                     | [ADR-0022](../adr/0022-the-timeline.md) · [Observability](../concepts/observability.md)                                |
| Canonical state is not in React                                                               | [Architecture](../architecture.md) · [ADR-0011](../adr/0011-application-shell-and-modes.md)                            |
| Presentation switches go through the stance stack                                             | [Client](../guides/client.md)                                                                                          |
| One `Worker` constructor                                                                      | [Workers](../concepts/workers.md) · [Development](../guides/development.md)                                            |
| One session constructor                                                                       | [Client](../guides/client.md)                                                                                          |
| Terrain is sampled in body-fixed axes                                                         | [Frames](../concepts/frames.md)                                                                                        |
| No field value read off a rank                                                                | [ADR-0019](../adr/0019-the-geology.md) · [Determinism](../concepts/determinism.md)                                     |
| No planetary radius subtracted in a shader                                                    | [ADR-0020](../adr/0020-the-face.md) · [Rendering](../concepts/rendering.md)                                            |
| The ground and the sphere behind it shade alike                                               | [ADR-0020](../adr/0020-the-face.md) · [Rendering](../concepts/rendering.md)                                            |
| No `dispose()` on a mesh holding the shared index                                             | [ADR-0021](../adr/0021-the-ground.md) · [Rendering](../concepts/rendering.md)                                          |
| No stored value derived from a captured snapshot                                              | [ADR-0012](../adr/0012-dockable-panels.md) · [Client](../guides/client.md)                                             |
| No varying named after an attribute                                                           | [ADR-0020](../adr/0020-the-face.md) · [Rendering](../concepts/rendering.md)                                            |
| No attribute object under two names                                                           | [ADR-0021](../adr/0021-the-ground.md) · [Rendering](../concepts/rendering.md)                                          |
| A stand-in `DataTexture` is filtered like its map                                             | [Testing](../guides/testing.md#shader-behavior-runs-on-the-real-gpu-from-node)                                         |
| Never build two texture nodes over one stand-in object                                        | [ADR-0021](../adr/0021-the-ground.md) · [Testing](../guides/testing.md#shader-behavior-runs-on-the-real-gpu-from-node) |
| No canonical reader of the drawn ground, or the reverse                                       | [ADR-0021](../adr/0021-the-ground.md) · [Terrain](../concepts/streaming.md)                                            |
| No fine lattice coordinate from an absolute float32 direction, no lattice decision in a float | [ADR-0023](../adr/0023-the-gpu-producer.md) · [Rendering](../concepts/rendering.md#terrain-meshing)                    |
| Entity writes go through `World`'s verbs; `world.entities` is the read half                   | [Architecture](../architecture.md#invariants) · [ADR-0025](../adr/0025-the-rails.md)                                   |
| Landedness is a consequence, never asserted                                                   | [Architecture](../architecture.md#invariants)                                                                          |
| A coasting entity's epoch does not survive a move it did not make                             | [Time](../concepts/time.md) · [ADR-0025](../adr/0025-the-rails.md)                                                     |
| Saves store references, not regenerable content                                               | [Persistence](../concepts/persistence.md) · [ADR-0007](../adr/0007-persistence.md)                                     |
| The star catalog is an argument, not a singleton                                              | [Galaxy](../design/galaxy.md) · [Catalog](../guides/catalogue.md)                                                      |
| Do not store what the catalog can derive                                                      | [Catalog](../guides/catalogue.md)                                                                                      |
| A survey is not a search box                                                                  | [Catalog](../guides/catalogue.md)                                                                                      |
| Issue order is not orbital order                                                              | [Identity](../concepts/identity.md) · [ADR-0009](../adr/0009-issue-ordinal-addressing.md)                              |
| No hosting SDK below the adapter                                                              | [Architecture](../architecture.md) · [Hosting](../hosting.md)                                                          |
| Do not let the compiler memoize a mutable read                                                | [Client](../guides/client.md)                                                                                          |
| The canvas is not inside a route                                                              | [Client](../guides/client.md) · [ADR-0011](../adr/0011-application-shell-and-modes.md)                                 |
| Mode is a function of the path                                                                | [Client](../guides/client.md)                                                                                          |
| Overlays resolve location through one helper                                                  | [Client](../guides/client.md)                                                                                          |
| Render compression is radial about the eye                                                    | [Rendering](../concepts/rendering.md) · [ADR-0003](../adr/0003-render-coordinates.md)                                  |
| `placement.scale` is a radius, `compression` is the ratio                                     | [Rendering](../concepts/rendering.md#terrain-meshing) · [ADR-0015](../adr/0015-terrain-level-of-detail.md)             |
| A body with a `figure` is not also flattened                                                  | [ADR-0013](../adr/0013-measured-figures.md)                                                                            |
| `figure: null` means round, not unknown                                                       | [ADR-0013](../adr/0013-measured-figures.md)                                                                            |
| An unmeasured field is a row, in the universe's voice                                         | [ADR-0014](../adr/0014-the-record-with-holes-in-it.md) · [Planetarium](../design/planetarium.md)                       |
| Chrome is not sized or positioned against the viewport                                        | [Client](../guides/client.md) · [`DESIGN.md`](../../DESIGN.md)                                                         |
| One producer of the camera                                                                    | [Client](../guides/client.md) · [ADR-0011](../adr/0011-application-shell-and-modes.md)                                 |
| One producer of the lens; the field of view is derived                                        | [ADR-0017](../adr/0017-the-lens.md) · [Art](../design/art.md#photo-mode)                                               |
| One window-level key listener; actions by id                                                  | [ADR-0018](../adr/0018-the-instrument.md) · [UX § controls](../design/ux.md#controls)                                  |
| No `localStorage` outside `state/preferences.ts`                                              | [ADR-0018](../adr/0018-the-instrument.md) · [Persistence](../concepts/persistence.md)                                  |
| No key name written into a label                                                              | [ADR-0018](../adr/0018-the-instrument.md) · [UX § controls](../design/ux.md#controls)                                  |
| The aim is an offset on the pose; drag by the pixel angle                                     | [ADR-0018](../adr/0018-the-instrument.md) · [Planetarium](../design/planetarium.md)                                    |
| The planetarium does not write canonical state                                                | [Planetarium](../design/planetarium.md)                                                                                |
| Presentation asks at `renderTime`, not `clock.time`                                           | [ADR-0006](../adr/0006-simulation-clock.md) · [Planetarium](../design/planetarium.md)                                  |
| Mode chrome needs `pointer-events-auto`                                                       | [Client](../guides/client.md)                                                                                          |
| Overlay presence is not `mode="wait"`                                                         | [Client](../guides/client.md)                                                                                          |
| Do not latch a "run once" effect with a ref                                                   | [Client](../guides/client.md)                                                                                          |
| Dock moves go through `layout.ts`                                                             | [Client](../guides/client.md) · [ADR-0012](../adr/0012-dockable-panels.md)                                             |
| A new document under `docs/` goes in a wing                                                   | [Development](../guides/development.md) · [ADR-0016](../adr/0016-documentation-as-a-mode.md)                           |
| A plan goes in `design/`, never under `docs/`                                                 | [Development](../guides/development.md) · [ADR-0016](../adr/0016-documentation-as-a-mode.md)                           |
| One component per file                                                                        | [Development](../guides/development.md)                                                                                |
| Do not hand-roll a registry control                                                           | [Development](../guides/development.md) · [`DESIGN.md`](../../DESIGN.md)                                               |
| Cinematic effects are staging, not scripts                                                    | [Cinematics](../guides/cinematics.md)                                                                                  |
| A scripted camera clears the prop it stages                                                   | [Cinematics](../guides/cinematics.md)                                                                                  |
| Shots hand a prop over on a shared knot                                                       | [Cinematics](../guides/cinematics.md)                                                                                  |
| Labels are sentence case in source                                                            | [`DESIGN.md`](../../DESIGN.md) · [UX](../design/ux.md)                                                                 |
| Import `three/webgpu`, not `three`                                                            | [Rendering](../concepts/rendering.md) · [Development](../guides/development.md)                                        |
| Compile-ahead goes through one recipe                                                         | [Rendering](../concepts/rendering.md)                                                                                  |
| Do not edit files `pnpm brand` writes                                                         | [Development](../guides/development.md)                                                                                |
| Site metadata is duplicated on purpose                                                        | [Hosting](../hosting.md) · [Development](../guides/development.md)                                                     |
| Third-party tags load from a module, not `index.html`                                         | [Hosting](../hosting.md)                                                                                               |

When a defect exposes a missing invariant, add the rule to `AGENTS.md`, a
one-liner under `.claude/rules/`, a row here, and a regression test that can
actually fail.
