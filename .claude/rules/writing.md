# Writing: comments, documents, commits

No `paths:` — this loads at session start. It applies to every line of prose written
here, and most of them are written in files no glob would predict.
Reasoning and examples: [`docs/STYLE.md`](../../docs/STYLE.md).

- **Write the present tense. The code is what the product does now.** A comment, a doc,
  a plan, a rule or a PR body describes the system as it stands, never the version it
  replaced. "Used to", "previously", "formerly", "no longer", "we then changed", "the
  old approach" are the tell — find one and the sentence around it is usually deletable
  whole. A reader who never saw the previous version is the only reader there is, and to
  them a sentence about it is a claim they cannot check.

- **"Why the obvious thing does not work" is not history.** It is a present-tense fact
  about a constraint, and it is the most valuable thing you can write. The render origin
  is a snapped grid point that lags the camera and jumps, so compressing about it
  sawtooths every far object's parallax. Keep that. Drop the sentence saying when it was
  discovered.

- **History has three homes and none of them is a comment.** A bug that must not come
  back goes in [`CONTEXT.md`](../../CONTEXT.md) (`/context-log`). A decision and the
  alternatives it beat go in an [ADR](../../docs/adr/README.md) (`/adr`). What one
  change did goes in its commit message. Nothing else looks backward.

- **Commit subjects are declarative prose.** A conventional prefix, then a claim:
  `fix: the share card was a cyan marble`. Read `git log --oneline -20` and match it.

- **Every commit gets an extended body**, and it says _why_ — specifically why the
  obvious thing did not work — with the measured numbers that settled it. A body that
  restates the diff is a body that was not worth writing.

- **Do not restate the code, and do not address the next agent.** No "the maintainer
  should note", no "as we saw above", no session-speak.
