# Documentation style

InertialRef is written in **American English**, in one voice, for three
audiences. This page is the house style. Follow it for new pages and when
editing old ones.

---

## Audiences and homes

| Audience                          | Start here                                                      | What belongs there                                                                |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A person who just cloned the repo | [`README.md`](../README.md)                                     | What it is, how to run it, what is proven                                         |
| A person learning the system      | [`docs/README.md`](README.md)                                   | Vision, architecture, concepts, ADRs, guides, the design bible                    |
| A coding agent                    | [`AGENTS.md`](../AGENTS.md), then [`agents/`](agents/README.md) | Invariants, how to work, definition of done. Not product prose, not a build diary |

Keep those piles apart. A concept page is not a session recap. An agent page is
not a design essay. The build log ([`CONTEXT.md`](../CONTEXT.md)) is a diary on
purpose — it is not a substitute for either.

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
[`CONTEXT.md`](../CONTEXT.md) or in an [ADR](adr/README.md). Working guides may
cite those pages. They should not retell them.

### Avoid

- Session-speak: "the overlay refactor," "the black-screen class," "which is
  the trap one paragraph down."
- Insider shorthand without a definition. "The twelve" is fine after you have
  said "the twelve capability checks."
- Addressing "the next agent" or "the maintainer" as if they shared the chat
  that produced the file.
- Writing a label in the case you want on screen. Interface copy is title case
  in source; CSS decides what is shouted. See [`DESIGN.md`](../DESIGN.md).

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

- [`docs/README.md`](README.md) — the documentation map
- [`docs/agents/README.md`](agents/README.md) — the agent handbook
- [`DESIGN.md`](../DESIGN.md) — visual language, including the type scale
