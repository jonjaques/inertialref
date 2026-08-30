---
name: timeline-audit
description: What the performance-timeline change (ADR-0022, docs/the-timeline) came close to, and the invariant shapes that recur around an instrumentation seam
metadata:
  type: project
---

Findings and near-misses from auditing the timing seam (`packages/shared/src/timing.ts`,
`engine/browserTiming.ts`, ADR-0022). Carry these forward for any diff that adds an
emitter, a level switch, or a new port.

**Why:** instrumentation looks like a determinism risk and mostly is not — the real
defects were in the _mirrors_ and in one label. Spending the budget on `performance.now`
greps is spending it in the wrong place.

**How to apply:** when a diff adds a timing/logging/metrics seam, check the four things
below before reading any emitter.

## The mirror can drift _stricter_ than the canonical rule, and that is worse

The classic shape is a mirror that lags `AGENTS.md`. This one inverted it.
`AGENTS.md` bans `console.timeStamp`/`performance.mark`/`performance.measure` outside
`engine/browserTiming.ts` and bans `performance.` in `packages/*`. Both
`.claude/rules/timing.md` (first bullet) and `docs/agents/invariants.md` compressed that
to "never name a platform timing API outside the sink" — which the same diff violates
eight times with `performance.now()`, including twice in `frameTiming.ts`, **a file
inside that rule's own `paths:`**. An agent opens the file and the rule in context
contradicts the code in front of it.

**The check:** when a rule bullet compresses a canonical enumeration into a category
noun ("a platform timing API", "a host global"), expand the noun and grep it against the
diff. A bolded imperative that is broader than the sentence explaining it is the tell.

## The `paths:` list named the seam, not the call sites — again

Same failure as `feat/the-ground`'s determinism rule. `timing.md` scopes to
`browserTiming.ts`, `frameTiming.ts`, `perfBudgets.ts`, `shared/src/timing.ts`,
`profile.ts`, `scripts/timing.mjs`. Its three most operational bullets — nothing that
allocates outside `if (timer.on)`, a label is an aggregation key so keep the set
bounded, each side of a worker boundary emits only its own numbers — are about
`GameEngine.ts`, `terrainStreamer.ts`, `useTimedFrame.ts`, `workers/{host,pool}.ts` and
`render/{warmup,preload,firstLight,atmosphereLuts}.ts`, **none of which the globs match**
(`apps/game/src/engine/**` and `scene/**` load `rendering.md`; `packages/**` loads
`packages.md`). The rule that records a lesson does not load where the lesson applies.

## The bounded-label rule gets obeyed where it was argued and broken where it was not

`host.ts` moves the region address out of the label into `properties` and writes three
paragraphs about why. Four files away, `atmosphereLuts.ts:102` emits
``timer.measure(`bake ${key}`, …)`` where `key` is `scatteringKey` — a `:`-joined float
composite. Measured: Sol alone yields **9** distinct keys, e.g.
`bake 0.96:0.9:0.68:0.98:0.78:0.45:1:1.016030`, and the module cache never evicts, so the
retained-name set grows with every atmospheric body the session meets.

**The check:** grep every label template in the diff for an interpolation, then ask what
bounds the interpolated value. The author will have argued the case they thought of.

## `?? <literal>` four lines below "not defaulted here"

`profile.ts`'s `TimingPort.droppedFrameMs` docstring says the number is taken from the
host "rather than defaulted here"; `summarizeProfile` is `options.droppedFrameMs ?? 25`,
a hand-copied twin of `perfBudgets.ts`'s `DROPPED_FRAME_MS`. `apps/headless/src/main.ts`
calls it with no options, so `pnpm sim --profile` judges against the literal. Layer order
genuinely forbids the import — which is why the twin needs a _name_ and a comment, not
deletion.

## Where the audit budget actually paid off

- **Mutation-testing the grep guard.** `coreHostApis.test.ts` strips comments with a
  regex. Insert `performance.now();` at the first code column of every line where
  `blanked[i] === lines[i]` (a pure code line), across all 121 package files: 21,025
  mutants, 0 missed. Do not mutate lines that are partly string/template — the harness
  reports false misses because it inserts _inside_ the literal.
- **`@ts-expect-error` as an invariant.** `timing.test.ts` asserts `Span.end` returns void
  with `@ts-expect-error`; widening the return type makes the directive unused and fails
  typecheck. This is the strongest form of "a test that can fail" in this repository.
- **`timingInert.test.ts`** counts `performance.now` calls and asserts _exactly_ two a
  frame off, plus a second test proving the count rises when a sink attaches — the
  second half is what stops the first from being vacuous. Reusable pattern for any
  "costs nothing when off" claim.

## The tree moved during this audit too, as usual

Five files went clean → modified mid-run (`frameTiming.ts`, `profile.ts`,
`docs/adr/README.md`, `CONTEXT.md`, the plan) — a comment-correction pass following the
last commit. None of it resolved a finding. `git status` immediately before writing
remains mandatory. See [[audit-patterns]].
