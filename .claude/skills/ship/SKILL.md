---
name: ship
description: Take finished work to a pull request that is ready for review — rebased onto origin/main, the checks the diff actually warrants, a commit in house style, and a PR opened ready rather than draft. Review is /code-review, which the user invokes next.
argument-hint: '[branch name or PR title]'
disable-model-invocation: true
allowed-tools: Bash(pnpm check) Bash(pnpm sim:*) Bash(pnpm test:*) Bash(pnpm vitest:*) Bash(pnpm drive:*) Bash(node scripts/drive.mjs:*) Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git add:*) Bash(git commit:*) Bash(git switch:*) Bash(git checkout -b:*) Bash(git fetch:*) Bash(git rebase:*) Bash(git push:*) Bash(git push --force-with-lease:*) Bash(gh pr create:*) Bash(gh pr edit:*) Bash(gh pr view:*) Bash(gh pr diff:*) Bash(gh pr checks:*) Bash(gh pr comment:*) Bash(gh run list:*) Bash(gh run view:*) Bash(gh run watch:*)
---

# Ship it

Never invoked automatically. **Invoking it is the approval for everything in it** —
rebasing, committing, branching, pushing, opening the pull request, and editing it. Do
not stop to ask for permission at any step below; stop only when something is red, and
say what.

One caveat about that grant: `allowed-tools` covers the turn the skill was invoked in
and clears at the next user message. If the user says something mid-flow and a push then
prompts, that is the harness, not a change of mind — approve-by-invocation still stands.

**The PR opens ready for review, not as a draft.** Everything that could change the
diff therefore happens _before_ it opens: the rebase, the gate, the audits, the
screenshots. Ready means the work is finished and the evidence is attached, which is
exactly what makes it worth a reviewer's time.

**Which of those apply is a function of the diff**, and step 2 is where that is decided.
A documentation change does not need a browser to prove a paragraph. Running every step
on every change is not thoroughness — it is a slower way to reach the same PR, and it
teaches the reader that the verification section means nothing.

**Reviewing is not part of shipping.** `/code-review --fix` is the user's next command,
by their own workflow. Do not run it, do not spawn a reviewing subagent, and do not
offer one — the handoff line in step 9 is the whole of it.

---

## 1. Rebase onto `origin/main` before anything else

`main` carries a ruleset with `required_linear_history`, and the repository allows
**squash merges only**. A merge commit cannot land here, so a branch that has fallen
behind is either rebased or it is not mergeable — and finding that out at merge time
means re-running every check below against a tree nobody tested.

```bash
git fetch origin
git rebase origin/main
```

Rebasing **first** rather than last is the point: `pnpm check`, the audits and the
screenshots below are only evidence about the commit that will actually merge. Run them
against a stale base and they describe a tree that will never exist.

Conflicts are yours to resolve, in the direction the change intends — never
`--ours`/`--theirs` by reflex on a file you have not read. If the rebase rewrites commits
that are already pushed, the push in step 6 needs `--force-with-lease`. That is the
ordinary end of a rebase and prompts like any other push; a bare `--force` does not
belong here, and `git push -f` is denied outright.

## 2. Scope the checks to what the diff actually touches

`git diff --stat origin/main...HEAD` first, and run only the checks that can tell you
something you do not already know. A check whose answer is already in front of you is
not diligence; it is twenty minutes and a full build spent confirming a paragraph.

| The diff is                                                                                 | Run                                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Prose only — `docs/**`, `*.md`, `.claude/**`, `.cursor/**`                                  | `pnpm format:check`. Nothing else                                                          |
| Prose that states a number, a command or an API                                             | ...plus the one command that proves the claim, and `docs-curator` if it is a behavior page |
| Config and tooling — `.github/**`, `package.json`, a tsconfig, a linter or formatter config | `pnpm check`. No browser, no self-test                                                     |
| Any `.ts` / `.tsx` under `packages/` or `apps/`                                             | The whole of step 3                                                                        |
| ...and it touches `apps/game/src/render/` or a shader                                       | ...and `pnpm test:gpu`, which `pnpm check` and CI leave out                                |
| ...and it touches rendering, the HUD, the dock or a cutscene                                | ...and step 4, with a picture                                                              |

The rows are about **evidence, not effort**. A documentation change is verified by
reading it, and it is being read as it is written — the browser cannot say anything
about a paragraph and `pnpm build` cannot say anything about a heading. A config change
is exactly the case where `pnpm check` is the whole point, because the thing that broke
is the thing that runs it.

Two judgment calls the table cannot make. A prose change that _states a fact about the
code_ — a flag, a measured number, a command line — is verified by running that one
thing, not by trusting the sentence. And a diff that looks like documentation but
carries a `.ts` file is a source change with documentation in it; take the lower row.

Say which rows applied and which you skipped. "Docs only, so format check and nothing
else" is a complete verification report for a docs PR, and a better one than a green
build that proved nothing about the words.

## 3. Run everything slow at once

The gate and the read-only audits do not depend on each other, and the gate takes
minutes. Launch the audits in a **single message** so they run concurrently, then run
the gate while they work.

```bash
pnpm check          # graph, brand, presets, format:check, lint, typecheck, test, build
pnpm sim --self-test
```

**Green, or stop and say what is red.** `pnpm check` is the same command CI runs, by
construction, so a green local run means the only way CI fails is the environment.

Both of these subagents are read-only and neither is optional when its trigger fires:

- **`invariant-auditor`** when the change touches more than one package, or any of the
  rules in `AGENTS.md`. Nothing mechanical checks those; this is the only thing that
  does. What it confirms goes into the PR's **Invariants** section.
- **`docs-curator`** when the change altered behavior a page describes. A doc that
  describes the previous version is the failure mode the whole `docs/` split exists to
  prevent, and it is invisible in a diff.

## 4. Verify what CI cannot — in a real browser

CI already runs `pnpm check` and `pnpm sim --self-test`; repeating those proves nothing
new. What is missing is the shader suite — `pnpm test:gpu`, which needs an adapter CI's
runner does not have — and everything that needs a compositor or an eye. Drive it with
[`scripts/drive.mjs`](../../../scripts/drive.mjs) — never the Claude-in-Chrome
extension, which drives the human's own browser. `/drive` is the full card.

```bash
node scripts/drive.mjs --js "ir.look('g:milky-way/s:SOL/b:5')" --wait 3000 --shot after.jpg
node scripts/drive.mjs --down     # when the last capture is taken
```

- **A screenshot, for anything visible.** Caption it with the scale, frame or address it
  was taken at. Attach with `gh pr comment <n>` after the PR exists, and reference it
  from the body.
- **A before/after pair** when the change corrects something that was visibly wrong. The
  pair is the argument; a paragraph describing a frame is not.
- **`--sample <n>`** when the claim is about motion — a strobe, a level churn, a stall.
  A still cannot show any of them.
- **A headless probe** when a number is the point. `pnpm sim` and a throwaway script
  against `openSession` are cheaper than the browser and answer most of it.

## 5. Check what the change obliges you to update

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

## 6. Branch, commit, push

If the work is still on `main`, cut the branch now — `git switch -c <topic> origin/main`
— and never commit to `main`. Existing names are `feat/…`, `fix/…` or a bare topic;
match what `git branch -a` shows. See `.claude/rules/branching.md`.

Commit in house style: a conventional prefix and then a declarative claim, and an
extended body saying **why**, specifically why the obvious thing did not work, with the
numbers that settled it. `STYLE.md` § "Commit messages" is the specification; `git
log --oneline -20` is the calibration.

Several coherent commits beat one lump, and the squash setting keeps them: the repository
composes a squash message from `COMMIT_MESSAGES`, so those bodies are what lands on
`main`. This is also the moment to notice that a commit body has crept into a source
comment — history belongs here, not there.

```bash
git fetch origin && git rebase origin/main   # again: origin/main may have moved
git push -u origin HEAD                      # --force-with-lease if step 1 rewrote
```

The second rebase is cheap and catches the case the first cannot: `main` moving while
the gate and the audits were running. If it replays anything at all, `pnpm check` again
before pushing — a clean replay is not the same as a passing one.

## 7. Open it ready

```bash
gh pr create --base main --title "<subject>" --body-file <file>
```

No `--draft`. The verification a draft exists to defer has already happened above, and a
PR that sits in draft after it is finished is a PR nobody looks at.

`.github/pull_request_template.md` is the shape — what changed, the invariants it
touches, screenshots, verification, what was left out. Write the body to a file and pass
`--body-file`; a heredoc through `--body` mangles backticks and blank lines.

## 8. Watch CI, and fix red

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

There is more than one check: `pnpm check` from `.github/workflows/check.yml`, and a
Cloudflare `Workers Builds` deployment. Both have to be green.

If CI comes back red, fix it and push again — and say so in the report rather than
letting a red PR sit under a "ready" label. Meanwhile attach the screenshots from step 4
with `gh pr comment <n>` and `gh pr edit <n> --body-file <file>` to reference them.

## 9. Hand off

Report the PR number and URL, what CI returned, what you verified beyond it, and
anything left out.

Then stop. The review is the user's next command — `/code-review --fix` for a local
pass, or `/code-review ultra <PR#>` for the deep multi-agent cloud review. Both are
theirs to trigger and billed to them; do not attempt either.
