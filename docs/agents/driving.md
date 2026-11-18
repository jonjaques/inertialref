# Driving the simulation

The harness is the supported way to move the universe, in the browser and in
Node. This page is the agent-oriented short list. The full API is
[the harness guide](../guides/harness.md). Launch, screenshots, and browser
gotchas are in the [`drive` skill](../../.claude/skills/drive/SKILL.md).

---

## Two ways in

Prefer the cheap one. The headless runner drives the **same harness object**
the browser exposes as `window.ir`.

```bash
pnpm sim --self-test              # twelve capability checks (~0.4s)
pnpm sim --targets --goto b:2     # the same navigation from a terminal
pnpm sim --terrain-baseline       # what terrain costs, measured (~16s)
pnpm sim --help
```

The baseline is the slow one because it is the one that generates: forty-eight
patches per zoo body, at 24 to 69 ms each. Its request pattern is the
deterministic half and costs nothing, which is what a caller that passes no clock
gets.

A shader question has a rung of its own between these and the browser:
`pnpm test:gpu` compiles and runs a TSL graph on the physical GPU from a
`*.gpu.test.ts`. Name the relevant file to keep the run focused; total cost
depends on the selected tests and physical adapter
([testing](../guides/testing.md)). Use the
browser only for what only a compositor can prove: LOD at real display pixels,
framing, a cutscene, presentation, a strobe.

```js
ir.help()
ir.targets() // start here — every other verb takes an address
ir.goTo('b:2')
ir.dossier('b:2') // what it is, rather than where it is
await ir.selfTest()
await ir.scenario('surface')
```

`goTo` and the observatory's `look` accept human forms (`SOL`, `s:SOL/b:2`,
`b:2` relative to the current system). The low-level `parseAddress` stays strict.

`ir.look` moves only a camera. `ir.goTo` teleports the ship. Both can fill the
frame with Jupiter; only one leaves you in orbit of it.

---

## Terrain, without a browser

The streamer's selection rule is a pure function
([`selectTerrain`](../concepts/streaming.md#terrain-streaming)), so what a camera
would ask for is arithmetic rather than an observation. Every verb here runs
headlessly and gives the same numbers in a console, in `pnpm sim` and in a test.

```js
ir.zoo() // one body per surface archetype, found rather than listed
ir.sites('g:milky-way/s:SOL/b:5.6') // the named places on a body
ir.descend('g:milky-way/s:SOL/b:5.6', { site: 'summit' }) // orbit → 2 m, on paper
ir.terrainBaseline() // the zoo, its descents, and measured patch cost
```

Standing on one runs anywhere; it is only worth doing where there is a picture.
It moves a camera and nothing else:

```js
ir.visit('g:milky-way/s:SOL/b:5.6', { site: 'summit', height: 2 })
ir.preset('earthrise') // a named picture: address, framing and lens, in one call
ir.chrome(false) // the interface out of the frame — the state a plate is taken in
ir.layers(false) // names and traces off, which is a different claim from the chrome
ir.terrain() // the live streamer and the rocks on it — null headlessly
ir.ascend() // back to the framing the camera left, or abandon a drop
ir.drop(20, -30, { seconds: 6 }) // fly down instead of cutting, facing the star
```

**A patch count is only comparable against the lens it was taken through.** The
headless probes measure at the flight lens over 1920×1080 and state both in
their reports; the live streamer uses whatever the camera panel is set to and
the display's own pixels, so an `ir.terrain()` taken at another lens is a
different question rather than a disagreement. Past the flight lens the live
selection also reads where the camera looks and refines at the lens only inside
the frame, which `ir.terrain().outside` counts and the headless probes, with no
camera to aim, do not do. `ir.lens()` is what the picture is being taken with,
and `ir.descend` takes a `lens` and a `viewport` to ask at another one.

**`ir.visit` cuts and `ir.drop` flies.** Use `visit` for a plate — the frame
after it returns is the frame asked for — and `drop` when the descent itself is
the subject, which takes its `seconds` and ends facing the star. A `--shot`
taken straight after `drop` photographs the top of the arc.

`ir.visit` stands a camera on the ground; `ir.land` teleports the ship onto it.
The same distinction as `look` and `goTo`, one clamp lower — and they are not the
same ground: the camera stands on `drawnSurfaceRadius` and the ship lands on
`surfaceRadius`, up to 1.25 m apart
([ADR-0021](../adr/0021-the-ground.md)). Sites are `summit`,
`basin`, `shore`, `rough`, `corner` and `pole`, derived from the body's own field
rather than authored, so they survive regeneration.

---

## The browser, when only a compositor will do

[`scripts/drive.mjs`](../../scripts/drive.mjs) is the one way in. It speaks the
Chrome DevTools Protocol to a Chrome it launches itself, on its own profile and
port, so it needs no focus and does not touch the browser a person is using.

```bash
node scripts/drive.mjs --js "ir.look('g:milky-way/s:SOL/b:5')" \
                       --wait 3000 --shot saturn.jpg
node scripts/drive.mjs --keep-storage --sample 240 --sample-js "ir.terrain()"
node scripts/drive.mjs --down
```

Steps run in the order written, in one session, and Chrome stays up between
calls. Each invocation clears local storage and cookies, then boots the requested
page. `--keep-storage` retains them and permits attaching to the booted page;
`--fresh` still forces a reload when combined with it. IndexedDB saves, asset
caches and service workers are retained. Batch setup and measurements in one
invocation when they must share state. `--reload` steps keep that invocation's
storage.

### Public HTML before the scene

Use `--document` to wait for the document to become readable without waiting
for a renderer. `--no-javascript` implies this mode and disables page
scripts before navigation, including the first navigation of a new rig.
Inspection expressions passed through `--js` still run through DevTools.

```bash
node scripts/drive.mjs --url http://localhost:8787/docs/architecture \
  --document --no-javascript \
  --js '({title:document.title, text:document.body.innerText})' \
  --shot docs-without-javascript.jpg
node scripts/drive.mjs --url http://localhost:8787/docs/architecture \
  --document --block-url '*App.*.js' --wait 2000 --logs \
  --shot docs-without-runtime.jpg
```

Repeat `--block-url` for additional request patterns. Match the actual chunk
names emitted by the build. Blocking bypasses service workers so a cached
response cannot conceal the requested failure. These settings are per
invocation, and changing script execution or blocked patterns reloads a warm
page. Omitting the flags restores scripts and ordinary service worker behavior.

Document screenshots capture the compositor directly, without the renderer's
extra activation capture. Frame sampling and screencasts require scripts and
reject `--no-javascript`. Default readiness still waits for the renderer and
its boot cover, and default screenshots retain the two captures it needs.

### A saved shot as the setup

The driver can open a bundled preset or a single-shot JSON export through the
same URL the planetarium shares. This exercises time, orbit anchor, tracking,
surface stance and lens restoration together.

```bash
node scripts/drive.mjs --preset earthrise --wait 2000 --shot earthrise.jpg
node scripts/drive.mjs --picture .scratch/shoreline.json \
  --query 'lens.zoom=2' --query 'label=Sea + sky' --shot shoreline.jpg
node scripts/drive.mjs --picture .scratch/shoreline.json \
  --query 'save=1' --logs
```

`--preset` expands the named bundled shot into a complete URL. `--picture`
accepts the public JSON envelope containing exactly one shot; the two flags are
mutually exclusive. Both select `/planetarium` on the host given by `--url`,
which also supports a copied share link directly. To exercise a built-in's
short alias, use `--url 'http://localhost:5173/planetarium?preset=earthrise'`.

Repeat `--query 'key=value'` to override individual fields after selecting the
shot. Values are raw text, with shell quotes around the argument; the driver
handles URL escaping. Repeating a key keeps its last value. These are session
flags, applied before all steps, and must be repeated for a matching warm attach.
The driver always sets `presentation=occluded`.
Add `--print-url` to print the resolved link without starting Chrome or a server.

The URL uses `shot=2` plus dotted picture keys such as `time`,
`framing.state.distance`, and `lens.zoom`. Numbers retain full precision.
Time is seconds from J2000, camera angles are radians, and camera distances
are meters. Lens focal length and gauge are millimeters.
`lens.focus=null` means infinity; `framing.surface=null` means an orbit camera.
`save=1` restores the view and opens its save prompt at `/planetarium/presets`
without writing to the library. See the
[preset format](../adr/0033-presets-hold-a-photographic-instant.md).

A picture with weather is `shot=3` and carries `weather.regime`. The
cornerstones (`weather-e1-cumulus-orbit` … `weather-g6-descent`) are
`--preset` ids like the bundled shots; add `--query clouds=1` to draw their
weather, and without it they draw Earth's deck and no volume
([ADR-0067](../adr/0067-a-preset-holds-its-weather-and-a-cornerstone-is-a-preset-no-list-shows.md)).
`--settle` waits on the clouds as well under the flag: their caches and 32
frames of their history.

Invalid query overrides reach the page for error-path tests. Invalid JSON
fixtures fail before Chrome starts. Run `pnpm vitest run presetUrl.test
driveUrl.test` for the codec and driver tests without a browser. In the browser,
verify URL restoration and field edits, preservation of the pose across dialog
navigation, and removal of shot fields when focusing another body.

### Session lifetime

Run shutdown separately. `--down` exits before step processing, so a command
containing both `--js` and `--down` closes Chrome without evaluating the script.
The same applies to `--file` and `--shot`. Finish the inspection batch, then
call `node scripts/drive.mjs --port <port> --down` for that rig.

### Which checkout is served

A server answering `--url` is not evidence of a tree. A sibling worktree's
Vite on 5173 boots the same app under the same build id, because worktrees
cut from one commit describe it alike. After every boot and every attach the
driver reads `ir.build()` and holds the served tree against its own
checkout's `git rev-parse --show-toplevel`. A page another checkout serves is
refused before the first step, and the refusal names both trees. The usual
cause is a sibling's Vite on 5173: while the port answers the driver starts no
server, and `pnpm dev` refuses the taken port. Serve this checkout on a port of
its own, `pnpm dev:client --port <n>`, and drive it with
`--url http://localhost:<n>/ --no-serve`. Pass `--tree <path>` only when you
mean to drive another checkout. Naming the sibling to get past a refusal
drives the sibling and reports it as this tree. A production build names no
tree, and neither does a build older than the verb, so both read
`identity unchecked` and proceed: `--url` at `pnpm preview` on 8787 and
`presets:compare --base` at an older commit. The preset commands pass the
tree they serve and print which tree each set of plates came from. Trees
compare after realpath, so a symlinked worktree, or `/tmp` against
`/private/tmp`, is one tree. The check names the served tree, not the edit:
the build id is stamped when the server starts.

### The operating point

A figure is a figure about the point it was taken at, and the wrong point
boots and answers like the right one. So after every boot, attach and
`--reload`, and before the first step, the driver holds the page to its
operating point with the launch guard in
[`scripts/driveLaunch.mjs`](../../scripts/driveLaunch.mjs), over its own
socket:

- a WebGPU renderer;
- an adapter that is neither a fallback nor, by name, a software rasterizer:
  the engine's own device's `adapterInfo` where it has one, and a fresh
  request's otherwise;
- the viewport and ratio the invocation's `--width`, `--height` and `--dpr`
  asked for, as the page reports them, the ratio compared as the float32
  Chrome keeps it in;
- a drawing buffer of that viewport × min(DPR, `dprCeiling` for the pointer)
  × the picture's supersampling factor, floored as three floors it, at the
  ratio the page reports;
- the served tree, as above.

`--document` and `--no-javascript` ask for no renderer, so the page is held to
the window and the served tree alone; with scripts off it answers no
`ir.build()`, and its tree reads `identity unchecked`. The window is checked as well as the
buffer because a page whose emulation another session cleared reports the
window it was left at, and on Chrome 157 the app's ratio follows an emulated
change, so its buffer agrees with that window and the buffer rule alone
passes it. The buffer is read two animation frames after the rig's
window is set, because a warm attach sets it on a page that has been at
another size: Chrome drops an invocation's emulation when its socket closes,
so between invocations the page sits at the window's own size and ratio,
1600×933 at DPR 2 on the Mac mini's display for a rig at 1600×900 at 1. A
page the guard finds with nothing booted in it is booted once more, for the
reload a fresh Vite makes inside the boot, and refused the second time.

A refusal prints the guard's reason, exits 1 and runs no step. It means the
page is not the point the command asked for, and the remedy depends on the
check: a buffer the rig did not ask for is the remount of trap 5 below, and
`--fresh` boots the page again at the rig's window; a WebGL backend or a
software adapter means this Chrome is not drawing on the GPU, and trap 4's
`--down` and a fresh start is the first thing to try; a tree mismatch is the
section above. Forced sRGB, `--color-profile srgb`, is recorded as
`dynamicRangeHigh` false and is not refused.

The record is a line of narration unless `--quiet`, the `operatingPoint` of
`--json` with `identity` beside it, and each `--reload` step's `point`. It
names the adapter and backend, the buffer against the window and the ratio,
the dynamic range, whether the system is Sol, a catalog star or generated,
and the served tree. Chrome's version from `/json/version` is in it too. The
port's session records it with the kind, the tree, the window and the
controls, and only once a page has passed, so a run that fails at boot or is
refused does not consume the warning. A version other than the one the
session recorded is warned about once per entry and never refused, because
Chrome stable updates itself.

`--status` reads the point again without navigating or booting. It prints
the rig's lines and the GPU's holder first, then sets the window, the kind
and the tree the session recorded for the last page that passed, prints the
line and the full record, and exits 1 when the guard refuses. It reads
nothing while another invocation is driving the page, and says so with that
invocation's pid: each invocation lists itself in the session until it
exits, because setting a window replaces the running invocation's, and the
status socket's close clears the page's device emulation for every session,
so a cast or a settle in progress would drop to the window's own size and
ratio. A page that does not answer within five seconds is not read rather
than refused, and so is a socket that does not open. A baseline older than both
`engine.picture` and `ir.build()`, which `presets:compare --base` can serve
from an older commit, names no picture to hold the buffer against, so its
buffer reads `unchecked` and the rig proceeds.

### One GPU job at a time

Every GPU job on the machine takes one lock, in the clone's git common
directory, because two at once have crashed macOS:
[`scripts/gpuLock.mjs`](../../scripts/gpuLock.mjs). A rig holds it from before
its Chrome launches until `--down` has closed that Chrome, and a later call on
the same `--port` joins it. Beside a rig, `pnpm test:gpu` and a rig on another
port are refused at once, with the holder's name, pid, age and worktree. A
refusal means wait or ask whoever is working in that checkout; never `--down`
a rig you did not start. `--gpu-wait <seconds>` queues instead, and
`pnpm test:gpu` takes `IR_GPU_WAIT=<seconds>`. `--down` is never refused, and
`--status` names the holder. A sandbox that cannot write the clone's `.git`,
Codex's workspace-write sandbox among them, fails every GPU command closed with
`cannot write the GPU lock`. The
[`drive` skill](../../.claude/skills/drive/SKILL.md#one-gpu-job-at-a-time) has
the preset commands' part and the sandbox's remedy.

### The traps

These are the browser, not bugs in the clock, and the driver handles the first
three; they are here because they explain what it is doing:

1. **`requestAnimationFrame` is suspended while the window is occluded.** Focus
   emulation is what makes the page render anyway. Without it boot never leaves
   "first light…" and every capture is the boot cover.
2. **Every screenshot is taken twice.** The first capture activates the page and
   draws the frame, so alone it shows the state _before_ the step that preceded
   it. The second is the evidence. After a cutscene seek, wait 2–4 seconds more
   for asynchronous textures.
3. **HMR does not reliably rebuild the renderer.** After a source edit,
   `--reload`. A tab that has taken a dozen hot updates draws its HUD with
   `engine.gl` null, which looks like a rendering bug and is not one.
4. **A wedged Chrome needs `--down` and a fresh start.** Reloading is not always
   enough to recover its GPU state.
5. **The page is told its own pixels are not to be sampled, with
   `?presentation=occluded`, and the driver adds it to every URL.** The
   presentation watchdog decides whether the canvas has presented by reading
   the bitmap back from inside an animation frame, and skips the check while
   `document.visibilityState` is not `visible` — because an occluded window
   legitimately never presents. Focus emulation, which is what makes trap 1
   work, reports `visible` for a window that is still behind everything else;
   the in-frame sample reads the drawn texture rather than the composited one,
   so it reads correctly there, but a driven boot is a measurement and a ladder
   run is what it must never contain. Exhausted, the ladder remounts the
   canvas: a second full preload and warm-up census 4.5 s after the first —
   about 6.5 s of a 10.2 s `navigation to first light` — an uncaught dispose
   from inside Three on the way, and a drawing buffer measured at 3200×1800
   for a rig asking for 1600×900 at DPR 1. **Every terrain figure taken after
   a rebuild in this rig is a retina figure**, which is the trap below
   arriving without being asked for, and the launch guard refuses that page
   before a step. On Chrome 157 the app's ratio follows an emulated DPR change
   while focus emulation runs, and that buffer has not been reproduced there,
   so the guard's unit case in `scripts/drivePage.test.mjs` holds the
   refusal; [CONTEXT.md](../../CONTEXT.md) § "Every drive.mjs boot runs the
   guard, and a page between invocations is at no rig's point" has the runs.
   Boot from this rig is one census and ~4.3 s to first light.
6. **Chrome left running is contention the test suite feels.** The driver keeps
   it up on purpose, and a full `pnpm test` beside it has timed out on a
   different unrelated file each run and passed clean once `--down` had run.
   A single timeout that moves between runs is a reading about the machine.
7. **`--serve` cannot start a dev server in a worktree that has never built** —
   `cf dev` needs `apps/game/dist`. Use `pnpm dev:client` and `--no-serve`,
   or build once. [development](../guides/development.md) § Commands.
8. **The MacBook Air steps every figure up about 35% after about 3.5 minutes
   of load.** It is fanless (Mac17,4, base M5). At the far-shore preset,
   1600×900 at DPR 1, in Chrome 157 headless on the dev build, `ir.gpu` goes
   from 10.2 ms to 13.4–15.3, settle from 12–18 s to 28–31 and boot from 5 s
   to 7–8, and five idle minutes bring it back. Two cool sessions still
   disagree by 8%, and `pmset` records no warning. Onset and recovery each rest
   on one observation at that point, and the cause is inferred, because
   `powermetrics` needs sudo. So compare base and candidate **interleaved in
   one session** first. Idling five minutes between arms suits a short arm
   only: a six-boot series or a thirteen-plate pass runs 3–6 minutes and
   outlasts the onset. Name the thermal state of every figure: cool, or how
   many minutes under load, and on the Mac mini
   `notifyutil -g com.apple.system.thermalpressurelevel` before and after. The
   fan-cooled Mac mini (Mac18,5, M6) held `ir.gpu` flat through 10.4 sustained
   minutes at far-shore 1600×900@1 and 1440×900@2, thermal pressure 0
   throughout, but that is one session at each window, so the rule holds there
   too until repeated sessions give a between-session spread.

Default readiness is `ir.status().boot`: `drawing` once a renderer exists,
`booted` once the boot cover lifts. The bare harness appears seconds earlier,
so a probe on its presence alone captures an unlit canvas. `--document` uses
the committed document's readiness for public HTML checks.

**Terrain streams only below the eight-pixel relief gate, and above it
`ir.terrain()` reports zeros that read exactly like a broken streamer.** From
the root URL, neither `ir.land` nor `ir.orbit(address, 8)` was close enough:
both left `visited: 0` and `lens: null`. `ir.visit(address, { site: 'summit',
height: 2 })` **in the planetarium** is what makes the streamer run. Check
`visited` before concluding anything about ground.

**And `visited` is a figure about the last frame that walked, not about this
one.** `visited`, `culled`, `starved` and `level` are mirrors of whichever
frame last re-selected, and a converged stance re-selects on none of them — the
walks are a pure function of the eye, the optics, the level floor and the
geometry cache, so a frame in which none of them moved reuses the answer. The
counter that says whether a frame walked is `selections`, a total since the
streamer was made: two reads a second apart that differ by sixty are a
selection recomputed every frame, and two that agree are the memo holding.
Read it beside `visited` or the other four will describe a frame that walked
nothing.

**A pooled streamer's first frame on a body selects nothing at all.** The
subdivision floor is a worker answer — `universe.prepareSurface` is 33–43 ms of
floor search cold, plus the drainage graph on a wet body, and a frame cannot
carry either — so a body it has not prepared yet has no ceiling to select
against and the ground waits, the same way it waits for the heightfields
themselves. `--wait` through it; a single frame
after `ir.visit` reports zeros for a reason that is not the gate above.

---

## Why was that frame slow

The panel answers "is it fast right now" while you fly; the timeline answers
"why was that frame slow" afterward, and it is the only instrument here with a
time axis the others can be laid against.

```bash
node scripts/drive.mjs --js "(await ir.profile(2000)).text"   # a table and a verdict
node scripts/drive.mjs --url "http://localhost:5173/?timing=trace" --trace 3000
pnpm timing --threads                                         # read the trace back
```

`ir.profile` arms the level, records, disarms and reports, so nothing is left
retaining. It ends on the line worth having — _"9 of 61 frames over 25 ms; terrain.select
was the largest measured span in 7 of them, 8.4 ms of 31.0 ms"_ — which names
the largest span inside the **late** frames rather than the busiest one overall,
and puts the frame duration beside it so the ratio says whether the name is an
explanation. Where it is not, the line says so: everything the GPU does happens
after `frame` returns, so a late frame with nothing large inside it is the
expected shape rather than a gap in the report.

Off is the default everywhere and a recording without `?timing=trace` carries
none of these tracks. The worker tracks are in a trace and never in a drain,
because each side of the boundary times against its own `timeOrigin`.
[ADR-0022](../adr/0022-the-timeline.md).

### Measuring so the number means something

**Take a performance figure on a quiet machine, and take nothing else at the
same time.** A worker figure is the one that goes wrong silently: the same
summit arrival reads 45 ms runs quiet and 285 ms with a build running beside
it, so a `pnpm test` in another shell does not make the measurement noisy, it
makes it a measurement of the test run. Finish the suite, let the machine
settle, then measure. Chrome left up by the driver is part of the same
contention in both directions — trap 6 above is this one seen from the test
suite's side.

**Say which build.** Dev React is about five times the shipped cost and every
number below is a dev-build number; both are real and only one is about a
player. `pnpm preview` on 8787 is the shipped one, and it is worth re-measuring
anything that lands in a design document there.

**Name the thermal state.** On the fanless MacBook Air a figure taken after a
few minutes of load is a figure about a different machine; trap 8 above has the
step and the rule.

**A headless frame interval detects nothing under the 16.7 ms budget, and a
CPU span is not a control for a GPU change.** Headless rAF is a fixed 60 Hz
clock: a DPR change from 1 to 1.05 at far-shore on the Air raised `ir.gpu`
6.5% across seven interleaved pairs and moved rAF p95 by 0.00 ms. The same
change raised the CPU-only spans `Engine/snapshot` 28% and `Render/sensor`
24%: on the Air's M5 the CPU spans move with GPU load. Read `ir.gpu`
for a GPU question; a CPU span that moves beside a GPU change is not, by that
alone, CPU work.

**Name the operating point, and prefer two.** A figure measured at one is a
figure about that point. The four that recur, all dev build, 1600×900 at DPR 1
on an Apple M5, with `Engine/frame` vsync-bound at 16.7 ms throughout:

| point                             | engine  | notable                                        |
| --------------------------------- | ------- | ---------------------------------------------- |
| Planetarium, Earth from 14,400 km | 0.36 ms | snapshot 0.26, orbitTraces 0.13, starfield ~0  |
| Converged summit stance, 2 m      | 0.45 ms | terrainPatches 1.10, terrain 0.15, select 0.01 |
| Four retargets in a Sol tour      | 0.33 ms | orbits max 0.20, bodies max 25.7 on one frame  |
| Jump to a generated system        | 0.45 ms | one `Boot/bake atmosphere` of 39.7 ms mid-jump |

**`?workers=N` overrides the pool size**, bounded at sixteen, and it is how the
ceiling in `engine/browserWorker.ts` was chosen rather than assumed. The
experiment is worth re-running on any machine whose core count is not this
one's: land, converge for twenty seconds, and read `jobs/s`, `averageRunMs` and
`ir.terrain().level` together — throughput alone hides the dilation, and the
drawn level is the one a player watches.

---

## When a visual defect is reported

Terrain selection is measured in **display pixels**, so the streamer at a retina
window asks for four times the patches and behaves like a different subsystem. A
defect that will not reproduce is usually a window that has not been matched: get
the reporter's size and device pixel ratio before concluding anything about the code.

A **Chrome performance trace** recorded with Screenshots gives both at once, plus one
JPEG per composited frame at the page's real rate — a recording of what they actually
saw, on their machine. It is the strongest evidence a report can carry and the
cheapest thing to ask for.

```bash
node scripts/traceFrames.mjs ~/Downloads/Trace-*.json.gz   # frames, period, Hz, url
node scripts/drive.mjs --dpr 2 --width 1920 --height 1200 … --cast 200
```

Both difference consecutive frames and report the ones that differ from **both**
neighbors while those neighbors match each other. That shape is a strobe; motion
produces none, which is what makes a clean result mean something. A still cannot show
any of it and neither can `--shot`.

A **Firefox profile** answers what no picture can. Its markers say whether frame
pacing is even involved — the lunar strobe ran at a clean 60 fps with one long frame
in 261, which ruled out a hitch immediately — and its JS samples say what the app was
doing: `buildPatch` present on every frame of a 4.3 s capture is a terrain streamer
that never converged, and that was the finding.

---

## The author's instruments

Press the bug in the IR menu at the bottom center of the frame, or `` ` ``.
Four panels appear, all closed: controls, telemetry, perf, graphics. Every
panel calls the harness and nothing else, so anything you can do by clicking is
reproducible in a test. The Controls panel carries a **Harness** section —
cutscenes, scenarios and the self-test — which is where scaffolding belongs.

`P` opens perf, `H` clears both panes and `Shift+H` clears every piece of
chrome, which is the state a plate is taken in. All three are defaults; the
bindings live at `/settings/controls` and `?` prints the live ones.

Going somewhere is the **Catalog**, and it is not one of these: it is a panel of
the product's own, in the planetarium and in the flight workspace, with a verb
that depends on the mode.

The planetarium's **Camera** panel is where the observatory reads out — range,
altitude, frame fill, the two orbit angles and the address — because those are
facts about where the camera is standing rather than about the body in front of
it. The object panel is the body's record and carries none of them.

Look at the perf panel before optimizing anything, and before believing a
performance claim in a design document.
