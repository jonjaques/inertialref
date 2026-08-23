# REVIEW.md — the deepening plan

This page is the implementation plan for the architecture review of 23 Aug 2026. The review walked the recent hot spots — the boot warm-up, the Worker's
front door, the shell, the catalog surface — and found twelve places where a
shallow module can become a deep one: more behavior behind a smaller
interface, testable in Node through that interface.

> **All twelve landed on 23 Aug 2026.** `CONTEXT.md` § "Twelve shallow modules,
> deepened" is what implementing them found, including three bugs the plan did
> not predict and the measurement 4.3 was gated on. Where the built interface
> differs from the sketch below, the sketch is annotated **Built as** — the
> differences are small and each one is a fact the sketch could not have known.
> The phases are kept rather than deleted: the evidence in each is the reason a
> module is shaped the way it is, and that is worth more than a checklist.

The vocabulary is deliberate. A **module** is anything with an interface and
an implementation. Its **interface** is everything a caller must know — the
signature, but also the invariants, ordering constraints, and error modes. A
module is **deep** when a caller gets a lot of behavior per unit of interface
learned, **shallow** when the interface is nearly as complex as the
implementation. A **seam** is where an interface lives; an **adapter** is a
concrete thing that satisfies it there. One adapter means a hypothetical
seam; two adapters mean a real one. Depth buys **leverage** for callers and
**locality** for maintainers: change, bugs, and verification concentrate in
one place instead of spreading across call sites.

Every candidate below is backed by file-and-line evidence gathered from the
working tree at `d7fa1ee`. None is speculative. The work is phased so that
each phase lands on its own, passes `pnpm check` on its own, and gets its own
`CONTEXT.md` entry when it does.

---

## The order of work

| Phase | Candidates                                                          | Why this order                                                                                       |
| ----- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1     | serveMedia · sunk sphere · version verdict · provenance · head gate | Independent, Node-testable, each is one bounded change. The evidence is strongest here.              |
| 2     | warm-up module · first light                                        | The biggest structural payoff, in the hottest area. Needs browser verification, so it goes together. |
| 3     | engineStore · playhead · stance                                     | The shell's reading side. Ordered: the store first, because the playhead publishes through it.       |
| 4     | openSession width · registration · catalog name index               | Hygiene and one measured extra. The index waits for a decode-cost measurement.                       |

Phase 1 items are independent of each other and can land in any order or in
parallel worktrees. Phases 2 and 3 are internally ordered. Run the
`invariant-auditor` agent on each phase's diff before its PR; use the
`property-tester` agent for anything mathematical (the sunk sphere, the
version drift, the stance round trip).

---

## Phase 1 — bounded, independent, Node-testable

### 1.1 `serveMedia` — the Worker's range arithmetic behind an interface

**Files.** `apps/server/src/index.ts:123–240` (`media()`, 97 lines, no
tests) · `apps/server/src/media.ts:107–129` (`resolveRange`, tested) ·
`apps/server/src/routes.test.ts:74–153`.

**Evidence.** Four consecutive fix commits — `d189341`, `51f4bd1`,
`5a6eff3`, and the R2 fallback in `6cf684a` — touched `index.ts` and no test
file. Every bug was in the decision logic that has no interface: which store
answers (the `servedByAssets` predicate at `index.ts:131`), 200 vs 206 vs
304 vs 416, the 416 that needs a second `head()` to name the object's
length, and the HEAD body suppression written twice. `resolveRange`, the one
tested function, was correct throughout. The logic is reachable only through
`env: Env` — a whole workerd binding object — so nothing can call it from
Node. `routes.ts:9–16` names the treatment ("separated from `index.ts`
because it is the half with decisions in it") and stops one function short
of the media path.

**The deepened module.** `apps/server/src/serveMedia.ts`, beside
`routes.ts`. The seam sits between the Worker's bindings and the response
arithmetic — one level above where `resolveRange` already sits. The stores
parameter is a small structural type, which is what turns the hypothetical
seam into a real one: the workerd adapter in production, a fake in tests.

```ts
interface MediaStores {
  /** The asset binding: may answer, may fall through, may ignore Range. */
  asset(request: Request): Promise<Response>
  /** R2 by key. `range`/`onlyIf` mirror the R2 get options actually used. */
  get(key: string, options?: MediaGetOptions): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2Object | null>
}

function serveMedia(
  request: Request,
  object: MediaObject,
  stores: MediaStores,
): Promise<Response>
```

**Built as** `MediaStores.get(key, options)` with `range` and `onlyIf`
**required**, not optional. R2's `get` is overloaded and only the overload with
`onlyIf` present returns the body-less `R2Object` the 304 branch exists for;
optional options would have quietly selected the other one and deleted that
branch's reason to exist. `StoredObject` / `StoredObjectBody` are restated
structurally rather than imported from the generated workerd types, the way
`media.ts` restates `R2Range` — a fake that had to implement `arrayBuffer`,
`checksums` and `storageClass` is how a seam ends up existing only on paper.

Everything `media()` decides today moves behind that interface: the
`servedByAssets` predicate, the four status codes, the conditional-request
path, the `stored.range` trap that `.claude/rules/server.md` exists for, the
second `head()` for the 416's `Content-Range`, and the HEAD rule written
once. `index.ts` shrinks to routing:
`serveMedia(request, route.object, { asset: env.ASSETS.fetch, ... })`.

**Steps.**

1. Extract the body of `media()` and `unsatisfiable()` into
   `serveMedia.ts`, taking `MediaStores`. No behavior change; the diff
   should read as a move plus a parameter.
2. Point `index.ts` at it, passing the bindings.
3. Build a fake `MediaStores` in the test file: an in-memory object with a
   configurable size, an asset store that can answer HTML, ignore `Range`,
   or fall through.
4. Write the tests below. Delete nothing from `routes.test.ts` —
   `resolveRange`'s tests still describe `resolveRange`.

**Tests** (plain Node, through the existing vitest config — `Request` and
`Response` are Node globals; the workerd types erase at runtime):

- The asset store answering HTML gets a 200 (the SPA fallback).
- The asset store ignoring `Range` falls through to R2 with a 206.
- A conditional GET returns 304 with no body.
- A plain GET returns 200, never 206.
- A range past EOF returns 416 **with** `Content-Range: bytes */N`.
- `head()` also failing returns a 416 without a length.
- HEAD returns the headers and no body.

Each of those is a shipped bug or a near miss from the four fix commits.

**Done when** the seven tests pass, `media()` is gone from `index.ts`, and
`pnpm check` is green. Touches no ADR; extends the seam style
`docs/hosting.md` already lists.

---

### 1.2 The sunk sphere is one fact

**Files.** `apps/game/src/render/preloadPlan.ts:63–83` ·
`packages/rendering/src/scene.ts:158–193` ·
`apps/game/src/render/preloadPlan.test.ts`.

**Evidence.** The datum-sphere arithmetic — the sphere is sunk below the
peaks, and every shell ratio is measured against the sunk radius — exists
twice. `scene.ts:162` computes `max(radius * 0.9, radius - body.relief)`;
`preloadPlan.ts:70–74` computes `max(radius * 0.9, radius -
body.surface.maxElevation)`. The two agree today only because
`snapshot.ts:193` assigns `relief` from `maxElevation` — a three-hop
identity nothing asserts. The `0.9` clamp is typed twice. The guard is
`preloadPlan.test.ts`: ~40 lines that build a whole engine to compare two
six-line formulas, and whose header admits it is what holds them together. A
one-rounding-step drift is a silent full cache miss at boot.
`scatteringKey` was already extracted the right way (one definition,
imported by `atmosphereLuts.ts:19`); this finishes the job it started.

**The deepened module.** `packages/rendering` exports the fact — the
package is already the Three-free, Node-testable home for render
arithmetic:

```ts
/** The datum sphere sinks below the peaks; ratios measure against it. */
function sunkSphereRadius(radius: number, relief: number): number
function atmosphereShellRatio(
  radius: number,
  relief: number,
  hazeHeight: number,
): number
function ringScales(
  radius: number,
  relief: number,
  ring: RingSpan,
): { inner: number; outer: number }
```

**Built as** `packages/rendering/src/datum.ts`, with the clamp named
(`MAX_SINK`) and `sunkSphereRadius` made total over a negative relief — the one
input that would silently draw the sphere _above_ the datum, which is the
failure it exists to prevent.

`buildScene` calls it. `scatteringBakes` calls it. `preloadPlan.ts` keeps
what it is genuinely good at: walking loaded systems and deduping by key.

**Steps.**

1. Extract the arithmetic from `scene.ts:158–193` into an exported function
   set (same file or a sibling; the package's layout decides).
2. Replace both computations with calls.
3. Replace the live-engine equality test with a fast-check property over
   radii, reliefs, and haze heights — the `property-tester` agent's shape
   of work. Include the case the old test could not reach: relief above 10%
   of radius, where the clamp bites.
4. Delete the engine-building scaffold from `preloadPlan.test.ts`. The old
   test is waste once the property exists; replace, don't layer.

**Done when** one definition of the clamp exists, the property test passes,
and the key-equality test that remains asserts plan composition rather than
arithmetic. Smallest, highest-certainty item in this plan. Touches no ADR.

---

### 1.3 One verdict on "is this the same universe?"

**Files.** `packages/protocol/src/net.ts:108–149` ·
`packages/persistence/src/save.ts:67–131` ·
`packages/devtools/src/harness.ts:735–747` ·
`apps/game/src/net/health.ts:71` · `packages/net/src/authority.ts:166`.

**Evidence.** Two universe-identity manifests exist — the generation
versions (`Record<string, number>`) and the catalog version string
(`hyg-4.4+nea-2b24daf0`) — and they meet in three places: the net
handshake, the save load, and the health endpoint. Only the handshake has a
comparator (`incompatibility`, `net.ts:126–149` — deep, tested, one
caller), and its `Versions` type has no notion of the catalog at all, so a
client whose catalog moved joins a server whose catalog did not, cleanly.
The save side compares by string interpolation into an error message
(`save.ts:126–128`) that only runs after `loadSystem` has already thrown.
`harness.load()` receives `restored.generation` and `restored.catalog` and
discards both. `docs/roadmap.md:85` carries this as an open square: "both
versions are recorded and nothing compares them yet."

**The deepened module.** The comparator that exists grows to answer the
second question. The seam stays at `packages/protocol` — layer 4, already
imported by net, persistence, and the Worker:

```ts
interface Versions {
  generation: Record<string, number>
  catalog: string // the catalog manifest's version string
}

interface VersionDrift {
  key: string // 'catalog' or a generation algorithm name
  ours: string | number | undefined // undefined = absent, which is a mismatch
  theirs: string | number | undefined
}

/** Empty array = the same universe. */
function versionDrift(ours: Versions, theirs: Versions): VersionDrift[]
```

**Built as** two types rather than one. `UniverseVersions` is
`{ generation, catalog }` — what a _save_ claims — and `Versions extends` it
with `protocol`, which answers a different question: whether two peers can talk
at all, where the universe versions answer whether there is anything worth
saying. A save has the second and not the first. The Worker states its catalog
version from `data/catalog/manifest.json`, the artifact the packed file is
written beside; `apps/headless/src/catalog.test.ts` holds the two together,
because they are now read by different things.

`incompatibility` becomes a reading of `versionDrift` (any drift on a key
both sides require). The handshake sends the catalog string. The save
loader returns the drift to its caller instead of interpolating it into a
failure-path message, and `harness.load()` forwards it instead of
discarding it. The health panel reads the same function.

**Steps.**

1. Widen `Versions` with the catalog string; keep `incompatibility`'s
   absent-key rule (an absent key is a mismatch, never a default —
   `net.ts:117–125` already gets this right and `protocol.test.ts:256–278`
   already proves it).
2. Add `versionDrift`; reimplement `incompatibility` on top of it.
3. Send and check the catalog in the handshake
   (`packages/net/src/authority.ts:166` and its `LocalAuthority` peer).
4. Return the drift from `restoreWorld` / surface it from
   `harness.load()` as part of the result, not only on failure.
5. Read it in `hud/NetworkSection.tsx` and wherever the loader's caller
   reports a stale save.

**Tests.** A save written against `hyg-4.4` and loaded against `hyg-4.5`
produces a named drift rather than a silent success. A generation key this
build has never heard of is reported, not ignored. A property: the
handshake and the loader give the same verdict on the same pair — that
property is what makes one module worth having over two.

**Done when** the three meeting places call one function and the roadmap
square closes. This implements ADR-0007's stated consequence ("changing a
generation algorithm changes what an old save loads into") rather than
revising it. ADR-0008 is untouched; `LocalAuthority` keeps working.

---

### 1.4 Provenance survives the projection

**Files.** `packages/devtools/src/travel.ts:43–61, 99–121` ·
`packages/universe/src/galaxy.ts:81` ·
`apps/game/src/planetarium/CatalogueRow.tsx:34–38` ·
`apps/game/src/hud/TargetRow.tsx`.

**Evidence.** `SystemStub.catalogued` carries whether a system is a real,
observed star or a procedural projection. The projection onto
`TravelTarget` (`travel.ts:99–121`) drops it, so a real star and an
invented one render identically — against the PRODUCT.md brand commitment
that the interface states `observed` or `projected`. `CatalogueRow` renders
`loaded` — a streaming fact — in the slot where the epistemic fact belongs.
The `BodyProvenance` type (`'observed' | 'projected'`) already exists at
`system.ts:103`.

**The change.** One field forward. `TravelTarget` gains
`provenance: BodyProvenance`, mapped from `stub.catalogued` at the
projection — the domain word, not the storage boolean. `CatalogueRow` and
`TargetRow` render it; `loaded` keeps meaning loaded.

**Tests.** Extend the existing "what `targets()` must never omit" test
(`devtools.test.ts:327`). In a Sol-only catalog session, everything outside
Sol is `projected`; with the real catalog, Alpha Centauri is `observed`.

**Done when** the destination list distinguishes a real star from a
generated one. This is the smallest item in the plan and closes a named gap
in `CONTEXT.md`. Respects the catalog rules; the catalog stays an argument.

---

### 1.5 Gate the one artifact scrapers actually read

**Files.** `apps/game/index.html:41–198` · `apps/game/src/site.ts` ·
`scripts/brand/build.mjs:323–377` · `apps/game/src/site.test.ts:83–104`.

**Evidence.** `pnpm brand --check` re-derives and diffs every generated
public-surface artifact — `manifest.webmanifest`, `robots.txt`,
`sitemap.xml`, `favicon.svg` — and never reads `index.html`, the one file a
scraper parses. The head duplicates the site facts by design (a scraper
does not run JS, and `run_worker_first` would bill every asset request —
that trade is settled in `docs/hosting.md:423–428` and is not reopened
here), but the duplication is unguarded: the canonical at `index.html:44`
is hand-typed and was right by luck when `d4f4065` fixed `canonicalUrl`
(the generated sitemap fixed itself; the head did not need to — this
time), and the head carries four description strings that the 60–160
character bound in `site.test.ts` does not hold.

**The deepened module.** A check, not a generator — generating the head was
argued and declined, and `build.mjs:300–305` records why a generator fights
`pnpm format`. A module in `scripts/brand/` whose interface is "pass, or
name the tag that disagrees":

- The home `<title>` equals `documentTitle(ROOT)`.
- Every description-bearing tag (`meta[name=description]`,
  `og:description`, `twitter:description`, each JSON-LD `description`) is
  within the same 60–160 bound the test already enforces.
- Every absolute URL in the head starts with `SITE.origin`.
- `theme-color` equals `SITE.background`; `og:image` is
  `SITE.origin + SITE.socialImage`; the canonical is `canonicalUrl(ROOT)`.
- The service worker's `PRECACHE` list (`public/sw.js:52`) names only files
  the brand build generates or the repo ships — the second unguarded
  duplication in the same family.

Parsing is tolerant extraction over a file whose shape the repo controls —
no HTML-parser dependency for a gate on our own head. If the extraction
ever misses a tag, the check fails loudly rather than passing silently:
assert the expected tag count.

**Built as** described, with two corrections the sketch could not have known.
**Strip the HTML comments before extracting anything**: the head's own
commentary quotes the tags it explains, so the first `<title>` in the file is
inside a comment and the first version of the checker read four hundred words of
prose as the page title. And the 60–160 bound applies to the three tags a search
result or a card actually shows; a JSON-LD `description` is never rendered as a
snippet, so it is held to a stated, looser bound whose job is to catch a
placeholder at one end and an essay at the other.

**Steps.**

1. Write `scripts/brand/checkHead.mjs` reading `index.html`, `sw.js`, and
   importing `SITE`, `PAGES`, `documentTitle`, `canonicalUrl` the way
   `build.mjs:41` already does.
2. Wire it into `--check` so `pnpm check` runs it.
3. Give it one fixture test with a deliberately drifted head, proving the
   gate can fail. A gate that cannot fail is not a gate.

**Done when** renaming a page, moving the origin, or padding a description
fails `pnpm check` instead of failing in an unfurler weeks later.

---

## Phase 2 — the render boot pair

Both items change what happens before first light. Land the warm-up module
first, then first light; verify each in the browser with the `drive`
harness (`ir.shot` after boot; a Saturn approach for the spike check — pace
any GPU measurement with `queue.onSubmittedWorkDone()` before believing it,
per `CONTEXT.md`).

### 2.1 One warm-up module behind the renderer handle

**Files.** `apps/game/src/render/preload.ts` (262) ·
`render/preloadPlan.ts` (83) · `scene/Bodies.tsx:677–752` ·
`scene/WarpFx.tsx:22–40` · `scene/TerrainPatches.tsx:31–71` ·
`render/planetTextures.ts:219–228` · `render/shipModels.ts`.

**Evidence.** The compile-ahead recipe — make visible, `compileAsync`
against the live camera and scene, make invisible, swallow the rejection —
is written out three times (`Bodies.tsx:739–750`, `WarpFx.tsx:35–39`,
`TerrainPatches.tsx:62–71`, the last twice, straddling a `transparent`
flip). The `gl as unknown as WebGPURenderer` cast is made independently in
the same three files. The measured fact that motivates it ("the backend
builds shader source per material instance") is re-explained in prose four
times and expressed in code nowhere. "What boot must warm" has five
producers — textures, LUT bakes, archetypes, the hull, and the per-instance
queues — and no census: `preload.ts:98` disclaims instance coverage ("the
others warm their own real instances"), and the drain queue in `Bodies.tsx`
is invisible to `BootProgress`, so the status line says "compiling the
sky…" while the thing that cost 88 ms has not started. A fourth mounted
effect that forgets the visibility toggle compiles a variant nothing draws
with, silently.

**The deepened module.** `apps/game/src/render/warmup.ts`. The seam sits at
the renderer handle, not at R3F's `gl`. Two layers:

```ts
/** The primitive all producers share. Owns the visibility toggle, the
 *  WebGPURenderer cast, the swallowed rejection, and the pacing. */
function warmCompile(
  handle: RendererHandle,
  target: { object: Object3D; camera: Camera; scene: Scene },
): Promise<void>

/** The census. Producers register; the module owns the progress total. */
interface Warmup {
  register(label: string, work: (compile: WarmCompile) => Promise<void>): void
  run(onProgress: (p: BootProgress) => void): Promise<void>
}
```

**Built as** `warmCompile(renderer, target)` over a one-method `WarmRenderer`
rather than over `RendererHandle`: the three scene components have R3F's `gl`,
not a handle, and a handle also carries a tone-curve controller and an output
description that warming has no business reading. The census gained a second
verb, `track`, for a producer boot _counts but does not drive_ — the body
build-ahead runs on the frame loop, and boot cannot await a loop over the frames
it is waiting for. Both verbs are **idempotent by label**, which the sketch did
not anticipate and StrictMode requires: see `CONTEXT.md` for the boot that sat
at `building bodies 62/62` forever.

`preload.ts` becomes one registered producer among several rather than the
file with a disclaimer in it. The scene components keep their build-ahead
timing (boot drain behind the overlay; one-per-frame trickle after a jump)
but express it through `warmCompile` — the recipe exists once. The
refcount rule (`Pipelines.delete` releases at zero use, so warm meshes are
held for the session — `preload.ts:45–50`) moves behind the interface with
everything else.

**Steps.**

1. Extract `warmCompile`; convert the three scene components to it. This
   step alone deletes the recipe duplication and the three casts.
2. Add the registration layer; convert `preload.ts`'s texture, LUT,
   archetype, and hull passes into registered producers.
3. Register the `Bodies` drain queue's boot-time portion so `BootProgress`
   totals include it and the status line stops lying.
4. Keep `preloadPlan.ts` as the enumerator it is (1.2 already slimmed it).

**Tests.** A fake `RendererHandle` that records
`(object, visibleAtCallTime)` proves in Node: nothing is compiled while
invisible; every registered producer contributes to the total; a producer
that throws does not sink the run. The plan — what will be warmed, in what
order, with what totals — becomes a pure value assertable in Node; today
only `scatteringBakes` is. The recipe itself stays GPU-verified: drive a
boot and a warm Saturn approach and hold the `CONTEXT.md` numbers
(spike-free first look, worst main-thread frame 2.3 ms).

**Done when** `rg 'as unknown as WebGPURenderer' apps/game/src/scene` finds
nothing, one file owns the recipe, and the boot progress total is the sum
of what registered. Touches no ADR; consistent with the rendering rules.

### 2.2 "First light" gets a home

**Files.** `App.tsx:241–264, 268–301, 331–395, 596–606, 820–838` ·
`render/presentationWatchdog.ts` (232) · `hud/BootOverlay.tsx` (79) ·
`hud/boot.ts` (32) · `render/output.ts:120` · `index.html` (`#boot`).

**Evidence.** The contract — the cover lifts when the warm-up resolved
**and** pixels are provably presented, where "provably" is
backend-dependent — is four `useState`s and five effects in an 842-line
component, plus a fifth state (`canvasEpoch`) for the watchdog's last
recovery rung. The backend split is leakage: `presentationWatchdog.ts:110–119`
documents that its probe is trustworthy only on a WebGPU canvas, then hands
enforcement to its caller — `App.tsx:366` reads `output.backend` and
implements the WebGL two-rAF alternative inline. The module states an
invariant it does not own. The resize-replay kick has three
implementations in two files (`App.tsx:294–301`, `App.tsx:600–606`, and the
watchdog's own rung 1), each with a comment explaining why the other two
are insufficient. None of this is tested; `hasLitPixels`
(`presentationWatchdog.ts:57–92`) is pure arithmetic over an `ImageData`
buffer and is reachable only by loading the app.

**The deepened module.** `apps/game/src/render/firstLight.ts`. The seam is
the presented signal — one interface, two adapters, chosen by
`RendererDescription.backend` **inside** the module:

```ts
interface PresentedSignal {
  /** Resolves when this backend can prove pixels reached the screen. */
  wait(handle: RendererHandle): Promise<void>
}
// adapters: webgpuPixelProbe (wraps the watchdog's onPresented),
//           webglTwoFrames (two visible rAFs; the probe legally lies there)

function createFirstLight(deps: {
  backend: RendererBackend
  watchdog: PresentationWatchdog
  requestRemount: () => void // the epoch, owned here
}): {
  phase(): 'booting' | 'revealing' | 'done'
  statusLine(): string // absorbs hud/boot.ts
  onWarmed(): void // latches; an HDR rebuild must not un-set it
  subscribe(cb: () => void): () => void
}
```

**Built as** `PresentedSignal` with `wait()` / `cancel()` and no `handle`
argument — the adapter is built against the canvas it will watch, so a watch
that has been replaced can be recognized and ignored. The state is published
through a zustand store, the same seam `state/engineStore.ts` uses, rather than
a bare `subscribe`. `replayMeasurement` lives in `presentationWatchdog.ts`
because rung 1 of its own ladder _is_ that call, and a module importing the
state machine to reach its own first rung would be a cycle.

The module owns the conjunction, the latch (`App.tsx:247–251`), the
exhausted-ladder release (a watchdog that runs out of rungs releases the
fade rather than hiding a possibly-fine scene forever), the canvas epoch,
and one resize-replay kick. `App.tsx` holds one subscription and renders
`<BootOverlay {...firstLight} />`.

**Steps.**

1. Extract the state machine with the current behavior; port the five
   effects one at a time, keeping each of `CONTEXT.md`'s "must not come
   back" items as a named test as it moves.
2. Define `PresentedSignal`; move the WebGL two-rAF branch out of `App.tsx`
   into the second adapter.
3. Consolidate the replay kicks into the module; delete the other two.
4. Export `hasLitPixels` for direct test.

**Tests.** In Node: booting → revealing → done; the warmed latch under a
simulated renderer rebuild; the exhausted-ladder release; `statusLine`
against synthetic `BootProgress`. With a stubbed 2D context: `hasLitPixels`
against a synthetic starfield buffer — the case its own comment warns about
(a 16×16 thumbnail of a starfield averages to black) and nothing checks.
In the browser: boot on WebGPU and on the WebGL fallback (Safari or
Firefox), and confirm the Firefox "first light… forever" failure stays
dead.

**Done when** `App.tsx` sheds four states and five effects, the backend
split lives behind the seam, and the boot cluster has Node tests. ADR-0011
cites the watchdog as motivation and decides nothing about its shape;
nothing here contradicts it.

---

## Phase 3 — the shell's reading side

Three modules, ordered: the store first because the playhead publishes
through it, the stance last because it changes what modes write while the
first two change what panels read.

### 3.1 Populate `engineStore`

**Files.** `state/engineStore.ts` (120) · `App.tsx:140–141, 529, 733` ·
`hud/usePolled.ts` · `hud/context.ts` · seven files with private timers.

**Evidence.** The store's header states its purpose: panels subscribe
instead of being handed props. Zero panels subscribe — `useEngine` has two
call sites, both in `App.tsx`. Meanwhile the engine is read by four other
mechanisms at four rates: the 8 Hz sampler, `usePolled` at 6/4/3 Hz, bare
`setInterval`s at 100 ms and 250 ms, and raw rAF loops — seven files each
owning a timer over the same singleton. `NavPanel.tsx:66` mirrors
`engine.showShip` into React state because no snapshot publishes it, and
disagrees with `PlanetariumMode.tsx:77` the moment either acts. Four
components carry `'use no memo'` opt-outs the store exists to make
unnecessary. The seam (`EngineSource`) is good and tested; the module is
shallow by adoption, not by design.

**The change.** Widen `EngineSnapshot` beyond `{status, cinema}` to the
fields panels actually poll — the world clock, the observer, the
presentation switches, the playhead (3.2). One sampler owns the rate.
Migrate consumers panel by panel; delete `usePolled` and each ad-hoc timer
as its caller moves. `DevContext.status` and `ModeRouteProps.status`
disappear as props.

**Built as** `{ status, cinema, observer, presentation, playhead }`. The world
clock is _not_ a new field: it is already inside `status.world`, and the fix
there was the selector, not the shape — `useEngine((s) => s.status?.world.paused)`
returns a boolean and bails out honestly. The travel survey deliberately stayed
out: it is a star sweep, not a field read, and sampling two of them eight times
a second is the cost the snapshot exists to avoid. It collapses in 4.3 instead.

**The guardrail.** The react-shell rule is right: `status` is a fresh
object every sample and never bails out of a re-render. The wider snapshot
therefore ships with narrow selectors — `useEngine(s => s.clock.paused)`
selecting primitives or stable slices — or it worsens the problem it
fixes. ADR-0011's "props over context" argument is about route props, not
panel data; the PR should say so explicitly, because a reviewer will
conflate them.

**Tests.** Panel derivations assert against literal `EngineSnapshot`
values in Node — today they require rendering against a live engine, which
`hud.test.ts` does at real cost. `engineStore.test.ts` extends to the new
fields.

**Done when** `rg 'setInterval|usePolled' apps/game/src/hud apps/game/src/planetarium`
returns only the store's sampler, and the `'use no memo'` census shrinks.

### 3.2 One playhead over the director

**Files.** `cinema/CinemaPlayer.tsx:151–261` · `hud/CutsceneOverlay.tsx:78`
· `cinema/CinemaMode.tsx:37–41` · `hud/useScrubber.ts` ·
`packages/devtools` (the director's status, if the second half is taken).

**Evidence.** Three components poll the director at three rates, and each
reaches around it into `engine.world.clock.paused` — a canonical field read
from three places. `toggle` is implemented twice, identically. Fifty lines
in `CinemaPlayer` reconstruct "did it end or was it stopped?" from a `null`
with a half-second heuristic (`frame >= durationFrames - fps / 2`), then
call `play()` again to fix a rendering problem — the UI mutating director
state because a return value is missing.

**The deepened module.** A cutscene session over the harness seam that
already exists (`cutsceneStatus` / `play` / `pause` / `seekCutscene` /
`stopCutscene`): one published playhead
`{ id, frame, durationFrames, fps, paused, ended }` and one set of verbs
(`toggle`, `seek`, `replay`, `stop`). It publishes through the 3.1
snapshot, so it adds no timer. Both transports and the mode consume it.

**The second half — grill before taking.** Move the ended/stopped
distinction into the director's status in `packages/devtools`, so the
session stops guessing entirely. That is a status-shape change in the
director's home package; check it against the cutscene rules and ADR-0010
first. ADR-0010's director stays a pure `sample(frame)` — a session
_reading_ it contradicts nothing; a richer status return is the part to
confirm. If declined, the session owns the single remaining copy of the
heuristic, which is still one instead of three.

**Taken.** `CutsceneDirector` records how a scene left — `lastOutcome()`
returning `ended` / `stopped` / `abandoned` — which is purely additive and
leaves `sample(frame)` exactly as pure as ADR-0010 requires. The heuristic is
gone rather than reduced to one copy. The session also took the scrubber's hold
rule: `useScrubber` owns the pointer, and what the hold _means_ — the published
frame stands still — is the session's, because both transports needed it and
neither owned it.

**Tests.** Against a fake harness in Node: ended vs stopped; the
frame-to-URL writeback rule (only while paused); replay clears `t`; seek
dismisses the end card. `cinema.test.ts` already tests the pure half at
this boundary; this extends it one step.

**Done when** one poll exists, `engine.world.clock.paused` has no readers
in `cinema/` or the cutscene HUD, and the end card's behavior is asserted
rather than inferred.

### 3.3 Presentation stance — push/pop, not assign-and-guess

**Files.** `pages/HomePage.tsx:143–172` ·
`planetarium/PlanetariumMode.tsx:76–99` · `flight/FlightMode.tsx:53–58` ·
`hud/NavPanel.tsx:64–66, 225` · `engine/GameEngine.ts:213–232, 487–615`.

**Evidence.** Four presentation fields (`showShip`, `showOrbits`,
`flareArtifacts`, the observatory target) are written on mode entry under
three different disciplines: the menu captures and restores previous
values; the planetarium restores to hard-coded literals — so leaving it
after arriving from the menu restores `showShip` to `true`, a value it
never took, which is a live inconsistency; flight sets and never restores,
its own comment calling it "belt and braces." `observatory.clear()` has
three callers whose correctness depends on unmount ordering.
`engine.showShip` has three writers, one of them a panel. `GameEngine.ts:230`
names the convention — "restored by whoever lowered it" — and assigns it
to no one.

**The deepened module.** A presentation stance behind `GameEngine`'s
interface: a mode declares what it wants drawn and the engine owns what
that means and what restoring means. The seam sits beside the camera
precedence resolution in `#step` — the one place that already arbitrates
between producers.

**Design question to settle first — design it twice.** Two shapes fit:

1. **A stance stack.** `engine.presentation.push(stance)` returns a handle;
   `release()` restores what was underneath. Modes push on mount, release
   on unmount. Handles compose; ordering bugs die because restore means
   "what was under me," not "what I remember."
2. **A mode-to-stance table.** The current mode is already derived —
   `modeForPath(resolvedLocation(location).pathname)` — so a table keyed
   by mode, read by `#step`, eliminates restore entirely: leaving a mode
   _is_ the next mode's stance applying. This fits ADR-0011's "mode is
   never held in state" more tightly.

**Settled: the stack.** The table needs an override channel for the toggle and
then a rule for what happens to that channel when the mode changes — which is a
restore rule wearing a different hat. `engine/presentation.ts` carries the
argument in full. One thing the sketch did not say: layers release **by
identity**, not by position, because React interleaves one route's cleanup with
the next one's mount and popping the top would take somebody else's layer.

The deciding constraint is `NavPanel`'s in-planetarium ship toggle: a user
override on top of the mode's stance. The table needs an override channel;
the stack gets it free (the toggle pushes). Settle this with a short
design pass (the `codebase-design` design-it-twice pattern) before
implementing; either way the three mode effects collapse and the
"belt and braces" duplication is deleted.

**The guardrail.** No fourth camera producer — the camera order (cutscene,
then observatory, then the ship) is ADR-0011's and this change covers the
three non-camera fields plus the observatory target's _lifetime_ only. The
stance must reconcile against the engine's actual state, not latch
(the react-shell rule).

**Tests.** Headless, in Node, no React: enter menu → planetarium → flight
→ back; assert all four fields land where they started. This extends the
shape of `observatory.test.ts`'s state-hash promise from canonical state —
already guarded — to presentation state, which is not.

**Done when** `observatory.clear()` has one owner, `engine.showShip` has
one writer plus the declared override, and the round trip is a Node test.

---

## Phase 4 — width, edges, and one measurement

### 4.1 Narrow `openSession`

**Files.** `packages/devtools/src/session.ts:55–97, 125–233` · callers in
`GameEngine.ts:338–352`, `apps/headless/src/main.ts:61–70`, ~12 test sites.

The module is the repo's best deep one and is accreting width: seven of
twelve options have at most one caller, `shipName` has zero, and the
`presentation` spread lands last in the session object — so a stray `world`
key in it would silently shadow the getter the module exists to protect (a
bug class `session.ts:44–47` records as having happened once). Fold
`presentation` and `onWorldReplaced` into one host-shaped parameter — they
are both "the host's render side" and always travel together — and delete
`shipName`. Keep `system`, `poolSize`, and `authority`: one caller each,
but each is a real axis, and ADR-0008 explicitly holds the `authority`
seam open. The seam does not move; it narrows. The win is type-level: the
host object cannot shadow `world`, making the recorded bug class
unrepresentable rather than commented against.

**Built as** `SessionHost` with `scene`, `frameStats` and `onWorldReplaced`,
assigned by name rather than spread — naming them is what actually removes the
shadowing, not folding them into one parameter.

### 4.2 The registration cliff

**Files.** `apps/game/src/main.tsx:197–232` · `public/sw.js` (well-tested)
· `apps/game/src/net/serviceWorker.test.ts`.

Offline-first is one well-tested module plus 36 untested lines where the
shipped bug was: registration listened for a `load` event that had already
fired (`3ed4872`), breaking exactly the first-ever visit that "works on a
plane" depends on. Lift the block into
`src/net/registerServiceWorker.ts` with the page-readiness and registration
dependencies injected; the seam sits between "the page is ready" and
"install the worker," which today is implicit in module evaluation order —
the thing that broke. Three Node tests with the fakes the service-worker
test file already builds: `readyState === 'complete'` registers
immediately; `'loading'` defers and registers exactly once on `load`; a
rejected `register()` warns and does not throw. The registered URL carries
the build id — proving from the page's side the contract `sw.js:39` reads
back, which the existing suite fakes from one side only.

### 4.3 The catalog name index — measure, then build

**Files.** `packages/universe/src/catalog/starCatalog.ts:123–140, 374,
455–457` · `catalog/designations.ts:270–279` ·
`planetarium/CataloguePanel.tsx:21, 46–60` · `hud/NavPanel.tsx:34–90` ·
`packages/devtools/src/travel.ts`.

The search box filters a 16 ly survey against a 150 ly catalog:
`travelTargets` is a star sweep that cannot run per keystroke, so
`CataloguePanel` filters its result with `.includes()`, and two panels
hard-code two radii and two poll loops. The catalog already holds a name
index (`#byName`) and an alias normalizer (`searchKey` — superscripts,
diacritics, Greek), but `find` is exact-key-only and no panel calls it.

The deepening splits the interface by question: `search(text, limit)` on
`StarCatalog` itself — where the index and the "index it, never scan"
contract already live, layer 3, below devtools — and `survey(from,
radius)` as today. 7,123 systems, indexed once at decode, answers the
whole sphere per keystroke. `travelTargets` keeps the part that earns its
keep: the frame-pose-versus-orbital-elements distinction and the
loaded/unloaded merge.

**The gate, measured (23 Aug 2026):** the exact-name index already existed — the
decode loop calls `searchKeysFor` for every star — so a _searchable_ one costs
**0.18 ms** marginal, because the only extra work is keeping the pairs instead
of discarding all but the first. Decode is 22 ms for 7,123 stars; a query over
all 16,537 keys is **0.14–0.30 ms**. Built eagerly.

One thing the split bought that the plan did not predict: `α Cen` resolved to
nothing, though `designations.ts` promises it should. Dropping the superscript
keys `ζ¹` and `ζ² Reticuli` — two unrelated systems — to one string, so the
exact map cannot hold it without answering an ambiguous name arbitrarily. That
is a constraint on `find`, not on a search box, which should offer both stars;
the un-superscripted forms are in the search index and out of the exact map.
(`alf cen` below is HYG's own internal abbreviation and is deliberately not
indexed — nothing in this repository spells alpha that way.)

Then: Node tests that "α Cen,"
"Alpha Centauri," "alf cen," and "HIP 71683" reach the same star, and that
a star 90 ly out is findable — a case the survey interface cannot even
express. The two panels' duplicated poll-and-catch state machines collapse
into one hook over the new interface.

Never make the catalog ambient: `search` is a method on the value, passed
as an argument, exactly like `resolveSystem`.

---

## Checked and cleared

The review also walked these and proposes nothing, so a future review can
skip them:

- **Deep already:** the dock algebra (`dock/layout.ts` + `floating.ts`,
  property-tested), `pages/paths.ts` + `useOverlay`, `hud/panelState.ts`,
  `cinema/timecode.ts`, `useScrubber`'s pure half, the persistence
  migration chain, and the `SaveStore` and `WorkerFactory` seams — two
  adapters each, real.
- **Settled, not reopened:** per-route Open Graph via HTMLRewriter
  (declined in `docs/hosting.md`; the revisit trigger is named there);
  anything multiplayer (ADR-0008 is design-only, and the single
  `AuthorityPort` adapter cannot rot — no `if (online)` branch exists);
  generating `index.html`; wiring `World.updateInterest` (a gameplay
  decision, per the build log).

## Definition of done, per phase

Each phase lands as its own PR: `pnpm check` green, new tests at the new
interfaces (replacing the tests they obsolete, not layering over them), an
`invariant-auditor` pass on the diff, a `CONTEXT.md` entry for the
decision, and — where a phase changes an interface this file describes —
the corresponding update here. Phase 2 additionally re-verifies the boot
numbers in the browser before merge.

**As implemented (23 Aug 2026):** `pnpm check` green and `pnpm sim --self-test`
12/12; the new interfaces carry their own tests and the tests they obsoleted are
gone rather than layered over; `CONTEXT.md` § "Twelve shallow modules, deepened"
records the decisions. Phase 2's browser pass confirmed the census live
(`baking atmospheres 28/62`, then `building bodies 46/62`, then first light onto
a fully textured scene) and found two bugs Node could not — both fixed, both
with regression tests. Two items are **outstanding**: the `invariant-auditor`
pass on each diff, and the Saturn frame-spike re-measurement, which needs a
composited window — the automation window stays `visibilityState: hidden`, and
Chrome suspends the frame loop entirely for one.
