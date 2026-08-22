---
name: ship
description: Take finished work from a dirty tree to a pushed branch and a pull request — full pnpm check, the capability self-test, a commit in house style, and a PR body that names the invariants the change touches.
argument-hint: '[branch name or PR title]'
disable-model-invocation: true
allowed-tools: Bash(pnpm check) Bash(pnpm sim:*) Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git add:*) Bash(git checkout -b:*) Bash(git switch:*) Bash(gh pr view:*) Bash(gh pr list:*)
---

# Ship it

Never invoked automatically — pushing and opening a PR are the user's call, and the Stop
gate deliberately stops short of both.

## 1. Prove it, all the way

The Stop gate runs graph → lint → typecheck → test on every turn that touched source. This
is the wider net, and it is the one `AGENTS.md` § "Definition of done" actually names:

```bash
pnpm check          # graph, format:check, lint, typecheck, test, build
pnpm sim --self-test # the twelve capability claims, executed rather than described
```

**Both green, or stop and say what is red.** Do not open a PR on a red gate and describe
it as a known issue.

## 2. Check what the change obliges you to update

Done is not "the tests pass". Before committing, confirm each of these is either done or
genuinely not applicable, and say which:

- **An ADR** if an architectural boundary moved. `docs/adr/` — twelve exist; the next is
  the next number. Use `/adr`.
- **`CONTEXT.md`** if anything was decided, measured, or is a bug that must not return.
  Use `/context-log`.
- **`AGENTS.md`** if a new invariant now exists — and then `.claude/rules/` for the
  path-scoped one-liner, per the contract in `.claude/rules/README.md`.
- **A regression test** if a defect exposed a missing invariant. Patch the invariant, not
  the symptom, and check the test can actually fail by reintroducing the bug.
- **`worker-configuration.d.ts`** if `wrangler.jsonc` changed —
  `pnpm --filter @inertialref/server run types`, and commit it.

## 3. Branch

Never commit to `main`. If the current branch is `main`, create one:
`git checkout -b <topic>`. Existing branches here are named `feat/…` or a bare topic
(`tng`); match what is already there.

## 4. Commit in house style

Look at `git log --oneline -20` first — the subject lines are declarative and have a voice
("five modes, a shell, and a mode with no ship", "the overlay hardening notes, which never
got committed"). Match it. Conventional-commit prefixes are used (`feat(ui):`, `fix:`,
`docs:`) but the subject after the prefix is prose, not a ticket summary.

The body says **why**, and specifically why the obvious thing did not work — the same
standard the code comments are held to.

## 5. Push and open the PR

Ask before pushing. `.claude/settings.json` puts `git push` and `gh pr create` behind a
prompt on purpose, and force-pushing and pushing to `main` are denied outright.

The PR body should name:

- what changed and why, in the same voice as the commit;
- **which invariants the change touches** — the ones in `AGENTS.md` and `.claude/rules/`
  — and how they still hold;
- what was verified, with numbers (`12/12 capability checks`, a tick rate, a frame index);
- anything deliberately left out.

CI runs `pnpm check` and `pnpm sim --self-test` on the PR, which is the same thing you
just ran locally — by construction, so the two cannot drift.

## 6. Offer the review

Once the PR is open, tell the user they can run `/code-review ultra <PR#>` for a deep
multi-agent cloud review of it. That command is theirs to trigger; do not attempt it.
