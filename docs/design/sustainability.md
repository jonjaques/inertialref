# Sustainability

Licensing, governance, contribution, and the one question that actually has a
cost attached: who pays for the persistent universe.

> This page replaces §13 Monetisation. There is none — see
> [charter](charter.md#business-posture). What replaces it is a set of decisions
> about how an open, non-commercial project stays alive.

---

## Licensing

**Settled: [Apache-2.0](../../LICENSE), written 2026-08-19.** Until that file
existed the repository was "all rights reserved" by default, which contradicted
the README's description of it as open source and made contribution legally
awkward for anyone who read carefully. That is now fixed.

### The decision

| What                               | License                 | Why                                                                                                                                                  |
| ---------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*` — the simulation core | **Apache-2.0**          | Permissive maximises adoption, and the engine identity is an asset for a project that wants contributors. The explicit patent grant is worth having. |
| `apps/*` — the game client         | **Apache-2.0**          | Same tree, same terms; splitting licenses within one repository creates confusion for no benefit here                                                |
| Ingested catalog data              | **Inherits its source** | Non-negotiable — see below                                                                                                                           |
| Authored art and audio             | **CC BY-SA 4.0**        | Standard for game assets; keeps derivative asset work open                                                                                           |

### The non-commercial trap, stated plainly

A license that forbids commercial use — CC BY-NC, or a custom "non-commercial"
clause — **is not an open source license** under the OSI definition, and it makes
the project ineligible for most package ecosystems, many contributor
expectations, and some distribution channels.

The right way to be a non-commercial project is to **use a genuine open license
and simply not commercialize it**. Copyleft (AGPL-3.0) is the stronger option if
the concern is somebody else running a paid hosted version; permissive
(Apache-2.0) is the better option if the concern is adoption. **Recommendation:
Apache-2.0** — the risk of someone monetising a browser space sim built on this
engine is small, and the value of being trivially adoptable is large.

**Resolved: Apache-2.0.** The risk copyleft would cover — somebody running a paid
hosted fork of a browser space sim — is small and speculative, and the value of
being trivially adoptable is large and immediate. People adopt engines, and the
engine identity is this project's most transferable asset. **Write the LICENSE
file first**; it is the cheapest and most overdue item in the entire bible.

### Data licensing is the constraint that bites

**Verified 2026-08-19 against the licensors' own pages, not from memory** —
[spike 4](../spikes.md#4--gaia-and-hyg-attribution-terms). One of the four rows
below was wrong, and it was the one that mattered.

| Source                     | Terms                           | Consequence                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HYG database** v4.x      | **CC BY-SA 4.0** (v3.x was 2.5) | **Share-alike reaches the packed binary.** § 4(b) makes a database containing a substantial portion of the contents _Adapted Material_ — but explicitly "**not its individual contents**", so the obligation attaches to the catalog and not to the code |
| **Gaia** (ESA)             | ⛔ **CC BY-NC 3.0 IGO**         | **Non-commercial.** Not "open with attribution", which is what this page previously said. Commercial use needs prior written authorization from `data.licenses@esa.int`                                                                                  |
| **NASA Exoplanet Archive** | **No license stated**           | Operated by Caltech under NASA contract; **not confirmed public domain**. The measurements are facts, the compilation may attract EU database right. Use the requested acknowledgment and stop calling it public domain                                  |
| **Open Exoplanet Catalog** | MIT                             | Unrestricted with notice                                                                                                                                                                                                                                 |

#### Gaia is the problem, and it is our own argument turned around

[The non-commercial trap](#the-non-commercial-trap-stated-plainly), above, is this
page's own reasoning for why the project refuses an NC clause. Bundling Gaia
attaches exactly that clause to the data the game cannot run without — the
Apache-2.0 code stays Apache-2.0, and the shipped artifact is no longer something
a downstream user may commercialize. **That is the outcome this section exists to
prevent**, arriving through the data rather than the code.

There is a conflicting statement in Gaia's DR3 documentation — _"The Gaia data are
open and free to use, provided credit is given to 'ESA/Gaia/DPAC'"_ — which reads
far more permissively than the license page. When a license page and a
documentation page disagree, **the stricter one governs until the licensor says
otherwise in writing.**

**Resolved: ship HYG + NASA. Gaia stays out of the bundle** until ESA answers a
request at `data.licenses@esa.int`. The ingest may consult Gaia for verification;
it does not redistribute it. Note that **AT-HYG inherits the problem** — it is
published as CC BY-SA 4.0 but built on Gaia DR3, so adopting it does not launder
anything.

#### The attribution strings, verbatim

| Source                 | What must appear                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gaia, credit line      | `Credit: ESA, Gaia DPAC`                                                                                                                                                                                                                                                                                                                                                                             |
| Gaia, acknowledgment   | _"This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement."_ |
| HYG                    | _The HYG Database_, astronexus, CC BY-SA 4.0 — with the license URI, the source URI, and a statement that it was modified                                                                                                                                                                                                                                                                            |
| NASA Exoplanet Archive | _"This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program."_ Cite Christiansen et al. (2025)                                                                                                                            |

CC BY-SA § 3(a)(1) sets the contents of the notice: creator identification, a
copyright notice, a notice referring to the license, a notice referring to the
warranty disclaimer, a URI to the source, and an indication that it was modified —
satisfiable "in any reasonable manner based on the medium".

#### The engineering consequence

**The packed catalog ships as its own asset with its own license notice beside
it — never inlined into the JS bundle.** A `.bin` fetched at runtime is an
aggregation of two separately licensed works. A base64 literal compiled into
`index.js` invites the argument that it is not, and blurs precisely the boundary
that lets Apache-2.0 code and CC BY-SA data coexist. This is a license requirement
expressed as a build constraint, and it should be enforced by the build rather
than remembered.

**Attribution must be in the game, not just the repository.** The catalog panel
that shows a star's data should show its source, which is both a license
requirement and — per [pillar 2](charter.md#pillar-2--the-sky-is-real) — exactly
what the design wants anyway. The obligation and the design agree.

---

## Governance

One maintainer, working with coding agents. That is the reality and the
governance model should say so rather than pretending at a committee.

|                                             |                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Decision authority**                      | Single maintainer                                                                                                                       |
| **What is written down**                    | [ADRs](../adr/) for anything expensive to reverse; [CONTEXT.md](../../CONTEXT.md) for facts learned the hard way; this bible for design |
| **What is enforced automatically**          | Layering (`pnpm graph`), lint, types, tests, build — all via `pnpm check`                                                               |
| **What a contributor must not have to ask** | Anything. [vision.md](../vision.md#assume-it-will-be-built-by-agents) makes "no tribal knowledge" a charter principle.                  |

The repository is already optimized for this: deterministic non-interactive
commands with useful exit codes, documentation that explains _why_, decision
records, and a build log. That is unusually good ground for contribution and it
should be protected.

**Still missing:** a `CONTRIBUTING.md`, a `CODE_OF_CONDUCT.md`, a CI
configuration, and a git remote. `LICENSE` ✅ landed 2026-08-19. The remaining
four are prerequisites for the project being open in practice rather than in
description.

✅ **`NOTICE` landed with the ingest**, in the same change that first read a
dataset — which is the only time it can land without shipping a release that was
out of compliance. It carries the CC BY-SA 4.0 reference and every attribution
string in the table above, and it states where the share-alike boundary falls:
on `data/catalog/`, not on the Apache-2.0 code that reads it.

The attribution also travels _inside_ the packed file, so a copy of the asset
alone still states its terms — `data/catalog/LICENSE.md` is the notice beside it
and `CatalogMetadata.attribution` is the same text within it.

---

## Contribution

The design's shape makes some contributions much easier than others, and saying
so up front is worth more than a generic invitation.

| Easy to contribute              | Why                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Catalog ingest and data quality | Self-contained, testable, and the identity-resolution work is genuinely hard and genuinely valuable |
| Biome material sets             | One authored artifact, a clear interface                                                            |
| Ship and interior parts         | Same                                                                                                |
| Terrain and noise algorithms    | Pure functions with golden vectors                                                                  |
| Accessibility work              | Well-specified in [ux](ux.md#accessibility) and independently verifiable                            |
| Translations                    | Text is centralised and there is no voice acting                                                    |

| Hard to contribute                            | Why                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Anything touching precision or determinism    | [Five decisions are expensive to reverse](../../CONTEXT.md) and a well-meaning `Vector3` breaks the whole premise |
| Renderer architecture                         | One coherent doctrine ([art](art.md)) that is easy to erode incrementally                                         |
| Anything that adds a dependency below `apps/` | Enforced against, deliberately                                                                                    |

---

## The hosting question

The only thing in this project that costs money.

| Mode                    | What runs                                                          | Cost shape                                                    |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Solo offline**        | Nothing                                                            | **Zero, forever.** Static hosting only.                       |
| **Solo online**         | A database and an API — discovery records, catalog revisions, sync | Small and predictable; scales with players, not with activity |
| **Persistent universe** | A live authority per active star system                            | **Real, and it scales with concurrency**                      |

[ADR-0008](../adr/0008-multiplayer-partitions.md) names the likely direction:
Cloudflare Workers plus Durable Objects, with a Durable Object per active
partition. That is a good fit — a partition is idle whenever nobody is in that
system, and most of the galaxy is always idle.

**The design already contains the cost mitigation**, which is unusual:

- The universe is derived, so **no world state is stored or served**
- Only mutations and entity states replicate — the same set a save file holds
- A partition with no players costs nothing
- [Solo online](modes.md#solo-online) — the recommended default — needs no
  simulation at all

**Resolved, and it should be published as a promise from day one.**

**Graceful degradation.** The persistent universe degrades to
[solo online](modes.md#solo-online), which degrades to
[solo offline](modes.md#solo-offline), and nothing is lost but other people's
records — because the universe is derived rather than stored. That is a genuinely
rare property and stating it converts a risk into a selling point.

**And the server is self-hostable.** The authority server is documented and
runnable by anyone, so communities can host their own persistent universes if the
official one stops. This is the answer most in keeping with an open-source
project: the game does not depend on this project's continued existence.

The cost is honest — packaging, documenting and supporting a server is real
ongoing work, and it should be scoped into [M7](production.md#m7--the-persistent-universe)
rather than assumed. In exchange, no player ever has to wonder what happens if
the maintainer stops, which is [risk #1](risk.md).

### Funding

Donations and sponsorship only, if at all, and explicitly not tied to anything
in-game. No cosmetics, no early access, no supporter tier that appears in the
world. The moment a payment buys something visible, every design decision on this
page acquires a second constituency.

---

## Related

- [modes](modes.md) — what each mode actually requires of a server
- [ADR-0008](../adr/0008-multiplayer-partitions.md) — the partition topology and its cost properties
- [galaxy](galaxy.md#data-sources) — the datasets whose terms bind this page
- [charter](charter.md#business-posture) — the posture this implements
