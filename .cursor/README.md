# Cursor

Repository-owned Cursor configuration. It complements the vendor-neutral
[`AGENTS.md`](../AGENTS.md) and reuses the existing Claude Code machinery
instead of creating a second source of truth.

- `environment.json` and `Dockerfile` define the Cloud Agent image, dependency
  install, development terminal, and exposed ports.
- `rules/*.mdc` supply Cursor's path matching and reference the canonical rule
  bodies in [`.claude/rules/`](../.claude/rules/README.md). Keep the globs in
  step with each rule's `paths:` frontmatter.
- `hooks.json` maps Cursor lifecycle events onto the shared implementations in
  `.claude/hooks/`. The scripts accept both Cursor and Claude hook payloads.

Cursor discovers `.claude/skills/*/SKILL.md` and `.claude/agents/*.md`
natively. Do not copy those into `.cursor/`: duplicate names make discovery
ambiguous and create two files to maintain.

The Dockerfile is ordinary OCI input. OrbStack can build it on macOS through
its Docker-compatible CLI, while Cursor Cloud builds and runs it on Linux.
OrbStack itself is not installed in the Cloud VM and no nested Docker daemon is
needed by this repository.
