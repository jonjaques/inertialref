# House style

InertialRef is written in **American English**, in one voice, for three
audiences. This page is that voice. It governs every surface prose reaches —
documentation pages, code comments, plans, pull request bodies, and commit
messages. Follow it for new writing and when editing what is already here.

The imperative half of this page is mirrored as
[`.claude/rules/writing.md`](.claude/rules/writing.md), which carries no
`paths:` and therefore loads at the start of every agent session. The rule has
to be in context before the first comment is written, not after.

---

## Audiences and homes

| Audience                          | Start here                                                        | What belongs there                                                                |
| --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A person who just cloned the repo | [`README.md`](README.md)                                          | What it is, how to run it, what is proven                                         |
| A person learning the system      | [`docs/README.md`](docs/README.md)                                | Vision, architecture, concepts, ADRs, guides, the design bible                    |
| A coding agent                    | [`AGENTS.md`](AGENTS.md), then [`agents/`](docs/agents/README.md) | Invariants, how to work, definition of done. Not product prose, not a build diary |

Keep those piles apart. A concept page is not a session recap. An agent page is
not a design essay. The build log ([`CONTEXT.md`](CONTEXT.md)) is a diary on
purpose — it is not a substitute for either.

A plan is a fourth pile and it lives in `design/`, outside the published tree.
`docs/` is the finished account of what the system does, and a reader who
reaches a page there is entitled to assume the system already behaves that way;
a plan is the one document whose subject is that it does not. Plans are written
in this voice like everything else.

---

## Voice

Write as if you are explaining the system to a skilled colleague who was not in
the room.

- **Lead with the fact or the rule**, then the reason it is that way.
- **Present tense, active voice.** "The renderer reads a snapshot." Not "we then
  made the renderer read a snapshot."
- **Be specific.** Prefer a measured number to an adjective. Prefer a file path
  to "the relevant module."
- **Explain why the obvious approach fails**, when that is the point of the
  page. Do not narrate the session that discovered it.
- **Name things the same way the code names them.** If the type is
  `UniverseVector`, do not call it a "universal vec" three paragraphs later.

Bug history, rejected approaches, and "this must not come back" belong in
[`CONTEXT.md`](CONTEXT.md) or in an [ADR](docs/adr/README.md). Working guides may
cite those pages. They should not retell them.

### Avoid

- Session-speak: "the overlay refactor," "the black-screen class," "which is
  the trap one paragraph down."
- Insider shorthand without a definition. "The twelve" is fine after you have
  said "the twelve capability checks."
- Addressing "the next agent" or "the maintainer" as if they shared the chat
  that produced the file.
- Writing a label in the case you want on screen. Interface copy is title case
  in source; CSS decides what is shouted. See [`DESIGN.md`](DESIGN.md).

---

## Look forward, not back

**The code is what the product does now.** Everything written about it —
comments, guides, plans, rules, pull request bodies — describes the system as it
stands. Not the version it replaced, and not the route taken to get here.

The target is a sentence about a **previous version of the system**, and these
are the tell: _used to_, _previously_, _formerly_, _no longer_, _we then
changed_, _the old approach_, _this was refactored from_, _as of this change_.
Find one, and the sentence around it is almost always deletable whole.

The words themselves are innocent — a body one tick behind the picture "is where
it used to be" and that is a present-tense fact about interpolation, not a
changelog. Read what the sentence is about, not which words it uses.

The reason is not tidiness. A reader who never saw the previous version is the
only reader a file reliably has, and to them a sentence about that version is a
claim they cannot check and cannot act on. It ages into a lie the moment the
thing it contrasts against changes again, and nothing mechanical catches it.

**"Why the obvious thing does not work" is not history.** It is a present-tense
fact about a constraint, and it is the most valuable sentence on the page:

> Presentation happens at `renderTime` — one tick back, plus the interpolation
> alpha. Asking where a body is at `clock.time` aims one tick behind the
> picture, by that body's velocity times up to 15.6 ms: invisible on a planet,
> and 11 and 19 pixels on Phobos and Deimos.

That stays. What goes is the sentence saying when it was found, who found it,
or what the file looked like the day before.

History has three homes, and none of them is a comment:

| What                                             | Where                                       |
| ------------------------------------------------ | ------------------------------------------- |
| A bug that must not come back; what was measured | [`CONTEXT.md`](CONTEXT.md) — `/context-log` |
| A decision and the alternatives it beat          | An [ADR](docs/adr/README.md) — `/adr`       |
| What one change did, and why                     | That change's commit message                |

---

## Code comments

Comments are held to the same standard as the prose, and to one more: they earn
their line or they do not exist.

- **Explain why, and specifically why the obvious thing does not work.** A
  comment that restates the code is worse than no comment, because it is a
  second thing to keep true.
- **Name the failure.** "Registration is idempotent by label, because StrictMode
  does everything twice." A constraint, a number, or a mode that breaks.
- **Match the density of the file you are in.** Do not import a different
  commenting habit into a module that has its own.
- **A comment that has to narrate a change is a commit message in the wrong
  file.** Move it.

---

## Commit messages

Every commit gets a subject and an extended body. Both are prose.

**The subject** is a conventional prefix and then a declarative claim, not a
ticket summary:

```
fix: the share card was a cyan marble
feat(cinematics): the hull was flying backwards, and the camera was inside it
```

Read `git log --oneline -20` before writing one and match what is there.

**The body** says why, and specifically why the obvious approach did not work,
with the measured numbers that settled it. This is the one place a backward
glance is correct — a commit exists to describe a change — so it may say what
the previous behavior was and why it was wrong. It may not use that license to
plant the same sentence in a source comment.

A body that restates the diff was not worth writing. A body that names a
constraint, a measurement, and a rejected alternative is what makes
`git log` worth reading a year later.

Pull request bodies follow the commit body, plus the invariants the change
touches and what was verified. The template is
[`.github/pull_request_template.md`](.github/pull_request_template.md).

---

## American English

Use American spelling and usage: _color_, _center_, _meter_, _license_,
_behavior_, _catalog_, _modeling_, _traveling_, _artifact_, _toward_.

Do not rename files or identifiers in this pass just to match. `catalogue.md`
and `cancelled()` stay until a dedicated rename. Prose follows American English;
code follows the identifier that exists.

Quoted third-party legal text keeps its original spelling.

---

## Page shape

Every page should make its job obvious in the first paragraph. Concept pages
open with the question they answer. Guides open with the task. ADRs open with
the decision.

Link to the canonical home of a topic instead of restating it. Duplication here
rots: the second copy is the one that stays wrong.

When a number is a measurement, say so. When it is a budget, say so. When it is
a guess, it does not belong in these pages until it has been measured or marked
as a playtest value in the design bible.

---

## Related

- [`docs/README.md`](docs/README.md) — the documentation map
- [`docs/agents/README.md`](docs/agents/README.md) — the agent handbook
- [`DESIGN.md`](DESIGN.md) — visual language, including the type scale
