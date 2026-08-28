# Cursor

Repository-owned Cursor configuration. It complements the vendor-neutral
[`AGENTS.md`](../AGENTS.md) and reuses the existing Claude Code machinery
instead of creating a second source of truth.

- `environment.json` and `Dockerfile` define the Cloud Agent image, dependency
  install, development terminal, and exposed ports.
- `rules/*.mdc` supply Cursor's path matching and reference the canonical rule
  bodies in [`.claude/rules/`](../.claude/rules/README.md). Keep the globs in
  step with each rule's `paths:` frontmatter. `branching.mdc`, `writing.mdc` and
  `browser.mdc` carry `alwaysApply: true` instead of globs, mirroring the three
  canonical rules that carry no `paths:`.
- `hooks.json` maps Cursor lifecycle events onto the shared implementations in
  `.claude/hooks/`. The scripts accept both Cursor and Claude hook payloads and
  claim one shared dirty marker, so enabling third-party configuration cannot
  run the gate twice for the same edits.

Cursor discovers `.claude/skills/*/SKILL.md` and `.claude/agents/*.md`
natively. Do not copy those into `.cursor/`: duplicate names make discovery
ambiguous and create two files to maintain.

Debug configurations live in [`.vscode/`](../.vscode/README.md), which both
Cursor and VS Code read. Launch Browser starts the game; Launch Node starts
the headless runner. There is no Cursor-specific copy.

The Dockerfile is ordinary OCI input. OrbStack can build it on macOS through
its Docker-compatible CLI, while Cursor Cloud builds and runs it on Linux.
OrbStack itself is not installed in the Cloud VM and no nested Docker daemon is
needed by this repository.

Cursor clones, smudges LFS, and starts `terminals` inside the image. The
Dockerfile therefore installs `git`, `git-lfs`, `tmux`, and a UTF-8 locale —
not just Node 26. A successful `docker build` is not a working Cloud Agent.
