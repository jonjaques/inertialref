---
paths:
  - 'docs/**/*.md'
  - 'scripts/docs/**'
  - 'AGENTS.md'
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

- **The route is the path, so renaming a file moves a public URL.**
  `docs/concepts/frames.md` is `/docs/concepts/frames`, and a `README.md` takes its
  directory's name rather than its own. Renaming one is a redirect nobody wrote — and
  the seventy files here link to each other by relative path, so it is also every
  inbound link inside the corpus.

- **`apps/game/.doc-content/` is derived. Never edit it.** It is a build input
  for Astro — the page bodies the documents are emitted from. `public/doc-content/`
  is the runtime fetch: the rail's manifest and the search index. Page bodies
  are not files there. Both are gitignored; `pnpm build` regenerates them.

- **A cross-reference in a doc comment is checked.** TypeDoc fails the build on a
  `{@link}` naming a symbol that no longer exists, rather than rendering words that link
  nowhere. Renaming an export means fixing what points at it.
