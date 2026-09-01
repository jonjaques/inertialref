# Writing: comments, documents, commits

No `paths:` — this loads at session start. It applies to every line of prose written
here, and most of them are written in files no glob would predict.
Reasoning and examples: [`STYLE.md`](../../STYLE.md).

- **Write the present tense. The code is what the product does now.** A comment, a doc,
  a plan, a rule or a PR body describes the system as it stands, never the version it
  replaced. "Used to", "previously", "formerly", "no longer", "we then changed", "the
  old approach" are the tell — find one and the sentence around it is usually deletable.

- **"Why the obvious thing does not work" is not history.** It is a present-tense fact
  about a constraint, and the most valuable thing you can write. Keep the constraint —
  the render origin is a snapped grid point that lags the camera and jumps, so
  compressing about it sawtooths every far object's parallax. Drop the date it was found.

- **History has three homes and none of them is a comment.** A bug that must not come
  back goes in [`CONTEXT.md`](../../CONTEXT.md) (`/context-log`). A decision and the
  alternatives it beat go in an [ADR](../../docs/adr/README.md) (`/adr`). What one
  change did goes in its commit message. Nothing else looks backward.

- **A commit subject is declarative prose** — a conventional prefix, then a claim:
  `fix: the share card was a cyan marble`; match `git log --oneline -20`. **Every commit
  gets an extended body** saying _why_ the obvious thing did not work, with the numbers
  that settled it. A body that restates the diff was not worth writing.

- **Do not restate the code, and do not address the next agent.** No "the maintainer
  should note", no "as we saw above", no session-speak.
