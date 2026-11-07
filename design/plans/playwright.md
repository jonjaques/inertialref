# Playwright runs the suites; drive.mjs stays the probe

**Augment the rig. Do not replace it.** Playwright Test becomes the runner for work that asserts. That covers a GPU-free shell project on every pull request, the boot and input suites, and the interleaved performance comparison. [`scripts/drive.mjs`](../../scripts/drive.mjs) stays the probe loop that agents call. Both drivers import one module for the app contracts (readiness, settle, `?presentation=occluded`), so neither driver carries its own copy. Three measurements decided this:

1. **The warm attach.** drive.mjs attaches to an already booted page in about 80 ms. A Playwright process pays 64–429 ms to launch, 4.1–5.0 s to reach `booted`, and 12.2 s of fresh-profile settle at earthrise. Claude Code sessions called the driver 493 times in 30 days, about 16 a day, and Codex sessions 694 times between 4 and 24 September. Each of those calls would pay the boot and the settle again.
2. **The lever is new headless, not Playwright.** Chrome 157 in new headless gives pixel-identical plates across launches (AE 0 at fuzz 0), a 60 fps screencast, and the Metal adapter with `timestamp-query`. drive.mjs can launch it itself (P08). Playwright's own defaults pick worse browsers. Its default headless shell lands on WebGL over SwiftShader: 67 s to boot, 1 fps. Its bundled Chrome for Testing 151 spends 2–5× Chrome 157's GPU time per frame.
3. **A performance gate has to be interleaved in one session.** Five interleaved pairs resolve 0.85% of `ir.gpu` (95% confidence). On the fanless MacBook Air that took these figures, though, every figure steps up about 35% after about 3.5 minutes of load. A candidate measured against a stored baseline would be measuring the room. The fan-cooled M6 Mac mini is the machine for performance work. It held `ir.gpu` flat through 10 sustained minutes at each of two far-shore windows, but one session a day is not a calibration, so interleaving stays the rule there too.

The ranking points the same way. The five proposals with the highest return need no Playwright: a dark-plate noise measurement, a boot-ladder fix, a settle measurement two reviews fold into P24, and two documentation corrections. Playwright Test as a runner (P04) ranks 37th of 68. Its value is what its consumers make of it, and the cheapest of those consumers (P35, the shell project) needs only its base configuration.

The first wave ran all five on the Mac mini, beside P01's lock module, P03's launch guard, P06's tests and X3's port allocator, and it measured X13's idle rig (G5). #188 carries the code, and [The first wave, on the Mac mini](#the-first-wave-on-the-mac-mini) says what each step found.

---

## What was measured

Every figure in the probe tables below (A–K and N1–N7) comes from one machine: Mac17,4, a fanless MacBook Air with the base Apple M5, 32 GB, macOS 27.2, and a single built-in Retina display. That is Jon's workstation, not the performance machine. The Mac mini's own figures, M1–M6 and the first wave's G1–G5, are in [On the Mac mini](#on-the-mac-mini). #188's Node-lane figures are in the proposal sections they answer, each naming its unit.

**The performance machine is the Mac mini.** It is a Mac18,5 with the Apple M6 (12-core GPU), 32 GB and macOS 27.2, fan-cooled. Its main display is a 4K LG TV at 120 Hz, which reports a 1920×1080 UI (DPR 2) and sleeps after 10 idle minutes (`pmset` `displaysleep 10`), so an unattended run there meets a sleeping display. It runs Node v26.13.0 and Google Chrome 157.0.8103.39, the same versions as the Air. Playwright 1.62.1's Chrome for Testing 151.0.7922.34 and headless shell are installed there too, in `~/Library/Caches/ms-playwright`. The spike's raw evidence (the end of this plan) is in its main checkout as a copy of the Air's. Four things follow:

- Its fan removes the Air's thermal step at the two points measured there. [On the Mac mini](#on-the-mac-mini) has the figures.
- Its panel runs at 120 Hz, but a headed rig there does not: drive.mjs's off-screen window gets about 100 irregular rAF/s, and an on-screen window costs 2.2× headless GPU time at 48 rAF/s ([On the Mac mini](#on-the-mac-mini), M5 and M6). The off-screen rig is above the 64 Hz tick, so some of its frames carry no tick. Headless rAF stays a 60 Hz virtual clock on any machine.
- A full-screen window there is a 3840×2160 buffer. Terrain selection is measured in display pixels, so a full-window figure from the mini does not compare with one from the Air. The fixed sizes below, such as 1600×900@1, do.
- One GPU job at a time holds there too, because the rule is about the GPU, not the room.

The browser is Google Chrome 157.0.8103.39 through Playwright 1.62.1's `channel: 'chrome'` unless a row says otherwise. Node is v26.13.0. The target is the Astro dev server (dev React) at `29e2ed46`, except N7. Every URL carries `presentation=occluded`. Readiness is `ir.status().boot === 'booted'`, polled every 100 ms. Settle is two consecutive ok `ir.settled()` answers 250 ms apart, as in [`driveSteps.mjs`](../../scripts/driveSteps.mjs).

The two operating points:

- **earthrise:** Sol, `s:SOL/b:2.0`, framing rise.
- **far-shore:** generated system `g:milky-way/s:P222_1_0_9/b:4`, an ocean shore under a low sun, outside Sol.

The windows are 1600×900@1, 480×320@1 (plates), 1440×900@2 (buffer 2880×1800), and 1600×900@1.05.

Probes A–K test capability. N1–N7 measure the noise floor.

| Probe | Question                         | Verdict | Number                                                                                                             | Point · build               |
| ----- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| A     | Adapter per launch mode          | works   | Chrome 157 and CfT 151: `apple`/`metal-3`, timestamp-query. Default shell: adapter null, game on WebGL/SwiftShader | earthrise 1600×900@1 · dev  |
| B     | Time to `booted`                 | works   | Chrome 157 4.1–5.0 s; CfT 151 9.4 s fresh; default shell 67–79 s; settle 12.2 s fresh, 0.5–1.0 s reload            | both · dev                  |
| C     | Stills, plates, toHaveScreenshot | works   | AE 0 across launches and headless/headed; plates 40 and 10 px over 8% (floor 200)                                  | 1600×900@1, 480×320@1 · dev |
| D     | In-page frame pacing             | works   | Chrome 157 60 fps; CfT 151 far-shore 38–39 fps; `ir.gpu` 26.89 vs 14.13 ms                                         | both · dev, sequential      |
| E     | `page.keyboard.press`            | works   | Shift+KeyH: DOM 60 → 1,035 elements; synthetic `key`-only event: nothing                                           | earthrise · headless        |
| F     | Video and screencast             | works   | recordVideo fixed 25 fps; CDPSession screencast 179–180 frames in 3 s                                              | earthrise · headless/headed |
| G     | Chrome trace into the readers    | works   | `pnpm timing` and `traceFrames.mjs` unchanged; 11.9–13.7 MB per 3 s                                                | both · headless             |
| H     | `page.clock` stepping            | works   | each paused `runFor(16)` = 1 frame; 16 ms grid; aim while paused changes 0 px                                      | earthrise · headless        |
| I     | Playwright trace cost            | works   | no fps cost; 6.7–15.4 MB per 5 s                                                                                   | both · headless             |
| J     | Two pages rendering at once      | partial | both 60 fps; far-shore `ir.gpu` 10.4/14.1 alone vs 14.1 concurrent                                                 | both, one browser           |
| K     | drive.mjs as it stands           | works   | ready 5.7–6.3 s; settle 12.7 and 19.0 s; `dynamicRangeHigh` true                                                   | both · headed, display      |
| N1    | Between-run stability, N=5       | works   | `ir.gpu` min-of-3 CV 0.56% far-shore, 1.56% earthrise; heap after GC 0.1%                                          | 1600×900@1, cool            |
| N2    | Detectable regression            | works   | the table below                                                                                                    | derived from N1, N4         |
| N3    | Retina-class buffer              | partial | far-shore 39.8 ms (25 fps), every frame late; earthrise floor 8.94 ms                                              | 1440×900@2 · dev            |
| N4    | DPR 1.05 A/B, 7 pairs            | works   | `ir.gpu` +0.88 ms (+6.5%), t = 25; rAF p95 Δ 0.00                                                                  | far-shore, throttled        |
| N5    | Thermal state                    | fails   | +35% step after ~3.5 min; 5 min idle restores; cool sessions differ 8%                                             | far-shore 1600×900@1        |
| N6    | Headless vs headed, 5 pairs      | works   | headed `ir.gpu` +0.14 ms; sensor within-run SD 2.3× headed; boot +780 ms                                           | far-shore 1600×900@1        |
| N7    | Production vs dev, 5 pairs       | partial | heap after GC −42.7 MB (−31%); per-frame difference unresolved                                                     | far-shore · both builds     |

Further results behind the table:

- **The default headless shell.** With `--enable-unsafe-webgpu --use-angle=metal`, the shell reaches the real `metal-3` adapter and runs like the others. With `--enable-unsafe-webgpu` alone it gets SwiftShader's fallback adapter.
- **Headed windows.** A headed Playwright window rendered at 59 rAF/s before any focus emulation. That window had just launched and was frontmost. Real occlusion behind another window was not tested.
- **Pixels across browsers.** CfT 151 renders earthrise within 0.07 px of Chrome 157 at 3%. The WebGL fallback renders it 149 px away.
- **The thermal step.** It moves boot (5 → 7–8 s), settle (12–18 → 28–31 s), main-thread task time (400 → 510–790 ms/s), and the CPU spans together with GPU time.
- **CPU spans move with GPU load.** In N4, a DPR change also raised CPU-only spans: `Engine/snapshot` +28%, `Render/sensor` +24%. On this SoC the CPU spans are not independent controls for a GPU change.

### The noise floor and what a gate can detect

The figures are the half-width of the 95% interval and the 80%-power threshold, per arm, unpaired. They come from N1: cool, headless, dev build, 1600×900@1.

| Metric                       | CV    | n = 5          | n = 10         | n = 20         |
| ---------------------------- | ----- | -------------- | -------------- | -------------- |
| far-shore `ir.gpu` mean of 3 | 1.9%  | 2.7 / 3.8%     | 1.8 / 2.5%     | 1.2 / 1.7%     |
| far-shore `ir.gpu` min of 3  | 0.56% | 0.8 / 1.1%     | 0.5 / 0.7%     | 0.4 / 0.5%     |
| earthrise `ir.gpu` min of 3  | 1.56% | 2.3 / 3.2%     | 1.5 / 2.1%     | 1.0 / 1.4%     |
| far-shore `Render/sensor`    | 1.6%  | 2.3 / 3.1%     | 1.5 / 2.1%     | 1.0 / 1.4%     |
| far-shore main-thread task   | 1.8%  | 2.7 / 3.7%     | 1.7 / 2.4%     | 1.2 / 1.7%     |
| earthrise main-thread task   | 11.2% | 16.3 / 22.6%   | 10.5 / 14.8%   | 7.2 / 10.2%    |
| far-shore heap after GC      | 0.11% | 0.22 / 0.31 MB | 0.14 / 0.20 MB | 0.10 / 0.14 MB |
| far-shore `ir.passes` wall   | 7.8%  | 11.3 / 15.7%   | 7.3 / 10.3%    | 5.0 / 7.1%     |
| far-shore settle             | 19.5% | 28 / 39%       | 18 / 26%       | 12.5 / 18%     |

**Paired figures.** With interleaved pairs at far-shore while throttled (N4's A arm), `ir.gpu` has sd(d) = 0.093 ms on a 13.55 ms mean. That resolves 0.85 / 1.14% at 5 pairs, 0.49 / 0.68% at 10, and 0.32 / 0.45% at 20. CPU spans paired while throttled need 10 pairs for 8.5–12%.

**Headless rAF percentiles detect nothing below the 16.7 ms budget.** Headless rAF runs on a fixed 60 Hz virtual clock. In N4, `ir.gpu` rose 6.5% while rAF p95 moved 0.00 ms.

**`ir.gpu` noise sits inside a run.** Its between-run variance is about 0 when the machine is cool (0.007 ms between runs against 0.331 within). At earthrise, the first of three calls reads +0.40 ms high, cause unverified. Several repetitions in one context beat several fresh contexts.

Each SD comes from 5–7 runs. With n = 5 the SD's 95% upper bound is 2.87× the estimate, so the n = 5 figures could be up to about 3× worse. Each fresh-context run costs 29–40 s cool and 51–57 s throttled, mostly in settle.

### On the Mac mini

Measured on 7 November 2026 on the Mac18,5, at `521c494` (the dev build of `origin/main` at `db8f2a4`, plus this plan), served by `pnpm dev:client`. The protocol is N1's: Chrome 157.0.8103.39 through Playwright 1.62.1's `channel: 'chrome'` in new headless, a fresh context per run, readiness and settle as above, 1 s quiet, then `ir.gpu(120)` three times, keeping the minimum. Thermal pressure is `notifyutil -g com.apple.system.thermalpressurelevel`, read before and after every run. Each session ran its point without a pause between runs.

| Probe | Question                                            | Verdict | Number                                                                                                                                               | Point                |
| ----- | --------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| M1    | Adapter and cadence, headless                       | works   | `apple`/`metal-3`, `timestamp-query`, not a fallback; rAF 60; buffer 1600×900                                                                        | both, 1600×900@1     |
| M2    | Sustained load, 10.4 min, 27 runs                   | works   | `ir.gpu` 6.79 ms (the Air: 10.2 cool), CV 0.76% without one excursion; last three runs within 0.1% of the first three; pressure 0                    | far-shore 1600×900@1 |
| M3    | Sustained load, 10.4 min, 18 runs                   | works   | `ir.gpu` 21.24 ms (the Air: 39.8), CV 0.27%; last three 0.19% below the first three; rAF 41–42; buffer 2880×1800; pressure 0                         | far-shore 1440×900@2 |
| M4    | A second session after M3                           | works   | 11 runs over 4 min: median `ir.gpu` 6.777 ms against M2's 6.782 (−0.07%), CV 0.23%, after about 25 minutes of load                                   | far-shore 1600×900@1 |
| M5    | drive.mjs headed, window at x=2400                  | partial | 100.7–102.9 rAF/s with the display asleep, 98.6–100.7 awake, gaps to 16.8–18.2 ms, never 120; one `ir.gpu(120)` a run, 6.81 and 6.93 ms, as headless | far-shore 1600×900@1 |
| M6    | Playwright headed, on screen, display awake, 2 runs | partial | `ir.gpu` min of three 14.87 and 14.86 ms, 2.2× headless; rAF 47.8–48.3; settle 16.7–18.4 s                                                           | far-shore 1600×900@1 |

Further results behind the table:

- **No step.** Neither window shows the Air's step. Boot read 4.8–6.0 s and settle 12.2–12.5 s at 1600×900@1 from the first run to the last, where the Air's settle went from 12–18 s to 28–31 s. Thermal pressure read 0 before and after every run.
- **One excursion.** M2's runs 10 and 11, 3.8–4.6 minutes in, read 7.03–7.77 ms, rising within each run. The next 15 runs read 6.77–6.82 ms under the same load, where the Air's step held until 5 idle minutes. A code review and citation scripts were running on the machine at the time. M3 ran beside nothing heavier than editing and has none. The cause is unattributed. It is the figure the first wave's quiet windows exist to keep out.
- **Settle is a frame count.** The cold settle is about 735 presented frames at both windows: 12.24 s at 60 fps and 17.66 s at 42.1 fps. That is the final sky tier, 1,536 tiles at two a frame ([perf.md](perf.md):266-271). Where frames already run at 60, a faster GPU cannot shorten it, so a fresh-context suite costs as much wall time on the mini as on the Air.
- **A headed rig there is not a 120 Hz rig.** drive.mjs puts its window at x=2400, past the mini's 1920-point desktop, and the off-screen window gets about 100 irregular frames a second whether the display sleeps or not. An on-screen window gets the panel and pays for it: N6 found headed `ir.gpu` 0.14 ms above headless on the Air's built-in panel, and M6 finds it 2.2× headless on the mini's 4K TV. The cause is unmeasured; compositing the 3840×2160 desktop is the candidate.
- **What it does not establish.** M2 and M4 are one same-day pair, and M3 one session, against the 2% between-session target P48 sets. A stored baseline there waits on P48's repeated-session calibration.

**The first wave's GPU lane.** Measured on the same machine later that day as G1–G5 ([The first wave, on the Mac mini](#the-first-wave-on-the-mac-mini)), at `830c243` (`origin/main` after the ISS merge), the dev build served by `pnpm dev:client`, except G3, which `presets:compare` serves itself. One step ran at a time. Thermal pressure read 0 before and after every run. G2 and G5 ran with nothing else working on the machine; G3 reports pixels, so it ran beside the Node lane, whose one-minute load average reached 13.6.

| Step | Question                                             | Verdict | Number                                                                                                                                                                                              | Point                                              |
| ---- | ---------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| G1   | A synthetic key from `--js` on a warm page           | works   | a `keydown` and `keyup` carrying `code: 'Backquote'` flip the stored `ir.hud.debug.on` preference, dispatched on `window` or on `document`; the same pair with only `key` does nothing on either    | earthrise 1600×900@1 · headed drive.mjs            |
| G2   | Is a warm load an archive hit; what holds the settle | works   | warm relaunch and warm navigation hit the sky archive in 20 of 20 runs; warm settle 0.51–0.52 s at earthrise and 8.66–8.74 s at far-shore (medians), closed by `terrain.deposits`; one cold cluster | both, 1600×900@1 · headless, 5 runs an arm         |
| G3   | Dark-plate self-noise, headed                        | works   | 0 px over 3% on all 13 pictures, the six dark ones included, on a wiped rig profile and on a persistent one; 52 of 52 captures settled                                                              | the 13 pictures, 480×320@1 · headed, display awake |
| G4   | Dark-plate self-noise, headless                      | not run | G3 decided                                                                                                                                                                                          | —                                                  |
| G5   | What an idle rig holds                               | works   | detached: GPU process 0.02% of a core and 0% GPU utilization, against 49% and 90% attached; about 2 GB of GPU-driver allocations, detached or held, until `--down`                                  | far-shore 1600×900@1 · headed, display asleep      |

**Warm loads (G2).** Five runs an arm, interleaved, each through `launchPersistentContext`. A cold run starts on an empty profile directory. A warm relaunch is a new browser process on a profile in which the point has settled. A warm navigation is a new page's `goto` in a context that has settled it, which no earlier probe measured.

| Point     | Arm             | Boot, median | Settle, median (range)    | Frames in settle | Last settle input                    |
| --------- | --------------- | ------------ | ------------------------- | ---------------- | ------------------------------------ |
| earthrise | cold            | 4,245 ms     | 12,306 ms (12,231–12,325) | 731              | `sky.pending`                        |
| earthrise | warm relaunch   | 3,981 ms     | 522 ms (254–540)          | 31               | `terrain.deposits`, or none (1 of 5) |
| earthrise | warm navigation | 3,883 ms     | 509 ms (256–538)          | 31               | `terrain.deposits`, or none (2 of 5) |
| far-shore | cold            | 4,417 ms     | 12,296 ms (12,212–12,357) | 717              | `sky.pending`                        |
| far-shore | warm relaunch   | 4,216 ms     | 8,743 ms (8,607–9,078)    | 519              | `terrain.deposits`                   |
| far-shore | warm navigation | 4,141 ms     | 8,655 ms (8,525–9,076)    | 504              | `terrain.deposits`                   |

A warm load restores the 512 cube before `booted`, and the terrain heightfield cache answers from disk: 374–417 of 417 tiles at earthrise, 1,194–1,218 of 1,218 at far-shore. Far-shore's deposit slope table ([ADR-0051](../../docs/adr/0051-a-rock-stands-on-the-drawn-ground.md)) is measured after every load, warm or cold, and lands 8.3–8.8 s after `booted` warm and 9.0–9.4 s cold. So a warm context saves about 12 s at earthrise and about 3.6 s at far-shore. The cold settle at both points is the sky's final tier, quiet at 11.96–12.10 s, and the mini shows no second far-shore cluster.

**The census (G3).** `compare.mjs --all --twice` ran twice, unedited, through an instrumented copy of `capture.mjs` that also read `ir.galaxy()` after each shot: first on a wiped rig profile, then on the profile the first run left, with the display held awake by `caffeinate -d`. Every picture read 0 px over 3% between its two captures, in both runs and across them. The zero holds at the 3% level, not at fuzz 0: far-shore has 134,197–137,280 of its 153,600 pixels differing by 1–4 of 255, and the Sol pictures 0–414 pixels by at most 4. The persistent profile restores only Sol skies, because the sky archive keeps two entries (`GALAXY_SKY_ARCHIVE_ENTRIES`, [`galaxySkyArchive.ts`](../../apps/game/src/render/galaxySkyArchive.ts):13) and the five pictures outside Sol evict each other, so earthrise is the one direct pair of a bake against a restore, at 0 px. Against the committed JPEG plates at 8%, computed offline from the saved captures, every picture reads 0–49 px except tau-ceti-moonrise at 124 and centauri-daybreak at 231, the one over `NOISE_FLOOR` (200). The inferred cause is the TV's color profile, which the mini's captures carry; no run separated it from the machine.

**The idle rig (G5).** A drive.mjs rig on its own port, sampled once a second for 60 s in each state, with the display asleep throughout. CPU is from `ps`, as a share of one core. Utilization and driver allocations are from `ioreg -r -c AGXAccelerator`'s `PerformanceStatistics`, as medians, and allocations in MiB. The GPU process's footprint is from `footprint`, which counts the process rather than the driver's allocations.

| State          | GPU process | Renderer | GPU utilization | Driver allocations over baseline, MiB |
| -------------- | ----------- | -------- | --------------- | ------------------------------------- |
| live, attached | 49.2%       | 78.2%    | 90%             | +2,218                                |
| idle, detached | 0.02%       | 1.07%    | 0%              | +1,869                                |
| held, attached | 1.07%       | 5.37%    | 0%              | +1,849                                |
| held, detached | 0.02%       | 0.80%    | 0%              | +1,883                                |
| after `--down` | —           | —        | 0%              | 0 (baseline 1,148)                    |

Detached, the page rendered at most 4 frames in 66.7 s, the re-attach included, so a hold adds nothing to a detached rig. Each state's first `ioreg` read after rendering stops is a stale 79–90%, the no-rig baseline's too, which is why the column is a median. Detached or held, the GPU process keeps a 2.0–2.2 GB footprint, about 1.6 GB of it graphics, and only `--down` returns the allocations. The hold is the engine's own `holdFrames()`, reached from a `--file` step by importing `/src/engine/frameHold.ts` from the dev server, with no engine change: the sim tick and the render calls stopped for the 154 s hold and resumed within 3 s of release.

**The sandbox (unit N1).** A Claude Code worktree subagent there, in bypass-permissions mode with worktree isolation, created and removed a file in `git rev-parse --git-common-dir` through node's `openSync(…, 'wx')`. The harness's worktree guard refuses a `node -e` that runs git inside itself, so the path comes from a plain `git rev-parse` first.

**What the first wave does not establish.** G3 is the mini's figure, on the TV's color profile; the Air's headed census is unmeasured. G5 ran with the display asleep, so whether a detached rig keeps rendering beside an awake display is unmeasured. Far-shore's 17–19 s settle cluster is the Air's, and the mini does not reproduce it.

### What was not run

- **Hosted CI.** No browser ran on the hosted macOS or Linux runners. Every figure is about the Air, except the Mac mini's own.
- **Dark plates headless.** No dark picture was captured headless, and headless plate parity was measured for 2 of the 13 pictures, both lit. Headed, each of the 13 was captured four times on the Mac mini, twice in each of G3's two runs.
- **drive.mjs headless.** drive.mjs has never launched headless. Every headless figure is Playwright-launched Chrome running with Playwright's switches.
- **Occlusion.** Real occlusion of a headed Playwright window was not tested.
- **Thin points.** far-shore at 2880×1800 was measured once on the Air; the Mac mini has 18 runs (M3). Most capability probes ran once per mode.
- **Production per-frame cost.** It is unresolved because N7's interleaved session ran hot. Only the heap result is clean. No production-against-production A/B was run, and the DPR A/B ran on the dev build.
- **The Chrome for Testing gap.** CfT 151 against Chrome 157 (probe D) was measured sequentially, with thermal state uncontrolled.
- **`page.clock` off the main thread.** Probe H checked the main thread only. Worker clocks, GPU completion and the presentation watchdog under a paused clock were not probed.
- **Other A/Bs and throttling.** No run used `?workers=1`, `?producer=cpu`, CPU throttling or network throttling.
- **Other engines and versions.** Firefox, WebKit and Playwright 1.65 were not run.
- **The thermal cause.** It was not measured, because `powermetrics` needs sudo.
- **Attach paths.** None of these ran: `browser.bind()`, `connectOverCDP` to the rig's Chrome, `playwright-cli attach --cdp`.
- **Device emulation.** None of these ran: `hasTouch` against `(pointer: coarse)`, pointer lock, `Emulation.setSafeAreaInsetsOverride`, the headless audio pipeline.
- **Sandbox writes.** Whether the Codex and EnterWorktree sandboxes can write the git common directory was not checked. On the Mac mini a full-access T3 Code session can, and so can a Claude Code worktree subagent (unit N1).
- **Environment noise.** Every dev-server load logged three 504 "Outdated Optimize Dep", nine 404s and 3–15 502s (no Worker running). None of them stopped a boot.

---

## The rig and Playwright side by side

| Capability            | The rig today                                   | Playwright                                                     | Verdict                        |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------ |
| Warm probe loop       | ~80 ms attach to a booted page across processes | dies with its process; `connectOverCDP` or `bind()` unmeasured | rig                            |
| Boot readiness        | `ir.status().boot` ladder; renderer-mode race   | `goto` commit tracking; boot still polled                      | shared module (P02, C4)        |
| Occluded rAF          | focus emulation and `bringToFront` every call   | focus emulation default; anti-backgrounding flags              | absorbed; occlusion untested   |
| Headless              | refused; header says it presents nothing        | Chrome 157 new headless: Metal, 60 fps cast, AE 0 plates       | both; P08 brings it to the rig |
| Default browser       | Chrome stable                                   | headless shell (SwiftShader) or CfT 151                        | trap; P03                      |
| Color profile         | display; `dynamicRangeHigh` true                | forced sRGB; `dynamicRangeHigh` false                          | trap 11 returns                |
| Stills                | two `captureScreenshot`, keep the second        | one `captureScreenshot`, same path                             | equal                          |
| Plate comparator      | magick 3%/8%, 200 px floor, lit gate            | pixelmatch YIQ 0.2, `ssim-cie94`                               | keep the rig's matcher         |
| Cast                  | screencast, ack inside the handler, 60 fps      | CDPSession, same 60 fps; recordVideo 25 fps                    | port via CDPSession            |
| Chrome trace          | Tracing over the page socket                    | `browser.startTracing`; readers accept it                      | either                         |
| Action trace          | none                                            | 6.7–15.4 MB per 5 s                                            | Playwright, failures only      |
| Keys                  | none; a `code`-carrying synthetic event works   | `keyboard.press`, trusted                                      | both (P07, P34)                |
| Pointer drag          | synthetic; capture stubbed                      | trusted mouse; HTML5 drag manager                              | Playwright for the dock        |
| Touch                 | none                                            | tap only; long press via CDP                                   | CDPSession                     |
| Gamepad               | none                                            | none                                                           | init-script fake               |
| Pointer lock          | none                                            | no permission name                                             | open                           |
| Network               | URL blocking                                    | `route`, HAR, `routeWebSocket`, `setOffline`                   | Playwright                     |
| Permissions and media | raw CDP in scratch scripts                      | `grantPermissions`, fake-media flags                           | Playwright                     |
| Service worker        | survives every invocation                       | per-context; `setOffline` reaches it                           | Playwright                     |
| Contexts and tabs     | the first `http` page only                      | many contexts                                                  | Playwright                     |
| Assertions and report | none; callers parse `--json`                    | runner, retries, reporters                                     | Playwright                     |
| Frame stepping        | none                                            | `page.clock`: 1 frame per `runFor(16)`, timing blanked         | its own lane (P22)             |
| Storage clearing      | local and session; keeps IndexedDB              | fresh context wipes all; `setStorageState` wipes saves         | rig semantics via CDPSession   |
| DPR                   | live metrics override                           | per context; real 2880×1800 buffer                             | Playwright for points          |
| GPU exclusivity       | none                                            | locks inside one run only                                      | neither; P01                   |
| Dev server            | `dev.mjs`; accepts a foreign Vite               | `webServer`; same holes                                        | X3                             |
| Linux CI              | hard-coded macOS Chrome path                    | yes                                                            | Playwright, shell only         |

### What Playwright absorbs

- **Process and protocol robustness.** Playwright owns the browser's lifetime, which covers about 7 of the rig's 22 recorded defects: orphaned processes, uncleared timers, a dead socket read as success, the trace `RangeError`.
- **CLI parsing.** About 5 defects disappear when steps are code instead of flags.
- **Trap 10.** Its cause is precise. The keymap resolves chords from `event.code` and does not reject untrusted events ([`keymapStore.ts`](../../apps/game/src/input/keymapStore.ts):489-493). A `key`-only synthetic event does nothing. Trusted `keyboard.press` sidesteps the question.
- **Console replay across navigations.** Per-page console events replace a second `Runtime.enable` that replays the previous page's output.

### What Playwright reintroduces

- **The browser it picks.** The default headless shell lands on SwiftShader at 1 fps, and the bundled CfT 151 costs 2–5× the GPU time. Both are browsers no player runs.
- **Launch switches.** `--force-color-profile=srgb` takes `(dynamic-range: high)` and the extended-output path with it, and `--disable-back-forward-cache` hides the `pageshow(persisted)` path.
- **Cold settle.** A fresh context pays 12–20 s of settle per test. drive.mjs is warm by default: its per-port profile keeps the IndexedDB sky and terrain archives, because [`drivePage.mjs`](../../scripts/drivePage.mjs) clears only local and session storage.
- **Polling and parallelism.** `waitForFunction`'s default `raf` polling hangs whenever rAF is suspended. The runner's default parallelism breaks the one-GPU-job rule. The rule exists because two overlapping GPU jobs have crashed macOS twice, and it is written down only in agent memory.
- **`page.clock`.** It replaces `performance`, so `mark` and `measure` return dummy entries and [`browserTiming.ts`](../../apps/game/src/engine/browserTiming.ts) goes blank. `ir.profile` hangs on a faked `setTimeout`.
- **A looser image check.** `toHaveScreenshot`'s YIQ threshold of 0.2 is looser than the house 3%/8% rule. recordVideo's fixed 25 fps hides any strobe faster than 12.5 Hz.

### What stays under any driver

Several things are contracts with the app, and every driver has to keep them:

- `?presentation=occluded` on every URL.
- `booted`, never `window.ir` alone, as the readiness signal.
- Two quiet `ir.settled()` reads.
- A WebGPU canvas read back only inside rAF.
- Terrain selection measured in display pixels.
- An operating point outside Sol.
- The thermal step.

---

## The proposals, ranked by return

Every score is a mean over several scorers. The forty-nine proposals the generators wrote were scored four times: at consolidation, and by each of three reviews (feasibility, fit, completeness). The nineteen a review added were scored three times: by the review that wrote it, and by the two that did not. The return is computed from those means:

> **ROI = value × (confidence / 5) / (max(0.5, effortDays) × (0.75 + risk / 4))**

Value, risk and confidence run from 1 to 5. Effort is in agent-days. The table rounds E to one decimal, so the last digit of ROI may not reproduce from the columns.

A **veto** names a review that would drop the proposal. A vetoed proposal keeps its rank and its section, because its reasoning belongs on record. Each added proposal's section ends with a **Review** paragraph carrying the two cross-reviews. One idea was dropped before scoring: Safari WebGPU through Playwright's bundled WebKit, which exposes no `navigator.gpu` ([#39762](https://github.com/microsoft/playwright/issues/39762), closed as not planned). P47 keeps Safari coverage through `safaridriver` instead.

| #   | id                      | Title                                | V    | E   | R    | C    | ROI   | Needs               | Veto        |
| --- | ----------------------- | ------------------------------------ | ---- | --- | ---- | ---- | ----- | ------------------- | ----------- |
| 1   | dark-plate-noise-census | Dark-plate self-noise                | 3.67 | 0.6 | 1    | 3.67 | 4.610 | P01                 |             |
| 2   | C4                      | Boot-ladder commit race              | 2.33 | 0.5 | 1    | 4    | 3.733 | —                   |             |
| 3   | settle-attribution      | What the cold settle waits on        | 2.67 | 0.5 | 1    | 3.33 | 3.556 | P01                 | fit, compl. |
| 4   | C2                      | Record the thermal step              | 3.33 | 0.6 | 1    | 3    | 3.429 | —                   |             |
| 5   | C1                      | Correct the disproved rig docs       | 2.33 | 0.5 | 1    | 3.67 | 3.422 | —                   |             |
| 6   | P03                     | Launch preset and guard              | 3.75 | 1.1 | 1    | 4    | 2.667 | —                   |             |
| 7   | P06                     | Tests for the strobe detector        | 3    | 1.1 | 1    | 4.5  | 2.400 | —                   |             |
| 8   | P07                     | Trusted `--key`, `--click`, `--drag` | 3    | 1.5 | 1    | 4    | 1.600 | —                   |             |
| 9   | P13                     | Two lanes in skill and rules         | 3    | 1.6 | 1    | 4    | 1.477 | P04 P07 P08         |             |
| 10  | P20                     | Operating-point registry             | 3.75 | 2.3 | 1    | 4    | 1.333 | —                   |             |
| 11  | X10                     | Thermal-state stamp                  | 2.67 | 1   | 1.33 | 2.67 | 1.313 | P01 P18             |             |
| 12  | P01                     | Machine-wide GPU lock                | 5    | 2.4 | 2.25 | 3.5  | 1.123 | —                   |             |
| 13  | P43                     | PR media in one command              | 2.75 | 2   | 1    | 4    | 1.100 | P01 P06 P14         |             |
| 14  | P39                     | Save fixtures from a release         | 2.5  | 1.4 | 1.75 | 3.5  | 1.072 | P01 P03             |             |
| 15  | P32                     | Hosted macOS runner probe            | 3.75 | 1.9 | 1.75 | 3    | 1.011 | P03 P33             |             |
| 16  | X13                     | Idle rig holds its frames            | 2.67 | 1.1 | 3    | 2.67 | 0.875 | P01                 | feas.       |
| 17  | P37                     | Docs link check and crawl            | 3    | 2.5 | 1.5  | 4    | 0.853 | P35                 |             |
| 18  | P02                     | One contract module, two wires       | 3.5  | 2.4 | 2    | 3.5  | 0.825 | —                   |             |
| 19  | P45                     | Verification receipts                | 2.75 | 2.6 | 1    | 3.75 | 0.786 | P04                 |             |
| 20  | P33                     | Boot lifecycle smoke                 | 3.75 | 2.5 | 2    | 3.25 | 0.780 | P01 P04             |             |
| 21  | X3                      | Ports and server identity            | 3    | 1.8 | 1.67 | 2.67 | 0.748 | —                   |             |
| 22  | P19                     | `ir.environment()`, `ir.perf()`      | 3.75 | 3.1 | 2    | 3.75 | 0.720 | —                   |             |
| 23  | P30                     | Promise verbs, `ir.quiescent()`      | 3    | 2.5 | 2    | 3.75 | 0.720 | —                   |             |
| 24  | P08                     | Headless by default in drive.mjs     | 4    | 2.3 | 3    | 3    | 0.711 | P03 P06             |             |
| 25  | P24                     | Boot record, cold and warm           | 3.5  | 2.5 | 2    | 3    | 0.672 | P01 P18 P19         |             |
| 26  | C3                      | Headless `presets:compare --all`     | 3    | 1.7 | 2    | 2.33 | 0.672 | P08 P01             | compl.      |
| 27  | P42                     | Upgrade smoke                        | 3.5  | 2.8 | 2    | 3    | 0.611 | P01 P14 P18 P33 P34 |             |
| 28  | P18                     | `pnpm perf:compare`                  | 4.75 | 4.8 | 2    | 3.75 | 0.600 | P01 P04 P05         |             |
| 29  | P35                     | GPU-free shell project               | 4    | 3.1 | 2.25 | 3    | 0.585 | P04                 |             |
| 30  | X4                      | Browser group in the check graph     | 2.67 | 1.8 | 2.33 | 2.67 | 0.582 | P01 P33             | feas., fit  |
| 31  | P09                     | Bridges between the lanes            | 2    | 1.3 | 2    | 2.25 | 0.576 | P02 P04             |             |
| 32  | P31                     | Motion points by trusted input       | 3.75 | 3.1 | 2    | 3    | 0.576 | P18 P20 P30         |             |
| 33  | X2                      | Pin the measurement browser          | 2.67 | 1.5 | 2    | 2    | 0.569 | P01                 | feas., fit  |
| 34  | X9                      | Cloned warm-state template           | 2.67 | 1.8 | 2    | 2.33 | 0.543 | P04                 | fit         |
| 35  | X12                     | Refresh rate as an axis              | 2.33 | 1.5 | 1.67 | 2    | 0.533 | P20 P21             | fit         |
| 36  | P34                     | Input correctness specs              | 3.75 | 3.4 | 2    | 3    | 0.533 | P01 P04             |             |
| 37  | P04                     | Playwright Test and rig fixture      | 3.75 | 4.1 | 2    | 3.5  | 0.509 | P01 P02 P03         |             |
| 38  | X5                      | Late pipeline-compile census         | 3.33 | 2.8 | 2    | 2.67 | 0.502 | P04 P20             |             |
| 39  | P27                     | Work-counter ledger                  | 3.5  | 3.1 | 2    | 2.75 | 0.493 | P20                 |             |
| 40  | P25                     | Trace-driven attribution             | 2.75 | 2.8 | 2    | 3    | 0.480 | P18                 |             |
| 41  | P48                     | Fan-cooled perf runner               | 3.75 | 3   | 3    | 2.75 | 0.458 | P01 P18             |             |
| 42  | P12                     | Vitest Browser Mode                  | 1.5  | 1.7 | 1.5  | 2.75 | 0.438 | —                   | fit, compl. |
| 43  | P05                     | Measurement fixtures                 | 3.75 | 4.6 | 2    | 3.25 | 0.422 | P04                 |             |
| 44  | X11                     | Accounts in the browser              | 2.33 | 2.5 | 2.33 | 3    | 0.420 | P35                 | fit         |
| 45  | P36                     | Accessibility assertions             | 2.75 | 3   | 2    | 2.75 | 0.403 | P01 P35             |             |
| 46  | P41                     | Cinema reference loop                | 2.5  | 3   | 2    | 3    | 0.400 | P01 P14             | fit         |
| 47  | P28                     | Quality-knob registry                | 2.75 | 3.1 | 3    | 3.25 | 0.381 | —                   |             |
| 48  | X8                      | Draw-class marginal cost             | 3    | 3.2 | 2.33 | 2.33 | 0.332 | P18 P20             |             |
| 49  | P14                     | Plates as a Playwright suite         | 4    | 4.9 | 3    | 3    | 0.328 | P01 P04             |             |
| 50  | P22                     | `page.clock` temporal lane           | 3.5  | 4.1 | 3    | 2.75 | 0.311 | P01 P04 P06 P20     |             |
| 51  | X6                      | WebKit and Firefox shell             | 2.33 | 2.8 | 2    | 2.33 | 0.307 | P35 P01             | fit         |
| 52  | P26                     | Nightly paired perf series           | 2.75 | 3   | 3    | 2.5  | 0.306 | P01 P18 P24         | fit         |
| 53  | X7                      | Handheld and compact points          | 2.33 | 3   | 2    | 2.33 | 0.290 | P04 P20 P01         | fit         |
| 54  | P23                     | Memory lane and heap diff            | 3.75 | 5   | 3    | 2.75 | 0.275 | P01 P05 P18 P19 P20 |             |
| 55  | P16                     | Automated bisection                  | 3.5  | 4.8 | 2.5  | 2.5  | 0.268 | P01 P14 P18         |             |
| 56  | X1                      | Presentation fault lane              | 3.33 | 3.7 | 3.33 | 2.33 | 0.268 | P01 P04             |             |
| 57  | P38                     | Service worker across builds         | 2.75 | 4   | 3    | 2.75 | 0.252 | P01 P04             |             |
| 58  | P21                     | `ir.stepFrames()`                    | 3.5  | 4.8 | 4    | 2.75 | 0.232 | —                   | fit         |
| 59  | P40                     | Recorded input replay                | 3.5  | 6.3 | 3    | 3    | 0.224 | P34 P39             |             |
| 60  | P49                     | Playwright Test Agents               | 1.5  | 3   | 3    | 2.5  | 0.167 | P35                 | all three   |
| 61  | P15                     | Self-triaging plates                 | 2.5  | 4.3 | 3    | 2    | 0.157 | P14 P16             | fit         |
| 62  | P46                     | Browser property fuzzer              | 2.5  | 5   | 3    | 2.25 | 0.150 | P01 P05             | fit         |
| 63  | P29                     | Budget tuner                         | 3.25 | 6.3 | 3    | 2    | 0.139 | P01 P18 P19 P20 P28 |             |
| 64  | P11                     | ir-mcp server                        | 3    | 6.5 | 3    | 2.25 | 0.138 | P01 P02 P03         | fit         |
| 65  | P44                     | Guide over loopback WebRTC           | 2.5  | 5.3 | 3    | 2    | 0.127 | P01 P04             |             |
| 66  | P47                     | Differential rendering               | 2.75 | 6.6 | 3.5  | 2.25 | 0.115 | P01 P14 P18         |             |
| 67  | P17                     | Moved-plate explainer                | 2.5  | 9   | 4    | 2    | 0.063 | P04 P16             | fit         |
| 68  | P10                     | Full replacement (on record)         | 1.5  | 12  | 4    | 3.5  | 0.050 | P04 P07             | all three   |

Each section below gives the claims behind a proposal and their status:

- **measured:** a probe in this spike.
- **verified:** read in the repository or the installed package.
- **sourced:** an external document read for the spike.
- **inferred:** reasoned from the above.
- **training data:** not read from a source now.
- **unverified:** stated with nothing behind it.

A review's correction is folded into the mechanism where the correction is accepted.

### 1. dark-plate-noise-census: measure dark-plate self-noise headed and headless before choosing how to close the #180 blind spot

**Pitch.** [CONTEXT.md](../../CONTEXT.md):12504-12506 records that #180's comparison passed with titans-haze and centauri-daybreak moved 1.34% and 1.71%. On a 480×320 plate that is about 2,060 and 2,630 px. That is the same order as the "thousands of pixels" that [`compare.mjs`](../../scripts/presets/compare.mjs):84-99 gives for headed star fields. One measurement says whether dark plates can be reported by default headed, or need headless determinism.

**Mechanism.** Two runs of one tree under P01.

1. The incumbent: `pnpm presets:compare --all --twice`, recording px over 3% for each picture.
2. The 13 pictures captured twice in fresh Chrome 157 headless contexts at 480×320@1.

Tabulate each picture's self-noise beside #180's deltas, then decide:

- If headed noise sits well under the deltas, [`compare.mjs`](../../scripts/presets/compare.mjs) reports dark plates by default against a per-picture floor taken by `--twice`.
- If it does not, the headless path (C3, or P14) is the fix.

**Builds on.** [`compare.mjs`](../../scripts/presets/compare.mjs), [`capture.mjs`](../../scripts/presets/capture.mjs), [`pictures.ts`](../../packages/devtools/src/pictures.ts).

**First step.** One `pnpm presets:compare --all --twice` on HEAD, on a cool machine.

**Success.** A table of the 13 pictures by headed and headless self-noise, beside the #180 deltas, and a recorded decision: a `compare.mjs` default change, C3, P14, or a combination.

**Risks.** About an hour of GPU time. The thermal step changes settle time. Whether it changes pixels is unmeasured.

**Claims.**

- `--all` and `--twice` exist (`compare.mjs`:110-111): verified.
- Headed star fields differ between captures by thousands of pixels: verified as written in `compare.mjs`.
- Headless earthrise, 55% of it below 12% gray, was AE 0 at fuzz 0 across launches: measured. That is partial evidence for dark pictures.

**Review.** Both cross-reviews kept it and sharpened it. The dark exclusion in `compare.mjs` and ADR-0046 rests on a measurement taken before the settle protocol: 1,069–3,090 px at a 2.5 s wait, in the same CONTEXT.md entry that shows settling took the lit pictures from 7,939 px to 0 ([CONTEXT.md](../../CONTEXT.md):10483-10494). The headed arm alone may therefore show the dark plates are deterministic now, and the headless arm runs only if it does not. Each capture records `ir.galaxy()`'s archive hits, and the incumbent arm runs once more on a wiped profile. Its persistent profile can compare a bake with a restore, and the galaxy volume accumulates temporally (stride 8, [`GalaxyVolume.tsx`](../../apps/game/src/scene/GalaxyVolume.tsx):46), so a gap is not blamed on headedness by default. The two arms run interleaved or with a cool-down between them. It supersedes C3, which measures the headless half only and waits on P08.

**Result (G3).** The headed arm decides it, on the Mac mini. Both runs read 0 px over 3% on all 13 pictures, the six dark ones included, against #180's roughly 2,060 and 2,630 px. "Well under" was a ceiling of 515 px, a quarter of the smaller delta. The decision is a change to [`compare.mjs`](../../scripts/presets/compare.mjs): dark plates reported by default against a per-picture floor taken by `--twice` (Phase 1). The headless arm (G4) does not run, and C3 and P14 drop for this blind spot. The floor belongs to the machine that takes it: the mini's captures read centauri-daybreak 231 px from its committed plate at 8%, with the TV's color profile the inferred cause. The Air's headed census is unmeasured.

### 2. C4: fix the boot ladder's renderer-mode commit race on its own

**Pitch.** In renderer mode `committed` is `!document || …` ([`drivePage.mjs`](../../scripts/drivePage.mjs):122-127), which is immediately true. After `Page.navigate` and a 500 ms sleep, the old page's `booted` can therefore satisfy `READY`. The window for this is `--keep-storage` with `--reload` or `--fresh` against a slow commit. P02 carries the fix inside a two-day refactor. On its own it is a half-day change with its own test.

**Mechanism.** Require the frame tree's `loaderId` to match the navigation's in both modes, keeping the `navigation.loaderId === undefined` escape. Add a [`drivePage.test.mjs`](../../scripts/drivePage.test.mjs) case using the existing fake socket: `Page.getFrameTree` reports the old loader for 600 ms while `READY` already answers true.

**First step.** The failing test, written first.

**Success.** The test fails against today's file and passes after the change. The other cases are unchanged.

**Risks.** One extra round trip per poll. The hazard is inferred from the code and has not been reproduced live.

**Claims.**

- The short-circuit: verified.
- The fake-socket suite (12 cases): verified.

**Review.** Both cross-reviews kept it at lower value. No wrong-page reading is on record, and the exposure needs a commit slower than the 500 ms sleep. The window is wider than stated: any `--keep-storage` invocation whose URL differs from the booted page navigates without the `about:blank` hop. The test covers `--reload` as well, and it is the regression test P02 ports.

**First wave (unit N2, #188).** Built, with three cases: the race through `--reload`'s forced boot and through a `--keep-storage` run onto another URL, and the `loaderId === undefined` escape. The two race cases fail against `drivePage.mjs` at `830c243`. The exposure is wider than either account above: `--reload` is exposed without `--keep-storage` too, because [`drive.mjs`](../../scripts/drive.mjs) clears storage only before its initial boot, and its `reboot` never clears. In the fake, the change adds one `Page.getFrameTree` per poll and no time.

### 3. settle-attribution: find out what the 12-second cold settle waits on (vetoed by fit and completeness)

It proposed a timeline of every settle input on cold and warm loads, on the premise that the galaxy tiles reading 0/1638 at both settles meant the cold settle is not the sky's progressive refinement. The premise does not hold. The cache reports `completedTiles` as 0 whenever nothing is pending ([`galaxyCache.ts`](../../apps/game/src/render/galaxyCache.ts):194), and the harness says so beside the readout ([`harness.ts`](../../packages/devtools/src/harness.ts):706-708). [perf.md](perf.md):266-271 already has the arithmetic: the final 512² tier is 1,536 tiles at two a submitted frame, about 12.8 s at 60 fps, against the measured 12.1–12.7 s. Probe B ran its success metric too: in one context, far-shore, a new galactic position, settled in 13.0 s after the earthrise reload's 0.52 s, so a warm settle is per position, not per context.

**Kept as:** P24's first step. It reads `ir.galaxy()`'s archive hits on a warm load, and attributes far-shore's two settle clusters (12–13 s against 17–19 s), which the sky does not explain. G2 ran it on the Mac mini ([On the Mac mini](#on-the-mac-mini)). A warm load is an archive hit, and the mini settles far-shore cold in one cluster, so the second cluster is the Air's to attribute: a run there that logs G2's per-input timeline answers it.

### 4. C2: write the fanless-Air thermal step into the perf plan and the driving card

**Pitch.** This machine (Mac17,4) steps every figure up by about 35% after about 3.5 minutes of load, and recovers after 5 idle minutes. None of these mention it: [perf.md](perf.md), [`driving.md`](../../docs/agents/driving.md), [`harness.md`](../../docs/guides/harness.md), SKILL.md. Two standing habits compare two temperatures: the baseline-then-branch plate and boot series, and six boots per build.

**Mechanism.** A section in perf.md records the numbers:

- far-shore `ir.gpu` 10.2 → 13.4–15.3 ms.
- Settle 12–18 → 28–31 s.
- Boot 5 → 7–8 s.
- An 8% disagreement between cool sessions.
- `pmset` recording no warning.

The rule it implies: interleave base and candidate in one session, or idle 5 minutes between arms, and name the thermal state of every figure. perf.md figures taken sequentially across builds are marked as possibly confounded. driving.md and SKILL.md gain a trap. They also record that headless rAF is a fixed 60 Hz clock, and that CPU spans move with GPU load on this SoC.

**First step.** `rg -n` over perf.md for before/after figures taken in separate runs, listing which were sequential.

**Success.** perf.md and driving.md state the step, its onset and its recovery, with numbers. Every sequential cross-build figure in perf.md carries a thermal note or is re-measured interleaved.

**Risks.** The cause is inferred, since `powermetrics` needs sudo. The protocol does not depend on it. The trap is written as a fact about this machine at its measured point.

**Claims.**

- The step and its recovery: measured (N5).
- No mention of thermal, throttling or fanless in the four documents: checked.

**Review.** The onset and the recovery each rest on one observation at far-shore 1600×900@1, and the cause is inferred, so the text names the point and says so. Interleaving comes first in the rule. A six-boot series or a 13-plate pass runs 3–6 minutes and outlasts the onset, so idling between arms suits short arms only. Tagging past perf.md figures "possibly confounded" cannot be acted on, because no figure records its thermal state. The scope is one bullet in perf.md's "Caveats that shape these numbers" and one trap in driving.md and SKILL.md. The trap names the machine. The step is a fact about the fanless Air. The Mac mini held flat through 10 sustained minutes at two windows ([On the Mac mini](#on-the-mac-mini)), but that is one session at each, so the rule holds on both machines until P48's calibration gives a between-session spread.

**First wave (unit N6, #188).** Written: a caveat in perf.md, trap 8 in driving.md and trap 12 in SKILL.md, each naming the Air. [`harness.md`](../../docs/guides/harness.md) carries no thermal note, which the review's scope leaves out.

### 5. C1: correct the rig documentation the probes disproved, now

**Pitch.** Three claims in the rig's documentation are measured false:

- [`drive.mjs`](../../scripts/drive.mjs):28-35 says a headless compositor "presents nothing".
- The same lines say "SwiftShader has no macOS build to fall back to".
- [`SKILL.md`](../../.claude/skills/drive/SKILL.md) trap 10 says a synthetic `KeyboardEvent` cannot fire a binding.

Agents follow those lines every day, and correcting them does not wait on P04, P07 or P08.

**Mechanism.** The drive.mjs header keeps the window, with the reasons that hold:

- Pacing is real only headed, because headless rAF is a fixed 60 Hz clock (N1, N4). Headed pacing follows the window: about 60 Hz on the Air, and about 100 irregular rAF/s for the off-screen rig on the Mac mini, whose panel runs at 120 Hz (M5).
- The extended-range path needs the display profile (probe A).
- The guide needs an audio pipeline.

Trap 10 states the measured cause. The keymap resolves chords from `event.code` and accepts untrusted events ([`keymapStore.ts`](../../apps/game/src/input/keymapStore.ts):489-493). So `dispatchEvent(new KeyboardEvent('keydown', {code: 'Backquote', bubbles: true}))` from `--js` works, and a `key`-only event does nothing. The text is written in the present tense, and a `/context-log` entry carries the probe figures.

**First step.** Draft the new trap 10 from probe E. Then check that `drive.mjs --keep-storage --js` with a `code`-carrying event flips the instruments on a warm page. The readout is the stored preference, `localStorage['ir.hud.debug.on']` ([`preferences.ts`](../../apps/game/src/state/preferences.ts):107, 721-727), which is a storage key and not a field of `ir`. That check is one GPU job.

**Success.** `rg` finds no sentence in `scripts/`, `.claude/` or `docs/agents/` making any of the three claims, and `docs:build` passes.

**Risks.** drive.mjs itself has never launched headless. The header says what was measured, which is Playwright-launched Chrome 157 in new headless, and claims nothing for drive.mjs until P08 validates it.

**Claims.**

- The keymap accepts untrusted events: verified.
- A `code`-carrying synthetic event toggles the instruments: measured (E).
- Chrome 157 headless screencasts at 60 fps: measured (F).

**Review.** [`driving.md`](../../docs/agents/driving.md) carries none of the three claims, so its part of the scope is empty. The false lines are `drive.mjs`:28-32 and SKILL.md's trap 10. An untrusted event resolves the chord but skips `useDevice('keyboard')` ([`keymapStore.ts`](../../apps/game/src/input/keymapStore.ts):489-493), so it is not what a real key press does, and an `isTrusted` hardening of the keymap would remove it without a sound. The new trap 10 says both and points at a trusted CDP key (P07). drive.mjs has no headless mode until P08, so its header gives the measured headless figures as Playwright-launched Chrome's, and P08 rewrites it again.

**First wave (G1, unit N6, #188).** G1 ran the first step's check on the Mac mini ([On the Mac mini](#on-the-mac-mini)): the stored preference flips on a warm page from a `code`-carrying event on `window` or on `document`, and a `key`-only event does nothing. The keymap's one listener is on `window` ([`keymapStore.ts`](../../apps/game/src/input/keymapStore.ts):645-667), which a `document` dispatch reaches by bubbling, and `chordFromEvent` declines an empty `code` ([`chord.ts`](../../apps/game/src/input/chord.ts):117). #188's trap 10 states that result, and its drive.mjs header states probes A, C and N4.

### 6. P03: a launch preset and an operating-point guard that fail closed

**Pitch.** Three wrong-browser modes fail silently:

- The default headless shell: adapter null, WebGL over SwiftShader, 67 s boot, 1 fps.
- Chrome for Testing 151: 2–5× the GPU time.
- Forced sRGB: `dynamicRangeHigh` false.

One module encodes the measured launch choices. One guard refuses anything else and stamps every result with its operating point.

**Mechanism.** `scripts/driveLaunch.mjs` exports two presets:

- `sdr`: `{channel: 'chrome', headless: true}`.
- `display`: `{channel: 'chrome', headless: false, ignoreDefaultArgs: ['--force-color-profile=srgb']}`, plus a window position.

Before launch, the preset refuses any browser but Chrome stable: `channel` unset, `'chromium'`, or an `executablePath` fails before a page opens, so the shell's 67 s boot is never waited out. A spec that compares browsers (P47 stage 1, X2's question) declares itself a comparison probe and is exempt from this check only.

After boot, `assertOperatingPoint(evaluate)` checks the page through an `evaluate` port, so the same checks run over a Playwright page and over drive.mjs's socket. They are expressions, and they move into P02's expressions module when it lands:

- `engine.gl.description.backend`.
- The adapter is neither a fallback nor a match for [`gpuAdapter.mjs`](../../scripts/gpuAdapter.mjs):30's `SOFTWARE` pattern.
- The drawing buffer equals viewport × `min(DPR, dprCeiling(coarse))` × `pictureDprFactor(picture)`, rounded as the renderer rounds it ([`App.tsx`](../../apps/game/src/App.tsx):419, 755, [`output.ts`](../../apps/game/src/render/output.ts):128-131, [`picture.ts`](../../apps/game/src/render/picture.ts):85-86). A plain viewport × DPR would fail a DPR-3 or coarse-pointer project by design, and a supersampled picture doubles the buffer.
- The served build and tree match the tree under test (X3).

The guard knows three operating-point kinds, `webgpu`, `fallback` and `shell`, so P35 and P47's fallback stage are not refused. It records `browser.version()` and warns when it changes. It does not refuse on a version floor, because Chrome stable updates itself. It returns `{origin, build, browser, viewport, DPR, buffer, adapter, backend, dynamicRangeHigh, picture, Sol or generated}` for `testInfo` annotations. drive.mjs runs the same guard after boot and prints it in `--status`. Once P19 lands, the in-page record is the source and the guard asserts against it, so there is one record.

The headless shell with `--enable-unsafe-webgpu --use-angle=metal` also reaches Metal (probe A). It is not chosen, because players run Chrome stable.

**First step.** Node tests for the guard's decisions over the probe outputs, with no browser.

**Success.**

- A spec with `channel` unset or set to `'chromium'` fails before launch, naming the browser.
- The preset passes.
- Every fixture and every drive.mjs boot runs the guard.

**Risks.** three's `WebGPUBackend` keeps the adapter only as a local, so the engine's adapter is readable only through `device.adapterInfo` (training data). A fresh in-page `requestAdapter()` can answer differently from the device the engine holds. One review puts the effort at 1.5 days.

**Claims.**

- The default shell is on SwiftShader at about 1 fps: measured (A, B).
- CfT 151 26.89 ms against Chrome 157 14.13 ms at far-shore: measured, sequentially.
- Forced sRGB in 1.62.1 (`coreBundle.js`:34668): verified.
- Headed HDR under `ignoreDefaultArgs`: unverified.

**First wave (unit N5, #188).** The presets and the guard are built, with Node tests over fixtures trimmed from the probe outputs, and wired into nothing. A caller's `ignoreDefaultArgs` adds to the preset's, so dropping one more default never restores forced sRGB, and the record names a point's system `sol`, `catalog` or `generated`: a catalog star such as HIP71683 is neither of the other two. `dprCeiling` and `pictureDprFactor` import cleanly under Node's type stripping. [`gpuAdapter.mjs`](../../scripts/gpuAdapter.mjs)'s `SOFTWARE` pattern is not exported, and importing that file runs Dawn's adapter requests and can `process.exit`, so the guard reads the pattern from its source until a module with no side effects exports it. The drive.mjs half and the identity check are the second wave's.

### 7. P06: tests for the strobe detector and trace readers before any transport moves

**Pitch.** [`frameDiff.mjs`](../../scripts/frameDiff.mjs), [`traceFrames.mjs`](../../scripts/traceFrames.mjs) and [`timing.mjs`](../../scripts/timing.mjs) have no tests. Every proposed port claims parity with them, and their verdicts end up in PR bodies.

**Mechanism.** `analyzeFrames(paths, timestamps, {changed})` takes the per-pair pixel count as an injected port. The port is a function of two paths, because the skip comparison asks for pairs that are not adjacent. `frameDiff.test.mjs` runs on synthetic counts:

- A static run: median 0, floor 200.
- A moving camera: no isolated frames.
- A one-frame flash every 26 frames at 60 fps: period 26, about 2.3 Hz.
- Alternating gaps merging under `TOGETHER = 5` (`frameDiff.mjs`:143).
- `reportFrames`' wording below `TRUSTWORTHY_FPS = 40` (`frameDiff.mjs`:188).

Each test is checked against a deliberate mutation of the line it guards. `traceFrames.mjs` and `timing.mjs` parse `argv` at import and export nothing, so they need a small extraction, or tests that spawn the CLI. A synthetic `{traceEvents}` with three Screenshot events covers gzip, plain and bare-array input. The `magick`-backed case skips with a named reason wherever ImageMagick 7 is absent. ubuntu ships ImageMagick 6's `convert` (training data).

**First step.** The port, then the static, moving-camera and periodic-flash cases.

**Success.** Line coverage of `frameDiff.mjs` and `traceFrames.mjs` reaches 90% (0% today). The root coverage config includes only `packages/*/src` and `apps/*/src` ([`vitest.config.ts`](../../vitest.config.ts):116-121), so the figure comes from a focused run: `pnpm vitest run scripts/frameDiff.test.mjs scripts/traceFrames.test.mjs --coverage --coverage.include=scripts/frameDiff.mjs --coverage.include=scripts/traceFrames.mjs`. Each test fails on its mutation. The root suite grows by less than 0.2 s.

**Risks.** None of note. This lands before P02, P08, P14 and P22, which all claim parity with `analyzeFrames`.

**Claims.**

- The only I/O is the per-pair count (`frameDiff.mjs`:111-135): verified.
- The root suite includes `scripts/**/*.test.mjs` ([`vitest.config.ts`](../../vitest.config.ts):49): verified.

**First wave (unit N3, #188).** Built. Line coverage is 100% for `frameDiff.mjs` and 95.65% for `traceFrames.mjs`, and the extraction kept `traceFrames.mjs` and `timing.mjs` byte-identical in 32 of their 34 recorded cases; the other two are crashes whose stack lines moved. The review after it made both readers and `drive.mjs`'s `--cast` count fps as intervals over the span, so a short capture does not read above `TRUSTWORTHY_FPS`, and a trace with no readable frame exits 1 instead of reporting nothing strobes. 30 of 31 mutations of `frameDiff.mjs` fail a test. The survivor is `median`'s index, which takes the upper of the two middle values on an even count, so a five-frame run with one flash isolates nothing. No test pins it, because pinning it would hold a false negative, and changing it moves the detector's verdicts. The three test files add about 105 ms of test time.

### 8. P07: trusted key, click and drag steps in drive.mjs

**Pitch.** The rig has no input step. There are 20 UI-flow scratch scripts and 28 that call `.click()` or `dispatchEvent`. With the warm attach, a key probe costs about 100 ms instead of a 4–5 s Playwright boot.

**Mechanism.** [`driveSteps.mjs`](../../scripts/driveSteps.mjs) gains three steps:

- `--key <chord>`: `Input.dispatchKeyEvent`, key down and up, with `code`, `key`, modifiers and `windowsVirtualKeyCode`.
- `--click x,y|<css>`: mouse moved, pressed and released. A selector resolves to its center through `Runtime.evaluate`. Coordinates are CSS pixels under the emulated metrics, with a test at `--dpr 2`.
- `--drag x1,y1:x2,y2[:steps]`.

`checkSteps` validates all three before Chrome starts, and a `rig.input` port keeps them testable with the fake socket. Trusted input supplies user activation. [`dropGesture.mjs`](../../scripts/browser/dropGesture.mjs) runs on `--drag` and drops its `setPointerCapture` stubs (lines 22-26). The steps map one-to-one onto `page.keyboard` and `page.mouse`.

**First step.** `--key` with a test, then Backquote and Shift+KeyH on a warm earthrise page against probe E's numbers.

**Success.**

- `--key Backquote` flips the stored `ir.hud.debug.on` preference.
- `--key Shift+KeyH` takes the DOM from about 60 to about 1,035 elements.
- dropGesture runs with no stubs.
- A malformed chord is refused before Chrome starts.

**Risks.** From training data: raw `Input.dispatchMouseEvent` does not start an HTML5 native drag in Chromium. Playwright drives one through its own drag manager (`Input.setInterceptDrags`, `Input.dispatchDragEvent`). So `--drag` will not move a dock panel on react-dnd's HTML5 backend ([`DockProvider.tsx`](../../apps/game/src/dock/DockProvider.tsx):26-58), and that row belongs to P34. Key dispatch into the headed, off-screen, focus-emulated window is unmeasured.

**Claims.**

- `keyboard.press` reaches the keymap: measured (E).
- CDP mouse input establishes native capture: inferred.
- An unprevented CDP F5 reaching Chrome's reload: unverified.

### 9. P13: the drive skill, rules and agent briefs move to two lanes

**Pitch.** [`browser.md`](../../.claude/rules/browser.md), [`AGENTS.md`](../../AGENTS.md) and the skill sanction one launcher. Once P04, P07 and P08 exist, the instructions say: drive.mjs to probe, `pnpm test:browser` to prove. Both launch their own Chrome, and neither ever uses the extension. C1 carries the corrections now. This proposal is the lane rewrite.

**Mechanism.**

- **Rule wording.** The `browser.md` and `AGENTS.md` wording is Jon's to approve, in his own words.
- **SKILL.md.** It gains a lane-choice section and the `rig.steps(argv)` promotion path. Its trap table is re-sorted by lane.
- **New traps.**
  - The default headless shell is WebGL on SwiftShader at 1 fps.
  - Bundled CfT 151 is 2–5× slower on the GPU (measured sequentially until P47's interleaved rerun).
  - A fresh context pays about 12 s of settle.
  - `page.clock` blanks the timeline.
  - `toHaveScreenshot`'s YIQ 0.2 is looser than the 3%/8% rule.
  - recordVideo is 25 fps.
  - A 5 s trace is 6.7–15.4 MB.
  - Headless rAF is a fixed 60 Hz clock.
  - The thermal step, as a fact about this machine.
- **Other files.** [`driving.md`](../../docs/agents/driving.md), [`harness.md`](../../docs/guides/harness.md), [`development.md`](../../docs/guides/development.md), [`testing.md`](../../docs/guides/testing.md), the `worktree-implementer` brief (take the lock, pick its own ports), the shared briefs Codex loads, and the Cursor glob.
- **Audit.** `docs-curator` is named for Jon to invoke, not launched.

**First step.** The re-sorted trap table from the probe outputs, and the `browser.md` wording sent to Jon.

**Success.** `docs:build` passes and every trap names its lane. In two spot-checked sessions, an agent given only SKILL.md picks headed for a pacing question and headless for a plate.

**Risks.** One review puts the effort at 2 days, counting the Codex and Cursor mirrors.

**Claims.** Every new trap is measured (A–I, N1, N4, N5).

### 10. P20: an operating-point registry with stable ids

**Pitch.** The measured performance points are a four-row prose table in [`driving.md`](../../docs/agents/driving.md) and untracked scratch rigs. `ir.scenarios()` holds none of them. `PICTURES` already holds 13 held-instant fixtures, five of them outside Sol, with a headless ledger.

**Mechanism.** `packages/devtools/src/perfPoints.ts` defines `PerfPoint {id, picture, viewport {width, height, dpr}, motion, cache, settle, metrics, budgets?, notes}`, with ids such as `far-shore@1440x900x2`.

- **Seed set.** Still points only: earthrise and far-shore at 1600×900@1 and 1440×900@2, with far-shore retina recorded as a known 39.8 ms budget miss. Motion, cutscene and input entries wait for a consumer (P31, P22).
- **Verbs.** `ir.perfPoints()` lists ids. `ir.perfPoint(id)` stages the camera with no canonical write.
- **Expansion.** `scripts/perf/points.mjs` expands an id into URL, viewport and DPR for `drive.mjs --point` and for fixtures.
- **Ledger test.** A test in `apps/headless`, after the [`pictureLedger.test.ts`](../../apps/headless/src/pictureLedger.test.ts) pattern, resolves every point through `openSession`. It asserts `stateHash` unchanged, and refuses a gate set with no generated-system point or no DPR-2 point.
- **Axes that change results.** Build (production heap −31%, N7), browser build (probe D), output mode and color profile (probe A), refresh rate (X12), and input kind (X7).

**First step.** `perfPoints.ts` with the four still points and the ledger test, reusing `pictureLink`.

**Success.** The ledger resolves every point headlessly in under 10 s with `stateHash` unchanged. A gate set lacking either required point fails.

**Risks.** Low. One review sizes the still-point table at 1.5 days.

**Claims.** `harness.preset` resolves every picture headlessly: verified (`pictureLedger.test.ts`:150-160).

### 11. X10: a thermal-state stamp, and a measured choice between pre-heating and idling

**Pitch.** N5's step is inferred to be thermal. `ProcessInfo.thermalState` is readable without sudo (training data). Logging it beside a sustained run shows whether it changes at the step.

**Mechanism.** `scripts/perf/thermal.mjs` runs a cached helper compiled from `print(ProcessInfo.processInfo.thermalState.rawValue)`, and reads it at run boundaries and every 10 s.

- **Experiment one.** A 10-minute A/A at far-shore 1600×900@1, logging `thermalState` against `ir.gpu`. If the state moves at the step, P19's record carries it, and P18 discards a pair whose arms differ.
- **Experiment two.** Pre-heat until three A-arm values agree within 1%, against idling for 5 minutes, comparing between-session spread over three sessions each.

**First step.** The helper, logged once a second through one 10-minute loaded session. This needs only P01. P18 is needed only to adopt the result.

**Success.** A recorded answer on whether `thermalState` changes within 30 s of the step, and a spread figure for each protocol.

**Risks.** `thermalState` is coarse (nominal, fair, serious, critical) and may not move at a 7 W plateau. A recorded negative is still a result. A Swift toolchain on this machine: unverified.

**Review.** `notifyutil -g com.apple.system.thermalpressurelevel` reads the pressure level with no compile step, so the Swift helper is unnecessary. The first experiment needs only a logger beside the scratch `run.mjs`, not P18 or P01. Adopting a protocol needs P18's statistics, which the effort leaves out. Each protocol is about three 10-minute sustained sessions, an hour of exclusive GPU time on the machine Jon works at. P48 is the structural fix. On the Mac mini the pressure level read 0 before and after every run of two 10-minute sessions with no step to correlate, so this proposal is about the Air only.

### 12. P01: one machine-wide GPU lock that every GPU job takes

**Pitch.** Two overlapping GPU jobs have crashed macOS twice. The one-GPU-job rule lives only in agent memory. Playwright's test locks coordinate inside one run and cannot see `test:gpu` or drive.mjs ([test-parallel-js.md](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/test-parallel-js.md)).

**Mechanism.**

- **The module.** `scripts/gpuLock.mjs` exports `acquire(holder, {waitMs})` and `release()`. The lock is `$(git rev-parse --git-common-dir)/inertialref-gpu.lock`, which resolves to the main checkout's `.git` from every worktree (verified). It is created with `openSync(…, 'wx')` and holds `{pid, holder, cwd, worktree, startedAt, processStart}`.
- **Staleness and release.** A lock is stale only when every process it names is gone: `ESRCH`, or a differing process start time, for the holder and for any Chrome it launched. A killed drive.mjs whose detached Chrome still renders is not stale. It is released on exit, SIGINT and SIGTERM, except by drive.mjs (below).
- **Holders.** [`vitest.gpu.config.ts`](../../apps/game/vitest.gpu.config.ts) through `globalSetup` (the busiest, 605 calls in 30 days); presets capture, compare and plates; Playwright GPU projects, from which the shell project opts out; perf, bisect, soak and MCP runners. drive.mjs holds it from Chrome's launch until `--down` or Chrome's exit, because its Chrome is detached and outlives each invocation ([`drive.mjs`](../../scripts/drive.mjs):403-424). Releasing per invocation waits on Jon's decision, on X13's figures (G5), that an idle rig is not a GPU job.
- **Nested holders.** An outer holder hands its children the lock: `capturePlates` spawns drive.mjs for every capture ([`capture.mjs`](../../scripts/presets/capture.mjs):157-180), and a child that acquired on its own would refuse its parent. The parent passes a token that the lock file records, and a child whose token matches the file proceeds without acquiring. A token is not a bypass: one that does not match the file is refused like any other acquire. A child records the Chrome it launches in the same file, and the staleness rule above covers it, so the lock outlives a parent whose children leave Chrome up. The preset commands do: `plates.mjs` ends by saying `pnpm drive --down when finished` ([`plates.mjs`](../../scripts/presets/plates.mjs):94). The parent's own exit, normal or by signal, removes only its own entry.
- **Failing and waiting.** By default an acquire fails fast, naming holder, pid, age and worktree. `--gpu-wait <s>` queues with a bound and reprints the holder every 10 s; it is not `--wait`, which is drive.mjs's ordered page delay in milliseconds ([`driveSteps.mjs`](../../scripts/driveSteps.mjs):111-116). The message says to wait or ask. It never says to `--down` another agent's rig, because that kills their session. There is no environment bypass.
- **Long holders.** P18 holds the lock 25–30 min, P23 45–75 and P29 1–2 h. They follow a lease policy and run as attended blocks.
- **Around the lock.** The Stop gate warns while it is held; a full check beside a rendering rig timed out at 300 s and passed in 179 s with the rig closed (CONTEXT.md:8469-8472). `pnpm gpu:who` names the holder. Acquisitions are appended to a log.

**First step.** `gpuLock.mjs` and its tests (create, refuse, stale pid, pid reuse, release on signal, two child processes, a child carrying the holder's token, a holder dead while its Chrome lives, a parent exiting normally and by signal while its child's Chrome lives). Then `vitest.gpu.config.ts`. Before that wiring, probe whether the Codex and EnterWorktree sandboxes can create the file. A full-access T3 Code session on the Mac mini creates and removes it, and so does a Claude Code worktree subagent there (unit N1), once the path comes from a plain `git rev-parse`: the harness's worktree guard refuses a program that runs git inside itself. The Codex and EnterWorktree sandboxes are unprobed.

**Success.**

- With a drive.mjs rig up in one worktree, `pnpm test:gpu` in another exits non-zero within 1 s naming it, or under `--gpu-wait` starts within one poll of `--down`.
- `presets:compare`'s nested drive.mjs captures run under its one acquisition, and an unrelated job beside them is refused.
- A SIGKILLed holder with no live Chrome is reclaimed. One whose Chrome still runs is not, and neither is the lock of a finished `presets:plates` whose rig is still up.
- Two Playwright GPU runs serialize.
- The acquisition log shows no overlap in 30 days.

**Risks.** The lock sits in another checkout's `.git`. A harness that cannot write there loses every GPU command, so a failed create fails closed with a named cause. The scope is this project's checkouts. oMLX, Ollama, ComfyUI and Jon's own Chrome compete for the same GPU and are outside it.

**Claims.**

- `openSync 'wx'` is atomic on APFS: training data.
- drive.mjs records `chromePid` at spawn (`drive.mjs`:425-430): verified.
- `process.kill(pid, 0)` liveness: training data.

**First wave (unit N1, #188).** The module is built, with tests over the first step's cases, and wired into nothing. Its shape for the second wave: a child joins through a token in `IR_GPU_LOCK_TOKEN`; `record(pid)` keeps the lock for a browser that outlives the process that launched it, and `forget(pid, {token})` is what `--down` will call, so `--down` is never refused; every change to a held lock runs under an edit mutex and lands by rename. A refusal returns in 34–47 ms, including the holder's spawn. `capture.mjs` spawns drive.mjs with no `env`, so the wiring merges the lock's environment into it. A lock that declares another format version is refused as busy rather than reclaimed, because a worktree on another branch can run another revision of the module, and a lock this one cannot read is one it cannot prove gone. The process start time comes from `ps -o stat= -o lstart=`, and ubuntu CI ran the suite green on #188.

### 13. P43: PR media from one command

**Pitch.** 56 commits cite screenshot, plate or cast evidence, and each PR assembles it by hand.

**Mechanism.** `pnpm pr:media [ids…] [--cast <frames>] [--motion <recipe>] --base origin/main` does the following:

- Captures base and tree.
- Writes `pair.png` with `compare.mjs`'s difference map.
- Records casts through a CDPSession. `Page.startScreencast` runs with JPEG q85, max 1280, every frame, and the ack sent first ([`cdp.mjs`](../../scripts/cdp.mjs):139-178). Frames are sorted by timestamp and encoded with ffmpeg as in `drive.mjs`:581-622. Each cast runs through `analyzeFrames`.
- Moves base and tree the same way with `startMotion` recipes.

Output goes to `.data/pr-media/<branch>/` with a markdown block. Uploading stays the `share-media` skill's job. The dependency on P14 is soft, because `compare.mjs` already writes base and tree captures and pair sheets. `page.screencast`'s `showActions` and `showChapter` (1.59) can annotate clips.

**First step.** A media spec for one picture over probe F's CDPSession screencast.

**Success.** One command produces the plate table and one cast for a two-picture change in under 4 minutes.

**Risks.** Base and tree casts align frame for frame only if motion starts at the same render instant, which is unproven.

**Claims.** Screencast at 60 fps through a CDPSession: measured (F).

### 14. P39: saves captured from a released build, committed as fixtures with explicit verdicts

**Pitch.** The roadmap's [automation gaps](../../docs/roadmap.md) list "No stored save fixture". The only old-save test is an inline v0 literal ([`persistence.test.ts`](../../packages/persistence/src/persistence.test.ts):213-242).

**Mechanism.** `scripts/saves/capture.mjs` takes `ir.save()` at three stances: the default ship, a generated-system orbit, and landed on Mars. It writes `{build, schemaVersion, stateHash, save}` to `packages/persistence/fixtures/`. `fixtures.test.ts` holds each fixture to a declared verdict: `restores` with a `stateHash`, or `refused` with a reason. A schema bump that changes a verdict must change the expectation in the same diff.

The cheaper route needs no production visit. `openSession`, at the deployed revision and built in a worktree, writes the same fixture headlessly, with no analytics, no browser and no lock. Fixtures are named by the client's `BUILD_ID`. `/api/health`'s revision is `CF_VERSION_METADATA.id`, a Worker version id that reads `unknown` under `cf dev` ([`index.ts`](../../apps/server/src/index.ts):87-93). Capture from `inertialref.app` is optional. It needs analytics routed off, `globalPrivacyControl` set, and Jon's consent.

**First step.** One headless fixture for the default stance.

**Success.** Three fixtures and a root-suite test under 100 ms. A schema bump in a scratchpad copy fails, naming each fixture.

**Risks.** Saves carry no backward-compatibility promise, so most verdicts will read `refused`. The value is the reviewed diff, and P40's starting states.

**Claims.** `restoreSave` in Node reproducing the browser's hash: inferred.

### 15. P32: measure whether the hosted macOS runner can run the app

**Pitch.** The roadmap's "no image comparison in CI" rests on one unmeasured question. In niivue's run on macos-15, full Chromium in new headless got the paravirtual `apple` adapter, with no `timestamp-query` and `maxTextureDimension3D` 2048. The headless shell got SwiftShader.

**Mechanism.** `.github/workflows/browser-probe.yml` uses `workflow_dispatch` on macos-15 with a 30-minute limit, from [`gpu-probe.yml`](../../.github/workflows/gpu-probe.yml)'s skeleton. It checks out with LFS, builds, serves `astro preview` on a free port, and runs two legs: `channel: 'chromium'` and `channel: 'chrome'`. The job summary records:

- Adapter info and features, and the backend.
- Boot and settle ms.
- Per picture, two captures 10 s apart and one after reload.

P03's guard fails closed on a software adapter. The boot timeout is 8 minutes, with load average logged ([#14840](https://github.com/actions/runner-images/issues/14840)). The queue drains before close ([#14836](https://github.com/actions/runner-images/issues/14836)). A plain playwright-core script answers the question; specs come only after a positive answer. X5's compile census runs there too, since a count survives a GPU with no timestamps. If three dispatches agree, main's captures are cached by image and Chrome version and compared without being required. [`testing.md`](../../docs/guides/testing.md) then states what each hosted runner can and cannot measure.

**First step.** `browser-probe.yml` with one earthrise boot printing adapter info and boot ms, dispatched once.

**Success.** Three runs report per picture boot ms, settled or not, and px over 3% within and across runs. The roadmap row carries the figures either way.

**Risks.** Prior art leans negative on determinism (KhaozEngine [#614](https://github.com/APKiwiOrg/KhaozEngine/issues/614), Metal.jl). The repository is public, so hosted macOS minutes are free. The constraints are queue time and job length. The `chromium` leg's figures are about Chrome for Testing.

**Claims.**

- The `apple` adapter on macos-15: sourced (niivue run 35742921976).
- Boot within budget on 3 vCPU: unmeasured.

### 16. X13: an idle rig holds its frames, so a warm Chrome is not a GPU job (vetoed by feasibility)

**Pitch.** P01's lock, written naively, treats drive.mjs's detached Chrome as a holder until `--down`. In 30 days the transcripts show 605 `test:gpu` calls, 493 driver calls and 106 `--down` calls. With that rule, a warm rig nobody is using would be the lock's commonest refusal, and the guardrails forbid working around a block. One review infers that an idle off-screen rig renders nothing at all: its window sits at x=2400, drive.mjs passes no anti-backgrounding flag, and focus emulation lifts when the client detaches. That is the first thing to measure.

**Mechanism.** `ir.idle(on)` takes or releases `holdFrames()` through `RenderHost` ([`frameHold.ts`](../../apps/game/src/engine/frameHold.ts)), so nothing steps, streams or renders. drive.mjs calls `ir.idle(true)` last unless `--live` is passed, and `ir.idle(false)` first on attach. P01 records drive.mjs as a holder per invocation, plus an "idle rig" entry that does not block. `--status` prints idle or live.

**First step.** On a warm page, read `SystemInfo.getProcessInfo` GPU-process CPU live, then after `holdFrames` from a `--js` step.

**Success.**

- A held rig's GPU-process CPU drops near zero.
- `test:gpu` acquires the lock beside an idle rig.
- The next attach takes under 150 ms, and its first `--shot` matches one taken before idling (AE 0 at 3%).

**Risks.** A long hold lands in the next frame's delta. Presentation integrates `min(0.1, delta)` (`GameEngine.ts`:1533), so it should not jump (inferred). Whether an idle held page counts as GPU-heavy for the crash rule: unverified.

**Claims.** Nothing steps or renders while held: verified.

**Review.** The feasibility review vetoes it. Its success metric is the overlap the standing rule forbids, `test:gpu` acquiring beside a live rig, and being wrong costs a macOS crash. GPU-process CPU near zero says nothing about the memory a held page keeps resident, which is the load behind the crashes. So the measurement covers resident GPU memory too, and whether an idle rig counts as a GPU job is then Jon's call. `ir.idle` has to be idempotent, because `frameHold` counts holds. The simpler alternative is drive.mjs closing Chrome after an idle timeout, at the cost of the warm attach.

**Measured (G5).** On the Mac mini, with the display asleep ([On the Mac mini](#on-the-mac-mini)). The review's inference holds there: a detached rig renders almost nothing, at most 4 frames in 66.7 s, with its GPU process at 0.02% of a core, so a hold adds nothing to it. The memory does not follow. Detached or held, the rig keeps about 2 GB of GPU-driver allocations above the baseline, and only `--down` returns them, so the idle timeout is the alternative that frees it. `holdFrames()` is reachable from a `--file` step through the dev server's module graph, so the measurement needed no `ir.idle`. Whether a rig that submits no work and holds about 2 GB is a GPU job is Jon's call.

### 17. P37: the docs as a crawled site

**Pitch.** `docs:build` lets through relative links into `design/` and every `#anchor`. The 83 Mermaid diagrams and `DocumentMeta`'s client-side head exist only in the browser.

**Mechanism.** `scripts/docs/links.mjs` walks every relative link and fragment against the manifest, inside the existing docs stage, with no browser. It lands first, in about a day, without P35. The crawl half is a shell-project spec over the ~109 hand-written pages and a seeded sample of 50 TypeDoc pages. On each hop it asserts:

- No page or console errors.
- Every Mermaid block became an SVG with unique ids.
- After client navigation, title, canonical and robots equal the prerendered HTML.

**First step.** `links.mjs` against the manifest, run on a scratchpad copy with a dead link from [`roadmap.md`](../../docs/roadmap.md) into `design/plans/`.

**Success.** That copy fails the docs stage. The crawl finishes in under 2 minutes on ubuntu.

**Risks.** Client navigation with the runtime refused is unverified, and it inherits P35's runtime-notice issue.

### 18. P02: one implementation of the app contracts, run over either transport

**Pitch.** drivePage, driveSteps and cdp.mjs already take injected ports. A small wire adapter lets the same boot ladder, settle, selective storage clear and synchronous-ack cast run over a Playwright CDPSession, which removes the drift `capture.mjs`:4-9 warns about.

**Mechanism.** `scripts/driveWire.mjs`'s `wireFrom(session)` returns `send`, `subscribe`, an events buffer, and a `navigate` port mapped to `page.goto(url, {waitUntil: 'commit'})`. One driver owns navigation per transport. The `BOOT` and `READY` expressions, the two-quiet-reads settle and `withPresentation` are exported for fixtures that need only expressions. That expressions-only module costs about half a day and covers everything the probes needed.

Moving `capture()` and `cast()` out of drive.mjs into `driveCapture.mjs` is the expensive half, and it waits until P06 tests them. `trace()` does not move, because Playwright's `browser.startTracing` output feeds the readers unchanged (probe G). The race fix ships separately as C4. Under Playwright: console comes through `page.on('console')`, DPR comes from the context option, and drive.mjs's per-call focus setup is skipped.

**First step.** The expressions module, then `driveWire.mjs` with a fake-CDPSession test.

**Success.**

- `rg` finds no `ir.status().boot` poll outside `scripts/drive*.mjs`.
- The rig tests pass unchanged.
- A scratch proof casts at 58 fps or better, with a shot at AE 0 against drive.mjs's.

**Risks.** CDPSession events cross Playwright's client/server channel, so the ack is one hop later than over cdp.mjs's socket. 60 fps is measured only at JPEG max 1280. The C4 race test must run over both transports.

**Claims.**

- `CDPSession.send` shape and `on('event')` in 1.62.1: verified.
- Sync-ack screencast: measured.

### 19. P45: verification receipts keyed to the pushed tree

**Pitch.** Check stamps are keyed to the tree, but browser evidence is a still with no record behind it. A receipt makes "checked in the browser" verifiable and catches stale evidence.

**Mechanism.** Every `--shot` or `--cast` from drive.mjs or `capture.mjs` writes `.data/receipts/<tree-hash>/<slug>/receipt.json`. Later, every Playwright run does the same. A receipt holds:

- Commit, tree hash and dirty flag.
- The full URL, including `presentation=occluded`.
- P03's record, the settle report, and `stateHash` before and after.
- The sha256 of each artifact.

No receipt is written for a run that did not complete. `/ship` lists receipts matching the pushed tree and flags stale ones. Receipts cover ad-hoc probes. X4's stamps cover suites.

**First step.** Receipts in `capture.mjs`, which already assembles a partial record (`capture.mjs`:232). The P04 dependency is soft.

**Success.** A seeded test (receipt written, file edited, branch pushed) reports the receipt as stale.

**Risks.** The failure it targets is rare, so `/ship`'s cost stays small.

**Claims.** `.data` is gitignored: verified.

### 20. P33: a boot lifecycle smoke at four operating points on dev and production

**Pitch.** Boot defects keep escaping:

- StrictMode registered boot producers twice, and boot stuck at 62/62.
- `camera.aspect` 0 gave a black boot.
- A `WebGPURenderer` leaked only at DPR 2.
- The watchdog's remount left a 3200×1800 buffer.

**Mechanism.** `boot.spec.ts` covers earthrise and far-shore × 1600×900@1 and 1440×900@2 × dev and production, and asserts:

- `booted` within 30 s.
- P03's guard, including the buffer against the DPR ceiling.
- Exactly one `preload` measure under `?timing=full`.
- Mean luminance above a per-picture floor (0.304 at earthrise).
- No `pageerror`, and a console census against a committed allowlist for the dev server's 504, 404 and 502 noise.
- A same-context reload re-boots without incrementing `ir.graphics-session`.

The production leg builds into its own directory. `astro build` beside a live dev server rewrites `.vite/deps`.

**First step.** The earthrise 1600×900@1 dev case with the buffer and preload-count assertions.

**Success.** Eight tests green in under 5 minutes on a cool M5. A forced DPR-1 buffer under DPR 2 fails the buffer assertion.

**Risks.** The planned negative check (dropping the flag fails the preload count) probably passes vacuously headless, because the watchdog retires on its first lit sample. The double preload came from drive.mjs's headed, uncomposited window. The check runs headed, or it is left out. The retina project is mandatory.

**Claims.**

- The `preload` measure exists: read, not run.
- The DPR-2 buffer: measured (N3).
- StrictMode is dev-only: training data.

### 21. X3: one port allocator and a server-identity handshake for every rig

**Pitch.** drive.mjs, Playwright's `webServer`, the base trees, bisect, preview and static servers all need ports. The known failures:

- A foreign Vite answers on 5173 and is accepted as this tree's server.
- A port on the Fetch spec's bad-port list makes the probe read "nothing serving".
- Astro binds only `::1`.
- Another agent holds 9333.

No proposal owns the mechanism.

**Mechanism.** `scripts/ports.mjs` defines `portFor(role, tree)` as the role's base plus a hash of `git rev-parse --show-toplevel`, mod 200. The roles are vite, drive, preview, base, bisect and static. It skips 5173, 8787, 9333 and the bad-port list, and probes both `127.0.0.1` and `::1`. It is a tested pure core with a thin I/O shell.

For identity, `ir` exposes `BUILD_ID` ([`build.ts`](../../apps/game/src/build.ts):16) and the served tree's root. [`vite.config.ts`](../../apps/game/vite.config.ts):39-56 computes `BUILD_ID` from `git describe --always --dirty --abbrev=8`, which sibling worktrees cut from one `origin/main` share, so the root is what tells them apart. It comes from `git rev-parse --show-toplevel` on the dev server only, as a define that is empty in a production build or as a middleware header, because a shipped bundle must not carry a filesystem path. P03's guard compares both with the tree under test and refuses on a mismatch, naming both values.

**First step.** `portFor` and its tests. Then `BUILD_ID` through `ir` and the drive.mjs comparison.

**Success.** Two worktrees started at once get disjoint ports for every role. A rig pointed at a sibling worktree's server is refused, naming both trees.

**Risks.** The build id reflects the tree's dirty state when the server started, not later edits. So the check proves which tree is served, not which edit.

**Claims.**

- `BUILD_ID` is compiled in and shown on the About page (`AboutPage.tsx`:144, `NetworkSection.tsx`:70): verified.
- Vite's `define` applies in dev: training data.

**Review.** The allocator half is sound, and it targets a class the memory notes hit four times. The identity half needs more than `BUILD_ID`. It names a commit, any dirty tree reports `<sha>-dirty`, and parallel worktrees are cut from the same `origin/main`, so `BUILD_ID` alone cannot tell sibling trees apart. The served tree root in the mechanism is that review's correction. `pnpm dev` keeps 5173 and 8787 ([`dev.mjs`](../../scripts/dev.mjs):42-43), which AGENTS.md, CLAUDE.md, `t3.json` and the human workflow name. The allocator covers the drive, preset, Playwright and base roles. About 2 days.

**First wave (unit N4, #188).** The allocator is built, in 16000–17199: six roles of 200 ports each, below both ephemeral ranges and above the highest bad port. A port is free only when a connection fails at once on both 127.0.0.1 and ::1, because on macOS a bind to either succeeds beside a `0.0.0.0` listener. The core takes git's worktree list as well as the tree, because two trees started at once cannot tell each other apart by probing: with 200 slots, two trees collide 0.5% of the time, six 7.3% and nineteen 58.6%.

### 22. P19: `ir.environment()` and `ir.perf()`, one versioned perf record

**Pitch.** The facts a figure needs are spread across a dozen readouts. Some are reported by nothing: buffer against requested DPR, cache state, `TileProducerStats`. One perf.md "production" trace was really the dev page ([perf.md](perf.md):612-631).

**Mechanism.** In [`harness.ts`](../../packages/devtools/src/harness.ts), every fact comes through `RenderHost` and `TimingPort`, because `packages/` may not name `performance`.

`ir.environment()` is a readout. Every field is read with `?.` and none throws. It returns:

- Origin, dev or production, `BUILD_ID`, three `REVISION`.
- Adapter vendor and architecture, read from `device.adapterInfo` (three keeps no adapter reference), with `isFallbackAdapter` read defensively; timestamp-query; `crossOriginIsolated`.
- Viewport × DPR against the drawing buffer, `displayRatio`.
- Picture, output mode, `dynamicRangeHigh`.
- Pool size, producer, timing level, `clock.paused`.
- Terrain-cache activity, galaxy archive hits with a cold or warm verdict, and the `perfBudgets.ts` constants.
- `TileProducerStats`, which needs a new host path.
- Browser version, thermal state, refresh rate, and the lock holder at start.

`ir.perf({gpuReps: 4, gpuFrames: 120, discardFirst: true, passes: true, profileMs: 2000})` is a measurement, not a readout. Its order is fixed: spans first, sampled while frames run, because `ir.profile` observes the frame loop that a hold would stop; then `ir.passes` and `ir.gpu`, which hold frames ([`harness.ts`](../../packages/devtools/src/harness.ts):1649-1670), with `ir.gpu` last. It returns `{schema: 'perf/1', point, environment, frame, spans, late, gpu, passes, counters}`. `scripts/perf/sample.mjs` adds forced-GC heap and fails closed on a fallback adapter.

**First step.** `ir.environment()` with buffer, origin, build and adapter, tested against a fake `RenderHost`.

**Success.** At both points and both windows, one call returns a record whose fields agree with independent CDP reads. Five calls in one cool session give `ir.gpu` min-of-k CV at or under 1.6%.

**Risks.** It overlaps P03, and keeping one record is the resolution.

**Claims.**

- `BUILD_ID` from `git describe` or the CI sha: verified.
- Forced-GC heap CV 0.1–0.2%: measured (N1).

### 23. P30: promise verbs and a stricter quiescence readout

**Pitch.** Every runner polls boot every 500 ms and settle every 250 ms. `waitForFunction`'s default `raf` polling hangs while rAF is suspended. `settled()` ignores scatter, bakes, exposure adaptation, temporal history and easing still in flight.

**Mechanism.** Through host ports:

- `ir.whenBooted({timeoutMs})`.
- `ir.whenSettled({quiet: 2, budgetMs, strict})`, which rejects with the last report.
- `ir.whenFrames(n)`, which needs a frame-end hook. The 8 Hz sampler gives 125 ms granularity.
- `ir.quiescent()`: `settled()` plus `scatter.resolving === 0`, `orbitalBaker` idle, no atmosphere bake pending, exposure converged (|ΔEV| < 0.02 over 96 frames), easing finished, and reconstruction frames since the last cut at least `phaseCount`.
- A presentation digest of render time, eye pose, lens, EV, picture epoch and jitter phase.

The drive.mjs ladder becomes one `evaluate`, keeping the polling fallback for old builds.

**First step.** `whenBooted` and `whenSettled` with a fake-host test, then [`drivePage.mjs`](../../scripts/drivePage.mjs)'s ladder on them.

**Success.** `whenSettled({strict: true})` resolves where two captures 2 s apart are AE 0 at fuzz 0, at earthrise, far-shore and a daylight terrain site, 10 of 10. `quiescent()` never throws over a host with every readout missing.

**Risks.** The engine sampler is a `setInterval` ([`engineStore.ts`](../../apps/game/src/state/engineStore.ts):190, started at [`App.tsx`](../../apps/game/src/App.tsx):491). It runs while rAF is suspended, but is throttled in the headed off-screen window and faked under `page.clock`. The useful half is `quiescent()`, since plates are already AE 0 at still points.

### 24. P08: headless by default for evidence that needs no display

**Pitch.** [`drive.mjs`](../../scripts/drive.mjs):28-35 keeps a window because headless "presents nothing". On Chrome 157 that is measured false: 179 screencast frames in 3 s, trace screenshots at 61 fps, plates identical to headed. Headless removes three problems:

- The occluded-window trap.
- Desk shots, one of which cost an hour and a false bisect.
- A window that can take focus from the person at the desk.

**Mechanism.** drive.mjs gains `--headless` (`--headless=new`), recorded in the state file like `colorProfile`, so an attach in the wrong mode is refused. Validation comes before any default changes:

1. A flash every 30th rAF, as a DOM layer and as an exposure flip, cast headless and headed. The period in frames matches. The rate matches each run's own measured rAF cadence divided by 30, because a headed rig's cadence is its window's: about 2 Hz on the Air, about 3.4 Hz for the Mac mini's off-screen rig at 100 rAF/s (M5), against headless's fixed 2 Hz.
2. A retina, GPU-bound reproduction, like the 2.29 Hz disk strobe at 3840×2400.
3. All 13 plates headless against headed.

The terrain-cache oscillation reproduction is budgeted apart. Headed stays the mode for:

- Frame-interval percentiles, since headless rAF missed a 6.5% regression (N4).
- Presentation and watchdog questions.
- Extended output.
- The human guide session.

Headless `--sample` output says that its rAF is a 60 Hz clock.

**First step.** The flash page, cast 240 frames both ways, through `analyzeFrames`, as one GPU job under P01.

**Success.** The strobe is found headless within 1 frame of headed, and each run's rate within 5% of its own cadence divided by 30, at 1600×900@1 and 1440×900@2. 13 plates are AE 0 at 3%.

**Risks.**

- Every headless datum came from Chrome launched with Playwright's switches (`--disable-renderer-backgrounding`, `--disable-background-timer-throttling`). drive.mjs with a bare `--headless=new` is untested.
- Defects that depend on display vsync may vanish headless.
- EnterWorktree sessions refuse headless Chrome from Bash, so the default depends on what the session can launch.

### 25. P24: a boot record, cold against warm, on the production build and a throttled network

**Pitch.** perf.md asks for a default-sky boot record and a cold-load budget of 4 s on 20 Mbit. Neither is measured.

**Mechanism.** `boot.spec.ts` runs on the production preview with `?timing=full`. It reads from the Boot track: navigation to first light, preload, surface warm-up, catalog fetch and decode, and atmosphere bakes. Then:

- A final-sky mark, inside `browserTiming.ts`, at the final tier's publication.
- A throttled lane through `Network.emulateNetworkConditions`.
- A Clerk lane with and without `PUBLIC_CLERK_PUBLISHABLE_KEY`, using a development key Jon supplies through `op`.

Cold and warm runs are interleaved, because boot moves with the thermal step (4.85–6.1 s cool against 6.4–8.3 s hot).

**First step.** Five cold and five warm production boots at both points. This needs only P01. P18 and P19 are needed only for paired verdicts and the record.

**Success.** A cold-against-warm boot table with intervals, and the throttled lane against 4 s.

**Risks.** The cold settle is the final sky tier: [perf.md](perf.md):266-271's 1,536 tiles at two a frame is about 12.8 s, against the measured 12.1–12.7 s. The 0/1638 reading at settle is the readout zeroing its count when nothing is pending (`galaxyCache.ts`:194), not evidence against it. The first step therefore confirms that a warm load is an archive hit, and attributes far-shore's slower settle cluster. Warming by reload already works at earthrise (0.5–1 s, probe B); at far-shore a warm load still waits 8.5–9.1 s on `terrain.deposits` (G2).

**The first step's archive half, on the Mac mini (G2, dev build).** A warm relaunch and a warm navigation are both archive hits, at both points, and the mini shows no slower far-shore cluster to attribute. The production table of cold against warm boots is unmeasured.

### 26. C3: headless `presets:compare --all`, with measured dark-plate floors, on the existing rig (vetoed by completeness)

**Pitch.** Dark plates are skipped by default because headed star fields differ by thousands of pixels between captures. Headless Chrome 157 captures are pixel-identical across launches at lit points (probe C). If dark pictures hold that headless, `--all` becomes the default. That gives P14's sensitivity while keeping one plate recipe ([`capture.mjs`](../../scripts/presets/capture.mjs):4-9) instead of two.

**Mechanism.** After P08, `capture.mjs` passes `--headless` to drive.mjs. Run `pnpm presets:compare --twice --all` headless under P01 and tabulate px over 3% for the 13 pictures. Then:

- If every picture is at or under `NOISE_FLOOR` (200, `compare.mjs`:72), `--all` becomes the default and `LIT_FLOOR` becomes a reported column.
- Otherwise, a per-picture floor table records each figure and its commit in a comment.

Either way, dark plates are always reported, never skipped silently. Repeat at 1440×900@2 for earthrise and far-shore. P41's parked `/cinema` keyframes can join as cases. The dark-plate census (rank 1) decides whether this is needed. This proposal makes the census's headless arm permanent.

**First step.** With P08's flag in place, one headless `--twice --all`.

**Success.** A committed per-picture self-noise table. Against #180's pair (base `f74fce69`, head `5cfe6a43`), the default compare reports titans-haze and centauri-daybreak as moved.

**Risks.** About 13 × 2 × 20–30 s of GPU per run. The committed plates were accepted from headed display-profile captures. If capture moves headless, the plates need a one-time recapture and a note in [ADR-0046](../../docs/adr/0046-the-check-is-a-graph-and-the-pictures-are-the-fixture.md).

**Claims.** Dark pictures headless: unmeasured, which is what this run measures.

**Review.** The completeness review vetoes it. It duplicates the dark-plate census, which takes the same `--twice --all` table in half a day without waiting on P08, and adds the headed arm that may make P08 unnecessary for this blind spot. Behind P08 its real cost is about 3.8 days, near P14's. The committed plates were captured headed, so a headless default also needs all 13 recaptured and reviewed. The success metric needs `5cfe6a43` checked out as the photographed tree, because `compare.mjs` always photographs its own checkout as the head.

**The census answered it (G3).** The headed arm reads 0 px on all 13 pictures, so C3 is not needed for the #180 blind spot.

### 27. P42: an upgrade smoke for three, React, Astro and Chrome

**Pitch.** Bumps have consequences only a browser shows. three r186 is held on 27 `test:gpu` failures. Chrome's silent updates move GPU cost without moving pixels.

**Mechanism.** `scripts/upgrade/smoke.mjs`, under P01, runs:

- `pnpm check --only gate` and `pnpm test:gpu`.
- Both trees built to production in separate directories.
- P14, P33 and P34 alternating base and candidate.
- Recorded versions.
- Boot as 5 interleaved pairs, and `ir.gpu` min-of-3 through P18's statistics, reported but not gated.

The three checklist from [ADR-0030](../../docs/adr/0030-three-r185.md) stays manual and is printed. The half-day slice lands first, with P03 and X2: record `browser.version()` beside the accepted plates, and warn on change before any picture verdict.

**First step.** That version watcher.

**Success.** Replaying the r186 bump fails on `test:gpu` and names moved pictures. A full smoke runs under 30 minutes.

**Risks.** It composes four suites that do not exist yet. It never gates against a stored absolute baseline.

### 28. P18: `pnpm perf:compare`, interleaved A/B with an inconclusive verdict

**Pitch.** N5 rules out a stored absolute baseline on this machine. N4 shows interleaved pairs work: +10% pixels read +6.5% `ir.gpu` at paired t = 25, with rAF p95 unmoved.

**Mechanism.** `pnpm perf:compare --base origin/main [--points …] [--pairs 5]`.

- **Trees.** `scripts/baseTree.mjs` is factored out of `compare.mjs`'s `checkoutBase` and owned once for P14 and P16 too. Each tree is built in its own worktree and served by `astro preview` on its own port.
- **Per run.** A fresh context; boot, settle and 1 s quiet; a `Performance.getMetrics` bracket; `ir.profile(2000)` twice with frames running; `ir.passes(60)`; `ir.gpu(120)` three times, keeping the minimum, in P19's order; forced-GC heap.
- **Order.** One discarded warm-up pair, then ABAB. An A-arm step above 8% flags a thermal transition and adds pairs, up to a cap.
- **Statistics.** `scripts/perf/stats.mjs`, a property-tested port of `analyze.py`, gives the paired difference, its 95% t interval and d_z. The verdict is `slower` or `faster` when the interval excludes 0 and the effect clears the metric's floor, `inconclusive` above a CoV ceiling, otherwise `same`.
- **Gated metrics.** `ir.gpu` min-of-3 and heap. CPU spans are secondary, because they move with GPU load here. rAF percentiles only flag budget breaches.
- **Output.** Bencher Metric Format JSON, a markdown table, and findings written into perf.md.

It is never in the gate, and runs only for performance-sensitive PRs.

**First step.** `baseTree.mjs` with `presets:compare` still green, then `stats.mjs` with property tests (t = 2.306 at df 8).

**Success.**

- DPR 1.05 at far-shore reads `slower` in 5 of 5 invocations.
- HEAD against itself reads `same` or `inconclusive` in at least 19 of 20 metric-invocations.

**Risks.**

- It does not close the roadmap's "controlled performance gate", because it runs locally on uncontrolled hardware. The row stays open.
- The 0.85% figure comes from 7 pairs, and its SD could be 2.9× worse. The `ir.gpu` floor starts at 2–3% and is lowered with data.
- The DPR detection was on the dev build. A production A/A and DPR A/B come before "production by default".
- Each run holds the lock 25–30 minutes.
- The P04 and P05 dependencies are soft: the measured design was a plain playwright-core script.

### 29. P35: a GPU-free shell project in `pnpm check`

**Pitch.** Home, the docs, the account pages and every dialog over them render without an engine. Seeding `sessionStorage['ir.graphics-session'] = '1'` makes the runtime refuse before import. That gives a parallel, GPU-free Playwright project on ubuntu, and the first browser check in CI.

**Mechanism.** Project `shell` runs on the default headless shell, with parallel workers locally weighted honestly in the graph, and no GPU lock. It is served by `astro preview` from the `bundle` stage's dist. `addInitScript` seeds the marker: `STRIKES` is 2 ([`graphicsSession.ts`](../../apps/game/src/graphicsSession.ts):22, 57-66), and [`runtimeLoader.ts`](../../apps/game/src/runtimeLoader.ts):22-31 throws before importing `clientStartup`. Specs:

- Dialogs keep query and fragment, and `goBack` does not reopen a closed one ([`useOverlay.ts`](../../apps/game/src/pages/useOverlay.ts):55-97).
- After every close, a Home control click succeeds. Actionability fails with "intercepts pointer events" when a scrim stays at `pointer-events: auto`.
- Switching settings tabs leaves exactly one scrim.
- A deep link and a reload land in the same mode.
- The admission cover shows on `/play/solo`, `/planetarium` and `/cinema`.
- The compact layout at 800×900.
- Preferences export and import through a download and `setInputFiles`.
- A request census showing no `googletagmanager` request.

`e2e:shell` (needs `bundle`, weight 2) runs in full `pnpm check` and CI, outside the Stop gate. Specs for presets and catalog move to the runtime lane, because those routes render nothing without an engine ([`ModeRoutes.tsx`](../../apps/game/src/pages/ModeRoutes.tsx):210-221). This project needs only the base config, not P04's rig fixture, so it can be the first Playwright landing.

**First step.** One spec that seeds the marker, opens and closes settings, asserts `goBack`, clicks Home, and records whether the runtime notice obstructs anything.

**Success.** Under 90 s on ubuntu, including a browser install on a cache miss. Scratchpad copies with `mode="wait"`, or keyed on pathname, each fail at least one spec.

**Risks.** The refused runtime raises [`RuntimeNotice`](../../apps/game/src/RuntimeNotice.tsx). On menu and docs routes it is a bottom-left `role="alert"` card. On mode routes it is a full-screen cover. Specs dismiss it, or a first-class `QUERY` switch is decided in a short ADR. On macOS the headless shell composites through SwiftShader, which is probably not a Metal job. That is measured before the project is declared outside the GPU rule.

### 30. X4: a local browser group in the check graph, stamped by tree, taken under the GPU lock (vetoed by feasibility and fit)

**Pitch.** The GPU suites (P14, P33, P34) are kept out of the Stop gate and CI, and nothing else runs them. Today `/ship` compares `presets:compare`'s date with the commits by hand.

**Mechanism.** [`check.mjs`](../../scripts/check.mjs) gains three stages in group `browser`:

- `browser:boot` (P33).
- `browser:input` (P34's runtime rows).
- `browser:plates` (C3 or P14).

Each stage weighs the full core budget, so it runs alone. Each needs `bundle`, takes P01's lock in its own process, and is marked local, so neither CI nor the Stop gate's `gate` group selects it. That is skipping by environment, not by changed files, and an ADR-0046 amendment says so. Passing stages are stamped by tree content like every other stage, so `/ship` claims them from stamps. Stamps cover suites. Receipts (P45) cover ad-hoc probes.

**First step.** `browser:boot` as a local stage, and a check that its stamp keys to the tree.

**Success.**

- `pnpm check --only browser` runs the group under the lock.
- A rerun on an unchanged tree reuses every stamp in under 5 s.
- Neither CI nor the Stop gate selects any of them.

**Risks.** Stamp keying for a stage that takes an external lock: unverified.

**Claims.** Stages carry name, needs and weight, with a budgeted scheduler (`check.mjs`:96-257): verified.

**Review.** The feasibility and fit reviews veto it. It contradicts the stated design. [`check.yml`](../../.github/workflows/check.yml):3-10 makes `pnpm check` the whole CI job, so that CI cannot keep a list that drifts from what a developer runs, and it keeps `test:gpu` outside the graph on purpose. Run by default, the group turns every agent's pre-change `pnpm check` into a multi-minute GPU job queued on P01's lock. Run only by `--only browser`, it is a named command plus a stamp, which P45's receipts already provide. `presets:compare` is not a stage and still ran 179 times in 30 days.

### 31. P09: bridges between the rig's Chrome and Playwright, measured before adoption

**Pitch and mechanism.** Four options, each measured before adoption:

- **(a)** A failing spec's page held open with `--remote-debugging-port`. drive.mjs then attaches with `--no-serve --keep-storage`, and records no pid, so `--down` cannot kill Playwright's Chrome.
- **(b)** `connectOverCDP` to a warm rig Chrome, with `noDefaults`.
- **(c)** `playwright-cli attach --cdp`.
- **(d)** `browser.bind()`, present in 1.62.1's types. It is Playwright's own way to share one launched browser across clients.

Only (a) has a clear payoff. (b) and (c) are dropped if (d) works.

**First step.** Boot drive.mjs on a spare port, attach once, and record buffer, DPR and the next warm-attach time.

**Success.** A recorded decision with attach latency and page survival.

**Risks.** A held page keeps rendering and holds the lock, so the hold needs a timeout. `playwright-cli install --skills` writes `~/.claude/skills`, against this machine's `~/.agents/skills` convention. It is never run here.

### 32. P31: motion operating points driven by trusted input

**Pitch.** The performance regressions players found were all motion:

- The orbit drag ran 62 ms frames at 1920×1080 (18 ms at 960×540).
- Mode switches drop frames, the worst about 137 ms.
- The galaxy return leg runs at 52.8 fps.

**Mechanism.** P20 input entries hold `{mouse, wheel, press}` step lists, replayed one move per frame and measured through P18's pairing. The scenarios:

- Orbit drag at 1920×1080, headless only.
- Free look.
- A wheel zoom through a terrain level boundary at DPR 2.
- Mode switches on the production build (perf.md item 1).
- The descent.
- The galaxy return leg.
- A system jump.

**First step.** The orbit-drag step list through `page.mouse` inside `ir.profile` at earthrise.

**Success.** Frames over 25 ms on the commit before the invisible-sky fix, and none on HEAD.

**Risks.** Headless hides cost below budget, so steady motion reads only through spans, and CPU spans move with GPU load. `page.mouse` reaching the observatory drag with capture: inferred.

### 33. X2: pin the measurement browser, after finding out whether probe D's gap is version or build (vetoed by feasibility and fit)

**Pitch.** Chrome stable updates itself, and probe D shows a browser change can move GPU cost 2–5× while moving pixels 0.07 px. Chrome for Testing publishes every stable version and does not auto-update ([Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing)).

**Mechanism.**

1. Install CfT 157.0.8103.39 outside the repository with `@puppeteer/browsers`. Run 5 cool interleaved triples (Chrome 157, CfT 157, CfT 151) at both points, taking min-of-3 `ir.gpu`.
2. If CfT 157 matches stable within P18's detectable effect, the measurement presets launch by `executablePath` from a tracked `scripts/browserPin.json`.
3. Chrome stable stays the lane for what players run.

Separately, the skill records a trap: never run `npx playwright install chrome`, which installs branded Chrome system-wide (training data).

**First step.** Probe D's script rerun as interleaved, cool triples.

**Success.** A recorded answer with paired intervals.

**Risks.** If the gap is CfT against branded Chrome, pinning is invalid for performance, and the deliverable becomes a version-change warning in P03.

**Claims.**

- A CfT build matching 157.0.8103.39 exists: unverified.
- CfT and `@puppeteer/browsers` behavior: sourced.

**Review.** The feasibility and fit reviews veto it. P18 compares both arms in one session with one browser, so a pin matters only across sessions (P26, vetoed) and for plates, which moved 0.07 px across six Chrome milestones. P03 already refuses the bundled build. The interleaved Chrome for Testing 157 against Chrome 157 run belongs in P42's first step, and the trap (never `playwright install chrome`) belongs in P03 or P13.

### 34. X9: a fixed warm-state template, cloned per test (vetoed by fit)

**Pitch.** Warm against cold is a hidden input to every figure. A persistent profile drifts as tests run. Cloning one warmed profile directory per test with APFS `cp -c` gives every test the same warm state.

**Mechanism.** Once per build id and Chrome version, `launchPersistentContext` on an empty directory visits the point set until each point settles, then closes. That directory becomes `.data/pw/template-<build>-<chrome>`. Each test clones it, removes Chrome's `Singleton*` lock files, and launches on the clone. `cache: 'cold'` is an empty directory. P19's record names the template.

**First step.** Warm a profile at earthrise, clone it twice, and compare settle time and archive hits.

**Success.** Ten clones settle at earthrise within 1.5 s each, with identical archive hit counts. Clone time is under 200 ms.

**Risks.** It pays off only if a warm load is an archive hit, which P24's first step confirms.

**Claims.**

- The archives are IndexedDB: verified.
- Chrome opens a cloned profile once the Singleton locks are removed: training data.

**Review.** The fit review vetoes it. The sky archive holds two entries ([`galaxySkyArchive.ts`](../../apps/game/src/render/galaxySkyArchive.ts)), and the 13 pictures span five systems (SOL, HIP71683, HIP8102, P222_0_0_6, P222_1_0_9), so a template warmed across the point set keeps only the last two skies; it needs one template per system. A cloned profile also carries Chrome's GPU and Dawn shader caches, which move boot figures as well as settle. A `git describe` build id does not change with uncommitted edits, so a dirty-tree template outlives the edits that move its archive versions. The saving is real: about 12 s a run at earthrise and about 3.6 s at far-shore (G2), and P04's worker-scoped context, ordered by system, gets most of it without a template store.

**Its premise, measured (G2).** A warm relaunch is an archive hit at both points, and earthrise settles warm within 0.25–0.54 s, at the settle protocol's 250 ms resolution and inside the success metric's 1.5 s. Far-shore, the one generated point measured, settles warm in 8.5–9.1 s, held by `terrain.deposits`, so a 1.5 s warm target does not hold there.

### 35. X12: refresh rate as an operating-point axis (vetoed by fit)

**Pitch.** The worst escaped temporal defect, the vibrating moons of Mars, was a relationship between the 64 Hz tick and the frame. The Air's rigs present at about 60 Hz. The Mac mini's display runs at 120 Hz, and players on high-refresh displays present at 120 or 144.

**Mechanism.** P20 points gain `refreshHz`. P21's `stepFrames(n, {dt: 1/refreshHz})` drives the frame sequence, and the temporal assertions run at 60, 120 and 144 Hz from one settled stance.

**First step.** In `headlessEngine`, 128 frames at dt 1/120 at the Phobos stance, against 1/60.

**Success.** On the commit before the camera-a-tick-behind fix, the Phobos residual exceeds 1 px at one of the three rates. On HEAD it is under 1 px at all three.

**Risks.** It waits on P21 for the rates a display does not give. The Air's panel being 60 Hz is training data. The Mac mini's panel is 120 Hz by `system_profiler`, but its off-screen rig runs at about 100 irregular rAF/s (M5). A headed cast there is a run above 64 Hz with no P21, not a 120 Hz one.

**Review.** The fit review vetoes it. The motivating defect showed at 60 Hz: the sawtooth beat "at 60 fps against a 64 Hz tick" ([CONTEXT.md](../../CONTEXT.md):3480-3482), so a refresh-rate axis is not what would have caught it, and the success metric is met at 60 Hz alone. The regime 60 Hz never reaches is a frame with no tick, which only a rate above 64 Hz produces. [`world.test.ts`](../../packages/simulation/src/world.test.ts):120 already holds the universe equal at 60 and 144 Hz. A Node property test over `dt` for the presentation residual answers the rest in about a day, without a browser or P21. A headed `--cast` on the Mac mini is the browser check for the regime with no tick in a frame, at no build cost; the veto stands for the axis, not for that cast.

### 36. P34: input correctness specs

**Pitch.** `page.keyboard.press` reaches the keymap (probe E), and trusted mouse drags establish native capture. Specs cover the input and focus class:

- A drop that missed by 0.552 rad.
- A dialog unreachable by Tab.
- A held action surviving a modal.

**Mechanism.** A curated keymap table, each row asserting a harness readout:

- Backquote toggles the stored `ir.hud.debug.on` preference.
- Shift+KeyH toggles `engine.chrome`.
- Space toggles `world.paused`, and is declined on a focused control.
- Shift+Slash goes to `/keys`.
- F5 then F9 leaves `stateHash` equal.

Other rows:

- **Dock drag.** Through Playwright's HTML5 drag manager, never raw CDP, asserting every panel in exactly one zone.
- **Drop gesture.** By `page.mouse`.
- **Pointer lock.** On the on-foot avatar at `/play/solo`, after first measuring whether Chrome grants it under Playwright.
- **Touch.** First, whether `hasTouch` makes `(pointer: coarse)` match. If it does, the DPR ceiling drops to 1.5 and the point is named.
- **Gamepad.** A `getGamepads` fake, with focus following `nearestInDirection`.

Rebinding rows are GPU-free and run in P35.

**First step.** Probe E's script promoted to `input.spec.ts` with three rows.

**Success.** A scratchpad copy restoring "keep the first hit" fails the drop spec.

**Risks.** The gamepad fake proves focus routing, not the HID driver.

### 37. P04: Playwright Test as the browser suite runner

**Pitch.** `@playwright/test` runs everything that asserts. drive.mjs stays the REPL.

**Mechanism.**

- **Config.** Outside `vitest.config.ts`'s include list, so `pnpm test` stays Node-only. It gets knip, oxlint and a typecheck project, `workers: 1`, `trace: 'retain-on-failure'` with screenshots off, and video off.
- **Server and setup.** `webServer` on X3's port with `ASTRO_DEV_TOOLBAR=0`. `globalSetup` takes P01's lock for the run and makes a warm-up visit for Vite's first-visit reload. The shell project runs from its own config with no `globalSetup`, so a shell run takes no lock and boots no unseeded runtime.
- **Two fixture families.** A base family for P35. A worker-scoped `rig` fixture that runs the P03 guard and serves fresh or warm state (X9) as a recorded option. It refuses URLs without the flag, boots by numeric `expect.poll`, and exposes `shot`, `cast`, `trace`, `sample` and `steps(argv)` over P02.
- **Projects.** One per operating point (1600×900@1 and 1440×900@2), and every spec names a Sol and a generated point.
- **Retries.** `retryStrategy: 'isolated'` and `failOnFlakyTests` apply to the shell project in CI only.
- **ADR.** It records Vitest Browser Mode (P12), full replacement (P10) and Test Agents (P49) as rejected alternatives.

**First step.** Port the scratch config and spec, measure warm boot plus settle, and decide the version. 1.62.1 is the measured version. 1.65 was tested against Chrome 157 and adds the `-exclusive-` lock and `send` timeouts, and rerunning the probe set takes about an hour.

**Success.** The earthrise/far-shore spec and one keyboard row are green on both projects. Every result carries P03's record. The root suite collects zero specs.

**Risks.**

- `tests/browser/` is in no workspace or tsconfig ([`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) covers `apps/*` and `packages/*`), so the suite lives in an `apps/` workspace or under `scripts/browser/`.
- Nothing triggers it but P13's instructions and P45's receipts, because X4's check-graph stages are vetoed.
- One review puts the effort at 4.5 days.

**Claims.**

- Green under `channel: 'chrome'`: measured (C).
- The TypeScript loader resolves relative `.ts` imports into `packages/devtools` and `apps/game/src`: verified by a no-browser run, 2 passed in 330 ms. The `@/` alias needs config.
- No `allowBuilds` entry needed: verified.
- A warm profile after fresh navigation: measured on the Mac mini (G2), an archive hit at both points.

### 38. X5: a late pipeline-compile census

**Pitch.** [`warmup.ts`](../../apps/game/src/render/warmup.ts) documents a failure in which every warmed pipeline compiles again on the first presented frame. A count of pipelines built after `booted` is exact. The thermal step cannot touch it, and it plausibly runs on the hosted runner.

**Mechanism.** An `addInitScript` wraps `GPUDevice.prototype.createRenderPipeline`, `createComputePipeline` and their async forms before the app requests its device. It records label, kind and the rAF count, as [`gpuHarness.ts`](../../apps/game/src/render/gpuHarness.ts):395-421 does in the Dawn suite. A transition script at P20's points runs:

- A picture switch.
- A system jump.
- `galaxyJourney` there and back.
- A mode switch.
- A cinema seek.
- The descent.

Late compiles go to a reviewed `compileLedger.json`. The target is 0, and any nonzero entry carries a reason.

**First step.** Count pipelines before and after `booted` and across one picture switch at earthrise headless.

**Success.** The ledger is stable across 5 launches at a Sol and a generated point. A scratchpad copy that drops one producer's warm-up registration fails, naming the pipeline.

**Risks.** Async compile order may vary. Whether a settled stance gives a deterministic count: unverified. Wrapping the prototype intercepts the app's device: training data.

**Review.** The defect behind it is misattributed. [perf.md](perf.md):87-93 puts the 137 ms mode-switch frames down to React mount and unmount commits, not compiles, and no escaped late compile is on record. A target of 0 is unrealistic for a system jump, where a body or haze family the boot never loaded compiles new materials legitimately, so the ledger is a list of reasons. The wrapper never throws and passes unknown descriptors through (rule 65). It is P27's browser half, and is built with it. Running it on the hosted runner waits on P32.

### 39. P27: a work-counter ledger

**Pitch.** Timing on hosted runners is noise, but much of a frame's cost is a count, and counts are deterministic given seed, stance and display-pixel viewport.

**Mechanism.** [`pictureLedger.test.ts`](../../apps/headless/src/pictureLedger.test.ts) already snapshots `selectTerrain` for 13 pictures at 480×320. The Node half extends it:

- 1600×900 and 2880×1800 viewports.
- Views per status sample, and `performance.now` calls per frame.
- Heightfield jobs issued, and frames until converged. The streamed counts go to the slow stage.

The browser half comes after P04: `renderer.info` draw calls, warm-up totals, working texture bytes, and a draw-call budget check.

**First step.** Converge counts for the four still points, byte-stable across ten runs.

**Success.** Doubling `BUILDS_PER_FRAME` in a scratch copy fails the ledger, measured by frames to converge rather than job count alone.

**Risks.** Overlap with the existing ledger lowers its new value.

### 40. P25: trace-driven attribution

**Pitch and mechanism.** When P18 reads `slower`, both arms take `browser.startTracing` with `?timing=trace` for 3 s, plus `ir.passes(60)` outside the window. Span and pass tables are diffed with P18's statistics and ranked by effect size. When `ir.gpu` moved, CPU-span deltas are labeled "possibly power-coupled". A `Profiler`-domain `.cpuprofile` adds function-level main-thread attribution.

**First step.** A tested diff over probe G's two `pnpm timing --json` tables.

**Risks.** `ir.passes` CV is 7.8–12.8%, and throttled CPU spans need about 10 pairs. The report says so. One review sizes it at 2 days.

### 41. P48: move the perf lab off the fanless workstation, onto the Mac mini

**Pitch and mechanism.** The fan-cooled M6 Mac mini runs the perf lab, first as the machine Jon's deep performance runs use and then as a self-hosted runner labeled `gpu-perf`, with runner concurrency 1 plus P01. It runs P18 on labeled PRs, P23 nightly and the plates, and makes absolute baselines and change-point detection possible once its A/A spread is known. `gpu-probe.yml` already names third-party GPU runners, RunsOn and machine.dev, so a Linux T4 probe needs no Team plan.

**First step.** Done for the step: [On the Mac mini](#on-the-mac-mini) has 10.4 sustained minutes at far-shore 1600×900@1 and 1440×900@2 with `ir.gpu` flat and thermal pressure at 0, against the Air's 35% step. What remains is the calibration: five cool sessions on different days at both windows, giving the between-session spread against a target of under 2% (the Air's cool sessions differ by 8%). Below it, stored baselines become usable there; above it, the mini interleaves like the Air.

**Risks.** The scores in the ranked table assume a hardware purchase, and the hardware exists, so the effort and risk overstate this proposal; it is not re-scored. The mini is fan-cooled but compact, and whether it throttles under a 45–75 minute tour is not known. A self-hosted runner on a public repository is a fork-PR risk, and label-gating is necessary but not sufficient. The runner is Jon's decision.

### 42. P12: Vitest Browser Mode, rejected as the rig's runner (vetoed by fit and completeness)

`@vitest/browser-playwright` 5.1.0 matches the repository's vitest 5, but runs tests in an iframe of an orchestrator page. The app's readiness, focus emulation, routing and service worker assume the top-level window. Its niche, TSL graphs in Chrome's WebGPU beside Dawn-in-Node, has no recorded defect behind it and adds a GPU job. **Deliverable:** one paragraph among P04's ADR alternatives.

### 43. P05: measurement fixtures that retire the hand-rolled scenario runners

**Pitch.** About 94 top-level scratch scripts re-invent one runner, and three orchestrators carry byte-identical `settle.mjs` copies.

**Mechanism.** Tracked fixtures:

- `invariance`: `stateHash`, lens and exposure before and after.
- `rafSampler`: informative headed only.
- `gpuCost`: min-of-3, after rAF windows.
- `heap`: forced GC.
- `cast`: CDPSession screencast into `analyzeFrames`.
- `trace`.

Because demand is drive.mjs calls, the same pieces also ship as page-script snippets runnable by `drive.mjs --file`. The sunlit and hour-sweep finders are their own project: 18 finder scripts, which belong as harness verbs.

**First step.** The invariance guard and rAF sampler from `perf-step.mjs`.

**Success.** The ported orchestrators match the old ones when measured interleaved, cool, in one session. The original metric, "within 1% of recorded figures", is refuted by N5.

**Risks.** Adoption depends on P13.

### 44. X11: accounts in the browser (vetoed by fit)

**Pitch and mechanism.** Two halves:

1. A build without `PUBLIC_CLERK_PUBLISHABLE_KEY` asserts no Clerk request, no sign-in affordance, and the signed-out solo door. This half lands now in P35's project.
2. A development-instance build uses `@clerk/testing/playwright` (`clerkSetup`, `clerk.signIn`) with `CLERK_SECRET_KEY` from Jon through `op`. It covers the modal over a mode keeping the address, `/auth/callback`, a granted test user at the solo door, and sign-out.

No authenticated trace is ever uploaded.

**Risks.** The second half waits on credentials, as it must.

**Review.** The fit review vetoes it as a proposal of its own. The no-key spec folds into P35 as a case of about half a day, and its request census also guards Clerk's boot cost. It builds with the publishable key explicitly empty, because Vite reads `.env.local` and `.env.production` at build time and another checkout may hold a key. The signed-in half rests on Clerk's hosted UI over the network and on a test user Jon provisions, so it stays local until then. It uses the pinned `clerk` CLI, not `npx clerk@latest`. No escaped account defect is on record.

### 45. P36: accessibility as assertions

**Pitch and mechanism.**

- `@axe-core/playwright` on each dialog root, Home, a docs page, `/keys` and each settings tab.
- Partial `toMatchAriaSnapshot` templates.
- Focus containment, and focus returning on Escape.
- Reduced motion leaving no running animations in BootLedger, EntryTrace and the doc skeleton.

A contrast probe reads background luminance behind each `.hud-layer` text box on a composited screenshot, against 4.5:1 ([DESIGN.md](../../DESIGN.md):223). Its percentile is measured at a lit limb and a night side before it gates anything.

**First step.** Violation and incomplete counts on Home and settings, which size the triage list.

**Risks.** In P35's refused mode, the runtime notice's `role="alert"` is on every page.

### 46. P41: the cinema's reference loop, frame-exact (vetoed by fit)

Parked `/cinema?t=` frames land exactly: 0 px between captures, against about 530 px for a verb seek. Twelve keyframes from the measured beats, compared tree against base in one session, give the cutscene a check with no third-party frames. A dump mode for the sibling `tng-inertial` checkout's `compare_render.py` serves only the main checkout. **Kept as:** the twelve keyframes as cases in `presets:compare`, since the census leaves neither C3 nor P14 to hold them, about half a day.

### 47. P28: `ir.knobs()` and `ir.setKnob()`, a quality-knob registry

**Pitch and mechanism.** Quality knobs sit behind four doors:

- Live engine fields.
- Sensor-chain rebuilds.
- Page-lifetime URL switches.
- Hard-coded constants: 24 requests a frame, 1,280 patches, 16 cell pixels, 2 sky tiles per submission.

`knobRegistry.ts`, beside [`engineKnobs.ts`](../../apps/game/src/state/engineKnobs.ts), lists `{id, domain, current, apply: 'live'|'chain'|'reload', owner}`. Writes go through `preferences.write`. Constants move into `engine.tuning`, read-only first, and overridable by a strictly parsed `?tune=` declared in `QUERY`.

**Risks.** Moving tuned constants is safe only behind P27's ledger proving the defaults byte-identical, so P27 comes first despite the empty dependency list. A `?tune=` reachable in the shipped build, where `window.ir` ships, needs Jon's stance.

### 48. X8: a draw-class marginal-cost table

**Pitch and mechanism.** Two verbs through `RenderHost`:

- `ir.drawClasses()` lists draw classes.
- `ir.drawClass(id, visible)` toggles `material.visible` on the scene the engine holds. It replaces the Vite dep-bundle `_roots` path and never writes a presentation switch.

`scripts/perf/ablate.mjs` runs rotating pairs of all-visible against all-minus-one, with `ir.gpu` min-of-4, and writes a "marginal, not standalone" table into perf.md.

**First step.** The read-only listing at earthrise.

**Success.** At far-shore, both windows, marginal costs plus the residual sum to within 10% of full `ir.gpu`.

**Risks.** Small draws are latency-bound, so marginal cost understates overlapped work.

**Review.** The verb alone, about a day, is worth landing. It retires the `_roots`-through-the-Vite-bundle path the scratch rigs rely on. The table is weaker than it reads. At a static stance a node that holds its target measures nothing, small draws are latency-bound, and on a tile-based GPU hiding one class changes overdraw for the others, so the 10% sum-to-total metric likely fails by construction. It needs P18 and P20, and the far-shore 1440×900@2 point runs headless only.

### 49. P14: the thirteen pictures as a Playwright suite

**Pitch.** As specs, plates run headless, interleave base and head in one session, compare losslessly and attach difference images.

**Mechanism.** `compare.mjs`'s matcher moves into `scripts/presets/matcher.mjs` as `toMatchPlate`: `SAME` 3%/8%, `NOISE_FLOOR` 200, `LIT_FLOOR` 0.2. It is never `toHaveScreenshot`'s YIQ default. One test runs per picture at 480×320@1. Comparator 1 checks the committed plates. Comparator 2 checks an in-session base on a second `webServer`. The entry points stay `presets:compare` and `presets:plates`.

**First step.** All 13 twice headless, the same measurement as the dark-plate census.

**Success.** #180's pair reports both dark plates moved, and suite and `presets:compare --all` agree on all 13.

**Risks.**

- CONTEXT.md:12504-12506 records a comparison that passed while two dark plates moved. It does not record whether those moves were wanted.
- The incumbent is warm, and fresh contexts pay 12–20 s of cold settle each (28–31 s throttled), so wall time may get worse.
- Moving capture changes who writes the committed plates, which needs a recapture and an ADR-0046 amendment.
- C3 delivers the sensitivity with one recipe. One review puts parity at 6 days.

**The census answered its sensitivity case (G3).** The headed arm reads 0 px on all 13 pictures, so the default compare closes the #180 blind spot without this suite.

### 50. P22: a deterministic temporal lane with `page.clock`

**Pitch.** With `page.clock` installed before navigation, the game boots normally, and each paused `runFor(16)` renders exactly one frame (probe H). Motion can be stepped and asserted with no engine change and no 40 fps trust floor.

**Mechanism.** Project `temporal` under P01. The fixture installs the clock, boots and settles unpaused, then requires `settled().ok` and `pool.queued === 0` before pausing. It steps an increment, runs `runFor(16)` and takes a screenshot (271–282 ms per step). It refuses `ir.gpu`, `ir.passes` and `ir.profile`. The cases:

- Phobos over 128 steps.
- far-shore coast pans.
- Picture-switch frames.
- A terrain boundary and the disk at DPR 2.
- Parked cinema frames.

**First step.** 120 paused frames of a slow pan at far-shore through `analyzeFrames`. This needs only P01 and P06.

**Risks.**

- Every test pays a cold boot, because the clock installs before navigation.
- The 16 ms grid against the 15.625 ms tick beats at about 41 frames, which is not what a 60 Hz player sees. The Phobos case needs a control on the pre-fix commit.
- Workers and GPU completion run in real time, so this is a lane for camera-path defects, not streaming.
- If those limits matter, P21 replaces it.

### 51. X6: cross-engine shell coverage (vetoed by fit)

**Pitch and mechanism.** Firefox stuck at "first light" forever, iOS `100vh` breakage and Safari pipeline refusals were all found by people. P35's specs run unchanged in two more projects:

- `shell-webkit`: Desktop Safari and iPhone 15 descriptors.
- `shell-firefox`.

One local Firefox runtime case asserts `booted`, or a named refusal, within 60 s, never a cover still up at the deadline. Playwright's WebKit has no `navigator.gpu`, so the same case there exercises WebGL.

**First step.** P35's first spec on both engines.

**Risks.** Playwright's WebKit is not Mobile Safari. Device crashes stay human-found.

**Review.** The fit review vetoes it. None of the user-found cross-engine defects on record would be caught. Firefox's first light is now a backend-chosen seam with Node tests (`firstLight.ts`), Safari's pipeline refusal is WebGPU, which Playwright's WebKit lacks, and the Mobile Safari crash loops and iOS `100vh` are device behavior. Playwright's Linux WebKit is not Safari, and engine-specific shell failures need triage the estimate leaves out. A local Firefox WebGPU run is one more GPU job under the lock. P47 holds the cross-engine lane on record.

### 52. P26: a nightly paired perf series (vetoed by fit)

A nightly P18 against the last nightly's commit, chained by ratio and anchored weekly, behind gates for idle time, AC power, load and the lock. It catches drift below any one PR's detectable effect. On the Air it runs unattended GPU load on Jon's workstation. It crosses Chrome's silent updates (X2), and depends on a launch agent that is an ask rule. **Revisit:** on the Mac mini, with P48.

### 53. X7: handheld and compact operating points for the running game (vetoed by fit)

**Pitch and mechanism.** [`output.ts`](../../apps/game/src/render/output.ts) caps a coarse pointer at DPR 1.5. `viewport.ts` switches to the compact dock below 900 px and picks the touch drag backend. A context with `isMobile`, `hasTouch` and DPR 3 asserts:

- A buffer of exactly viewport × 1.5.
- The compact dock.
- A 200 ms long-press drag through `Input.dispatchTouchEvent`.
- Chrome inside the safe-area insets, through `Emulation.setSafeAreaInsetsOverride` where available.

**First step.** Whether `hasTouch` makes `(pointer: coarse)` match in Chrome 157.

**Risks.** Chromium emulation is not an iPhone.

**Review.** The fit review vetoes it. Neither `dprCeiling` nor the coarse-pointer branch has a test. The part worth keeping is a Node test of `dprCeiling` and of `App`'s `min(DPR, ceiling)`, plus one buffer assertion at a touch point inside P33: about half a day. Playwright's touchscreen is tap-only, so the long-press drag needs raw `Input.dispatchTouchEvent` into react-dnd's touch backend, and the safe-area command is experimental. No escaped defect is recorded for these branches. The handheld defects on record are WebKit and device facts that emulation cannot reproduce, and the lane measures no handheld performance. Any inset assertion respects rule 30.

### 54. P23: a memory lane, a soak slope and a constructor heap diff

**Pitch and mechanism.** Forced-GC heap is the steadiest figure measured (CV 0.1–0.2%). A scripted tour on the production preview takes heap, DOM counters, texture bytes and pool stats at each revisit, gated on retained delta, paired. A soak gates on slope. `scripts/perf/heapDiff.mjs` diffs constructors across one jump.

**First step.** `heapDiff.mjs` alone, an afternoon with immediate payoff for perf.md's open memory items.

**Risks.**

- Tours of 45–75 minutes belong to P48 hardware.
- A `?census=gpu` wrapper over-counts and never throws.
- The tour needs a DPR-2 revisit point, because the one leak that cost players reproduced only there (CONTEXT.md:778-783).

### 55. P16: automated bisection over plates and GPU cost

**Pitch and mechanism.** `git bisect run` with a three-verdict step: exit 0 same, 1 moved, 125 unknown or build failure, resampling while unknown. Plate mode differences each candidate against the good commit's own capture. Perf mode runs rotating `[good, bad, candidate]` rounds under P01.

**First step.** Measure cross-build plate noise for two commits that share rendering.

**Risks.**

- `compare.mjs` serves the base with `astro dev` and builds nothing (`capture.mjs`:96-101), so the build step is new.
- Each step needs `git lfs pull`.
- Perf mode is about an hour of lock time, so it is nightly-only.
- There are two recorded multi-PR hunts in 244 commits.

### 56. X1: a presentation-lifecycle fault lane

**Pitch.** Every driven URL carries `presentation=occluded`. So nothing tests the watchdog's recovery ladder, device loss or bfcache re-begin, and boot-lifecycle defects live in exactly that code. One annotated exception lane boots without the flag, records no figures, and injects faults.

**Mechanism.** The cases:

- **(a)** A healthy boot without the flag: one `preload` measure, and the buffer equal to the ceiling-clamped viewport × DPR.
- **(b)** A document that loaded hidden, in a background tab, then `bringToFront`.
- **(c)** A dark-by-intent picture: at most one remount.
- **(d)** A device loss with reason `'unknown'`, from an init script that wraps `device.lost`, driving [`rendererErrors.ts`](../../apps/game/src/render/rendererErrors.ts):13-38 to the failure notice, then retry to `booted` with one renderer. A page-side `device.destroy()` reaches nothing, because three r185 returns early on a `'destroyed'` loss.
- **(e)** `Page.setWebLifecycleState` frozen and active, and bfcache with `--disable-back-forward-cache` removed.

**First step.** Case (d) alone, headless.

**Success.** Scratchpad copies missing the once-per-load guard, the `pageshow` handler or producer retirement each fail one case.

**Risks.** A headed window may take focus. A wrapped `device.lost` proves the app's handling of a loss, not three's.

**Review.** Case (d) as first written exercised nothing: three r185 returns early on a `'destroyed'` loss (`three/src/renderers/webgpu/WebGPUBackend.js`:264, read in the installed package), so a page-side `destroy()` freezes the page with no notice. The mechanism now wraps `device.lost` instead. Case (f), a GPU-process crash, is dropped: on this machine that is the event that took WindowServer down twice. Case (b) needs focus emulation turned off through a CDPSession. Whether a page holding a WebGPU device is bfcache-eligible is unverified, and going to `/docs` is a same-document navigation, so the bfcache half needs a cross-document hop. A trimmed core of (a) headless, (c) and the freeze half of (e) is about two days. It catches the false-ladder class that P33 cannot reach, because P33 sets the flag.

### 57. P38: service worker install, update and offline launch across two builds

Two dists are built from one tree with different `WORKERS_CI_COMMIT_SHA` values ([`vite.config.ts`](../../apps/game/vite.config.ts):39-46) and served from one origin. The phases:

- Install and warming.
- `setOffline` and reload.
- A switch to build B, which keeps one previous build and leaves the save intact.
- `/api` never served from cache.
- The health pip under routed variants.

Phases 1, 3, 4 and 5 run GPU-free, with `navigator.gpu` and WebGL2 stubbed so `startClient` registers the worker and the renderer then fails. Only the offline boot needs the lock. No escaped service-worker defect is on record.

### 58. P21: `ir.stepFrames(n, {dt, drain})` (vetoed by fit)

An engine verb advances N presented frames at a fixed `dt`, with real span timings, by redirecting `EngineTick` and every `useTimedFrame` consumer to a stepped delta. R3F 9.8.2 takes `clock.getDelta()` unless `frameloop` is `'never'`, so the delta must come from the engine. The verb would also let X12 cover 120 and 144 Hz. It touches [`EngineTick.tsx`](../../apps/game/src/scene/EngineTick.tsx), the one place the wall clock enters the game. **Deferred:** until P22's real-time blind spots are shown to matter.

### 59. P40: recorded input replay

An `InputLog` in `packages/simulation` is fed by the world's input verbs (`setControl`, `setThrottle`, `setFlightAssist`, `killRotation`; `world.ts`:840-878). `pnpm sim --replay` replays it against `stateHash`, under a fast-check property test. A browser spec records a 30 s flight with real keys through `ir.recording()` and checks the Node replay matches. This closes the roadmap's ["Replay and reconciliation"](../../docs/roadmap.md) gap. About 90% of it is engine work, and headless saves suffice as starting states. **First step:** the recorder over the four verbs in `openSession` and the round-trip property.

### 60. P49: Playwright Test Agents, fenced to the DOM shell (vetoed by all three reviews)

`init-agents --loop=claude` writes `.claude/agents/playwright-test-*.md` and a root `.mcp.json`. That collides with the repository's shared briefs, and the files are regenerated on every update. The planner sees only accessibility snapshots, which cannot see the canvas. The healer edits tests toward green and may mark them skipped, against the rule that a regression test is proven to fail first. **Deliverable:** a line in P04's ADR.

### 61. P15: a self-triaging plate suite (vetoed by fit)

It classifies each moved plate as rig noise, gone dark, lost light, or a real change, and proposes a relight patch or a recapture, never accepting one. It depends on P14 and P16, and on a per-plate light history nothing stores. The reusable piece, the sub-solar and hour-sweep finders as a tested library, belongs with P05.

### 62. P46: a property-based browser fuzzer (vetoed by fit)

fast-check Picture arbitraries and camera-verb sequences run in one booted page against the harness's oracles: no errors, `stateHash` unchanged, finite readouts, lit when `ir.light().lit`. Failures shrink to a shot URL. Realistically 60–100 cases an hour, every one under the lock. No escaped defect on record would have been caught by it.

### 63. P29: a budget tuner over the quality-versus-cost frontier

MotionMark-style ramps over one knob, then a constrained search over three or four. Each sample is `ir.gpu` min-of-4 interleaved with the reference, and quality is scored by FLIP or ΔE94 against a max-quality capture. The output is a Pareto table in perf.md, never a default. **First step:** one manual ramp of picture scale at `far-shore@1440x900x2` (39.8 ms against 16.6) recorded in perf.md. The tuner gets built only if the ramp shows an unexpected knee. The photorealism stance makes the frontier a human judgment.

### 64. P11: ir-mcp, the harness as typed agent tools (vetoed by fit)

A long-lived MCP server holds booted Chrome 157 pages and exposes `ir` verbs with schemas generated from `GameHarness`. It adds a third launcher with its own trap list. It holds the lock for an agent session unless Jon exempts an idle page (X13; G5 finds a held page keeps about 2 GB of driver allocations). It amends `browser.md`, which is Jon's rule. WebMCP (`page.webmcp`, 1.64) is the alternative that keeps schemas beside the verbs. Agents' preference over the 80 ms CLI is unmeasured.

### 65. P44: the guide over loopback WebRTC

Fake-media flags, a granted microphone and a loopback provider page answering the SDP give real WebRTC at zero spend, and retire `webrtc.mjs`, a third hand-rolled Chrome launcher. **First step:** whether a headless page's `AnalyserNode` reads non-zero from a fake microphone, before five days are spent. The two-context multiplayer half waits for H4, because `/ws` answers 501.

### 66. P47: differential rendering across browser builds and engines

- **Stage 1** is a Chrome-next lane: plates and paired `ir.gpu` on the next Chromium. Its first step, an interleaved cool rerun of probe D, is cheap and comes early, because P03 and P13 lean on the 2–5× figure.
- **Stage 2** is WebGL2-fallback parity through P03's `fallback` kind. Thirteen plates at 1 fps take more than 20 minutes.
- **Stage 3**, Firefox and Safari WebGPU over WebDriver, is a moonshot with two non-Playwright drivers.

### 67. P17: an explainer that names the pass behind a moved plate (vetoed by fit)

`ir.readTarget(label)` reads named intermediate targets inside rAF, then draw-class ablation (X8), then an import-graph ranking of the changed files. It adds readback to the frame loop under the rule that a readout never changes or stops the frame. **Deferred:** until P16 shows how often a move stays unexplained.

### 68. P10: full replacement of drive.mjs (on record, not recommended; vetoed by all three reviews)

Deleting about 1,158 lines removes about 7 process and 5 CLI defects of the rig's 22. The cost:

- The 80 ms warm attach, replaced by at least 4 s of boot.
- The display color profile.
- The `--json` contract.
- Rewrites of SKILL.md (466 lines), driving.md (390) and about 20 other files.

About 10 of the 22 defects are app contracts that stay under any driver. **Reconsider only if** drive.mjs falls below 20 invocations in 30 days, 60 days after P04 and P07 ship.

---

## Sequence

Node-only work runs in parallel worktrees. GPU work runs one job at a time, on a cool machine, interleaved, with the thermal state named. Long GPU holders run as attended blocks, because agents call `test:gpu` about 20 times a day.

### The first wave, on the Mac mini

The first wave runs on the Mac mini: `worktree-implementer` agents in parallel worktrees for the Node lane ([`/parallel`](../../.claude/skills/parallel/SKILL.md)), and one agent at a time in the GPU lane. No file belongs to two units in one wave. Until P01 is wired, the GPU lane's one agent is the lock, so no Node-lane unit runs `pnpm test:gpu`, a browser, drive.mjs or `presets:*`.

**It ran on 7 November 2026.** The Node lane is #188, the six units collected in the order below onto `830c243`, with `pnpm check` green on the collected tree. The GPU lane's figures are in [On the Mac mini](#on-the-mac-mini): G1 and G2 ran before the Node lane, G3 beside it, and G5 after every worker had exited. G4 did not run, because G3 decided. Until #188 merges, the second wave is cut from its branch, `feat/playwright-first-wave`.

**Before any agent starts.**

1. **The evidence.** `.scratch/playwright-spike/` is untracked, so no worktree carries it. N5, G4, P13's trap table, P04's port and probe D's rerun read it from the mini's main checkout, which holds a copy of the Air's (643 files, 91 MB, matched by checksum), and a unit that reads it copies what it needs into its own tree as fixtures. Where the copy is missing, those units do not start. They are not rebuilt from this plan's figures.
2. **Browsers.** Chrome 157 stable is installed, and so are Playwright 1.62.1's Chrome for Testing 151.0.7922.34 and its headless shell, machine-wide in `~/Library/Caches/ms-playwright` (`playwright install chromium` from the evidence directory, 554 MB). A unit uses the evidence directory's Playwright, whose `node_modules` `bun install` restored there. It never runs `playwright install chrome`.
3. **The server.** A fresh worktree has no `apps/game/dist`, so `pnpm dev` fails at the Worker's asset binding. The GPU lane serves with `pnpm dev:client` and drives with `--no-serve` ([`driving.md`](../../docs/agents/driving.md):240). 5173 is bound by name, so one worktree serves at a time.
4. **The display.** A headed rig on the mini gets neither the panel's 120 Hz nor a headless-comparable GPU cost: about 100 irregular rAF/s off-screen, and 2.2× headless `ir.gpu` on screen (M5, M6). So no first-wave step reports a headed frame interval or a headed time there. drive.mjs follows the attached display's color profile, which is the TV's, so a mini capture compares with another mini capture (`presets:compare`'s base and head), not with plates accepted under another display. G3 runs with the display woken and held awake (`caffeinate -d`), because no capture has been taken against a sleeping one.
5. **Quiet windows.** A GPU-lane step that reports a time (boot, settle, `ir.gpu`, spans) runs with the Node lane paused: no install, build, Stop gate or suite beside it. A step that reports pixels needs only the one-job rule.

**The Node lane, in parallel.** Every unit finishes with its named command, then `pnpm typecheck && pnpm test` in its worktree, and reports numbers.

| Unit | Work                    | Owns                                                                                                                                       | Finish line                                                                                                                                                                  |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1   | P01's module            | `scripts/gpuLock.mjs`, `scripts/gpuLock.test.mjs`                                                                                          | `pnpm vitest run scripts/gpuLock.test.mjs` over P01's first-step cases, and whether the agent's own sandbox can create and remove a file in `git rev-parse --git-common-dir` |
| N2   | C4                      | `scripts/drivePage.mjs`, `scripts/drivePage.test.mjs`                                                                                      | the new case fails against the unchanged file, then passes; the other 12 cases are unchanged                                                                                 |
| N3   | P06                     | `scripts/frameDiff.mjs`, `scripts/traceFrames.mjs`, `scripts/timing.mjs`, and a test file each                                             | P06's focused coverage command at 90%; each named mutation fails its test                                                                                                    |
| N4   | X3's allocator          | `scripts/ports.mjs`, `scripts/ports.test.mjs`                                                                                              | `pnpm vitest run scripts/ports.test.mjs`                                                                                                                                     |
| N5   | P03's presets and guard | `scripts/driveLaunch.mjs`, `scripts/driveLaunch.test.mjs`, fixtures from the evidence                                                      | the guard's decisions over the probe outputs, with no browser; needs precondition 1                                                                                          |
| N6   | C1 and C2               | the header comment of `scripts/drive.mjs`, `.claude/skills/drive/SKILL.md`, `docs/agents/driving.md`, `design/plans/perf.md`, `CONTEXT.md` | `pnpm docs:build`; C1's `rg` finds none of the three claims                                                                                                                  |

**The GPU lane, one step at a time, in this order.** Every figure names the machine, the point, the build and the thermal state.

| Step | Work                                                                                                                                            | Window                | Feeds                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------- |
| G1   | C1's check: a `code`-carrying event from `--js` flips the stored `ir.hud.debug.on` preference on a warm page                                    | pixels                | N6's trap 10            |
| G2   | P24's first step: warm-load archive hits, and far-shore's two settle clusters                                                                   | quiet                 | P24, and X9's question  |
| G3   | The census, headed: `pnpm presets:compare --all --twice` on HEAD, on a wiped profile and on the profile it leaves                               | pixels, display awake | rank 1's decision       |
| G4   | The census, headless, only if G3 does not decide: the 13 pictures twice in fresh Chrome 157 headless contexts at 480×320@1, by probe C's script | pixels                | C3 or P14               |
| G5   | X13's measurement: GPU-process CPU and resident GPU memory, live and held                                                                       | quiet                 | Jon's idle-rig decision |

**Collecting it.** In this order, each rebased onto the one before: N2, N3, N4, N1, N5, then N6 once G1 has reported.

**The second wave**, cut from the collected first, is one unit at a time because every piece edits drive.mjs: P01's wiring (`apps/game/vitest.gpu.config.ts`; drive.mjs, held from launch to `--down`; `scripts/presets/*.mjs`, one outer acquisition whose token each drive.mjs child carries), then X3's identity half (`ir.build()` with the dev-server tree root, and drive.mjs's comparison), then P03's drive.mjs half (`--status` runs the guard, whose identity check needs X3's). From then on the lock, not the lane's one agent, serializes GPU work.

### Later phases

**Phase 1 — the rig, hardened (weeks 2–3).**

- Whether an idle rig counts as a GPU job, which is Jon's call on X13's figures (G5: almost no GPU work detached, about 2 GB held until `--down`).
- P07 `--key` and `--click`, then P08's flag. Both edit drive.mjs or its steps, so they land one at a time.
- P08's validation: flash page, retina strobe, 13 plates.
- The census's change to `compare.mjs`: dark plates reported by default against a per-picture floor taken by `--twice` (rank 1, G3). C3 is not needed.
- The engine additions that need nothing else: P20 still points, then P30, then P19. All three edit `harness.ts` and the host ports, so they are one unit at a time, not a fan-out.
- P47 stage 1's first step: the interleaved rerun of probe D.
- P42's first step: Chrome for Testing 157 against Chrome 157, interleaved and cool (X2's question).

**Phase 2 — the Playwright foothold (weeks 3–5).**

- P02's expressions module.
- P04's base config, with the version decided after a probe-set rerun on 1.65.
- P35 in `pnpm check`.
- P37: the Node half first.
- P02's `driveWire.mjs`, and the `capture()` and `cast()` move once P06 tests them, because P04's rig fixture exposes them over P02.
- P04's rig fixture, then P33.
- P13 once P04, P07 and P08 are in.
- P45's `capture.mjs` half.
- P43.
- P32 dispatched as a plain script, then as specs.
- P04's worker-scoped context, ordered by system, as the warm state (X9's template store is vetoed).

**Phase 3 — the performance lane (weeks 5–8).**

- P05's snippets and fixtures.
- P18, after a production A/A, and on the Mac mini after P48's repeated-session calibration.
- X10.
- P24.
- P27's Node half, then X5 as its browser half.
- P25 and X8.
- P31.
- P34, X1, X11's no-key half in P35, X7's retained half (a Node test of `dprCeiling` and one touch-point buffer assertion in P33), P36, P39, and P41's keyframes as `presets:compare` cases.
- P42's full smoke, after P34. P14 is not scheduled, and the census did not call for it, so the smoke's plate leg is `presets:compare`, which by then reports the dark plates by default.

**Phase 4 — each moonshot gated on a measurement.**

- P22, then P21 and X12 only if P22's blind spots bite.
- P40.
- P28 after P27, then P29 after its manual ramp.
- P23, with `heapDiff` early.
- P16 plate mode.
- P38.
- P47 stages 2 and 3.
- P44 after its audio check.
- P26 on the Mac mini, on Jon's decision, once its repeated-session calibration exists.
- P12, P10 and P49 as lines in P04's ADR.

**On record, not scheduled.** A vetoed proposal is not work for a run until its gate opens. P15 and P17 wait until P16 shows how often a move stays unexplained. P46 waits for an escaped defect it would have caught. P11 waits until agents' preference over the 80 ms CLI is measured. X6 and X4 have no gate: P47 holds the cross-engine lane on record, and P45's receipts cover what X4's stamps would.

---

## What the engine has to add

| Addition                                                | Shape                                            | For                       | Constraint                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ir.idle(on)`                                           | `RenderHost` → `holdFrames()`                    | X13, P01                  | a driver state, never set inside a measurement; needed only if Jon exempts an idle rig, since a detached one already renders almost nothing (G5) |
| Build identity                                          | `ir.build()` → `BUILD_ID` and the served tree    | X3, P03, P19, P39         | the tree root on the dev server only                                                                                                             |
| `ir.environment()`                                      | operating-point record                           | P19, P03                  | a readout: every field `?.`, never throws                                                                                                        |
| `ir.perf(opts)`                                         | `perf/1` record                                  | P19, P18                  | spans with frames running, then held passes, `ir.gpu` last                                                                                       |
| Budgets and `TileProducerStats`                         | through host ports                               | P19                       | `packages/` may not import app code or name `performance`                                                                                        |
| `ir.perfPoints()`, `ir.perfPoint(id)`, `perfPoints.ts`  | registry over `PICTURES`                         | P20, X5, X7, X8, X12, P31 | no canonical write                                                                                                                               |
| `ir.whenBooted`, `whenSettled`, `whenFrames`            | promises                                         | P30, P02, P04             | no new timer; frame-end hook for `whenFrames`                                                                                                    |
| `ir.quiescent()`, presentation digest                   | readout                                          | P30, P22                  | never writes, never stops a frame                                                                                                                |
| `ir.drawClasses()`, `ir.drawClass(id, visible)`         | `RenderHost`                                     | X8, P17                   | never a presentation switch                                                                                                                      |
| `ir.knobs()`, `ir.setKnob()`, `engine.tuning`, `?tune=` | through `preferences.write`                      | P28, P29                  | P27 first; Jon's stance on a shipped `?tune=`                                                                                                    |
| `ir.stepFrames(n, {dt, drain})`, `frameDelta()`         | `frameStep.ts` beside `frameHold.ts`             | P21, X12                  | touches the one wall-clock entry                                                                                                                 |
| `ir.targets()`, `ir.readTarget(label)`                  | readback inside rAF while held                   | P17                       | a readout never changes the frame                                                                                                                |
| `ir.recording()`, `InputLog`, `pnpm sim --replay`       | `packages/simulation`                            | P40                       | canonical verbs only; an ADR for the format                                                                                                      |
| `?census=gpu`                                           | wraps `createBuffer`, `createTexture`, `destroy` | P23                       | over-counts, never throws                                                                                                                        |
| Final-sky mark                                          | a Timer mark in `browserTiming.ts`               | P24                       | marks only in that file                                                                                                                          |
| Graphics-off `QUERY` switch                             | `paths.ts`                                       | P35, P36                  | a short ADR, only if the strike marker proves entangled                                                                                          |

Some pieces need no engine change and live in fixtures:

- The compile census through `addInitScript` (X5).
- A `GPUDevice` `uncapturederror` listener (P46).
- A `navigator.getGamepads` fake (P34).
- Chrome's fake-media flags (P44).

WebMCP page tools registered from `harness.ts` are an experimental alternative to P11's generated schemas.

---

## What would change the ranking

Each of these answers would move proposals up or down. The ranked table is scored before the first wave and is not re-scored; an answered item says which way it moves:

- **P24's first step.** Answered on the Mac mini for the dev build (G2). A warm load is an archive hit, so P04's worker-scoped context, ordered by system, saves about 12 s a run at earthrise, and P18 rises. At far-shore it saves about 3.6 s, because a warm settle still waits 8.5–9.1 s on `terrain.deposits`, so a suite at far-shore budgets about 9 s of settle warm and 12 s cold on the mini. The slow cluster did not reproduce on the mini.
  - _If the Air's 17–19 s cluster is terrain:_ every suite at a generated point on the Air budgets 17–19 s of settle.
- **The dark-plate census.** Answered on the Mac mini (G3). Headed self-noise is 0 px on every picture, well under #180's deltas, so a `compare.mjs` default change closes the blind spot in about a day, and C3 and P14 drop.
- **X13 and the sandbox probe.** Answered in part. A held page does not free its GPU memory (G5), although a detached rig already spends no GPU time, so the question for Jon is whether a rig holding about 2 GB with no work submitted is a GPU job. A Claude Code worktree subagent writes the git common directory (unit N1).
  - _If Codex or EnterWorktree sessions cannot write it:_ P01 needs a different lock home before anything wires to it.
- **P32 on the hosted runner.**
  - _If positive and repeatable:_ P14's comparator, P27's browser half and X5 move into CI.
  - _If negative:_ the roadmap row closes with a figure, and image comparison stays local.
- **Probe D's interleaved rerun (P42's first step).**
  - _If the gap is the version:_ a pinned CfT at stable's version becomes the measurement browser.
  - _If it is the build:_ P03 warns on version changes and nothing pins.
- **P48's calibration on the Mac mini.** Its step question is answered: none in 10 sustained minutes at two windows.
  - _If the between-session spread is under 2%:_ absolute baselines, P26's nightly, P23's soak and P29's tuner become routine there, and P48 rises well above its scored rank, which assumed a purchase.
  - _If it is not:_ the mini interleaves like the Air, and P48 is a quieter room, not a baseline store.
- **Adoption.** If agents keep calling drive.mjs 16 times a day after P04 ships, P11 and P10 stay at the bottom. If specs displace it, P10's reconsider criterion applies.
- **Playwright 1.65.** A clean probe-set rerun moves the pin to the version tested against Chrome 157, and brings the `-exclusive-` lock and `send` timeouts.

### Open questions

Playwright and browser behavior:

- Does `hasTouch` make `(pointer: coarse)` match in Chrome 157, which would also select the 1.5 DPR ceiling?
- Is `requestPointerLock` granted under Playwright-launched Chrome, headed or headless? Does a CDP-dispatched F5 that the page does not prevent reach Chrome's reload?
- Does a headed Playwright window keep rAF running while truly occluded on macOS 27?
- Does an off-screen or headless page give the guide's level clock an audio pipeline?
- Is `Emulation.setSafeAreaInsetsOverride` available in Chrome 157?
- Can a `browser.bind()` client see and survive the binder's own booted context? Can `playwright-cli attach` pass `noDefaults`?

What the measurements did not cover:

- Does the dev build's per-frame cost differ from production at a static stance? N7 resolved only heap.
- What is far-shore's spread at 2880×1800 on the Air with N > 1? The mini's is CV 0.27% over 18 runs (M3).
- Does `page.clock`'s 16 ms grid reproduce 60 Hz temporal defects, and do the watchdog, firstLight timers and worker heartbeats stay healthy under a paused clock?
- What is the cross-build plate noise for commits that change no rendering? P16's plate mode rests on it.
- Does a headless boot without `presentation=occluded` ever climb the watchdog? This decides whether P33's negative check can run headless.
- Does the Air's headed census also read 0 px at 3%? G3's figure is the Mac mini's, on the TV's color profile.
- What closes far-shore's 17–19 s settle cluster on the Air, the sky or `terrain.deposits`? The mini settles in one cluster, so G2's per-input timeline, run on the Air, answers it.
- Does a detached off-screen rig keep rendering while the display is awake? G5 measured it with the display asleep.

Repository and machine:

- Where do the suites live: an `apps/` workspace or `scripts/browser/`? `tests/browser/` is covered by no workspace and no tsconfig.
- Does `ProcessInfo.thermalState` move at the 35% step?
- Does the Mac mini step under a load longer than 10 minutes, such as P23's 45–75-minute tour?
- On the mini, where do the off-screen rig's ~100 irregular rAF/s come from, and why does an on-screen headed window cost 2.2× headless `ir.gpu` when the Air's costs 0.14 ms more?
- What retention budget applies under `.data` for traces (6.7–15.4 MB per 5 s), profiles, templates, casts and bisect worktrees? No proposal sets one. Traces and storage state that carry a Clerk session never leave the machine.

---

## Sources

The external sources below were read for the spike on 6 November 2026. Facts marked "training data" in the sections above have no source here.

**Playwright**

- Releases [v1.58.0](https://github.com/microsoft/playwright/releases/tag/v1.58.0) through [v1.65.0](https://github.com/microsoft/playwright/releases/tag/v1.65.0); [release notes](https://playwright.dev/docs/release-notes)
- Chromium launch switches: [`chromiumSwitches.ts`](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/chromiumSwitches.ts), [`chromium.ts`](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/chromium.ts), [`crPage.ts`](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/crPage.ts), [`crInput.ts`](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/crInput.ts)
- [Test locks and parallelism](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/test-parallel-js.md), [clock](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/clock.md), [screencast](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/api/class-screencast.md), [CDPSession](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/api/class-cdpsession.md), [BrowserType](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/api/class-browsertype.md), [Browser](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/api/class-browser.md), [page assertions](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/api/class-pageassertions.md), [Test Agents](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/test-agents-js.md), [service workers](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/service-workers-js-python.md), [touch events](https://github.com/microsoft/playwright/blob/main/docs/src/touch-events.md), [WebMCP](https://github.com/microsoft/playwright/blob/v1.65.0/docs/src/api/class-webmcp.md)
- Issues and pull requests: [#39762](https://github.com/microsoft/playwright/issues/39762), [#39844](https://github.com/microsoft/playwright/pull/39844), [#30585](https://github.com/microsoft/playwright/issues/30585), [#11627](https://github.com/microsoft/playwright/issues/11627), [#39129](https://github.com/microsoft/playwright/pull/39129), [#36441](https://github.com/microsoft/playwright/issues/36441)

**Hosted runners and WebGPU in CI**

- [runner-images #14840](https://github.com/actions/runner-images/issues/14840), [#14836](https://github.com/actions/runner-images/issues/14836)
- [niivue #199](https://github.com/niivue/mono/issues/199), [run 35742921976](https://github.com/niivue/mono/actions/runs/35742921976), [niivue-e2e.yml](https://github.com/niivue/mono/blob/main/.github/workflows/niivue-e2e.yml)
- [luma.gl #2874](https://github.com/visgl/luma.gl/issues/2874), [deck.gl vitest config](https://github.com/visgl/deck.gl/blob/master/vitest.config.ts), [KhaozEngine #614](https://github.com/APKiwiOrg/KhaozEngine/issues/614), [GeometricSolvers.jl #34](https://github.com/JuliaGNI/GeometricSolvers.jl/issues/34), [real_water #45](https://github.com/alexcz-a11y/real_water/issues/45)
- [Chrome: supercharge web AI testing](https://developer.chrome.com/blog/supercharge-web-ai-testing), [WebGPU developer features](https://developer.chrome.com/docs/web-platform/webgpu/developer-features), [headless shell](https://developer.chrome.com/blog/chrome-headless-shell), [headless-dev on BeginFrame](https://groups.google.com/a/chromium.org/g/headless-dev/c/WgNE0CAlx-8), [HeadlessExperimental.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/HeadlessExperimental.pdl), [Emulation.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl), [agent-browser WebGPU](https://agent-browser.dev/webgpu)
- [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing), [@puppeteer/browsers](https://pptr.dev/browsers-api)

**Prior art in rendering tests and performance gates**

- [three.js e2e](https://github.com/mrdoob/three.js/tree/dev/test/e2e), [Babylon.js performance tests](https://github.com/BabylonJS/Babylon.js/blob/master/packages/tools/tests/test/performance/README.md), [MapLibre render tests](https://github.com/maplibre/maplibre-gl-js/blob/main/test/integration/render/render.test.ts), [Bevy example-run](https://github.com/bevyengine/bevy/blob/main/.github/workflows/example-run.yml), [wgpu CI](https://github.com/gfx-rs/wgpu/blob/trunk/.github/workflows/ci.yml)
- [Chromium representative perf tests](https://chromium.googlesource.com/chromium/src/+/da893991/docs/testing/rendering_representative_perf_tests.md), [Pinpoint compare](https://skia.googlesource.com/buildbot/+/5e5efc5f8a30/pinpoint/go/compare/compare.go), [Skia Gold inexact matching](https://chromium.googlesource.com/chromium/src/+/d4afc97b7/ui/base/test/skia_gold_matching_algorithm.cc), [debugging janks](https://chromium.googlesource.com/chromium/src.git/+/main/docs/speed/debug-janks.md), [Long Animation Frames](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- [Tachometer](https://github.com/google/tachometer), [CodSpeed on CI noise](https://codspeed.io/blog/benchmarks-in-ci-without-noise), [Bencher thresholds](https://bencher.dev/docs/explanation/thresholds/), [Bencher Metric Format](https://bencher.dev/docs/reference/bencher-metric-format/), [github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark), [E-Divisive change points](https://arxiv.org/abs/2003.00584), [Apache Otava](https://arxiv.org/html/2505.06758v1), [Rocket.Chat #40518](https://github.com/RocketChat/Rocket.Chat/pull/40518)
- [NVIDIA FLIP](https://github.com/NVlabs/flip), [MotionMark](https://webkit.org/blog/6943/motionmark-a-new-graphics-benchmark/), [MotionMark 1.3](https://webkit.org/blog/14908/motionmark-1-3/), [Figma on performance](https://www.figma.com/blog/figma-faster/), [memlab](https://github.com/facebook/memlab), [fuite](https://github.com/nolanlawson/fuite), [git-bisect](https://git-scm.com/docs/git-bisect)

**Other**

- [Notebookcheck: M5 MacBook Air under sustained load](https://www.notebookcheck.net/Apple-MacBook-Air-13-M5-gasps-for-air-as-MacBook-Pro-14-M5-shows-40-higher-gaming-performance-in-Cyberpunk-2077.1264788.0.html)
- [Clerk: testing authenticated flows with Playwright](https://github.com/clerk/clerk-docs/blob/main/docs/guides/development/testing/playwright/test-authenticated-flows.mdx)
- [Vitest Browser Mode](https://github.com/vitest-dev/vitest/blob/main/docs/guide/browser/visual-regression-testing.md)

**Raw evidence.** The probe scripts, their outputs, the noise-floor plans and `analyze.py` are untracked, in `.scratch/playwright-spike/` of the Air's main checkout, with the noise-floor runs under `perf-feasibility/`. The Mac mini's main checkout holds a copy at the same path. `bun install` there restores Playwright 1.62.1 from its `bun.lock`. It uses the cached Chrome for Testing 151 build, which both machines hold. Anything worth keeping becomes a tracked script under one of the proposals above. The first wave's GPU-lane outputs (G1, G2, G3 and G5, each step's scripts, and the agents' structured results) are untracked too, in `.scratch/playwright-first-wave/` of the Mac mini's main checkout.
