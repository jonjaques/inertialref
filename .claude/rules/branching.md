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

- **Rebase onto the target before pushing, never merge.** `main` enforces
  `required_linear_history` and takes squash merges only, so a merge commit cannot land:
  `git fetch origin && git rebase origin/main`. Do it before running the checks, so the
  evidence describes the commit that will actually merge. `--force-with-lease` after a
  rebase of an already-pushed branch is the ordinary end of a rebase; it prompts like any
  other push. Never a bare `--force`, and never at `main`.

- **Pushing and opening a pull request are `/ship`.** Invoking that skill is the
  approval for everything in it. Reviewing is not part of it — `/code-review` is a
  separate command the user runs. `git push -f` and the direct `git push … main` forms
  are denied by matcher, and GitHub's ruleset refuses a non-fast-forward to `main`
  server-side besides; every other push prompts. Check the branch yourself rather than
  trusting either to catch it.
