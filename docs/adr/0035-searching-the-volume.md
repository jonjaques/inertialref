# ADR-0035: A volume search is a predicate over generated bodies, streamed in batches

Status: accepted · 6 Sep 2026

## Context

The catalog could be searched by **name**. `StarCatalog.search` is an index over
every designation, it answers in 0.14–0.30 ms, and it is the right answer to
the question a person asks when they already know what they are looking for.

It cannot answer the other question a reading room exists for — _what is out
there like this_. Two reasons, and only the first is obvious:

**The index holds stars, not worlds.** Every designation belongs to a system;
no body has one until its system is generated, and most never are.

**The thing being asked about does not exist yet.** A system is a pure function
of its seed ([ADR-0005](0005-procedural-seeds.md)), which is what makes the
universe streamable without storing generated systems — and it means the only way to know
whether a star has a world with a sea is to build the system and look. There is
nothing to index, because there is nothing there.

`design/plans/the-companion.md` designed this query as the deterministic half
of a natural-language companion. Nothing of that plan is built; the finder is
useful on its own and is what this record is about.

## Decision

**A predicate over generated bodies, run in worker batches, drawn as it
arrives.**

### Every field reads something the record already carries

`WorldQuery` filters on the host star's spectral class, the body's class, its
atmosphere, its sea, its rings, its habitability, its landability, its moon
count and its radius. **No tag is invented for searching.** A result is then a
claim about the world the generator makes rather than about a label somebody
attached to it, and where a field is derived rather than stored —
`isHabitable`, `isLandable` — it is derived by the function the rest of the
build already uses. The search and the object panel cannot come to different
conclusions about the same body, and the test asserts that body for body
rather than asserting the filter returned something.

**"Sea", not "water".** The generator's answer is whether the ground
temperature admits a _liquid_, and on a cold world that liquid is methane
([ADR-0026](0026-the-liquid.md)). Labelling it water would be the interface
inventing a fact the simulation is careful not to claim.

### Streaming is several jobs, because a job cannot report progress

`WorkerOutbound` is `success | failure | ready`. There is no partial-result
message and adding one would put a second delivery mode into every task's
contract for the benefit of one. So the volume is cut into **32-system
batches**, each submitted as its own job, and rows accumulate as each answers.

Thirty-two is about a quarter-second of generating. Fewer and the queue is
thousands of jobs whose per-job structured clone is a real share of the work;
more and a wide sweep is a handful of jobs, so rows arrive in lumps and the
last worker holds the whole answer.

### The star class is checked against the stub before the system is built

The stub permits rejecting a nonmatching host class before generating its
system. The share of work avoided depends on the selected population and
query; there is no fixed rejection ratio. `matchSystem` checks the generated
star against its parsed class afterwards.

### The nearest thousand are kept, and the rest are counted

A sweep is bounded by the volume; the volume is not bounded by anything a
reader will read. "Rocky, within 150 light years" is 37,929 systems and over a
hundred thousand bodies. Uncapped, re-sorting the accumulation as batches land
was the main thread's whole budget — measured, it dropped the simulation clock
to a fifth of real time while the sweep ran.

So the harness keeps the nearest thousand, trimming at twice that so the sort
is amortized, and reports the true total beside them. A list that is short
because the cap bit is not a search that found little, and the count says
which.

### Ordering is a display decision, made where it is displayed

`systemsWithin` sorts by id so its answer is a pure function of its query. The
sweep is _dispatched_ nearest first, but eight workers do not finish in the
order they were given, so arrival order is a race. The rows are sorted by
distance in the hook that draws them — the same split `travel.ts` already
makes, and the same one [ADR-0009](0009-issue-ordinal-addressing.md) makes
about orbital order.

### It is a dialog, and a child of the planetarium's route

A panel that took four seconds to answer inside a dock column would look
broken. A dialog is a thing you opened on purpose, with room for the controls
the question needs and for the count that says how far along it is. It is a
child route rather than a global overlay for the reason the preset library is
([ADR-0033](0033-presets-hold-a-photographic-instant.md)): the camera, the
clock and the pose have to still be there when a result is pressed.

The five yes/no clauses are **three-state**. A switch cannot say the difference
between "I do not care whether it has air" and "I want the ones with none", and
both are searches somebody runs — the airless worlds are where the sharp
horizons are.

## Alternatives considered

**Index the bodies at build time.** A table of every world within 150 light
years, shipped like the star catalog. It is the fastest possible answer and it
breaks the thing the whole architecture is for: generated content is a function
of the seed and the generation manifest, so the table would be a second source
of truth that goes stale on every `SYSTEM_ALGORITHM` bump, and it would answer
for one seed only.

**One job for the whole radius.** Simplest to write, and the panel is then
blank until the last system is built — forty seconds at 150 light years, with
nothing to look at and nothing to cancel.

**A partial-result message in the worker protocol.** The direct way to stream
from one job. Rejected as a change to every task's contract for one caller's
benefit; batching gets the same behavior out of the delivery mode that already
exists, and it parallelizes as a side effect where one streaming job would not.

**Filtering the survey the navigator already runs.** The mistake rule 18 exists
to name, one level up: that survey is a star sweep with a radius and it holds
no bodies at all.

## Consequences

**Good.**

- The reading room can be asked its own question, over a volume nobody has
  looked at, and the answer is about the worlds the generator actually makes.
- The list fills in continuously: measured at 1600×900, 3,335 rows by 3% of a
  37,929-system sweep and 16,805 by 17%, cancellable at any point.
- `ir.findWorlds(query, { lightYears, onBatch })` is the console's own verb, so
  a script can ask the same question.
- The predicate is pure and testable without a world: properties assert that
  every clause can only narrow, that two clauses are an intersection, and that
  the answer does not depend on the order the stubs arrive in.

**Costs, honestly.**

- **A wide sweep is expensive and says so.** 150 light years is 37,929 systems
  and about a minute of worker time. The control names the cost before it is
  paid; nothing makes it cheap.
- Results past the thousandth are counted and discarded. Widening the query is
  the way to see further in, and the interface does not offer paging.
- Nothing is cached between searches. Asking the same question twice generates
  the same systems twice, which is the honest starting point — a cache keyed on
  seed, generation manifest and query is a later decision with a memory budget
  attached.
- The sweep centre is the camera's eye, so a search run from Alpha Centauri
  answers about a different volume from one run at Sol. That is the intended
  reading of "within 25 light years" and it does mean two searches with the
  same query can differ.

## Related

- [ADR-0028](0028-client-tasks.md) — the task registry and the pool this rides
- [ADR-0005](0005-procedural-seeds.md) — why there is nothing to index
- [ADR-0026](0026-the-liquid.md) — what a sea is, and why it is not water
- [ADR-0033](0033-presets-hold-a-photographic-instant.md) — the child-route dialog this follows
- [Planetarium](../design/planetarium.md) · [Galaxy](../design/galaxy.md)
- `design/plans/the-companion.md` — the plan this is the deterministic half of
