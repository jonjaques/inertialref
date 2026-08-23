# Architectural decision records

Twelve decisions that are expensive to reverse. Each records the **context**, the
**decision**, the **alternatives that were rejected**, and the **consequences**
— including the ones that turned out to be costs.

> These were written after the implementations, from the measurements those
> implementations produced. That makes them less a plan and more a record of
> what each decision actually cost, which is the more useful artifact.

| #                                           | Decision                    | Status       | One-line summary                                                                                                                                           |
| ------------------------------------------- | --------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-universe-coordinates.md)        | Universe coordinates        | accepted     | Int32 sector index + float64 offset in a 2^40 m sector. Sub-millimeter anywhere in 249,000 ly.                                                             |
| [0002](0002-reference-frames.md)            | Reference frames            | accepted     | Frames carry the semantics of motion, not precision — the coordinates already handle that.                                                                 |
| [0003](0003-render-coordinates.md)          | Render coordinates          | accepted     | Floating origin on a power-of-two grid, plus logarithmic depth compression that preserves angular size.                                                    |
| [0004](0004-entity-addressing.md)           | Entity addressing           | accepted     | Identity is a path through containment, and that path is also the seed path.                                                                               |
| [0005](0005-procedural-seeds.md)            | Procedural seeds            | accepted     | Hierarchical derivation, never a shared stream. xoshiro128** over exact integer ops.                                                                       |
| [0006](0006-simulation-clock.md)            | Simulation clock            | accepted     | 64 Hz fixed timestep, because 1/64 is exact in binary. Wall clock decides only how many.                                                                   |
| [0007](0007-persistence.md)                 | Persistence                 | accepted     | A save is the seed, the tick, and what could not be regenerated — under 700 bytes.                                                                         |
| [0008](0008-multiplayer-partitions.md)      | Multiplayer partitions      | **proposed** | Authority partitions by star system. Design only; multiplayer is a later phase, though the partition key is already a live debug field.                    |
| [0009](0009-issue-ordinal-addressing.md)    | Issue-ordinal addressing    | accepted     | A body index is the ordinal it was issued at, not its orbital position — so real astronomy can add a planet without renaming every world outward of it.    |
| [0010](0010-cinematic-director.md)          | Cinematic director          | accepted     | Scripted scenes are presentation borrowed from a running world and returned intact — the camera overridden, nothing canonical written, time from the tick. |
| [0011](0011-application-shell-and-modes.md) | Application shell and modes | accepted     | The canvas lives outside every route; the mode is a pure function of the path; the camera has one precedence order — cutscene, observatory, ship.          |
| [0012](0012-dockable-panels.md)             | Dockable panels             | accepted     | Panels move between four zones. The layout is a value and the moves are property-tested arithmetic; the drag library is only an input device.              |

---

## How they connect

```mermaid
flowchart TB
    A1["<b>0001</b><br/>universe coordinates"]
    A2["<b>0002</b><br/>reference frames"]
    A3["<b>0003</b><br/>render coordinates"]
    A4["<b>0004</b><br/>entity addressing"]
    A5["<b>0005</b><br/>procedural seeds"]
    A6["<b>0006</b><br/>simulation clock"]
    A7["<b>0007</b><br/>persistence"]
    A8["<b>0008</b><br/>multiplayer partitions"]
    A9["<b>0009</b><br/>issue-ordinal addressing"]
    A10["<b>0010</b><br/>cinematic director"]
    A11["<b>0011</b><br/>application shell"]
    A12["<b>0012</b><br/>dockable panels"]

    A1 -->|"precision already solved,<br/>so frames are free to be<br/>about motion"| A2
    A1 -->|"canonical → GPU"| A3
    A2 -->|"anchor frames"| A3
    A4 -->|"the address<br/>is the seed path"| A5
    A5 -->|"content is derivable,<br/>so it is not stored"| A7
    A4 -->|"a save stores<br/>references"| A7
    A6 -->|"state is a function<br/>of tick count"| A7
    A2 -->|"gravitational coupling<br/>bounds authority"| A8
    A7 -->|"replicate what a client<br/>cannot derive"| A8
    A4 -->|"amended: orbital order<br/>is not identity"| A9
    A5 -->|"the catalog version<br/>joins the manifest"| A9
    A3 -->|"the scene is built<br/>around one eye"| A10
    A6 -->|"scene time derives<br/>from the tick"| A10
    A10 -->|"a second producer<br/>of the same eye"| A11
    A4 -->|"the address is<br/>what a URL carries"| A11
    A11 -->|"a mode made<br/>of panels"| A12

    style A1 fill:#0369a1,stroke:#0c4a6e,color:#fff
    style A8 fill:#334155,stroke:#1e293b,color:#94a3b8,stroke-dasharray: 5 5
    style A9 fill:#0e7490,stroke:#155e75,color:#fff
    style A11 fill:#0e7490,stroke:#155e75,color:#fff
```

Two dependencies are worth noticing because they are not obvious:

- **0001 → 0002.** Because coordinates are precise everywhere, frames did _not_
  have to be a precision mechanism, which is the opposite of how most engines at
  this scale are built. That freed frames to be about the semantics of motion.
- **0005 + 0004 → 0007.** Determinism plus stable identity is what makes a save
  a few hundred bytes instead of gigabytes. Persistence did not need a clever format; it
  needed the other two decisions to have been made correctly.
- **0004 → 0009.** ADR-0004's own consequences section admitted that bodies are
  addressed by orbital index and that changing the layout renames them. That was
  acceptable while the only thing changing the layout was us. It stops being
  acceptable when real astronomy is a generation input, which is what 0009
  corrects — and it is free to correct only while there is no save corpus.
- **0010 → 0011.** The cinematic director needed one thing from the renderer: an
  eye that is not the ship's. Having built that seam, the planetarium was a
  _second producer of the same shape_ rather than a new mechanism — which is why
  a whole mode cost a nullable field and six lines of precedence.

---

## Writing a new one

Add an ADR when a decision would be expensive for a future engineer to reverse,
or when they would otherwise have to reverse-engineer _why_ from the code.

Keep the four headings: **Context**, **Decision**, **Alternatives considered**,
**Consequences**. The alternatives section is the one that ages best — it is the
difference between a record and a rationalisation.

Prefer real numbers over adjectives. "0.24 mm anywhere in 249,000 ly" is a
decision record; "very precise" is a mood.

---

## Related

- [Concepts](../README.md#concepts) — how these decisions work in practice
- [Architecture](../architecture.md) — where they meet
- [Roadmap](../roadmap.md) — what they are load-bearing for next
