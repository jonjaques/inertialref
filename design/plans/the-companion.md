# The companion: a desk in the reading room

A person types "show me a water world around a red dwarf" or "give me a tour of
the Saturn system" into a panel in the planetarium, the camera goes there, and
a paragraph in the Survey's voice says what is on screen. The language model
runs in the browser, on the same GPU as the frame, through Transformers.js.
Behind the one panel there are two agents — a **director** that turns language
into camera moves through the harness, and a **narrator** that reads the record
and says what it sees — and the person is never shown the seam. It ships as an
**experimental** feature: labeled so, reached through a dialog that says what
is about to happen and shows it happening, and kept — weights and all — in the
browser's own cache on disk, so the download is paid once. This page is the plan
for building it.

What this page is not: a narrator in the sense [world](../../docs/design/world.md)
rules out, which is settled in § 1 and is the one decision on this page that
belongs to the design bible rather than to the code; a companion in the
cockpit, which is an NPC and stays absent; voice, which
[audio](../../docs/design/audio.md) settles; a server-side model, which is a
seam here and not a section.

| Landed                                                                           | The record                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The harness: every verb a person can do, callable by name                        | `packages/devtools/src/harness.ts`, `ir.help()`; [harness](../../docs/guides/harness.md)                                                                                           |
| The observatory: focus, compose, stand, look, and no mutation                    | `packages/devtools/src/observatory.ts`, [planetarium](../../docs/design/planetarium.md)                                                                                            |
| The record: every field of a body, holes marked with a reason                    | `packages/devtools/src/dossier.ts`, [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md)                                                                                 |
| Named places on any body, derived from its own ground                            | `packages/universe/src/surveySites.ts` — `summit`, `basin`, `shore`, `rough`, `corner`, `pole`                                                                                     |
| A system surveyed off-thread without being loaded                                | `surveySystemTask`, `packages/workers/src/tasks.ts`                                                                                                                                |
| Sixteen compositions and seven pictures, one solver                              | `packages/devtools/src/shots.ts`, `pictures.ts`                                                                                                                                    |
| A lenient resolver for anything a person might type                              | `resolveDestination`, `packages/devtools/src/travel.ts`; `StarCatalog.search` at 0.14–0.30 ms over 16,537 keys                                                                     |
| Dockable panels, a key context that yields to a text field                       | [ADR-0012](../../docs/adr/0012-dockable-panels.md), [ADR-0018](../../docs/adr/0018-the-instrument.md), `isTyping` in `apps/game/src/hud/focus.ts`                                  |
| Dialogs as overlay routes over a mode that stays mounted                         | [ADR-0011](../../docs/adr/0011-application-shell-and-modes.md); `isOverlayPath`, `overlaySurface`, `resolvedLocation` in `apps/game/src/pages/paths.ts`                            |
| An offline shell that leaves cross-origin fetches alone                          | `apps/game/public/sw.js` — same-origin GETs only, the `isShell` guard, an `inertialref-` cache prefix                                                                              |
| The prior art for a lit shoreline                                                | `.scratch/shore.ts`, `.scratch/subsolar.mjs` — uncommitted, and exactly the scan the director needs                                                                                |
| The prior art for the gate: preflight, fit groups, a two-phase load, the SW rule | Mote, `~/Developer/llmcoder` — `src/llm/models.ts`, `src/llm/engine.ts`, `src/ui/ModelPicker.tsx`, `src/sw.js`; a WebLLM app, and the model runtime is the only thing that differs |

Not built: any language model in the tree (no `@huggingface/transformers`,
`onnxruntime`, `ai` or `zod` anywhere in the lockfile); a query over generated
worlds (finding a sea means sweeping stars and generating each system, which is
what `.scratch/oceans.ts` does by hand); an itinerary that the observatory
executes over time; a second constructor of a `Worker`; a chat surface of any
kind; any preference, dialog or settings section about a model.

---

## Where the numbers come from

A **published** figure carries its source. A **measurement** is either from
this repository's own log or taken today from a registry. A **budget** is a
claim a phase measures, and every figure about the model — tokens per second,
frame cost, memory, accuracy — is a budget until phase 0, because nothing here
has run a language model on this GPU beside this renderer yet.

Model sizes are the Hugging Face Hub's file listings for the `onnx-community`
conversions, summed over their external-data chunks, as of the day this page is
written. Package versions are npm's `latest` tags on the same day. The 26 ms for
a synchronous `loadSystem` and the 906 MB heap at the end of a tour are from
`CONTEXT.md` and [perf](perf.md). The catalog search timing is the measurement
in `starCatalog.ts`'s own comment. The download throughput figures are Mote's,
measured on this machine over WebLLM's shards — 670 MB in 27 s, and 5–25 MB/s
observed across sessions — and are the only measurement of a multi-gigabyte
weight fetch into this browser's cache that exists here.

Two figures on this page are **derived** rather than measured and say so: the
number of systems inside a survey radius, and the cost of sweeping them.

---

## 1. Principles

**One desk, two hats, one model.** The person sees a single companion and a
single reply. The director and the narrator are two system prompts and two tool
sets run against one loaded model in one worker, one after the other, both
writing into one message. Two models would be two downloads and two GPU
residents, and the frame has one GPU. The split is real — the director is
greedy, terse and only ever emits tool calls; the narrator is sampled, prose,
and never moves the camera — but it is a split in the prompt, not in the
runtime.

**The model speaks; the code decides where the camera goes.** Language becomes a
_structured intent_ — a name, a query, a scope — and deterministic code turns
that into an address, a sweep, or an itinerary. The model never emits an address
it was not handed, never sweeps a catalog, never computes a framing. This is
what makes the director testable without a model (every resolver is pure), the
model swappable without a rewrite (the tool surface is six small schemas), and
the failure mode legible: a wrong move is a wrong _name_, visible in the action
line, not a wrong number buried in a pose.

**The companion holds the planetarium's controls and nothing else.** The verbs
it can call are the ones the Camera, Presets, Ground and Time panels already
expose, and the guard is the one the planetarium already has: `world.stateHash()`
before and after a session of asking, with the clock paused, is equal. No
teleport, no `shot`, no `land`, no save, no entity. It has no verb in flight
mode because it does not exist there.

**Numbers come from the record.** Every physical quantity the narrator states
is a fact from the dossier of the body on screen, handed to it in the prompt.
What the model knows on its own — that Cassini flew through Enceladus's plumes,
that Titan's lakes are methane — is _context_, and it is licensed only for a
body whose provenance is `observed`: Sol's hundred and twenty-nine, and the 702
catalog planets. A `projected` world is a projection and the narrator says so,
in the universe's voice ([ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md)):
"no probe has flown here", never "the generator". A test greps for the engine's
vocabulary, the same way `dossier.test.ts` does.

**The Record register, in text, in the reading room.** This is the decision that
belongs to the bible. [world](../../docs/design/world.md) lists _a narrator_
under what is deliberately absent, citing tonal rule 2 — awe is never announced
— and lists _NPCs to talk to_ beside it. Both rules are about the game: a
character in the cockpit saying how the gas giant should feel. The planetarium
is [the mode with no ship](../../docs/design/planetarium.md#the-one-idea), a
reading room for the same data the game is built on, and a reading room has a
desk. The companion is that desk: it speaks in the **Record** register — dry,
figures first, provenance attached — never in Correspondence, and it is held to
rule 2 mechanically: a test fails on "beautiful", "breathtaking", "majestic",
"awe" and an exclamation mark anywhere in its prompts or its evaluated output.
It appears in the planetarium and nowhere else. The amendment this asks of the
bible is one row and one sentence — _a narrator_ stays absent from the game, and
planetarium.md gains "the desk" under its tools — and the wording is proposed in
phase 5 for a decision, not made here.

**Experimental, behind a dialog that says what will happen, and the rig never
pays for it.** The default model is 2.7 GB and the feature is a preview of a
component whose answers are checked for tone and for figures but not for truth
beyond the record. So it says so: the panel is labeled _Experimental_, and
nothing downloads until a person has read a dialog that states the size, the
source, where the bytes will be kept, what leaves the machine and what the
device can hold, and has pressed the one button on it — and then watched the
download and the load happen in that same dialog rather than behind a spinner.
The boot preload census does not know the companion exists; a driven boot under
`?presentation=occluded` never loads it; CI never touches weights. The game
without it is the game as it stands, and § 7 is the gate in full.

**The cache is the platform's, on disk, and it is asked to stay.** Weights live
in the browser's Cache Storage under this origin — the on-disk cache the runtime
reads natively — with persistent storage requested so a 2.7 GB bucket is not
best-effort, and a settings row that shows what is held and deletes it. A second
download is the failure this principle exists to prevent.

**Testable without the model, and the model tested without the browser.**
Everything that decides — the query matcher, the sweep, the itinerary composer,
the brief, the resolvers, the tone grep, the fit classification, the cache
check — is pure TypeScript in `pnpm test`. The model itself is evaluated by an
opt-in script against fixtures, in Node or through the driver, and its scores
are written into this page. The AI SDK's mock language model stands in for the
real one in the transport's tests.

---

## 2. The shape

The layer rule decides where each half lives.
[`pnpm graph`](../../scripts/check-graph.mjs) forbids any third-party runtime
dependency under `packages/`, so the model runtime, the AI SDK and its schema
library cannot go below `apps/`. Everything that _does not need them_ can, and
should, because that is where the tests are cheap.

| Half        | Lives in                           | Holds                                                                                                                                                                                | Depends on                                                                               |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Pure**    | `packages/devtools/src/companion/` | `WorldQuery` and its matcher, `findWorlds`, `composeTour` → `Itinerary`, `brief(dossier)`, `resolveNamed`, the two prompts as strings, the evaluation fixtures                       | `universe`, `workers`, the rest of `devtools`; nothing third-party                       |
| **Runtime** | `apps/game/src/companion/`         | the worker, the provider, the preflight and the cache check, `CompanionTransport`, the six tools and their executors, `TourRunner`, the dialog, the panel, the preferences, `ir.ask` | `@browser-ai/transformers-js`, `@huggingface/transformers`, `ai`, `@ai-sdk/react`, `zod` |

`devtools` is layer 6 and already depends on every other package; the pure half
is a directory in it rather than a layer 7, because a package whose only job is
to be imported by one app is a package for the sake of a package. It moves out
the day a second consumer appears — the headless runner wanting `ir.tour`
without a browser is the likely one.

**One turn, in order.** A message arrives from the panel; the transport does
the following and writes everything into a single assistant message:

1. **The fast path.** If the whole message is something `resolveDestination`
   accepts — an address, `Titan`, `HIP 71683` — the camera moves through
   `observatory.focus` and the model is not consulted for the move. The narrator
   still speaks. A bare name is the commonest thing anyone will type and it costs
   0.3 ms, not four seconds.
2. **The director pass.** `streamText` with the director prompt, the six tools,
   greedy decoding, a hard ceiling of 160 output tokens and three steps. Every
   tool call is executed against the live harness as it arrives; each move
   writes a `data-move` part — the Record-register line `→ Titan · portrait`.
   The director's own prose, if it produces any, is discarded unless it called
   `clarify`, whose argument becomes the reply and ends the turn.
3. **The narrator pass.** `streamText` with the narrator prompt, the brief of
   whatever is now on screen, the results of the moves, and the last eight turns
   of conversation; sampled, streamed, 220 tokens at most. Its text parts
   stream into the same message under the action lines.
4. **A tour keeps going after the turn ends.** An itinerary is a `data-tour`
   part with a current stop, and each stop the runner reaches triggers a
   narrator pass of its own, appended as a new text part — one assistant
   message, several paragraphs, arriving over minutes.

The two passes share one model instance and one worker, so they serialize; the
KV cache is not shared between two prompts, so each pass pays its own prefill.
That is the cost of two hats and § 6 budgets it.

---

## 3. The director

**Six tools, and every argument is a name or an enum.** Addresses never appear
in a schema; the executors resolve them.

| Tool      | Arguments                                                                                                                  | Executor                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `show`    | `name`                                                                                                                     | `resolveNamed` → `observatory.focus`; `StarCatalog.search` for a star, `findBody` by name inside the loaded system |
| `find`    | a `WorldQuery` — host class, body kind, sea, shore, rings, habitable, locked, temperature band; `radiusLy` from the ladder | `findWorlds`, nearest first; the first match is focused and the rest are listed in the reply                       |
| `frame`   | one of the sixteen composition ids or seven picture ids                                                                    | `observatory.compose` or `harness.preset`                                                                          |
| `stand`   | a survey site id, or `lit-shore`                                                                                           | `observatory.stand` with the site; `lit-shore` runs the day-side shoreline scan                                    |
| `tour`    | `scope`: a system or body name; `include`: `moons`, `planets`, `rings`, `all`                                              | `composeTour` → `TourRunner.start`                                                                                 |
| `time`    | `warp`: a step on the ladder `1, 5, 25, 100, 1000, 10000, 100000`; or `pause`                                              | `harness.timeWarp` / `pause` — the Time panel's own verbs                                                          |
| `clarify` | `question`                                                                                                                 | ends the turn with the question as the reply                                                                       |

The model is told, in its prompt, the names of the bodies in the loaded system
and the nearest twenty stars — a few hundred tokens — so that "Titan" and
"Proxima" are strings it has seen rather than strings it recalls. It is told
nothing else about the universe. It cannot force a tool (`toolChoice` is
unsupported by the provider and warned), so a turn with no tool call is handled
as a clarification, never as silence.

**The query vocabulary.** A `WorldQuery` is a record of optional predicates, and
the matcher is a pure function of a `Body`, its `Star` and its distance:

| A person says                     | Predicate                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| red dwarf / orange star / sunlike | `star.spectralClass` in `M` / `K` / `G`                                                                                         |
| water world, ocean, sea           | `body.surface.seaLevel !== null`, and the body is `rocky`, `ice` or `moon`                                                      |
| shoreline, coast, beach           | sea, and land: `seaLevel` strictly inside `(0, 1)` — a sea that covers the whole relief has no shore; `coastWidth(surface) > 0` |
| gas giant with rings              | `kind === 'gas-giant'` and `appearance.rings !== null`                                                                          |
| habitable, temperate              | `isHabitable(star, elements)`, the `HABITABLE_INSOLATION` band                                                                  |
| frozen / scorched                 | `equilibriumTemperature` below `FROST_POINT` (170 K) / above 600 K — a band the prompt states in words and the schema in kelvin |
| tidally locked, eternal day       | `tidallyLocked(body)`                                                                                                           |
| somewhere I can land              | `isLandable(body)`                                                                                                              |

Every predicate reads a field the record already carries; none is invented for
the companion. "Earth-like" is deliberately not a predicate: it is a bundle of
three of these and the model is told to spell it out.

**The sweep is bounded by a ladder and ordered by distance.** `systemsWithin`
returns stubs sorted by id for purity; the finder re-sorts by distance and
generates in that order, so the nearest match is known the moment the sweep
passes it and the first result returns before the sweep ends. Radii are the
catalog panel's own — 5, 10, 25, 50 ly — and the default is 10. Generation
runs where the data is, in a `universe.findWorlds` task on the existing pool:
it takes the query and a list of stubs, generates each system, matches, and
returns only the matching bodies with the fields the reply needs. The task is
cancellable through `TaskContext.cancelled` and a second question cancels the
first. `surveySystemTask` is left at version 2; it answers a different question
and its response carries neither `seaLevel` nor a temperature.

Derived, with the derivation shown: within 25 ly the catalog is complete and the
RECONS census gives about 260 systems inside 10 pc, so roughly **120 systems**
inside 7.7 pc; at 26 ms each that is about **3 s** on one thread. At 50 ly the
procedural fill at 0.1 star/pc³ over 15,000 pc³ is about **1,500 systems** —
**40 s** on one thread, **7 s** across six workers, and [perf](perf.md) records
that a worker's runs are 5–10× the Node baseline for reasons still unexplained,
so 50 ly is offered and never the default. A match set is cached for the session
under `(seed, catalog version, query)` and nowhere else — a generated result is
regenerable and does not go in a save.

**A lit shore, not a shore.** `surveySites` already finds `shore` — where the
land crosses the sea — but it finds it anywhere on the body, and half the time
that is the night side, where a planetarium shows a black frame. The director's
`lit-shore` promotes `.scratch/shore.ts` into `packages/universe`: rotate the
star direction into body-fixed axes, sweep a grid of a few degrees around the
sub-solar point for sign changes of `elevationAt − seaDatumElevation`, and
return the nearest crossing with the bearing from sea to land, so the stance
faces the water with the sun behind the camera. Sunset is a composition already;
this is the daylight case, and [the standing rule](../../CLAUDE.md) that terrain
is judged in daylight is what makes it the default for "show me a shoreline".

**Decoding is greedy and the ceiling is low.** `temperature: 0` maps to
`do_sample: false` in the provider, which is what makes a fixture reproducible on
one machine; `maxOutputTokens: 160`, because the provider's default is 4,096
and a runaway small model at that ceiling is a minute of GPU; `stopWhen` at
three steps, because a `find` followed by a `stand` is two and nothing legitimate
is four. Thinking is off. Whether it should be on for the director alone is a
phase-0 measurement, not a setting.

---

## 4. The tour

**An itinerary is data, and the observatory executes it.**

```ts
interface Itinerary {
  title: string
  stops: readonly Stop[]
}
interface Stop {
  address: string // canonical, from the composer
  framing:
    | { kind: 'compose'; id: string }
    | { kind: 'picture'; id: string }
    | { kind: 'stand'; site: string }
  dwell: Seconds // wall seconds, presentation only
  cue: string // what the narrator is asked to speak to at this stop
}
```

`composeTour(system, scope, include)` is a pure function of the loaded
`StarSystem` and returns the same itinerary every time: the primary at
`portrait`; its rings, where `rings !== null`, at the `the-rings` picture for
Saturn and `backlit` elsewhere, because a thin ring is brightest from behind
([rings](rings.md)); then its moons in `orbitalOrder`, the largest four by
radius at `portrait` and the rest skipped, each with a cue naming what is
distinctive in the record — the only moon with an atmosphere, the one with a
sea; then `far-crescent` on the primary as the way out. A system-level tour is
the star at `wide`, then the planets in `orbitalOrder` at `portrait`, dwarfs
included and rubble excluded, on the same rule the orbit traces use. Dwell is
12 s at a primary and 8 s at a moon, wall clock, tunable from the panel and
irrelevant to any canonical state.

**The runner is a presentation object driven by the frame.** `TourRunner`
advances with the same `dt` the observatory's `sample(dt)` takes, so it eases
while paused the way a fly-to does. At each stop it calls the framing verb,
waits until `status().travelling` is false, starts the dwell, and on expiry
moves on; on arrival it raises `stopReached`, and the transport answers with a
narrator pass whose cue is the stop's. It pushes a presentation stance for the
duration — labels at the eighteen-name step, orbit traces on the subject's
siblings, which is the default scope and needs no `all` — and releases it on
the way out, so the panels a person had arranged are exactly where they were.

**The person is always in charge.** Typing anything pauses the tour; `next`,
`back`, `pause` and `end` are buttons on the tour card and go through the action
registry like every control; a `show` or `frame` from the director while a tour
is paused is an ordinary move and the tour resumes from its next stop when
asked. Ending a tour is `TourRunner.stop`, which releases the stance and leaves
the camera where it is — the way `stopCutscene` hands the ship back.

**Speeding up the moons is the Time panel's verb.** "Make the moons move" is
`time({ warp: 1000 })`, and the reply reports what was _delivered_:
`achievedTimeScale` against `timeScale`, because a coasting ship takes warp in
full and a thrusting one is capped at 1,920 simulated seconds per second
([ADR-0025](../../docs/adr/0025-the-rails.md)). The narrator is handed both
numbers and says the true one. A tour that changed the warp restores it when it
ends, through the same verb.

**Why not a cutscene.** ADR-0010's script is a function from a frame number to a
pose, authored in screen terms, reproducible to the frame and checked for hull
clearance. A tour is interactive — it stops when you talk to it, it moves on
when you ask, its dwell is a preference — and a person's interruption is not a
frame number. The itinerary could be compiled into a `CutsceneScript` and played
in cinema, and that is a seam in phase 6 rather than the design.

---

## 5. The narrator

**Input is the brief.** `brief(dossier, observer)` serializes the record of the
body on screen into two or three hundred tokens in the Record register — each
group's measured facts as `label: value (note)`, the pending rows reduced to a
count and two examples with their reasons, the provenance stated in the first
line, then the observer's own facts: altitude, phase, fill, whether the camera
stands or orbits. The moves the director made this turn follow, as the same
action lines the person saw. Then the last eight turns. Nothing else.

**The prompt's rules are the bible's rules.**

- Figures come from the brief. A quantity the brief does not carry is "not
  measured", with the reason the record gives.
- For an `observed` body, what is known beyond the record — missions, discovery,
  named features, history — is welcome and is marked as such in a sentence, not
  a citation.
- For a `projected` body, the world is a projection worked out from its star,
  and nothing has been there. No spacecraft, no mission, no history.
- The universe's voice: never `generator`, `procedural`, `seed`, `noise`,
  `engine`, `render`, `this build`.
- Rule 2: no sentiment, no superlatives about beauty, no exclamation. What is
  large is stated in kilometers.
- Sentence case, American English, three to six sentences, the figure before the
  adjective.

**Two mechanical checks, one measured figure.** `companion.test.ts` greps both
prompts and every fixture output for the banned vocabularies above and fails on
a hit, the way `dossier.test.ts` guards the record's reasons. A second test
extracts every number-with-unit from an output and requires each to appear in
the brief that produced it, to the rounding the brief used — the "plausible
number" [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md) rejects,
rejected again at the mouth. And a **Sol evaluation** of thirty questions with
published answers — Titan's surface pressure, what Cassini found at Enceladus,
when Voyager 2 passed Neptune — is scored per model and the figure lands in
this page. That figure decides one thing: whether a vendored file of sourced
sentences per Sol body (`packages/universe/src/solar/notes.ts`, a paragraph
each, cited) joins the brief for observed bodies. It is the fallback for a
model whose recall is not good enough to be trusted, and it is declined until
the measurement says so, because it is also a second copy of facts the model
either knows or does not.

**What the narrator is not.** It has no tools. It cannot move the camera, warp
the clock or search the catalog. A question that needs a move — "and what
about its largest moon?" — is a director question, and the transport routes
every message through the director first, so the narrator only ever describes
where the camera already is.

---

## 6. The model, the runtime and the worker

**The stack.** Transformers.js's own documentation carries a Vercel AI SDK
integration, and that is the higher-level wrapper: `@browser-ai/transformers-js`
turns a model id into an AI SDK `LanguageModel`, so `streamText`, `tool`,
`stopWhen`, `useChat` and `ChatTransport` are the API and the model is a
provider. Versions on the day of writing, all installed in `apps/game`:

| Package                       | Version | Note                                                                                 |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `@huggingface/transformers`   | 4.2.0   | ONNX Runtime Web 1.26 underneath; WebGPU device                                      |
| `@browser-ai/transformers-js` | 3.0.2   | peers `ai ^7`, `@huggingface/transformers ^3.7 \|\| ^4`; 2.x is AI SDK v6, 1.x is v5 |
| `ai`                          | 7.0.92  | `streamText`, `tool`, `stepCountIs`, `createUIMessageStream`, `ChatTransport`        |
| `@ai-sdk/react`               | 4.0.95  | `useChat` with a custom transport; peers React 19                                    |
| `zod`                         | 4.5.4   | tool input schemas; `ai` peers `^3.25 \|\| ^4.1`                                     |

What the provider does and does not do, read from its source: `temperature: 0`
becomes greedy decoding; `maxOutputTokens` maps to `max_new_tokens` and defaults
to 4,096, or 8,192 with thinking; `enableThinking` is a provider option and off
by default; `toolChoice`, `stopSequences`, `seed` and `responseFormat` are
unsupported and warned. Tools go into the chat template through
`apply_chat_template({ tools })`, so the model sees them in its own trained
format. **Tool calls are parsed after generation ends, not streamed**, so the
director's pass is silent until it is done — the panel shows a working state,
and the narrator is the part that streams. Abort goes through an
`InterruptableStoppingCriteria` and reaches the worker as an `interrupt`
message; a person's next message aborts the pass in flight. Load progress
arrives per file — `initiate`, `download`, `progress`, `done`, then one `ready`
for the session — and the provider aggregates it to a single 0–1 through
`initProgressCallback`, with `rawInitProgressCallback` for the per-file events
the dialog in § 7 draws.

**The model.** Measured from the Hub today, `q4f16` unless stated:

| Model                                        | Weights  | Role                                                                                                                        |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `onnx-community/Qwen3-4B-Instruct-2507-ONNX` | 2,756 MB | **The default.** The non-thinking instruct revision; three external-data chunks, so `use_external_data_format: true`        |
| `onnx-community/Qwen3-4B-ONNX`               | 2,702 MB | The thinking-capable 4B, for the phase-0 comparison of thinking on the director's pass rate                                 |
| `onnx-community/Qwen3-1.7B-ONNX`             | 1,360 MB | The fallback offered on a machine that cannot hold the 4B                                                                   |
| `onnx-community/Qwen3-0.6B-ONNX`             | 543 MB   | The smoke-test model for the transport and the worker; never a default — too small to hold a tool schema and a name at once |
| `onnx-community/LFM2-1.2B-Tool-ONNX`         | 828 MB   | A director-only candidate if the 4B's pass rate disappoints and the two hats ever become two models                         |

The 4B is the floor for the job. A model that hears "a shoreline with a red
dwarf" has to hold six schemas, twenty star names and a system's bodies in
context and emit one well-formed call; a 0.6B model does that by luck, and the
smaller models are on the table for the worker's plumbing, not for the person.
The cost of the floor is stated in the dialog: 2.7 GB once, kept on disk, and a
machine that can spare about 4 GB of memory for it. The picker files the 1.7B
under what a smaller machine can hold, and a failed load of the 4B — WebGPU
adapters differ in `maxBufferSize`, and a 2.7 GB model is the case that finds
out — is a reason to offer the smaller one, not an error.

**The worker is the second constructor in the one file.** The rule is that no
`Worker` is constructed outside `apps/game/src/engine/browserWorker.ts`, and the
reason is that tasks there are typed, versioned, dispatched and instrumented by
one owner. The pool cannot host a model: every worker in it is constructed
eagerly, runs the same registry and is chosen by whoever is idle, so a model
loaded into one would be absent from the other seven and resident eight times
over if loaded into all. So `browserWorker.ts` gains `createCompanionWorker()`,
a single long-lived module worker running `TransformersJSWorkerHandler`, owned
by the companion host and disposed with the session — and the rule's sentence
becomes "two constructors, one file", which is the rule as it stands with its
reason intact.

**The GPU is shared, and that is the phase-0 measurement.** ONNX Runtime Web
opens its own `GPUDevice` on the adapter Three's renderer is using, and a decode
loop is thousands of small dispatches the compositor has to interleave with the
frame. Budgets, all measured on the perf rig at 1600×900 DPR 1 before anything
ships:

| Figure                                      | Budget                               |
| ------------------------------------------- | ------------------------------------ |
| Cold download, 4B                           | stated in the dialog; egress is R2's |
| Warm load from the cache to first token     | **6 s**                              |
| Prefill, 1,200-token prompt                 | **1.5 s**                            |
| Decode                                      | **20 tok/s**                         |
| Director pass, end to end                   | **4 s**                              |
| First narrator token after the director     | **6 s** from the message             |
| Frame time while decoding, against idle     | **≤ 1.5×**                           |
| JS heap added by the host (weights are GPU) | **≤ 150 MB**                         |

If the frame budget fails there is no clever fix on this side of ONNX Runtime:
the options are a smaller model, a lower ceiling on tokens, or not decoding
while a fly-to is easing — the runner knows when it is travelling, and a pass
can wait for `travelling === false`, which is also when there is something to
describe.

**Where the bytes come from is § 7.** In production, R2 on its own host; in
development, a local mirror, else the Hub. ONNX Runtime's own `.wasm` and worker
glue default to a CDN and are pointed at bundled copies through
`env.backends.onnx.wasm.wasmPaths`, so the only network request the companion
makes at runtime is for weights, once.

**No fallback to WebAssembly.** A 4B model on the CPU is not a companion, and a
fast WASM path needs threads, which need COOP/COEP, which
[hosting](../../docs/hosting.md#cross-origin-isolation-is-a-door-that-is-currently-open)
keeps closed for a reason. A browser without WebGPU is told so by the preflight
in § 7, in the Record register, and offered nothing else.

**Two preferences, both in `state/preferences.ts`, in a `companion` group**:
`companion.consented`, the fact that a person pressed the button in the dialog,
and `companion.model`, the id. Nothing else about the companion persists in a
preference; the weights are the cache's business (§ 7), and the conversation is
session state that ends with the session, because a chat log is not a save and
the Almanac is the record a person keeps.

---

## 7. The gate: the dialog, the download, and the cache on disk

**Experimental, and labeled so wherever it is met.** The panel's header carries
_Experimental_ beside its title; the dialog opens with the word; the settings
section repeats it and says what it means in the Record register — a model that
runs on this machine, whose answers are checked mechanically for tone and for
figures against the record and for nothing else, that can be removed from this
browser in one press, and that nothing else in the game depends on. The menu's
mode card is unchanged: the planetarium is the planetarium, and the desk is a
panel in it.

**Nothing is offered that the machine cannot run: the preflight.** Before the
dialog offers a button it asks the browser three questions, in the order Mote
asks them, because that order is the one a person can act on:

1. `navigator.gpu` is present. Knowable before the first paint. Absent, the
   panel's empty state says so — Chrome 113+, Edge 113+, Safari 18+ — and offers
   nothing. There is no degraded mode to fall back to and the copy does not
   pretend there is.
2. `requestAdapter()` returns one. A null adapter is a virtual machine, a remote
   desktop or a blocklisted driver; the wording points at `chrome://gpu`, which
   is the only place the reason is written. `requestAdapter` rejects rather than
   resolving null on some drivers, so it is wrapped.
3. The adapter's `features` has `shader-f16` and its `limits.maxBufferSize`
   exceeds the largest weight chunk. Every `q4f16` build needs half-precision
   shaders, and a GPU without them fails deep inside the load as a shader
   compile error rather than at the door; the 4B's chunks are each about 1 GB.

Then a budget. WebGPU exposes no memory figure on purpose — it is a
fingerprinting surface — so what the device can hold is inferred:
`navigator.deviceMemory` (Chrome only; the spec caps the report at 8 GB;
absent, assume 4) at three quarters, less the game's own resident figure, which
[perf](perf.md) puts at 906 MB of heap at the end of a tour before the
renderer's textures. The dialog states the inference _as_ an inference — "this
device is estimated to spare about 4.3 GB" — and each model is filed under it:
**fits**, **tight** (over the estimate but inside a 1.5× headroom, because the
estimate is one), **over**, or **blocked** (no `shader-f16`, or a chunk larger
than the buffer limit). The picker lists all four groups with the last two
disabled. A menu that silently omits the 4B is less honest than one that shows
it grayed with the reason beside it. `classifyFit` is a pure function of a model
record and a device profile and is tested as one.

**The dialog is an overlay route.** [ADR-0011](../../docs/adr/0011-application-shell-and-modes.md):
a dialog is a URL. `/companion` joins `isOverlayPath`, takes its own
`overlaySurface`, opens from the panel through `overlayState` so the planetarium
stays mounted behind it — the observatory keeps its target and the dock its
layout — and closes through `useOverlay`. The `dialog` key context takes the
keyboard from the mode, so `Escape` closes it and nothing typed reaches the
camera. It never opens itself: the panel's empty state is one sentence and a
button that opens it. Its rows, in order, in the Record register:

| Row                          | Says                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What this is**             | Experimental. A model that runs on this machine's GPU, inside this tab. It moves the planetarium's camera and reads the record in text.                                                                                                      |
| **What will happen**         | `2.7 GB` downloads once from `<host>` — the figure from the manifest, the host named — into this browser's cache on disk. Then the weights go onto the GPU, about `N` s the first time (a phase-0 figure). The panel opens when it is ready. |
| **Where it is kept**         | Cache Storage on this disk, under this site. Persistent storage is requested so the browser does not evict it. It can be deleted from Settings › Companion. `X used of Y` · `persistent` or `best effort`.                                   |
| **What leaves this machine** | The request for the weights. Nothing typed here, and nothing on screen.                                                                                                                                                                      |
| **What it needs**            | WebGPU with `shader-f16`; about `Z` GB of memory to spare. Detected: `<vendor · architecture> · shader-f16 · ~4.3 GB estimated`.                                                                                                             |
| **Model**                    | The picker, filed by fit, the default preselected; each row with its size and whether it is already in the cache.                                                                                                                            |
| **The button**               | `Download 2.7 GB` — or `Load` when every file is already in the cache, and the download row says so.                                                                                                                                         |

A cold load of `/companion` with no background renders, the way `/settings`
does, and its button leads to the planetarium with the panel open.

**The progress indicator is the dialog's second state.** After the press the
same dialog replaces its rows with a bar and a readout and stays on screen until
the model is ready or the person cancels. Three phases, named for what is
happening, because the phase is the point: the runtime's own progress sentence
buries the two facts that matter — which file, and whether the bytes are still
arriving or already going onto the GPU — and Mote's readout exists to surface
exactly those.

| Phase                    | Readout                                                                                                                  | Source                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fetching**             | `file 2 / 7 · 812 MB / 2,756 MB · <host> → browser cache`, and an estimate of the remainder from the first seconds' rate | the per-file `progress` events, summed; the estimate is labeled one. Mote measured 5–25 MB/s here, so 2.7 GB is two to nine minutes                    |
| **Uploading to the GPU** | `browser cache → GPU`, indeterminate, with elapsed seconds                                                               | from the last file's `done` to the session's `ready`. On a cached model this is the only phase — the cache on disk made visible without a word of copy |
| **Warming**              | one line                                                                                                                 | the provider's one-token generate; then the dialog closes and the panel takes focus                                                                    |

Cancel aborts the session through its `AbortSignal`, which stops the fetches in
flight. The runtime writes a file to the cache only when it is complete, so a
cancelled download leaves whole files and no partial ones, and pressing Download
again resumes at the first file that is missing. Failures are rows in the same
dialog, never toasts: quota (`QuotaExceededError` — the storage line, and what
would have to be freed), network (the file it stopped at, and a retry), and a
poisoned entry — an HTML shell stored where a JSON was expected, which is how a
misrouted request fails with `Unexpected token '<'` on every later load. The
loader deletes the entry and retries once; `public/sw.js`'s `isShell` guard
exists on this origin for the same failure in the other cache.

**The cache is the web platform's, on disk.** Transformers.js reads and writes
the Cache API natively — `caches.open(env.cacheKey)`, then `match` and `put`
per file — so the weights land in Cache Storage under this origin, on disk,
quota-managed, with no second implementation between the runtime and the bytes.
Four rules make it a cache a person can trust rather than a download that
happens to persist:

- **The bucket is named for what it holds.** `env.cacheKey` is set to
  `inertialref-companion` rather than the runtime's default `transformers-cache`,
  so a person inspecting Application › Cache Storage can tell whose 2.7 GB it
  is — and so the service worker's `activate` sweep, which deletes buckets under
  its own `inertialref-` prefix that are not the current build's, is written to
  leave this one alone by name. That exclusion is a test.
- **Persistence is asked for, once, at the press.** `navigator.storage.persist()`
  when the button is pressed — Chrome grants it silently to an engaged or
  installed origin and Firefox prompts — and `persisted()` is read back and
  shown in the dialog and in settings, because a bucket without it is
  best-effort and the failure is a second download nobody asked for.
- **The estimate is shown before the press.** `navigator.storage.estimate()`
  gives usage and quota; the dialog's storage row states both, and refuses the
  download with a reason when the quota would not hold it.
- **"Cached" is a fact the host establishes, and Delete is its inverse.** The
  runtime has no query for it, so the host enumerates `cache.keys()` against the
  model's known file list — `config.json`, `generation_config.json`,
  `tokenizer.json`, `tokenizer_config.json`, the `.onnx` graph and its `_data`
  chunks — and all present is what turns the button into `Load`. The same list
  is what `/settings/companion`'s **Delete cached weights** removes, entry by
  entry, behind a confirm, unloading the model first if it is the one loaded. In
  Node the runtime uses the file system instead (`env.cacheDir`), which is what
  the evaluation script gets for nothing.

Why the Cache API and not OPFS or IndexedDB: the runtime reads the Cache API,
so a custom store (`env.useCustomCache`) is a second implementation to keep in
step; the quota is one pool per origin however it is spent; and ONNX Runtime
loads whole buffers, so the streaming reads OPFS is good at buy nothing here.
Cross-Origin Storage — `experimental_useCrossOriginStorage`, a browser proposal
for sharing hash-addressed weights between origins so two sites do not each hold
a copy — is a seam for the day a browser ships it.

**The service worker must never sit in front of a weight fetch.** A worker
created by a controlled page is controlled, so the companion's fetches pass
`public/sw.js`. It returns cross-origin requests to the network untouched, which
is why the weights must _stay_ cross-origin — the Hub, or R2 on its own host. A
same-origin weight path would fall into its stale-while-revalidate branch and
store a second 2.7 GB in the shell's cache, which is the copy the quota then
evicts first; Mote hit exactly that with a broad runtime-caching rule and wrote
the rule down. The one same-origin exception is the development mirror below,
and the worker's fetch handler gains `/models/` beside `isLive` so it is never
handled either. Range requests are already returned untouched.

**A development mirror, so iterating on a prompt is not a download.** A Vite
middleware serves `./models/` — gitignored, multi-gigabyte, streamed from
outside `public/` so no build ever copies it into `dist/` — and
`env.remoteHost` points at it in development. `pnpm companion:models download
<id>` fills it from the Hub. A production build never reads it, and a test says
`fetch` is never called for it there. A miss answers with a JSON 404 rather than
falling through to Vite's HTML shell, because that fallthrough is the poisoned
cache above. This is Mote's `serveModels` and `pnpm models`, and the reasons
are the same: the Hub is rate-limited, and a person editing a system prompt
should not be paying 2.7 GB for each fresh profile.

**Where the bytes come from in production.** The R2 bucket
[hosting](../../docs/hosting.md#h-8--r2-holds-what-the-repository-will-not-carry)
already keeps for what the repository will not carry, on its own host so the
request stays cross-origin, mirrored by `media:push` with a manifest that pins
the model's revision and the byte count the dialog quotes — the figure on the
button is true because the manifest says so, not because the Hub happens to
agree today. Egress is R2's and free. In development the mirror; failing that,
the Hub.

**A settings section, `/settings/companion`.** The experimental note, the model
picker with its fit groups, the storage line (`X used of Y · persistent`),
**Delete cached weights**, and nothing else. It is where a person goes to take
the 2.7 GB back, and it is the second place the word _Experimental_ is written.

---

## 8. The panel

**A dock panel, closed by default, labeled Experimental.** `companion` joins
`planetariumPanels` in `apps/game/src/planetarium/registry.tsx` in the left
zone under the catalog, `defaultOpen: false`, with a hint that names the model
size. Its header carries _Experimental_ beside the title. It is in the launcher
rail like everything else, becomes a bottom-sheet tab on a phone, and carries
no other chrome the other panels do not have.

**One `useChat`, one transport, one message per turn.** `CompanionTransport`
implements `ChatTransport` over the two passes in § 2, `reconnectToStream`
returns `null` because there is no stream to reconnect to, and the message
parts are the vocabulary:

| Part          | Drawn as                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`        | the narrator's prose, streamed, in the panel's body type                                                                                             |
| `data-move`   | a Record-register line — `→ Titan · portrait`, `→ standing · lit shore · 1.2 km` — muted, before the prose                                           |
| `data-tour`   | the itinerary card: title, stops with the current one marked, `back · pause · next · end`                                                            |
| `data-load`   | the compact form of § 7's readout — one row, `browser cache → GPU · 4 s` — for a later session's warm load, when the dialog has already been through |
| `data-notice` | what the browser cannot do, or what warp was actually delivered                                                                                      |

The words _director_ and _narrator_ appear in source and in this page and never
on screen. The empty state is one sentence saying what the desk is, and one
button that opens the dialog in § 7; the download, its consent and its progress
never happen inside the panel. Raw tool calls are never rendered: a move is a
line, a failure to resolve is a sentence, a `clarify` is the reply.

**Typing never moves the camera.** The input is the same `<Input>` the catalog
uses, and `isTyping(event)` in the keymap store already returns every key typed
into a focused field to the field before a chord is built — that is the one
mechanism and it needs no second. `Escape` blurs. A `companion.ask` action that
focuses the field is registered with no default chord, because `/` is the
catalog's and the choice of a key is a bible decision, and the tour card's four
buttons go through `hud/Action.tsx` so their labels print the live chord if one
is ever bound. A test drives `KeymapStore.handleKeyDown` with the field focused
and asserts `F`, `L`, `Home` and the arrows reach nothing.

**Accessibility is the shell plan's rules plus one.** Streamed text goes into a
polite live region so a screen reader hears a paragraph, not two hundred
tokens; the dialog's progress bar is a `role="status"` region whose text is the
readout, so the phase is announced when it changes; the panel material's
contrast rules in [the shell](the-shell.md) apply unchanged; reduced motion
turns the bar into a number.

---

## 9. Testing, and what the harness can see

**In `pnpm test`, with no model:**

- `worldQuery.test.ts` — properties with `fast-check`: matching is a pure
  function of the body and the star; a query that matches Earth matches Earth on
  every run; widening the radius never loses a result; results are nearest
  first; an empty query matches everything landable and nothing else.
- `composeTour.test.ts` — the same itinerary from the same system every time;
  Saturn's tour is Saturn, the rings, Titan, Rhea, Iapetus, Dione, the crescent;
  a system with no rings has no ring stop; the cap holds.
- `brief.test.ts` — every value in a brief is a fact in the dossier it came
  from; the provenance is the first line; a projected body's brief names no
  mission.
- `companion.test.ts` — the vocabulary greps over both prompts and every
  fixture output; the number-with-unit check.
- `transport.test.ts` — `CompanionTransport` against the AI SDK's mock language
  model: a scripted tool call becomes a `data-move` and a focused target; a
  turn with no tool call becomes a clarification; an abort mid-pass leaves the
  camera where the last completed move put it.
- `preflight.test.ts` — `classifyFit` over a table of device profiles and model
  records: no `shader-f16` blocks every `q4f16`; a chunk over `maxBufferSize`
  blocks; the 4B is `tight` on a device reporting 4 GB and `fits` at 8; the
  budget is the stated arithmetic and nothing else.
- `cache.test.ts` — the cache check against a stubbed `caches`: all files
  present is `cached`, one missing is not; Delete removes exactly the model's
  entries and nothing in the shell's bucket; the service worker's `activate`
  sweep, executed against stubbed globals the way `serviceWorker.test.ts`
  already does, leaves `inertialref-companion` standing; a request for
  `/models/…` is never handled.
- `observatory.test.ts` gains the guard: `world.stateHash()` equal before and
  after `ir.ask` has run every tool once with the clock paused.

**Opt-in, with the model — `pnpm companion:eval`.** Forty director utterances
with their expected tool calls, thirty Sol questions with published answers,
and the tone grep over everything the model said, run against a named model
either in Node through `onnxruntime-node` on the CPU or in the browser through
the driver, and the two tables land in this page. It is not in `pnpm check`:
it needs 2.7 GB and minutes, and a gate that downloads a model is a gate
nobody runs.

**The harness sees all of it**, because a feature the debug tooling cannot
inspect is not done:

| Verb                             | Returns                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `await ir.ask(text)`             | `{ moves, text, toolCalls, timings }` — the whole turn, without the panel                                                                |
| `ir.tour(scope, include?)`       | the itinerary, started; deterministic and model-free                                                                                     |
| `await ir.findWorlds(query, ly)` | the matches, nearest first, with the sweep's count and duration                                                                          |
| `ir.companion()`                 | the preflight verdict and device profile, model id, cached or not, loaded, warm, tokens per second on the last pass, the last tool calls |

`ir.help()` lists them. `node scripts/drive.mjs --js "await ir.ask('show me
a shoreline')" --cast 240` is the visual check, and the frame-time figure while
decoding is `--js "await ir.ask(...)"` beside the perf rig's sampler.

---

## 10. Declined, with the reason

- **WebLLM.** Faster decode on the same GPU, and `@browser-ai/web-llm` wraps it
  with the same AI SDK surface; it is also what Mote runs, so the gate's prior
  art is already written against it. Declined because it is a second runtime
  with its own model format and a per-model compiled library; Transformers.js's
  ONNX covers text, embeddings and transcription with one runtime, and the ask
  was Transformers.js. The provider is a one-line swap if the phase-0 decode
  figure says otherwise, and the dialog, the cache and the preflight do not
  change.
- **Chrome's built-in Prompt API.** `@browser-ai/core` wraps Gemini Nano.
  Declined: one browser, a model chosen by the vendor and changed without
  notice, and no control over the tool format. Same seam.
- **A server-side model.** A Workers AI or Claude call would be faster and
  smarter and the transport would not change. Declined for now: the game is
  solo-offline first, [hosting](../../docs/hosting.md) keeps the server's job
  small on purpose, and every question a person asks would leave their machine
  — which the dialog's "what leaves this machine" row would then have to say.
  The provider seam is kept exactly so this stays a decision and not a rewrite.
- **Two models.** A 1.2B tool model for the director and the 4B for the
  narrator. Declined: two downloads, two GPU residents, and the frame has one
  GPU. LFM2-1.2B-Tool is in the table for the day the 4B's pass rate says
  otherwise.
- **Letting the model call `ir` directly.** A `run(js)` tool would be six
  schemas fewer and one prompt saying "do not teleport the ship". Declined: a
  prompt is not a guard, and the one thing the planetarium promises is that it
  writes nothing.
- **OPFS or IndexedDB for the weights.** § 7. The runtime reads the Cache API; a
  custom store is a second implementation over the same quota.
- **Downloading automatically, at boot, in the preload census, or from the
  panel without the dialog.** § 1 and § 7. A 2.7 GB download is a thing a person
  is told about first, in full, and watches.
- **Compiling a tour to a cutscene.** § 4. A seam, not the design.
- **Voice.** [audio](../../docs/design/audio.md): none. The twelve annunciator
  strings are an instrument; a companion reading paragraphs aloud is a
  performance.
- **Retrieval over the documentation, or embeddings over the catalog.** The
  record is structured and the brief is built from it directly; the catalog's
  search is already an index at a third of a millisecond. Embeddings return the
  day a person types "the one with the hexagon at its pole" and the resolver
  cannot answer.
- **Fine-tuning.** Not until the evaluation says the prompt cannot get there,
  and the evaluation does not exist yet.
- **The companion in flight.** An NPC in the cockpit is what
  [world](../../docs/design/world.md) rules out, and it is right.

---

## 11. Phases

**Phase 0 — the spike.** A `.scratch/` page beside the running planetarium
loads `Qwen3-4B-Instruct-2507` at `q4f16` through the provider in a module
worker and measures every budget in § 6 on the perf rig: cold download rate,
warm load from the cache, prefill, decode, frame time while decoding against
idle, heap; then the same for the thinking 4B with thinking on and off over
twenty director utterances, and for the 1.7B. Nothing ships. Gate: the numbers
are in this page and one model is named the default with a reason, or the frame
budget failed and the page says what that means.

**Phase 1 — the deterministic half.** `packages/devtools/src/companion/`:
`WorldQuery` and the matcher, `findWorlds` with the `universe.findWorlds` task
and its cache, `composeTour`, `brief`, `resolveNamed`, the lit-shore scan
promoted from `.scratch/shore.ts` into `packages/universe`, `TourRunner`, and
`ir.tour`, `ir.findWorlds` on the harness. Property tests as in § 9. Gate:
`ir.tour('Saturn')` walks the Saturn itinerary headlessly through
`observatory.status()` transitions with the state hash unchanged;
`ir.findWorlds({ sea: true, host: 'M' }, 25)` returns nearest first with its
duration measured and written here. Independent of phase 0 and worth landing
first: a tour button is a feature without a model.

**Phase 2 — the host and the gate.** The five packages into `apps/game`;
`createCompanionWorker()` in `browserWorker.ts`; the provider configured with
`remoteHost`, `wasmPaths`, `cacheKey` and external data; the preflight and
`classifyFit`; the cache check, the persistence request and the estimate; the
`/companion` overlay route with its rows, its picker, its button and its
three-phase progress; the two preferences and `/settings/companion` with
Delete; the development mirror and `pnpm companion:models`; the service
worker's two exclusions; `ir.ask` and `ir.companion()`; `CompanionTransport`
with the fast path only. Gate: `transport.test.ts`, `preflight.test.ts` and
`cache.test.ts` green; a real `ir.ask('Titan')` through the driver moves the
camera with the 0.6B smoke model loaded from the mirror; the dialog's stated
byte count equals the bytes the network log shows crossing; a second load of
the same model makes no network request for weights; Delete leaves the bucket
empty and the shell's cache untouched; a boot under `?presentation=occluded`
makes no request for weights.

**Phase 3 — the director.** The six tools and executors, the greedy settings,
the system-names context, the forty fixtures, `pnpm companion:eval`. Gate: the
pass rate on the default model is measured and written here; the hash guard
holds through `ir.ask` over every tool; a `find` at 10 ly returns its first
match inside the phase-1 figure.

**Phase 4 — the narrator and the fused stream.** The second pass, the brief in
the prompt, the per-stop narration on a tour, the two greps, the number check,
the thirty Sol questions. Gate: zero vocabulary hits over every evaluated
output; every number-with-unit traced to its brief; the Sol score written here
with the decision on `solar/notes.ts` it implies.

**Phase 5 — the panel.** The dock panel with its label, the five part
renderers, the tour card, the empty state that opens the dialog, mobile, the
live regions, the keymap test. And the proposed wording for the bible — one row
in world.md's table, one paragraph in planetarium.md's tools — as a diff in the
PR for a decision. Gate: a `--cast` of "give me a tour of the Saturn system"
from a cold panel, dialog included, reviewed frame by frame; the shell plan's
contrast rules hold on the panel and the dialog; typing `F` into the field moves
nothing.

**Phase 6 — seams.** The R2 mirror and its manifest; `solar/notes.ts` if
phase 4 said so; a server provider behind the same transport as a preference
that names where the question goes; Cross-Origin Storage when a browser ships
it; an itinerary compiled to a `CutsceneScript` for cinema; bookmarks from a
tour's stops, once bookmarks exist.

---

## 12. The order it is worth taking

1. **Phases 0 and 1 together.** One needs a GPU and no code; the other needs
   code and no GPU. The tour and the finder are the features a person would use
   most and neither needs a model to be useful.
2. **Phase 2**, because everything after it is blind without `ir.ask`, and
   because the gate is the part of this plan whose shape is already known —
   Mote's preflight, readout and cache rules port with the runtime's names
   swapped in.
3. **Phase 3 before 4.** A director that moves the camera correctly and says
   nothing is a feature; a narrator describing the wrong body is a bug.
4. **Phase 5 last**, because a panel over an evaluated pipeline is a day and a
   panel over an unevaluated one is a week of guessing which half is wrong.

---

## Caveats that shape these numbers

- **Every figure about the model is a budget until phase 0**, and the frame
  cost is the one that can end the plan: nothing on this side of ONNX Runtime
  paces a decode loop against a compositor.
- **The sweep's cost is derived twice over.** 26 ms is a main-thread
  `loadSystem`, which installs frames the finder does not need, and
  [perf](perf.md) measures a worker at 5–10× the Node baseline. The phase-1
  figure replaces both.
- **The memory budget is an inference from a capped, Chrome-only number.**
  `navigator.deviceMemory` reports at most 8 GB and is absent outside Chrome,
  so a 16 GB machine and a 64 GB machine file the models identically, and a
  browser that does not report it is assumed to have 4. The dialog says
  "estimated" because it is, and the phase-0 figures are what turn the headroom
  from a guess into a measured margin.
- **The download throughput is Mote's, on this machine.** 5–25 MB/s across
  sessions, from the Hub, over WebLLM's shards. Another network or another host
  moves the "two to nine minutes" in either direction, which is why the dialog
  estimates from the first seconds rather than quoting a constant.
- **The provider's tool parsing is post-hoc and format-specific.** It works on
  the Qwen chat template's own tool tags; a model whose tokenizer renders tools
  differently may parse to nothing, and the fixtures are what would show it.
- **`ai` moves fast.** The pin is `^7` today and the documentation for the same
  API names both `stepCountIs` and `isStepCount`; the compatibility table in § 6
  is the thing to re-read before an upgrade.
- **Sizes are the Hub's today.** A re-export of a conversion changes them, and
  the R2 manifest pinning a revision is what makes the dialog's number true.
- **Persistence is a request, not a guarantee.** Chrome grants
  `storage.persist()` on heuristics it does not publish, and a browser can still
  clear site data by hand. The `persisted` readout is honest about which state
  the bucket is in; it cannot promise the other.
- **The Sol evaluation grades recall, and recall is uneven.** A 4B model knows
  Titan and may not know Hyperion; the score is a mean, and the notes fallback
  is the answer to its variance, not to its mean.

## Not in this plan, deliberately

Voice in any form; the companion outside the planetarium; commissions, which
[exploration](../../docs/design/exploration.md) gives an authored voice that
this is not; the Almanac; a chat log that persists; translation of the prompts;
multiplayer presence in the reading room; a fallback runtime of any kind;
anything the model would _decide_ about canonical state.

## Reproducing

```bash
# the development mirror: fill it once, from the Hub, into ./models/ (gitignored)
pnpm companion:models download onnx-community/Qwen3-4B-Instruct-2507-ONNX

# phase 0: the spike page beside the running planetarium, measured on the perf rig
node scripts/drive.mjs --url 'http://localhost:5173/planetarium?at=g:milky-way/s:SOL/b:5' \
  --file .scratch/companion-spike.mjs --wait 20000 --js "await ir.profile(8000)" --down

# the deterministic half, no model
pnpm vitest run packages/devtools/src/companion

# the transport, the preflight and the cache, against the mock model and stubbed globals
pnpm vitest run apps/game/src/companion

# the model, opt-in: forty director fixtures, thirty Sol questions, the tone grep
pnpm companion:eval --model onnx-community/Qwen3-4B-Instruct-2507-ONNX

# the gate: the dialog's byte count against the network, and a second load with no weight request
node scripts/drive.mjs --url 'http://localhost:5173/companion' --js "await ir.companion()" --shot gate.png --down

# a tour, watched as the compositor presented it
node scripts/drive.mjs --url 'http://localhost:5173/planetarium?at=g:milky-way/s:SOL/b:5' \
  --js "await ir.ask('give me a tour of the Saturn system')" --cast 600 --down

# a shoreline in daylight, without the model
node scripts/drive.mjs --url 'http://localhost:5173/planetarium?at=g:milky-way/s:SOL/b:2' \
  --js "ir.visit('b:2', { site: 'lit-shore' })" --wait 3000 --shot lit-shore.png --down
```

## Related

- [planetarium](../../docs/design/planetarium.md) — the reading room this
  desk sits in, and the rule it inherits
- [world](../../docs/design/world.md) — the tonal rules and the row this plan
  asks to amend
- [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md) — why every
  number comes from the record
- [ADR-0010](../../docs/adr/0010-cinematic-director.md) — the format a tour
  is deliberately not
- [ADR-0011](../../docs/adr/0011-application-shell-and-modes.md) — why the
  gate is a URL over a mode that stays mounted
- [ADR-0012](../../docs/adr/0012-dockable-panels.md),
  [ADR-0018](../../docs/adr/0018-the-instrument.md) — the panel and the keys
- [hosting](../../docs/hosting.md) — where the weights live in production, and
  the service worker that must not touch them
- [perf](perf.md) — the rig every budget above is measured on
- Mote, `~/Developer/llmcoder` — the preflight, the fit groups, the two-phase
  load readout and the service-worker rule, ported here with the runtime's
  names swapped in
