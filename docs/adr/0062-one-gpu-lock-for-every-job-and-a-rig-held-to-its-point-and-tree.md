# ADR-0062: Every GPU job holds one lock, and a rig is held to the point and the tree it asked for

Status: accepted · 7 Nov 2026. The rig's half of the Playwright plan's opening
phase (P01, P03 and X3's identity half); the plan keeps the work these leave.

## Context

The rig is how this repository finds out what the app draws: `scripts/drive.mjs`
for a probe, the preset commands for the thirteen plates, `pnpm test:gpu` for
the shaders on the real GPU. Agents run all three, often several at once in
sibling worktrees, and three of the rig's failures were silent.

**Two GPU jobs overlapped and crashed macOS, twice.** The rule against it was
a sentence in agents' memory. Vitest's and Playwright's own locks coordinate
inside one run, so neither sees `pnpm test:gpu`, a drive.mjs rig or the same
command in another worktree. And a rig is not one invocation: drive.mjs leaves
its Chrome running, detached, between calls, because a boot costs about 6 s and
a warm attach a fraction of one. On the Mac mini (G5) that idle Chrome's GPU
process used 49% of a core with the GPU at 90% while the page stayed attached,
0.02% detached, and about 1.9 GB of driver allocations either way, which only
`--down` returned.

**A measurement could run in a browser no player runs.** Playwright's defaults
each fail without saying so: no `channel` headless is its headless shell, with
no WebGPU adapter, so the game boots on WebGL over SwiftShader in 67 s at about
1 fps; `channel: 'chromium'` is Chrome for Testing 151, which reaches the same
Metal adapter as Chrome 157 and spent 26.89 ms of GPU a frame at far-shore
against Chrome 157's 14.13; and its default `--force-color-profile=srgb` turns
`(dynamic-range: high)` off. Inside drive.mjs the same kind of failure is a
page at another operating point than the one asked for. Chrome drops an
invocation's device emulation when its socket closes, so between invocations
the rig's page sits at the window's own size and ratio (1600×933 at DPR 2 on
the Mac mini's display for a rig booted at 1600×900 at 1), and a remount has
come back with a 3200×1800 buffer under a 1600×900 DPR 1 viewport.

**A server on the expected port was taken as the tree under test.** Sibling
worktrees serve the same app on 5173, and `BUILD_ID` cannot tell them apart:
it is `git describe --always --dirty` of the commit they were all cut from.
A rig pointed at a sibling's Vite photographs the sibling and reports the
plate as this tree's.

## Decision

**Every GPU job holds one lock file in the clone's git common dir, from before
its first GPU work until its last GPU process is gone, and fails closed; every
drive.mjs entry to a page holds that page to the operating point and the tree
it asked for before a step runs.**

### The lock

- **One file for every checkout of the clone:**
  `$(git rev-parse --git-common-dir)/inertialref-gpu.lock`, which every worktree
  resolves to the main checkout's `.git`, found from the script's own checkout
  rather than the shell's. It is created with `openSync(…, 'wx')`, and every
  later change runs under an edit mutex and lands by rename, so a reader never
  sees half a write. `scripts/gpuLock.mjs` is the only code that touches it.
- **The file names every process it is held for**, each with its pid and start
  time: the holder, each child that joined under the holder's token, and each
  process the holder recorded because it outlives the holder. It is stale only
  when every one of them is gone — `ESRCH`, a zombie, or a start time that no
  longer matches — and anything that cannot prove a process gone counts it
  alive. A holder's exit, normal, SIGINT or SIGTERM, removes only its own entry.
- **Three holders.** `pnpm test:gpu` takes it in `globalSetup` before any test
  file runs, and keeps it for vitest's fork workers while they live
  (`keepChildren`). drive.mjs takes it before Chrome launches and records the
  Chrome, so the lock is held for the rig from launch to `--down`, and a later
  invocation on the port joins under the token the port's session recorded. A
  preset command takes it once, and every drive.mjs it spawns joins under the
  token it hands down in `IR_GPU_LOCK_TOKEN`.
- **A token is not a bypass.** A child joins only when its token is the live
  file's; any other token is refused like any acquire. There is no environment
  variable that skips the lock or moves it.
- **An acquire fails fast** with the holder, its pid, its age and its worktree,
  and says to wait or ask. `--gpu-wait <s>`, or `IR_GPU_WAIT=<s>` for the suite,
  queues with a bound and reprints the holder every 10 s. `--down` is never
  refused: it leaves alone a pid whose start time is not the one the session
  recorded, waits for the Chrome to exit, then drops it from the lock.
- **A lock that cannot be written refuses the job**, naming the error. A lock
  in another format version is refused as busy rather than reclaimed, because
  a worktree on another branch can run another revision of the module, and a
  lock this one cannot read is one it cannot prove gone.

### The guard

- **Before launch,** `scripts/driveLaunch.mjs`'s two presets (`sdr`, `display`)
  refuse every browser but Chrome stable: `channel` unset or `'chromium'`, or an
  `executablePath`, fails before a page opens, so the headless shell's 67 s boot
  is never waited out.
- **After every boot, attach and `--reload`,** `assertOperatingPoint` reads the
  page through an `evaluate` port and refuses it unless it is the kind asked
  for (`webgpu`, `fallback` or `shell`), on a hardware adapter, at the
  `--width`, `--height` and `--dpr` the rig set, with a drawing buffer of that
  window × `min(DPR, dprCeiling(coarse))` × `pictureDprFactor(picture)`,
  floored as three floors it, both functions imported from the app. It reads
  the buffer after two animation frames, because the canvas follows a resized
  window a frame or two late. A refusal exits 1 with the reason, and no step
  runs.
- **The record is the result's operating point**: one line of narration, the
  `operatingPoint` of `--json`, and in full under `--status`, which holds the
  rig's page to the point the session recorded for the last page that passed,
  and reads nothing while another invocation is driving it. Chrome's version
  is recorded and a change warned about, never refused.

### The tree

- **`ir.build()` answers `{ id, tree }`:** `BUILD_ID`, and on the dev server
  only, the root of the checkout it serves. The tree is a define set in a Vite
  plugin's `config` hook when the command is `serve`, so a production bundle
  carries no filesystem path, and `scripts/check-site.mjs` fails the build if
  one does.
- **drive.mjs holds the page's tree to the tree under test** — its own
  checkout's root, or `--tree` — after resolving both through `realpath`, and
  refuses a mismatch first and alone, naming both trees and how to serve this
  one on a port of its own. A page that names no tree (a production build, or
  a build older than the verb) reads `identity unchecked` and proceeds.

## Alternatives considered

**Holding the lock per invocation.** Release at each drive.mjs exit and the
rig's detached Chrome renders unlocked between calls — the 49% of a core and
the 1.9 GB above — and a suite started in that gap overlaps it. Whether an idle
rig may be exempt is Jon's call on those figures, in the plan's Phase 1.

**A lock in each worktree's own `.data/`.** It serializes nothing between
sibling worktrees, which is where the overlaps happen. The git common dir is
the one directory every worktree of the clone resolves to the same place.

**An advisory `flock` on an open descriptor.** The lock dies with the process
that holds the descriptor, and the process that matters, Chrome, outlives the
invocation that launched it, so Chrome would have to inherit the descriptor
for the rig to stay locked, and Node's core has no `flock` to take it with. A
file whose contents are the holders names them in every refusal; a refusal that
cannot name its holder sends the agent looking for one to kill.

**An environment switch for "I know what I'm doing".** An agent that meets a
refusal and finds a bypass uses it, and the crash it permits takes down
whatever else the machine was doing. The remedies are waiting and asking.

**Reclaiming a lock this revision cannot read.** It may be a newer branch's,
held by a live job. Refusing it as busy costs a person's attention when a
format changes; reclaiming it costs an overlap.

**Recording the operating point without refusing.** A stamp read after the
fact is a figure already taken at the wrong point and already compared: the
stamp arrives after the comparison it should have stopped.

**Refusing on a Chrome version floor.** Chrome stable updates itself, so a
floor refuses the machine the morning after an update. A change is warned
about, which is what a comparison across it needs to know.

**A buffer of viewport × DPR.** It refuses a coarse-pointer page, whose ratio
is capped, and a supersampled picture, whose buffer is doubled, by design. The
rule is the renderer's own, imported rather than restated.

**`BUILD_ID` alone, or a response header.** `BUILD_ID` is shared by siblings
cut from one commit. A header answers for whatever served the document, not for
the page the guard reads, and needs a second request; the define is read
through the same `evaluate` port as every other check.

**Refusing a page that names no tree.** `presets:compare --base` serves a
commit older than the verb, driven by this tree's driver, and a production
build names no tree by design. Both would be refused for being what they are.

## Consequences

- No two GPU jobs from this clone's checkouts overlap: on the Mac mini, a
  `pnpm test:gpu` beside a rig was refused in 0.40–0.62 s, naming the rig and
  its Chrome; a rig on another port was refused in 0.15 s with no Chrome
  launched; a suite queued under `IR_GPU_WAIT` started within one 500 ms poll
  of `--down`.
- **A rig left up blocks every other worktree's GPU work until `--down`.** That
  is the point, and it is also the commonest refusal; the refusal names the
  rig, and the preset commands print which rig they left holding the lock, even
  when they fail.
- **A sandbox that cannot write the clone's `.git` loses every GPU command.**
  Codex's workspace-write sandbox keeps `.git` read-only, so a Codex thread runs
  GPU work with full access, or with a permissions profile that grants write on
  `<clone>/.git`. The drive skill has the probe and the remedy.
- **The scope is this clone.** oMLX, Ollama, ComfyUI, another clone and Jon's
  own Chrome use the same GPU and never see the file.
- **The format is a contract across branches.** Changing `VERSION` makes every
  branch on the old revision refuse the new lock as busy, and the reverse, until
  both sides have it.
- **A warm attach costs the guard's read and its two frames:** about 0.2 s on
  the Mac mini, against the 80 ms the driver's header measured before it.
- **`--status` changes the page briefly.** It sets the recorded window before
  its read, and the page drops back when its socket closes.
- **The tree proves which checkout is served, not which edit.** `BUILD_ID`
  carries the dirty state of the moment the server started.
- **Known gaps.** Two waiters that both find a dead edit mutex can both enter
  it. `acquire` is not re-entrant within one process, and the wiring never asks
  it to be. A SIGKILL of vitest's main process leaves its fork workers
  unrecorded while they run, about 20 s in the probe. A `--status` read that
  starts as an invocation does can still clear that invocation's emulation.

## Related

- The lock: [`scripts/gpuLock.mjs`](../../scripts/gpuLock.mjs), the rig's hold
  in [`scripts/driveLock.mjs`](../../scripts/driveLock.mjs) and the suite's in
  [`scripts/gpuSuiteLock.mjs`](../../scripts/gpuSuiteLock.mjs). The guard:
  [`scripts/driveLaunch.mjs`](../../scripts/driveLaunch.mjs) and
  [`scripts/drivePage.mjs`](../../scripts/drivePage.mjs). The tree:
  [`apps/game/src/build.ts`](../../apps/game/src/build.ts).
- The working card for agents: the drive skill's § One GPU job at a time, and
  [Driving](../agents/driving.md).
- The measurements: `CONTEXT.md`, 7 Nov 2026, the entries from "Headless Chrome
  presents" through "A cold dev server's own reload".
- [ADR-0046](0046-the-check-is-a-graph-and-the-pictures-are-the-fixture.md):
  the plates this guard keeps from being taken at the wrong point.
