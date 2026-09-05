# AGENTS.md

Shared working card for Codex, Claude Code, and Cursor. Read this first; the
[agent handbook](docs/agents/README.md) covers the workflow, and
[human documentation](docs/README.md) describes the system.

## Start here

- Read [working.md](docs/agents/working.md), [STYLE.md](STYLE.md), and the
  unscoped [branching](.claude/rules/branching.md),
  [writing](.claude/rules/writing.md), and [browser](.claude/rules/browser.md) rules.
- Inspect the current branch, `git status`, and `git worktree list`. Preserve
  other agents' work. Follow an explicit user-selected base; otherwise use
  `origin/main` when cutting a branch at the first commit. Never commit to `main`.
- Read the relevant [ADR](docs/adr/README.md) and the full rule linked below.
  Run `pnpm check` before changing code; report a pre-existing failure.
- Find the test covering the behavior. Write a missing regression test first
  and prove it fails with the defect present. Prefer properties for mathematics.
- Use Node 26 and pnpm 11. See [development](docs/guides/development.md).
  In a fresh worktree, run `pnpm install --frozen-lockfile --prefer-offline`.
- Ask headlessly first: `pnpm sim`, focused Vitest, or `openSession` in `.scratch/`.
  Browser work goes through `node scripts/drive.mjs` and the `drive` skill.

## One infrastructure, native adapters

`.claude/` holds the shared rule extracts, skill bodies, agent briefs, and hook
implementations. Keep Claude Code working when changing them. `CLAUDE.md` is
Claude-specific orientation; [.cursor/](.cursor/README.md) contains Cursor's
adapters. [Codex setup](.codex/README.md) explains its native configuration.

- Codex reads this file automatically. It reads relevant `.claude/rules/*.md`
  explicitly; Claude's path loading is not a Codex feature.
- `.agents/skills/` links to `.claude/skills/`. Edit the shared target, never a
  copied skill. Resolve its relative links from the target's directory.
- `.codex/agents/` loads the shared Claude briefs with Codex-specific tool,
  memory, and worktree instructions. Do not translate `.claude` into `.Codex`.
- `ship`, `parallel`, `invariant-auditor`, and `docs-curator` are opt-in.
  Do not launch the review commands on the user's behalf. A configured agent
  is available, not authorization to spend on an audit.
- Codex subagents share the checkout unless assigned an actual worktree.
  For authorized parallel work, create isolated worktrees, assign absolute
  paths and file ownership, and verify each there. Do not disturb another
  agent's worktree or mutate the tree during a read-only audit.
- Format files changed through shell commands explicitly. Hooks are a safety
  net; they do not replace verification or carry permissions between hosts.

## The rules that actually matter

These imperatives are canonical. The [full rules](docs/agents/invariants.md)
retain their constraints, exceptions, measured failures, and technical links.
When a rule changes, update both accounts and the matching `.claude/rules/`
extract; keep its `.cursor/rules/` glob in step. Read the linked details for
any rule governing the files being changed.

- **Never put an absolute position in a `Vec3`.** [Details](docs/agents/invariants.md#rule-1).
- **Never use `Math.random()`, `Date.now()`, or `performance.now()` in canonical code.** [Details](docs/agents/invariants.md#rule-2).
- **Never call `console.timeStamp`, `performance.mark` or `performance.measure` outside `engine/browserTiming.ts`,** [Details](docs/agents/invariants.md#rule-3).
- **Never make generation depend on order.** [Details](docs/agents/invariants.md#rule-4).
- **Never hold an algorithm version because the draw order is intact.** [Details](docs/agents/invariants.md#rule-5).
- **Never put canonical state in a React component,** [Details](docs/agents/invariants.md#rule-6).
- **Never write a presentation switch directly.** [Details](docs/agents/invariants.md#rule-7).
- **Never construct a `Worker` outside `apps/game/src/engine/browserWorker.ts`.** [Details](docs/agents/invariants.md#rule-8).
- **Never assemble a session by hand.** [Details](docs/agents/invariants.md#rule-9).
- **Never pass a bare `Vec3` to anything that samples terrain.** [Details](docs/agents/invariants.md#rule-10).
- **Never read a field value off something chosen by rank.** [Details](docs/agents/invariants.md#rule-11).
- **Never write entity state around the world's verbs.** [Details](docs/agents/invariants.md#rule-12).
- **Never assert that something is landed.** [Details](docs/agents/invariants.md#rule-13).
- **Never let a coasting entity keep its epoch through a move it did not make.** [Details](docs/agents/invariants.md#rule-14).
- **Never persist anything regenerable.** [Details](docs/agents/invariants.md#rule-15).
- **Never make the star catalog ambient.** [Details](docs/agents/invariants.md#rule-16).
- **Never store what the catalog can derive.** [Details](docs/agents/invariants.md#rule-17).
- **Never filter a survey to serve a search box.** [Details](docs/agents/invariants.md#rule-18).
- **Never sort a system's planets by orbit and call it order.** [Details](docs/agents/invariants.md#rule-19).
- **Never import a hosting vendor's SDK below the adapter layer.** [Details](docs/agents/invariants.md#rule-20).
- **Never let React Compiler memoize a component that reads mutable state.** [Details](docs/agents/invariants.md#rule-21).
- **Never put the `<Canvas>` inside a route,** [Details](docs/agents/invariants.md#rule-22).
- **Never hold the current mode in React state.** [Details](docs/agents/invariants.md#rule-23).
- **Never read the raw pathname when a dialog could be open over a mode.** [Details](docs/agents/invariants.md#rule-24).
- **Never apply `flattening` to a body that has a `figure`.** [Details](docs/agents/invariants.md#rule-25).
- **Never leave a field out of a record because nothing has measured it.** [Details](docs/agents/invariants.md#rule-26).
- **Never read a body's figure as "unknown".** [Details](docs/agents/invariants.md#rule-27).
- **Never place a compressed body about the render origin.** [Details](docs/agents/invariants.md#rule-28).
- **Never scale metric geometry by `placement.scale`.** [Details](docs/agents/invariants.md#rule-29).
- **Never size or position chrome against the viewport.** [Details](docs/agents/invariants.md#rule-30).
- **Never add a second producer of the camera.** [Details](docs/agents/invariants.md#rule-31).
- **Never add a second producer of the lens.** [Details](docs/agents/invariants.md#rule-32).
- **Never add a second window-level key listener.** [Details](docs/agents/invariants.md#rule-33).
- **Never call `localStorage` outside `state/preferences.ts`.** [Details](docs/agents/invariants.md#rule-34).
- **Never write a key name in a label.** [Details](docs/agents/invariants.md#rule-35).
- **Never turn the head at a constant radians-per-pixel.** [Details](docs/agents/invariants.md#rule-36).
- **Never let the planetarium write canonical state.** [Details](docs/agents/invariants.md#rule-37).
- **Never ask where something is at `clock.time` in order to put it in a frame.** [Details](docs/agents/invariants.md#rule-38).
- **Never give a mode its chrome without `pointer-events-auto`.** [Details](docs/agents/invariants.md#rule-39).
- **Never give `AnimatePresence` `mode="wait"` over the overlay routes,** [Details](docs/agents/invariants.md#rule-40).
- **Never guard a "run once" effect with a ref.** [Details](docs/agents/invariants.md#rule-41).
- **Never move a workspace panel by splicing an array at a call site.** [Details](docs/agents/invariants.md#rule-42).
- **Never derive a stored value from a captured snapshot.** [Details](docs/agents/invariants.md#rule-43).
- **Never put two components in one file.** [Details](docs/agents/invariants.md#rule-44).
- **Never hand-roll a control the registry already has.** [Details](docs/agents/invariants.md#rule-45).
- **Never add a markdown file under `docs/` without listing it in `scripts/docs/wings.mjs`.** [Details](docs/agents/invariants.md#rule-46).
- **Never write a plan under `docs/`.** [Details](docs/agents/invariants.md#rule-47).
- **Never let a cinematic effect fire off a script.** [Details](docs/agents/invariants.md#rule-48).
- **Never fly a scripted camera through the prop it is staging.** [Details](docs/agents/invariants.md#rule-49).
- **Never treat a beat past a shot's last frame as dead.** [Details](docs/agents/invariants.md#rule-50).
- **Never write a label in the case you want to see it in.** [Details](docs/agents/invariants.md#rule-51).
- **Never subtract two planetary radii from each other in a shader, and never take a screen-space derivative of a planetary position.** [Details](docs/agents/invariants.md#rule-52).
- **Never read the drawn ground where the canonical one belongs, or the reverse.** [Details](docs/agents/invariants.md#rule-53).
- **Never give two attribute names one `BufferAttribute` object.** [Details](docs/agents/invariants.md#rule-54).
- **Never call `geometry.dispose()` on anything holding the shared index.** [Details](docs/agents/invariants.md#rule-55).
- **Never leave a stand-in `DataTexture` at its nearest default.** [Details](docs/agents/invariants.md#rule-56).
- **Never build two texture nodes over one stand-in object.** [Details](docs/agents/invariants.md#rule-57).
- **Never take a fine lattice coordinate from an absolute float32 direction, and never take a lattice decision in a float.** [Details](docs/agents/invariants.md#rule-58).
- **Never add a shading term to the ground without adding it to the sphere.** [Details](docs/agents/invariants.md#rule-59).
- **Never import from `three` in `apps/game`.** [Details](docs/agents/invariants.md#rule-60).
- **Never hand-write a compile-ahead.** [Details](docs/agents/invariants.md#rule-61).
- **Never edit a file `pnpm brand` writes.** [Details](docs/agents/invariants.md#rule-62).
- **Never change what the site says about itself in only one place.** [Details](docs/agents/invariants.md#rule-63).
- **Never load a third-party tag from `index.html`.** [Details](docs/agents/invariants.md#rule-64).

## Finish the work

Correctness, layer boundaries, determinism, passing tests, and `pnpm check`
are the definition of done. Use the checks the change warrants; prose-only
work needs formatting and documentation-link validation, not a renderer.
Update ADRs for architectural decisions and use `context-log` for findings
worth carrying forward. Commit coherent verified work with a conventional
subject and an extended body explaining why. Pushing and opening a PR use
`ship` when requested. State what changed, what was verified, and limitations.

## Cloud environments

Cursor's environment is `.cursor/environment.json`; it pins Node 26 and pnpm
11 and installs dependencies during the build. Inspect the **Game and Worker**
terminal before starting another dev server. `pnpm dev` serves ports 5173 and 8787. Claude cloud setup is in `CLAUDE.md`; other fresh hosts use
`scripts/cloud-setup.sh` as their environment setup script.

The app and tests need no Docker, database, or production credentials. Missing
reference audio and analytics settings must still produce a successful silent,
non-measuring build. Never add production credentials to silence those notices.
