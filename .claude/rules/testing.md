---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
---

# Tests

Reasoning: `docs/guides/testing.md`.

- **Tests run in plain Node.** That is the check that the core stays free of DOM, React
  and WebGL — nothing registers a browser environment, and nothing should start. The
  `*.gpu.test.ts` suffix is the one documented exception and buys its way out with a
  separate command, a separate config and a physical adapter; everything below about
  plain Node is about `pnpm test`.
- **Prefer a property test to an example when the thing under test is mathematical.**
  `fast-check` is installed. Round trips, invariants, ordering. Several real bugs here
  were found this way and would not have been found otherwise.
- **Golden vectors for the PRNG.** Changing one is a deliberate act, with an
  algorithm-version bump in the same commit.
- **State-hash equality for anything about determinism.** `world.stateHash()` is the
  canonical comparison — position, velocity, orientation, angular velocity, control
  input, flight assist, landedness.
- **Assert the physics, not the direction of change.** Capability check 5 once passed
  while reporting "fell from 57287 km to 57287 km"; it now compares against the analytic
  free-fall prediction.
- **Name the limit when a bound is loose.** `POSITION_RESOLUTION * 2` is a better
  assertion than `toBeCloseTo(x, 3)` because it says where the number came from.
- **Check that a regression test can actually fail.** Reintroduce the bug and watch it go
  red before you keep it. The terrain-normals test asserted that normals were unit length,
  which a radial normal also is — so it passed both before and after the fix for the bug
  it was written to guard.
- **Do not write a scalar mirror of a shader and test that.** A graph runs on the real
  GPU from a `*.gpu.test.ts` under `pnpm test:gpu` — see `.claude/rules/rendering.md`.
  Those files are excluded from `pnpm test` and `pnpm check` because they need a
  physical adapter, and a compute kernel in one must guard its own index.
- Run one file with `pnpm vitest run <substring>` — and one GPU file with
  `pnpm vitest run --config apps/game/vitest.gpu.config.ts <substring>`, because the root
  config excludes the suffix and the plain form answers "No test files found".
