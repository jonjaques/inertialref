<!--
  House style: STYLE.md. Write in the present tense about what the code does now,
  and in the past tense only about the change itself. Keep the headings; delete the
  comments and any section that genuinely does not apply, saying so in a line rather
  than leaving it empty.
-->

## What changed

<!-- The commit body, in the same voice: why, and specifically why the obvious approach
     did not work. Measured numbers rather than adjectives. -->

## Invariants

<!-- Which of the rules in AGENTS.md § "The rules that actually matter" this change
     touches, and how each still holds. "None" is a legitimate answer and a fast review.
     A new invariant means a bullet in AGENTS.md, a one-liner in .claude/rules/, and a
     row in docs/agents/invariants.md — say which of those landed. -->

## Screenshots

<!-- Encouraged, and close to required for anything visible. A still, a before/after
     pair, or a short capture beats a paragraph describing a frame.

     `/drive` runs the harness: `ir.preset('blue-marble')` for a still — an address, a
     framing and a lens, so the same frame comes back every time — with `ir.chrome(false)`
     and `ir.layers(false)` for the state a plate is taken in. `ir.play()` /
     `ir.seekCutscene()` for a beat. `ir.shot()` teleports the *ship* into a composition,
     which is a different act and changes canonical state. Say what the picture is of and at what scale or frame — a screenshot
     with no caption is not evidence of anything.

     Drag files in, or reference them as ![caption](url). -->

## Verification

<!-- What was run and what it returned, with numbers.

  - [ ] `pnpm check` green
  - [ ] `pnpm sim --self-test` — n/12 capability checks
  - [ ] Regression test added for any defect this fixes, and confirmed to fail without
        the fix
  - [ ] `CONTEXT.md` / ADR updated if something was decided or measured
-->

## Left out

<!-- Anything deliberately not done, and why it is a separate change. Known limitations
     go here rather than being discovered in review. -->
