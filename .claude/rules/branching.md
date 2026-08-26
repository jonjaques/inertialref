# Branching and committing

No `paths:` — this loads at session start, because the first commit of a session is
made before any rule about a directory would fire.
Reasoning: [`docs/agents/working.md`](../../docs/agents/working.md) § "Starting work".

- **A dirty working tree at session start is someone else's work. Ask before touching
  it.** The `SessionStart` hook reports the branch, the uncommitted count, and how far
  ahead of `origin/main` the branch is. Offer the choices — continue on this branch,
  stash it, commit it as it stands — and do not pick one unprompted.

- **Never commit to `main`.** Cut the branch **at the first commit**, not at session
  start: by then the work has been described and the branch can be named after it.
  `git switch -c <name> origin/main`, from `origin/main` rather than from whatever
  `HEAD` happens to be, so a stale or already-merged branch cannot become the base.

- **Name the branch the way the commit subjects are named.** `feat/…`, `fix/…`, or a
  bare topic, in the declarative voice `git log --oneline -20` shows — a claim about
  the work, not a ticket number.

- **Commit without asking.** A commit is reversible and costs nothing; a session that
  ends with forty files in one lump is not. Commit each coherent piece once the Stop
  gate is green, and write the extended body every time
  ([`docs/STYLE.md`](../../docs/STYLE.md) § "Commit messages").

- **Pushing and opening a pull request are `/ship`.** Invoking that skill is the
  approval for everything in it. Force-pushing and pushing to `main` are denied
  outright and are not to be worked around.
