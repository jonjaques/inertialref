---
paths:
  - 'docs/**/*.md'
  - 'design/plans/**'
  - 'design/reports/**'
  - 'scripts/docs/**'
  - 'AGENTS.md'
  - 'STYLE.md'
---

# Documents are published, and the build knows which ones

Reasoning: [ADR-0016](../../docs/adr/0016-documentation-as-a-mode.md),
[development](../../docs/guides/development.md) § "The documentation site".

- **A new markdown file under `docs/` goes in `scripts/docs/wings.mjs`, in the same
  change.** Everything in that directory is published at `/docs`, and the wing table is
  what says where — so a file no wing lists is a file the site cannot place. The build
  refuses rather than guessing, which means `pnpm docs:build` fails, and with it
  `pnpm build` and `pnpm check`. The failure names the file and the fix; what it cannot
  do is arrive before the end of a session. An ADR is the common case, and it has caught
  its own author once already: the record arguing for the documentation site was the one
  page the site would not publish.

- **A plan goes in `design/`, never under `docs/`.** That directory is outside the
  published tree: `docs/` is the finished account of what the system does, and a
  reader who reaches a page there expects the system to already behave that way. A
  plan promises the opposite. When a phase lands its decision moves into an ADR and
  the plan loses the section — cite the ADR, not the plan.

- **The route is the path, so renaming a file moves a public URL.**
  `docs/concepts/frames.md` is `/docs/concepts/frames`, and a `README.md` takes its
  directory's name rather than its own. `AGENTS.md` and `STYLE.md` are adopted from
  the root at `/docs/working-card` and `/docs/style`, so they carry a public URL too.
  Renaming one is a redirect nobody wrote — and the files here link to each other by
  relative path, so it is also every inbound link inside the corpus.

- **`apps/game/public/doc-content/` is derived. Never edit it.** It is generated the way
  the brand artifacts are, and the markdown is the source. It is gitignored, and
  `pnpm build` regenerates it.

- **A cross-reference in a doc comment is checked.** TypeDoc fails the build on a
  `{@link}` naming a symbol that no longer exists, rather than rendering words that link
  nowhere. Renaming an export means fixing what points at it.
