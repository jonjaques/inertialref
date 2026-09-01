# The deepening plan: what is left

Twelve shallow modules — the Worker's front door, the boot warm-up, the shell's
reading side, the catalog surface — reshaped so a caller gets more behavior per
unit of interface and can reach it from Node. All twelve are in the tree, each
carrying its reasoning in its own file:
[`apps/server/src/serveMedia.ts`](../../apps/server/src/serveMedia.ts),
[`packages/rendering/src/datum.ts`](../../packages/rendering/src/datum.ts),
`versionDrift` in
[`packages/protocol/src/net.ts`](../../packages/protocol/src/net.ts),
`TravelTarget.provenance`,
[`scripts/brand/checkHead.mjs`](../../scripts/brand/checkHead.mjs),
[`render/warmup.ts`](../../apps/game/src/render/warmup.ts),
[`render/firstLight.ts`](../../apps/game/src/render/firstLight.ts),
[`state/engineStore.ts`](../../apps/game/src/state/engineStore.ts), the cutscene
session's playhead over `CutsceneDirector.lastOutcome`,
[`engine/presentation.ts`](../../apps/game/src/engine/presentation.ts),
`SessionHost` in
[`packages/devtools/src/session.ts`](../../packages/devtools/src/session.ts),
[`net/registerServiceWorker.ts`](../../apps/game/src/net/registerServiceWorker.ts),
and `StarCatalog.search`. `CONTEXT.md` § "Twelve shallow modules, deepened"
records what implementing them found, including three bugs the plan did not
predict.

Two items from the definition of done are outstanding.

---

## The Saturn frame-spike figure is not re-measured

The number to hold is the one that motivated the warm-up work in the first
place: **worst main-thread frame 2.3 ms across a warm Saturn approach, zero
frames over 8 ms**, spike-free on a first look at any shipped body. Rewriting
the compile-ahead recipe into one registered census is exactly the change that
could move it, and nothing has read it since.

**The rig's frame periods cannot answer this and its spans can.** The driver's
Chrome is occluded, and an occluded compositor skips vsyncs the page never sees
— 18 of 240 periods over 25 ms while the longest main-thread task was 3.8 ms.
So a late-frame count taken there is about the rig. `ir.profile` over a Saturn
approach reports the spans _inside_ each frame, which is what the 2.3 ms figure
is about, and `?presentation=occluded` keeps the watchdog from rebuilding a
healthy renderer and doubling the census mid-measurement. The caveats in
[Performance: what is left](perf.md) apply to every number taken this way.

## No `invariant-auditor` pass ran on the diffs

The definition of done named one per phase, before each PR. It is worth running
against the tree as it stands rather than against merged diffs: the interfaces
that matter — the presentation stance, the session host, the catalog search —
are all still there to audit.

---

## Settled, not reopened

Named here so a later review does not relitigate them; each has a home that
carries the argument.

- **Per-route Open Graph through HTMLRewriter** — declined in
  [`docs/hosting.md`](../../docs/hosting.md), which also names the trigger that
  would reopen it. `run_worker_first` bills every asset request.
- **Generating `index.html`** — a generator fights `pnpm format`;
  `scripts/brand/checkHead.mjs` is a gate instead
  ([`scripts/brand/build.mjs`](../../scripts/brand/build.mjs) carries the
  reasoning).
- **Anything multiplayer** —
  [ADR-0008](../../docs/adr/0008-multiplayer-partitions.md) is
  design-only, and the single `AuthorityPort` adapter cannot rot because no
  `if (online)` branch exists.
- **Wiring `World.updateInterest`** — a gameplay decision, per the build log.
