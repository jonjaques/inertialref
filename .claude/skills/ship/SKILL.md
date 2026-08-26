---
name: ship
description: Take finished work from a dirty tree to a pull request that is ready for review — pnpm check, a commit in house style, a pushed branch, a draft PR, CI watched in the background, and the verification CI cannot do before it is marked ready.
argument-hint: '[branch name or PR title]'
disable-model-invocation: true
allowed-tools: Bash(pnpm check) Bash(pnpm sim:*) Bash(pnpm test:*) Bash(pnpm vitest:*) Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git add:*) Bash(git commit:*) Bash(git switch:*) Bash(git checkout -b:*) Bash(git fetch:*) Bash(git push:*) Bash(gh pr create:*) Bash(gh pr edit:*) Bash(gh pr ready:*) Bash(gh pr view:*) Bash(gh pr diff:*) Bash(gh pr checks:*) Bash(gh pr comment:*) Bash(gh run list:*) Bash(gh run view:*) Bash(gh run watch:*)
---

# Ship it

Never invoked automatically. **Invoking it is the approval for everything in it** —
committing, branching, pushing, opening the pull request, editing it, and marking it
ready. Do not stop to ask for permission at any step below; stop only when something is
red, and say what.

One caveat about that grant: `allowed-tools` covers the turn the skill was invoked in
and clears at the next user message. If the user says something mid-flow and a push then
prompts, that is the harness, not a change of mind — approve-by-invocation still stands.

The order matters. `pnpm check` gates the push, and everything slow happens **after**
the branch is up and CI is already running, not before.

---

## 1. Gate the push

```bash
pnpm check          # graph, brand, format:check, lint, typecheck, test, build
```

**Green, or stop and say what is red.** This is the same command CI runs, by
construction, so a green local run means the only way CI fails is the environment.

`pnpm sim --self-test` is deliberately **not** here. CI runs it, and running it locally
first only delays the push by the time it takes. The window for deeper verification is
step 5, while CI is already working.

## 2. Check what the change obliges you to update

Done is not "the tests pass". Confirm each of these is either done or genuinely not
applicable, and say which:

- **An ADR** if an architectural boundary moved. `docs/adr/` — the next number is one
  past the highest file there; count them rather than trusting any number written down.
  Use `/adr`.
- **`CONTEXT.md`** if anything was decided, measured, or is a bug that must not return.
  Use `/context-log`.
- **`AGENTS.md`** if a new invariant now exists — then `.claude/rules/` for the
  path-scoped one-liner, and a row in `docs/agents/invariants.md`. See
  `.claude/rules/README.md`.
- **A regression test** if a defect exposed a missing invariant. Patch the invariant,
  not the symptom, and **watch the test fail** with the defect reintroduced — three have
  failed that check here for three different reasons.
  `docs/guides/testing.md#prove-a-regression-test-can-fail`.
- **`worker-configuration.d.ts`** if `wrangler.jsonc` changed —
  `pnpm --filter @inertialref/server run types`, and commit it.

## 3. Branch and commit

If the work is still on `main`, cut the branch now — `git switch -c <topic> origin/main`
— and never commit to `main`. Existing names are `feat/…`, `fix/…` or a bare topic;
match what `git branch -a` shows. See `.claude/rules/branching.md`.

Commit in house style: a conventional prefix and then a declarative claim, and an
extended body saying **why**, specifically why the obvious thing did not work, with the
numbers that settled it. `docs/STYLE.md` § "Commit messages" is the specification; `git
log --oneline -20` is the calibration.

Several coherent commits beat one lump. This is also the moment to notice that a commit
body has crept into a source comment — history belongs here, not there.

## 4. Push and open a draft

```bash
git push -u origin HEAD
gh pr create --draft --base main --title "<subject>" --body-file <file>
```

**Draft, always.** A PR opened ready-for-review announces a verdict that has not been
reached yet: CI has not run and the verification in step 5 has not happened. Marking it
ready in step 6 is what makes "ready" mean something.

`.github/pull_request_template.md` is the shape — what changed, the invariants it
touches, screenshots, verification, what was left out. Write the body to a file and pass
`--body-file`; a heredoc through `--body` mangles backticks and blank lines.

## 5. Watch CI in the background, and verify what CI cannot

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
and a pass both arrive — a filter that only matched success would be silent through a
crash.

**Key the loop on the output, not on the exit code.** `gh pr checks` exits 8 while any
check is pending and 1 when one has failed, so `|| continue` never reaches the parse and
the watch runs to its timeout having emitted nothing. A non-empty body is the signal.

There is more than one check on a PR here: `pnpm check` from
`.github/workflows/check.yml`, and a Cloudflare `Workers Builds` deployment. Ready means
both.

Meanwhile, do the verification **CI has no way to do.** CI already runs `pnpm check` and
`pnpm sim --self-test`; repeating those locally proves nothing new. What is missing from
the PR is everything that needs a GPU, a browser, or a human eye:

- **A screenshot, for anything visible.** `/drive` — `ir.shot()` for a still,
  `ir.seekCutscene(name, frame)` then `ir.shot()` for a beat. Caption it with the scale,
  frame or address it was taken at. Attach with `gh pr comment <n>` and reference it
  from the body.
- **A before/after pair** when the change is a correction to something that was visibly
  wrong. The pair is the argument; a paragraph describing a frame is not.
- **A headless probe** of the specific claim the change makes, when a number is the
  point — a measured figure, a clearance, a tick rate.
- **`pnpm sim --self-test`** only if the change plausibly moves one of the twelve
  capability claims and you would rather know before CI tells you.

Two subagents belong in this window and nowhere else, because both are read-only, both
take minutes, and CI is paying for those minutes anyway:

- **`invariant-auditor`** when the change touches more than one package, or any of the
  rules in `AGENTS.md`. Nothing mechanical checks those; this is the only thing that
  does. Put what it confirms into the PR's **Invariants** section.
- **`docs-curator`** when the change altered behavior a page describes. A doc that
  describes the previous version is the failure mode the whole `docs/` split exists to
  prevent, and it is invisible in a diff.

If CI comes back red, fix it and push again. The PR is a draft; that is what draft is
for. Do not mark it ready and describe the failure as a known issue.

## 6. Mark it ready

When CI is green **and** the verification from step 5 is in the PR:

```bash
gh pr edit <n> --body-file <file>   # if screenshots or findings changed the body
gh pr ready <n>
```

Then report the PR number and URL, what CI returned, and what you verified beyond it.

## 7. Offer the review

Tell the user they can run `/code-review ultra <PR#>` for a deep multi-agent cloud
review. That command is theirs to trigger; do not attempt it.
