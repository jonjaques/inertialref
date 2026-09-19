---
name: ship
description: Take finished, verified work to a pull request — rebased onto origin/main, committed in house style, pushed, opened ready rather than draft, with CI watched. It runs no gate; the checks are CI's and the evidence is what was gathered during the work. Review is /code-review, which the user invokes next.
argument-hint: '[branch name or PR title]'
disable-model-invocation: true
allowed-tools: Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git add:*) Bash(git commit:*) Bash(git switch:*) Bash(git checkout -b:*) Bash(git fetch:*) Bash(git rebase:*) Bash(git push:*) Bash(gh pr create:*) Bash(gh pr edit:*) Bash(gh pr view:*) Bash(gh pr diff:*) Bash(gh pr checks:*) Bash(gh pr comment:*) Bash(gh run list:*) Bash(gh run view:*) Bash(gh run watch:*) Bash(pnpm check:*)
---

# Ship it

Never invoked automatically. **Invoking it is the approval for everything in it** —
rebasing, committing, branching, pushing, opening the pull request and editing it.
Nothing in it prompts: `git push` and `gh pr create` are allowed in
`.claude/settings.json`, and the one act that still asks is merging to `main`, which
is not part of this.

**"Ship" means the work is already verified.** By the time the word is said, the Stop
gate has run on every turn that touched source, and whatever the change needed beyond
that has been run during the work and its result is in hand: `pnpm presets:compare`
for anything visible, `pnpm test:gpu` for a shader, `pnpm check` for a change to the
build or the tooling, a headless probe for a number. This skill runs none of them. CI
runs `pnpm check` on the pushed commit, which is the same command and the same graph,
and the review is the user's next command. What this skill does is get the commit
onto a branch, onto the remote and into a pull request that says what was verified —
in about a minute, not twenty.

If something the diff plainly needed was never run, **say so in the pull request**,
under Verification — "not run" is a complete answer — rather than running it now or
describing a run that did not happen. Do not launch `invariant-auditor` or
`docs-curator` either; name in one line which of them the diff would have warranted,
and let the user decide to spend it.

---

## 1. Rebase onto `origin/main`, once

```bash
git fetch origin
git rebase origin/main
```

`main` carries `required_linear_history` and takes squash merges only, so a branch
that has fallen behind is either rebased or it is not mergeable. Conflicts are yours to
resolve, in the direction the change intends — never `--ours`/`--theirs` by reflex on a
file you have not read.

If the rebase replayed anything, the evidence in hand describes a tree that no longer
exists. Say so under Verification: CI is the check on the merged tree, and that is what
it is for. A rebase of a branch that is already pushed ends in `--force-with-lease`,
which is the ordinary end of a rebase; a bare `--force` is denied.

## 2. Branch and commit

If the work is still on `main`, cut the branch now — `git switch -c <topic>
origin/main` — and never commit to `main`. Names are `feat/…`, `fix/…` or a bare
topic, in the declarative voice `git log --oneline -20` shows.

Commit in house style: a conventional prefix and then a declarative claim, and an
extended body saying **why**, specifically why the obvious thing did not work, with the
numbers that settled it. `STYLE.md` § "Commit messages" is the specification. Several
coherent commits beat one lump, and the squash setting keeps them: the repository
composes the squash message from `COMMIT_MESSAGES`, so those bodies are what lands on
`main`.

Before the last commit, confirm each of these is done or genuinely not applicable —
they are part of the change, not a gate on it:

- **An ADR** if an architectural boundary moved (`/adr`; the next number is one past
  the highest file in `docs/adr/`).
- **`CONTEXT.md`** if anything was decided, measured, or is a bug that must not return
  (`/context-log`).
- **`AGENTS.md`**, the `.claude/rules/` one-liner and a row in
  `docs/agents/invariants.md` if a new invariant now exists.
- **A regression test** if a defect exposed a missing invariant, watched failing with
  the defect reintroduced.
- **The ledger or a plate**, if a change moved a picture on purpose: `pnpm
presets:ledger` rewrites the headless ledger, `pnpm presets:plates <id>` the plate,
  and the rewritten file in the diff is the claim under review.
- **`worker-configuration.d.ts`** if `wrangler.jsonc` changed
  (`pnpm --filter @inertialref/server run types`).

## 3. Push

```bash
git push -u origin HEAD          # --force-with-lease after a rebase of a pushed branch
```

## 4. Open it ready

```bash
gh pr create --base main --title "<subject>" --body-file <file>
```

No `--draft`: a PR that sits in draft after the work is finished is a PR nobody looks
at. `.github/pull_request_template.md` is the shape — what changed, the invariants it
touches, screenshots, verification, what was left out. Write the body to a file and pass
`--body-file`; a heredoc through `--body` mangles backticks and blank lines.

**Verification is a list of what ran, with its numbers, and what did not.** The Stop
gate's stages, `pnpm check` if it ran, the `pnpm presets:compare` table for anything
visible, `pnpm test:gpu` for a shader, the headless probe and its figure. A plate that
moved and was accepted is in the diff; a plate that moved and was fixed gets its
`reference | tree | difference` pair from `.data/presets/compare/<id>.pair.png`,
uploaded with the `share-media` skill and referenced from the body. A measurement
names its operating point, and at least one is outside Sol.

## 5. Watch CI, and fix red

Start the watch and **keep working** — do not block on it:

```
Monitor({
  description: 'CI checks on PR #<n>',
  timeout_ms: 1800000,
  persistent: false,
  command: `prev=""
    while true; do
      s=$(gh pr checks <n> --json name,bucket 2>/dev/null)
      [ -n "$s" ] || { sleep 30; continue; }
      cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
      comm -13 <(echo "$prev") <(echo "$cur")
      prev=$cur
      jq -e 'length > 0 and all(.[]; .bucket!="pending")' <<<"$s" >/dev/null && break
      sleep 30
    done`,
})
```

It emits one line per check as it settles and exits when none are pending, so a failure
and a pass both arrive. **Key the loop on the output, not on the exit code**: `gh pr
checks` exits 8 while any check is pending and 1 when one has failed, so `|| continue`
never reaches the parse and the watch runs to its timeout having emitted nothing.

There are two checks: `pnpm check` from `.github/workflows/check.yml` — the runner's log
names the stage that failed and what it cost — and a Cloudflare `Workers Builds`
deployment. Both have to be green. If CI comes back red, fix it, commit the fix as its
own step, push again, and say so in the report rather than letting a red PR sit under
a "ready" label.

## 6. Hand off

Report the PR number and URL, what CI returned, what was verified beyond it, and
anything left out.

Then stop. The review is the user's next command — `/code-review --fix` for a local
pass, or `/code-review ultra <PR#>` for the deep multi-agent cloud review. Both are
theirs to trigger and billed to them; do not attempt either.
