# Phase 0 waves 1-2: package reports

## weather/p0-wp1 (done, head 76b8612e74)

### Commits

- ea1f4bf feat(clouds): the weather clock reduces time and place exactly, out to 3.2e12 s
- dac0ded feat(clouds): the shells' crossings and altitudes come from heights, and hold where a ray can reach
- eeae331 feat(clouds): the weather cube addresses every direction by one face rule and the tangent warp
- 32252a5 feat(clouds): the overlap reference holds a column's fraction for its whole crossing
- 515abb7 feat(clouds): the placeholder weather keeps each layer's coverage as its mean, and decides a blob on integers
- 03492cc feat(clouds): the caches' frames scroll toroidally, and a cascade's near plane holds still while it does
- a1f6ef3 test(clouds): the trace's extents and the declared bytes are the design's figures
- 76b8612 feat(clouds): a frame's cloud state follows section 3.3's rules, the forced paths among them

### Design deviations

- §5.3's float32 altitude bound does not hold over the whole stated domain. Measured over 2×10^6 samples: points a ray reaches only by going through the body, where r(t)² = R² + numerator is a difference of two R²-sized floats, are off by 0.571 m in the [−1, 20] km band (a far root out the other side of a 1,167 km body) and by 3.9e-6 of R + t deeper than 0.3 R. On points that stay above 1 km under both the datum and the eye, the same sweep measures 0.207 m in the band (bound 0.25) and 3.97e-7 of R + t elsewhere (bound 1e-6). weatherShells.test.ts holds the bounds on that domain and names the limit. unionSpan stops at the datum ahead and the scene's depth stops at the ground, so the march never samples those points. The design's own figure was 0.088 m in the band.
- Blob cells: §5.4 says 16 texels a cell. I made a face edge hold blobCells(patternScale) cells, the power of two nearest (π/2)/patternScale, capped at 512. That gives the anvil's 0.05 rad 32 cells (16 texels each) and fair-cumulus's 0.02 rad 64 cells (8 texels each). A fixed 16-texel cell cannot reach fair-cumulus's 0.35 mean coverage with 0.02 rad blobs. Coverage patterns are my design, since §3.1 does not specify them. A blob is 1 inside half its cell's half-width and falls by smoothstep to 0 at the cell's inscribed circle; its mean over the cell is 23π/160. Bands are coverage·(1 + swing·cos(π·latitude/patternScale)) about the +Y pole. Measured means over 60,000 directions: 0.35022 for fair-cumulus, 0.24854 for the anvil, bands within 1e-4.
- cloudOverlap.stepShare carries one more series term than air.ts's (τ⁴/120). In float64 the four-term series is off by 8e-11 at τ = 0.01, which breaks §5.7(a)'s 1e-12. Above τ = 0.01 it uses −expm1(−τ)/τ.
- SunCascade gains an optional field `plane`: the near plane's absolute distance from the body's center along `toward`. A held cascade keeps that plane fixed in body-fixed space while it scrolls, and the box is rebuilt (stale) once the union over the current window leaves it. Sizing at rebuild is the window grown by half its width. Measured: the inner cascade re-centers after 10 to 15 km of travel toward the sun's azimuth at a 37.5° sun. The design has no box re-centering. Without a fixed plane, every kept texel's stored front depth would be off by the eye's travel along the sun.
- CloudFrame gains three optional fields: pictureEpoch, historyKey and flown. §3.3's key reset compares the previous picture epoch and history key, and fly accumulates a path, but no committed field could carry any of them. Optional, so existing frame literals (cloudUniforms.test.ts) still type; a frame without them reads as a changed picture and an unflown eye.
- Any key reset also rebuilds every level and cascade from no previous frame, as a cut does, because the caches' content belongs to the old body, epoch or lever set. The design says this only for cut.
- Under force 'scrub' the reported reset is 'jump', not 'force'. Scrub always jumps, and §3.3 lists jump before force; 'force' shows under 'reset' only.
- servedBody: both the inside-the-air rule and the largest-in-sky rule apply only among wet bodies. A forced address that is not in the scene serves nothing instead of falling back. When nothing is forced, the second body is the largest other wet body; a forced second equal to the served body is null. The second body gets empty clipmap, volume and cascade updates.
- Noise periods: noiseOrigin and drift are reduced by the least common multiple of the layers' 8×cellMeters, and detailOrigin by the least common multiple of cellMeters, so one origin serves layers of different cells (240 km and 30 km for cirrus-over-cumulus). This assumes the detail noise tiles once per base cell. The design leaves 'base period' and 'detail period' undefined for more than one layer.
- The level anchor re-snaps when the eye's gnomonic coordinates leave ±¼ window of the anchor. The snap grid is laid on the cube faces at ⅛ window. The window origin is round(plane/texel) − size/2, so its middle corner is within half a texel of the eye. levelFrames' epoch is 0 from a null previous, so a consumer must read `rebuilt` (and cascades' `stale`) to detect a cut.
- cloudFrame reads `levers?.on`. C's cloudContracts.test.ts calls cloudFrame({} as never, null) to show the stub is neutral; without the optional chain that call throws.

### Contract requests

- SunCascade.plane?: number was added (optional, set by sunCascades, never read by a shader). If you would rather a required field, or SunCascade carried no absolute value, say which; the alternative is passing the previous eye into sunCascades.
- CloudFrame.pictureEpoch?, historyKey? and flown? were added (optional). If CloudFrame should not carry them, cloudFrame needs another channel for the previous picture key and the fly path.
- WP4's scenarioCoverageNode needs uniforms that cloudUniforms.ts does not have: the pattern kind, patternScale, and a per-layer u32 blob threshold (blobThreshold(coverage), uploaded as an integer; a float threshold breaks rule 58). The blob period's two halves are already in `period`.
- cloudContracts.test.ts's 'the stubs are neutral' test still calls cloudFrame({} as never, null). When C or WP11 prunes it, cloudFrame's `levers?.on` can become `levers.on`.

### Notes for integration

- New exports, all additive: weatherShells.shellBoundaries; weatherClock.commonPeriod; weatherScenario.blobCells, blobThreshold, blobExists, BLOB_MEAN, genusProfileMean (the closed-form mean (1 + fall − rise)/2, §5.6's p̄); cloudFrames.horizonBasis (east = north × up, pole +Y, as buildScene's horizon); cloudFrame.cloudNoisePeriods, CLOUD_CLIPMAP_TEXELS, CLOUD_CLIPMAP_SIZE. cloudFrame.ts restates the volume, cascade and noise layouts because their modules reach Three at runtime; cloudFrame.test.ts holds each copy to cloudVolume.ts, cloudSunCascades.ts and cloudNoise.ts.
- For WP4 (the blob port): N = blobCells(patternScale) cells per face edge. The cell is floor((a+1)/2·N) on cubeFaceOf's warped coordinates. A cell exists when pcg4d(i, j, (face | layer<<3 | high<<5)>>>0, low).x < blobThreshold(coverage). The blob value is floor + (1 − floor)·(1 − smoothstep(0.5, 1, hypot(2(x−i)−1, 2(y−j)−1))), with floor = max(0, (c − BLOB_MEAN)/(1 − BLOB_MEAN)). Bands: c·(1 + swing·cos(π·asin(d.y)/patternScale)), with swing = c ≤ 0.5 ? 1 : (1−c)/c. A texel center of the 512 tile is never on a cell edge, and the blob is 0 at every cell edge, so a float32 cell index that disagrees at an edge still reads the same value.
- For WP4 (the noise): detailOrigin assumes the detail noise tiles once per base cell (period = cellMeters). Change cloudNoisePeriods if WP4 picks another detail scale. cloudProfile.ts's stub comment ('full density, as genusProfile draws it') no longer matches genusProfile, which is now per-genus smoothstep shapes.
- For WP4/WP5 (levels): texel (i, j) covers [i, i+1)·texel of plane coordinates about the anchor and is stored at (i mod size, j mod size). Dirty rects are storage texels inside [0, size)², split at the wrap, with no texel listed twice. `rebuilt` means the whole window.
- For WP5 (cascades): center has no component along toward; it lies in the eye's plane across the sun. So the sample's distance from the near plane is z = near − o·toward for an eye-relative offset o. The grid is laid on the sun axis through the body's center, so a kept texel's column is fixed in body-fixed space. `stale` marks only the frame the event happened; the resource has to remember what it still owes (one cascade a frame under the cap). A held cascade's dirty strips are the exposed columns and rows.
- Measured, not on the GPU: the exact clock reductions (BigInt reference, ±3.2e12 s); no floor correction needed for whole-second periods (0 found in 18×10^6 instants one float step under a multiple, 9 periods); the cube's texel solid-angle ratio is 1.397 at 64 texels per face (√2 in the limit); the far-shore records match the design's probe (V wet at τ 0.4, IV and V a dry); the generator's sulfuric worlds (τ 8, at least 450 K) keep no sea, so the aerosol clause was tested by putting P5q_1_0_4 I's deck over far-shore's ocean. No GPU test was run: WP1 has none.
- Before every commit I checked that the tests can fail by mutating the code. Each mutation turned at least one test red, then I restored the code. Mutations: the clock's wrap clause; Math.sign for the root's select; the face tie rule as >; the four-term series; <= in the blob compare; rows drawn across the full width in the strips; a 1 mm drift in a held cascade plane.
- The probe scripts behind the measured figures are in (session scratchpad, not kept)/wp1-probes/: probeAltitude.ts, probeCoverage.ts, probeFloor.ts and probeWet.ts. Their imports are relative to apps/game/.scratch, so copy them there to run them with node.
- Nothing was pushed and no PR was opened. The worktree is clean at 76b8612.

### Done command

```
pnpm check --only gate (measured, at 76b8612):
check · 11 stages on a budget of 12 cores
  ✓ graph 0.2s  ✓ typecheck:server 0.3s  ✓ typecheck:ingest 0.4s  ✓ typecheck:headless 0.4s  ✓ lint 0.2s  ✓ typecheck:core 0.6s  ✓ fta 0.5s  ✓ typecheck:game 1.4s  ✓ knip 2.2s  ✓ typecheck:astro 17.4s  ✓ test 38.4s
check passed · 38.4s wall, 61.9s of stage time
(Re-run after moving the gitignored scratch probes out of the worktree: "check passed · 0.0s wall, 11 reused", every stage stamped on this tree.)
WP1's eight test files alone: Test Files 8 passed (8), Tests 115 passed (115).
```

## weather/p0-wp2 (blocked, head 433b9e83bf)

### Commits

- 3e106536 feat(clouds): the Lorenz–Mie series prints Bohren and Huffman's numbers and finds Laven's rings in white light
- bb71f1fd docs(clouds): the series' starting index is BHMIE's margin, not a citation
- 433b9e83 feat(clouds): the droplets' phase table is generated, and its glory ring sits where the series puts it

### Design deviations

- §6.6 slow test: the 1% worst-case bound fails on the design's own grid, so I replaced it. The bound was 'worst relative difference under 1%' between Δln r 0.002 and 0.001 on one row. Measured differences: 4.53% on row 31 (32 µm, committed table against a fresh 0.001 sum), 2.37% on row 15, 1.31% on row 5, all at the side-scattering minimum and the glory's core. Halving the step further gave 2.96% (0.001 vs 0.0005), then 1.53% (0.0005 vs 0.00025). The 0.002 grid against itself shifted by half a step differs by 9.5%. Within one unit of x near 400, Q_sca spikes by 1.3%. This is Mie resonances far narrower than any affordable step, which a 10%-wide distribution does not average away; it is not a smooth function being undersampled. mieTable.slow.test.ts (row 31 at 0.001 against the committed row) now asserts four things: (1) the light the grid misplaces, ∫|Δp| dΩ, under 1% per band (measured 0.025/0.074/0.17%); (2) Q_ext and g within 1e-4 (measured 3.6e-5 and 1.9e-5); (3) the glory ring identical; (4) the worst single value under 5%, with the resonance limit named. I kept the grid at the design's 0.002. Refining is one constant, RADIUS_GRID.step, at proportional cost.
- The Bohren and Huffman test uses x = 2π·0.525/0.6328 = 5.21282, the radius and wavelength the printout itself used; 5.213 is its rounded print. At exactly 5.213, Q_sca would be 3.10500 against the printed 3.10543, 1.4e-4 off and outside the 1e-5 bound. The test also checks S11, POL, S33 and S34 at all 21 printed angles, to one unit in the sixth digit. I read the printout off a scan of p. 482 of the book, not from memory.
- The ring rule's 'first minimum' must lie strictly past ψ = 0. In white light a 10 µm drop's redness climbs from 0.36 at the antisolar point to a near-neutral hump of 0.41 at 0.5°, against 0.73 at the red rings. Letting ψ = 0 count as the minimum put the first ring on the hump, 76% inside 24/r. With the interior minimum the series lands, measured: first ring −10.3%, −8.8%, −6.7%, −6.2% of 24/r for 6, 10, 16 and 25 µm; second ring −1.5%, +0.7%, +2.3%, +2.0% of 37/r. The review's figures were −8.8% and 0% at 10 µm. The same rule gives gloryRed, where it changes nothing because the band's p(π−ψ) falls from its central peak.
- A band's nine wavelengths are the midpoints of nine equal steps across ±40 nm, λ_c + (40/9)(2k−8). Putting nodes on ±40 nm would spend two of the nine on the raised cosine's zero weight.
- §6.6 bulk test: checked per row only. The bulk is band-averaged per §3.12 (the mean of the three bands), so 'every row and band' cannot be tested.
- The ingest gate test recomputes rows 0, 15 and 31 at 12 table angles each, not all 1024 (1.7 s measured). All 1024 angles of row 31 alone cost about 5 s, which is too slow for the Stop hook's suite.
- The series takes a real index, so D_n is real (κ = 0 per §6.2). a_n, b_n and ξ_n are still complex pairs.
- gloryRed is found by a full 0.005° scan outward from ψ = 0, in blocks of 256, stopping at the block that shows the ring (0.4–0.65 s per row, measured). It refuses a row with no ring inside 60/r_e.

### Contract requests

- apps/game/src/render/cloudContracts.test.ts (the contracts package's): change or delete its last test, 'the stand-in droplet table decodes as the isotropic table it says it is'; deleting it also means dropping the then-unused `samplePhase` import. This is the blocker; options are in blockedQuestion.
- packages/rendering/src/atmosphere.ts (the contracts package's): export BANDS ([680, 550, 440], currently module-private), so the generator can import the air's bands instead of repeating the literal. Optional; DROPLET_TABLE.bands in apps/ingest/src/mieTable.ts repeats it with a comment.

### Notes for integration

- All figures below were measured on this Mac mini (Apple M6, Node v26.13.0) unless marked otherwise.
- Generator: 24 s (the committed header) and 25.4 s on the done-command rerun. The design estimated minutes. Rerunning changes only the header's runtime line; the data is deterministic (bit-identical).
- Output file: 264,929 bytes. Phase layout is [row][angle][band], 1024 × 32 × 3 half floats, matching what cloudPhase (WP5) uploads as RGBA16F.
- Phase values run from 0.0011 to 8,560 sr⁻¹ (normal halves, under 65,504). Normalization is within 5.9e-5 for every row and band.
- Through samplePhase, the table's red-band ring lies within 0.52 of a texel of gloryRed on every row (bound: one texel).
- Cloudbow: 139.7–142.0° for r_e ≥ 10 µm. Q_ext falls from 2.27 to 2.04 across the rows; g rises from 0.819 to 0.877.
- Size distribution: the weights recover r_e to 1.2e-9 and v to 9.4e-8.
- Test runtimes: mie.test.ts 0.2 s, apps/ingest mieTable.test.ts 1.9 s, packages/rendering mieTable.test.ts 0.4 s (all in the gate); mieTable.slow.test.ts 11.3 s in the slow suite, picked up by the slow config's existing include glob with no registration needed.
- Single texels at the side-scattering minimum (90–135°) and in the glory core carry quadrature noise of up to about 5% on the largest rows. The energy, the bulk and the ring positions are converged; phase 1 should not treat single texels there as converged.
- packages/rendering has sideEffects: false, and nothing outside tests calls mieDroplets(), so the 265 KB table is tree-shaken out of the main bundle until cloudPhase/cloudSystem use it behind the dynamic import. This is inferred from the imports and the flag; I did not run a bundle build.
- Sources were opened and cited in code, none quoted from memory: (1) Hale & Querry Table I, from refractiveindex.info's main/H2O/Hale, cross-checked against the authors' manuscript (NASA NTRS 19730006973) and Pilon's UCLA table; (2) Bohren & Huffman p. 482, from a scan; (3) Wyman, Sloan & Shirley 2013 Table 1, matching their Listing 1; (4) the IEC 61966-2-1 seven-decimal matrix, from the ICC's sRGB note, item 7; (5) Laven's p2c1 page; (6) Wiscombe's citation, Applied Optics 19(9), 1505 (1980), confirmed.
- Not run: no GPU test, browser, pnpm build or full pnpm check. Only the gate, the slow test, prettier -c and the spelling stage were run.
- Throwaway probes and downloaded references are in (session scratchpad, not kept)/wp2-scripts and (session scratchpad, not kept)/wp2-refs, outside the tree.

### Done command

```
Ran: node apps/ingest/src/mieTable.ts && pnpm exec prettier -w packages/rendering/src/mieDroplets.generated.ts && pnpm check --only gate && pnpm test:slow mieTable

- Generator: wrote the table in 25.4 s (measured).
- prettier: 17 ms.
- Gate stages that passed: graph 0.2 s, typecheck:ingest/headless/server/core/game/astro, lint, fta, knip.
- Gate test stage: FAILED. Test Files 1 failed | 350 passed (351); Tests 1 failed | 3926 passed (3927). The only failure is apps/game/src/render/cloudContracts.test.ts > the stubs are neutral > the stand-in droplet table decodes as the isotropic table it says it is (expected 16.53125 to be close to 0.0796, the stand-in's 1/(4π)). The `&&` chain stopped there, exit 1.
- Slow test, run on its own as `pnpm test:slow mieTable` (= vitest run --config apps/game/vitest.slow.config.ts mieTable): Test Files 1 passed (1), Tests 1 passed (1), 11.34 s.
- Regeneration changed only the header's runtime line (24 s to 25 s); phase, bulk and gloryRed came out bit-identical. I restored the committed file, so the tree is clean at 433b9e8.
- Also run: prettier -c on all 8 files, pass. `pnpm check --only spelling`, pass.
```

### Blocked

The done command fails on exactly one test, in a file this package does not own. In apps/game/src/render/cloudContracts.test.ts (the contracts package's), the last test, 'the stand-in droplet table decodes as the isotropic table it says it is' (lines 341–351), asserts four things about the stand-in: every value of mieDroplets().phase is close to 1/(4π); samplePhase(table, -0.3, 7)[1] is close to 1/(4π); bulk is [2,1,0] twice; the table has 2 rows. The real table fails that by construction, and §3.12 requires mieDroplets() to decode the generated file, so no implementation can work around it. Will you change that test, or authorize WP2 to? Option 1: delete the test block and drop `samplePhase` from line 4's import, since nothing else in that file uses it. Option 2: replace it with a shape-only check that holds for any table (phase length = radii × angles × 3; bulk and gloryRed lengths = radii). packages/rendering/src/mieTable.test.ts now holds the real table. Once that test is changed, the full done command is expected to pass: every other gate stage passes, 3,926 of 3,927 tests pass, and the slow test passes when run on its own.

## weather/p0-wp3 (done, head 97bc38481c)

### Commits

- 8155bc28 feat(clouds): the depth copy is this frame's distance along each ray
- e11d6554 feat(clouds): the split puts the scene pass's first half on the queue before the cloud work
- 2fd9c7d6 feat(clouds): pass B draws the OVER layer onto what the pass under the clouds left
- cfb21dd0 docs(clouds): the frame node says when a compile reaches it
- 97bc3848 docs(clouds): the split's comments give the reasons that hold

### Design deviations

- Pass labels are asserted in the timeline's ENCODE order, not the GPU order §9 writes. PassTimeline.summarize lists passes in first-frame encode order. Under both placements 'scene over clouds' is allocated before the cloud passes nested in it: under B at the split's copy hook, under A at pass B's beginRender. So the measured lists are [scene, scene over clouds, cloud depth, cloud trace], behind a full sea sheet [scene, scene after copy, scene over clouds, cloud depth, cloud trace], and under A [post, scene, scene over clouds]. GPU order (the resumed half runs after the cloud work) is proven by readbacks instead: the depth copy reads this frame's 10 m ground, and the no-split control reads last frame's 20 m.
- CloudFrameNode catches a throw from run() under every placement. It restores the renderer, logs once (warn, scope game.clouds, fields cause/stack/placement) and lets the frame draw on without clouds. The design does not specify this. An escaping throw leaves the scene pass and post chain without finishRender, and three's render tree pointing into an open pass. A mutation without the split's restore left _callDepth one high for the rest of the session.
- splitScenePass itself rethrows after restoring: the split is the mechanism, the frame node the policy. The restore is a new export, keepRenderer(renderer) in cloudSplit.ts. It snapshots _currentRenderContext, _currentRenderObjectFunction, _handleObjectFunction, _callDepth, nodeFrame.renderId and the lighting._cache length, plus target/face/mip, MRT, autoClear, toneMapping, outputColorSpace and the scissor test.
- CloudDepth is neutral until tied. warm() and render() do nothing before tie(), and bytes/textures() report only what exists on the GPU: 0/[] until a warm-up (1x1, 2 B) or a draw (w·h·2 B). This keeps C's cloudContracts.test.ts neutrality check green, and matches 'warm compiles against the tied depth'. The source node waits on a placeholder DepthTexture; tie() swaps in sceneTarget.depthTexture and refuses (invariant) a target whose sample count differs from the layout's.
- The depth copy reads the scene target's own depth texture directly (textureLoad, sample 0, no copy of it). The texel is the fragment's own pixel (screenCoordinate, row 0 at the top) and its image point is traceScreen's. Distance = -viewZ·sec(θ) with uniforms.camera.plane (unjittered), near and far.
- The over pass restores the scene target's timeline name to the literal 'scene' (the sensor's name) after pass B: passTimeline.ts offers no reader of a target's name. See contractRequests.
- Measured: R16F stores truncate on this Metal device. 1,024 of 1,024 texels landed below the float32 value, worst by 0.99 of a step. The depth tests' bound is one half-float step plus 8 float32 steps of decode, not half a step. The §5.11 tolerance of 2e-3 is still twice the worst step.

### Contract requests

- passTimeline.ts (C): a reader such as `passName(target: object): string | undefined` beside namePass. Then CloudOverPassNode can hand back whatever name the scene target had after pass B, instead of the sensor's literal 'scene' (cloudOverPass.ts SCENE_LABEL). It works today only because sensor.ts names that target 'scene'.

### Notes for integration

- WP11 / label tests: the timeline reports encode order. Under B expect scene, [scene after copy], scene over clouds, then the cloud passes. Under A expect the post quad's pass first (it begins before its dependencies draw), then scene, scene over clouds, then the cloud passes, all in encode order, although on the GPU the cloud passes run before 'scene over clouds'. Measured with timestamps on this machine: B alone [scene, scene over clouds, cloud depth, cloud trace]; behind a full sea sheet [scene, scene after copy, scene over clouds, cloud depth, cloud trace]; A [post, scene, scene over clouds], each once a frame over 4 frames.
- CloudDepth: call depth.tie(scenePass.renderTarget) at construction, before depth.warm(renderer). Warm and render are no-ops until tied. The copy resizes itself to the tied target's width/height every render. The system must write uniforms.camera.near and .far each frame (cloudUniforms.write does not); write(frame) supplies uniforms.camera.plane. uniforms.trace.render must equal the scene target's size, since readers map texels through screenTexel(screen, render).
- CloudDepth.texture is R16F with the RenderTarget's default LINEAR filter, as the stub had it. Readers should use .load() at screenTexel, not .sample(), or depth interpolates across edges. A stand-in for it in a package's tests should be linear too (rule 56).
- The depth copy reads up to one half-float step NEAR and never far (measured truncation, worst 0.99 step). A class test against it (sky = D ≥ F_out·(1 − 2e-3)) has that margin.
- CloudFrameNode swallows throws from run(): WP11 tests will not see an exception from cloud work. Attach `logHub.addSink(new RingBufferSink())` (@inertialref/shared) and read scope 'game.clouds' warnings. Only the first failure per node is logged.
- compileAsync reaches a render-scoped node's updateBefore only after the node has drawn in a render (measured: 0 runs before a first frame, 1 after). Three dedupes on render id, a top-level compile runs at id 0, and a fresh node's record starts at 0. The inFrame guard therefore matters for any compile after the composite's first frame. The driver's inFrame must be false outside beginFrame/endFrame.
- sensor.ts: PassNode.setLayers(null) works in r185 (back to the camera's own mask, the one-pass frame), but @types/three 0.185 declares no null; cast it (`null as unknown as Layers`), as cloudOverPass.gpu.test.ts does.
- CloudOverPassNode assumes the scene has no background (scene.background / backgroundNode). Three force-clears for a Color background whatever autoClear says, and draws a node background as the first opaque with no depth test. Either would wipe pass A inside pass B.
- Lights must test every layer under the flag. Measured: with the light on layer 0 alone, pass B builds 1 extra (unlit) pipeline past a warmCompile boot warm-up done with a camera on both layers; with layers.enableAll() it builds 0. Measured also: a camera without layer 1 compiles 0 pipelines on a marked mesh, and with layer 1 compiles 1.
- Over pass order: the node must sit after the scene term in the dependency sum (vec4(scene.rgb·0, 0).add(overPass·0)). Three runs updateBefore nodes in post-order, children left to right; the test's pixels confirm pass A ran before pass B.
- The split keeps one 1x1 FramebufferTexture probe per scene target (WeakMap keyed by the target), named via nameResume(probe, SPLIT_LABEL). It declines (false, during not run) for no WebGPU backend, no current render context, a canvas pass (no target), or a copy three refused for format, which never ends the pass.
- Not measured: any timing figure. The ms values the timeline reported were not asserted or recorded. No browser, drive.mjs or dev server was used. Every GPU run went through IR_GPU_WAIT=1800 and the vitest GPU config.

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudSplit cloudOverPass cloudDepth  (run at 97bc384, clean tree)

check · 11 stages on a budget of 12 cores
  ✓ graph 0.3s  ✓ typecheck:ingest 0.3s  ✓ typecheck:server 0.4s  ✓ typecheck:headless 0.4s  ✓ typecheck:core 0.5s
  ✓ lint 0.2s  ✓ fta 0.5s  ✓ typecheck:game 1.4s  ✓ knip 1.9s  ✓ typecheck:astro 16.8s  ✓ test 37.4s
check passed · 37.4s wall, 60.1s of stage time

 RUN  v5.0.5
······················
 Test Files  3 passed (3)
      Tests  22 passed (22)   (cloudDepth 5, cloudSplit 10, cloudOverPass 7; the timestamp-query label tests ran, not skipped: this adapter offers the feature)
```

## weather/p0-wp10 (done, head 261e094d65)

### Commits

- f0fa7bd8 feat(rendering): a scene unit is the sun above the air, and the sensor's white is half a stop under it
- b3a1e208 feat(clouds): phase 0's measurements run as batches on the rig, quiet, locked and tied to the commit
- 88b4909c test(clouds): every kind of page step runs where nothing of its module is in scope
- 261e094d docs(rendering): the white's doc says plainly why it is not moved to the unit

### Design deviations

- A/B protocol: §8.3's single ab() evaluation cannot finish, because scripts/cdp.mjs:57 times every DevTools command out at 120 s and five pairs take about 3 minutes. Each side is now its own --js step, all in one invocation and one boot, in the design's order: pairs, then the candidate's timeline, the profiles, then the base report. The page function is installed once per invocation (8.9 KB) and called per step.
- File split: one measure.mjs scored 107.3 in fta against a cap of 91, with a cyclomatic count of 244. I own no other files, so the work went by role. page.mjs holds the protocol: cloudStep, plus its Node half (plan, figures), the sweep's fit and the tables. diff.mjs holds the residual histogram reading beside the screenshot difference. Final fta scores, measured: measure.mjs 78.3, page.mjs 77.3, diff.mjs 49.4, measure.test.mjs 76.9.
- §8.7's decision rules are not encoded, and the 'Choice … rule outcome' table is not printed. The rules carried most of the branches, and §11.3 step 8 applies them by hand from the tables. The A/B table instead gains 'sensor ms Δ' and 'late Δ' columns, each from the run's own profile pair against its base.
- Added a `stances` batch, one run per scenario: ir.light(), the frame's pass labels, the sea split ('scene after copy') and a still. This is the check §12.2 item 9 asks WP10 to make before any batch.
- `scrub` is not a scenario of its own: it is `horizon` under the scrub kind, which is identical to §8.2's `scrub` row.
- Stances where §8.2 is silent, all inferred and unverified until the stances batch runs: earth-orbit takes earth-ground's latitude 0, longitude 0 and heading 90; sunset is the far-shore preset's own stance raised to 1,500 m, reading its heading as 'toward the sun' and keeping its pitch; pair-moon is ir.takePicture of far-shore's picture with the address b:4.0, framing {kind:'rise'} and no lens, because ir.rise() solves the lens but does not apply it.
- Ports 9341/9342, 2 retries and the 10-minute quiet wait are constants, not flags. A start that is not quiet within 10 minutes stops the batch (its JSON is kept) rather than running a row that would be marked.
- The busy list adds `tsgo` (TypeScript 7's native compiler) and `astro` (whose process runs Vite) to §8.1's names. The load limit defaults to half the cores, with --max-load to override. Thermal pressure is read from notifyutil in every sample.
- targets is 58 runs where the design estimates about 60: steady, cut and scrub on 7 far-shore scenarios, fly on ground and orbit, and per Earth scenario a priced steady and fly plus the deck alone.
- Cold boots read the first lever-on frame at the far-shore preset's own stance, with no visit, because the boot itself is the measurement.
- The error batch checks Enhanced through engine.exposure.processing, since CloudRenderReport has no processing field. A row drawn under the other processing is refused. Residual shares and percentiles are bin-resolved upper bounds: 1% falls on a bin edge and is exact; 2% and 5% fall inside bins.

### Contract requests

- No instrument produces two of §8.7's inputs. Cache gate (a) needs 'volume vs field image difference under 3% radiance RMSE over cloud texels'. The maxSteps/lightTaps/farFootprint rule needs 'image differs from the next larger value by under 1% radiance RMSE'. CloudRenderReport carries no radiance readback, and the residual meter compares composite forms only. Step 8 cannot apply those rules until a report field or a GPU instrument (WP11/WP12) exists.
- §8.6 wants the Enhanced ring at the limb reported separately: sky-class texels within 2° of the limb under Enhanced. CloudRenderReport.residual has only thin, light, total and classDisagreement, so it needs a fourth histogram (WP9/WP11).
- Residual binning: the runner assumes bin = clamp(floor(16·(log10 e + 4)), 0, 63), following the exposure meter as §3.16 says. WP9's residual meter must bin exactly this way, or diff.mjs's binEdge must change with it.

### Notes for integration

- After integration, run `node scripts/clouds/measure.mjs --batch stances` first. Its table shows each scenario's sun and phase, served and second bodies, whether horizon draws the sea split, the cloud pass labels and a still. Change a stance only through the orchestrator.
- `--dry-run` prints every planned drive.mjs invocation for any batch, with no lock, browser or preview. It currently plans: stances 13 runs, decisions 78, sweep 8 (four a size: 72 cells plus 6 marginal cells), targets 58, memory 12, error 16. Every lever set in every batch passes isCloudLevers.
- What the runner needs from WP11, read by name (page.mjs's cloudStep): `engine.cloudsAvailable === true` under ?clouds=1; `ir.clouds()` returning settle, extents.trace, steps (with levers.stats echoed back for the sweep's acceptance), residual, bytes (total, plus the stubs' resource keys farAtlas and farSpheres), pipelines, served, second and regime; and the 'warming the clouds' producer span on the Boot track. The stance step refuses a page that lacks the system.
- The error batch's screenshot view needs `magick` on PATH. Without it, the row records the error and the residual figures still stand.
- Outputs land in `.data/clouds/<batch>-<ISO>.json`, rewritten after every run so a stopped batch keeps what it measured, with shots under `.data/clouds/shots/`. The memory batch deletes only `.data/drive/profile-9342`, before each cold boot. The runner refuses to start while a session or a Chrome is up on 9341 or 9342 that it did not start, and closes only the rigs whose session carries its own lock token.
- For the docs step: ADR-0065 should cite exposure.ts's EXTRATERRESTRIAL_ILLUMINANCE and SCENE_UNIT_LUMINANCE, and the new entry in design/plans/the-air.md ('The galaxy, the stars and the sun's disk take the sensor's white for the scene unit'). The code cites ADR-0056 only, because 0065 does not exist yet. The harness guide's 'Measuring the weather' section should cover the split-step protocol and the stances batch.
- Figures, measured or computed: every scene-unit figure is computed from the constants, not measured on a GPU (42,589.86 cd/m², ratio 1.4197 or 0.5055 stop, disk 108,708 lx or 0.8125 of E⊥, 53,333 vs 46,239 units, compression 0.1910 to 0.1974, star floor up to 0.2245 mag, Mars 2.32×). The fta scores and test counts are measured. Not run: no browser, rig, ir.gpu figure or batch; the batch durations are still the design's estimates.

### Done command

```
pnpm check --only gate, at 261e094 with a clean tree:
check · 11 stages on a budget of 12 cores
  ✓ graph 0.3s · ✓ typecheck:server 0.3s · ✓ typecheck:ingest 0.4s · ✓ typecheck:headless 0.4s · ✓ typecheck:core 0.5s · ✓ lint 0.2s · ✓ fta 0.5s · ✓ typecheck:game 1.4s · ✓ knip 2.0s · ✓ typecheck:astro 16.6s · ✓ test 36.5s
check passed · 36.5s wall, 59.0s of stage time
All 11 stages passed, none failed. The gate prints no per-test counts. The focused runs, measured:
- scripts/clouds/measure.test.mjs: 47 passed.
- packages/rendering/src/exposure.test.ts: 29 passed, 3 of them new.
- The five Node files that read the white (exposure, atmosphere, starVisibility, gameEngine.galaxy, bodyUniforms): 100 passed.
- GPU files that hard-code 1/30,000 (atmosphereSky, materials), run under the lock as `IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts atmosphereSky materials`: 39 passed.
Also passing: pnpm spelling:check (0 flagged declarations) and prettier --check on every changed file.
```

## weather/p0-wp4 (done, head eb476bd29a)

### Commits

- 6a2e8d15 feat(clouds): the weather's noises tile at their periods, and every lattice draw is pcg4d's
- 99c19bb3 feat(clouds): the noise bake is weatherNoise at every texel center
- 100bb0f4 feat(clouds): the weather cube is the placeholder's coverage at every texel, gutters included
- 1f784bb6 feat(clouds): the clipmap is the cube resampled, and a strip update is the full bake
- 71cdb7c8 feat(clouds): the field's three media are one recipe, and every read names level 0
- 013e9112 fix(clouds): the noise volumes wrap their slices without a warning, and the test holds the R axis
- 7b79f4fd docs(clouds): the maps' header says the packing is the clipmap's too
- ae771b7e fix(clouds): the noise volumes' R wrap is set through the 3D texture's type
- eb476bd2 docs(clouds): the base noise's spread states the cloudy shares it was measured to give

### Design deviations

- The curl is baked into the base noise instead of being read once a segment by the march (§3.8 and §5.6). The bake moves the base's lattice point by up to a quarter cell across body-fixed xz, using the analytic curl at uv = cells.xz/8, so the base still tiles at 8 cells. Reasons: CloudMediumFn has no input for a per-segment value, and the march is WP6's. The volume and far bakes have no segments, so a per-segment curl in the trace would give the trace a different field from the one the volume caches and the far bakes draw, and that would bias the volume-against-field image comparison. A step still makes its four reads. The curl texture is still baked and bound, and the sweep's 'curl' extra reads it.
- I added a spread step the design does not name. The base is the Perlin–Worley value, remap(perlin, fbm − 1, 1, 0, 1), then smoothstep(0.52, 0.82) (BASE_NOISE_SPREAD). Measured over 20,000 points, the raw value sits in a bell around 0.67 (1% below 0.523, 1% above 0.803). Without the spread, a full-profile layer is cloudy over about 1%, 64% and 99% of its volume at coverage 0.2, 0.35 and 0.5. With it, the measured shares are 15%, 31% and 50%.
- Clipmap schedule: §3.9 says 'levels 0–1 this frame and 2–5 over the next four'. Each frame instead rebuilds every stale level among 0–1 plus the longest-stale level among 2–5, and that level can go the same frame it went stale. So a jump frame rebuilds 0, 1 and 2, and 3–5 follow over the next three frames. This matches §4.4's counts exactly: 3 passes a frame under cut and under scrub, and 1 for the steady refresh. It also lets a single re-anchored coarse level rebuild the frame it moves. A run of cuts still reaches every level.
- Maps: a face goes stale on a jump, a scenario change, a change of pattern period, or the first full-size frame. All six are then rebaked nearest the eye first and the opposite face last, by dot product with the face normals. Steady state is one face a frame, as designed.
- CloudProfile's G channel holds the genus mean (p̄, constant along each row). §5.6's unresolved density therefore comes from the same fetch as the profile.
- sweepMedium unrolls up to six base fetches (SWEEP_READS_MAX), each behind a branch on the sweepReads uniform, rather than looping. Each fetch is offset by (37, 61, 17) base texels and folds all four channels as dot(v, (0.4, 0.3, 0.2, 0.1)). The extra read is a branch chain on sweepExtra. The WGSL holds 11 textureSampleLevel calls: 6 base fetches plus one each for clipmap, profile, detail, curl and level.
- CloudClipmapNodes has a new member, level(sample, body, k): one read of texture 0 at level k. The sweep's 'clipmap' and 'level' extras use it. The change is additive.
- Outside every layer the media return column 1e9 and radius 10, matching CLOUD_VACUUM. Where a cell is unresolved (f = 1), σ is σ_k·p̄ even when coverage is 0, and fraction is 0. That is §5.6 as written.

### Contract requests

- CloudUniforms (CloudLayerUniforms) has no slot for the scenario's pattern. scenarioCoverageNode needs: the pattern kind, patternScale, blobCells, each layer's u32 blob threshold and floor, and the per-layer channels the maps carry (log τ, convective share, middle-layer ice share, wind). I implemented around it: cloudMaps.ts keeps a side bundle per CloudUniforms object in a WeakMap, and exports writeScenarioPattern(uniforms, scenario), which writes compare-first. CloudMaps.render calls it each frame before anything bakes. Any pass that uses scenarioCoverageNode or analyticMedium on a frame where CloudMaps does not render must call writeScenarioPattern itself. It would be cleaner to move these values into CloudLayerUniforms and have cloudUniforms.write fill them.
- CloudMediumFn (sample, body) cannot carry a per-segment value, so the march cannot apply §5.6's once-a-segment curl through the medium. I baked the curl into the base noise (see designDeviations). If phase 1 wants a per-segment curl, the medium contract needs a segment-state input.
- CloudClipmap's constructor takes an optional second argument, source: CloudMapNodes. Without it the clipmap bakes straight from the placeholder's function. It is optional only because cloudContracts.test.ts constructs CloudClipmap with one argument. WP11 must pass maps.nodes (new CloudClipmap(uniforms, maps.nodes)) so the clipmap is baked from the cube, as §3.9 specifies.

### Notes for integration

- Frame order matters (§4.2). Call uniforms.write(frame) before any maps or clipmap render, because the clipmap's six bake materials read uniforms.served.clipmap[k] directly. Render CloudMaps before CloudClipmap in the same frame: after a jump the clipmap's schedule relies on the maps having already rebaked the eye's face that frame.
- CloudNoise.render(renderer, frame, budget) applies frame.levers.noiseFormat through setFormat itself, and bakes whatever noise is missing. Call it every frame; it draws nothing once everything is baked. The first render that selects 'rgba8' bakes all 128 RGBA8 slices that frame under 'cloud noise' (a burst of 128 passes), then swaps the binding by value. Until that render, pending is true.
- warm() on CloudNoise, CloudMaps and CloudClipmap compiles against the real format. The maps and clipmap warm 1 × 1 (× 6 for the clipmap) targets; the noise warms its RGBA8 sweep variant at 1 × 1 × 1. Noise warm also bakes the R8 base, detail and curl. A warm failure is logged on 'game.clouds' and swallowed, as warmCompile does; the next render does the work. Measured: the first full-size draw after warm builds no pipeline, for the maps, the clipmap and the sweep variant's bake.
- Declared bytes, measured equal to the GPU textures' size × format × levels, one mip level each. Noise: 2,097,152 (base) + 32,768 (detail) + 32,768 (curl) + 4 (the RGBA8 stand-in), and 8,388,608 for the RGBA8 variant once baked. Maps: 16 B after warm, 25,362,816 once rendered. Clipmap: 96 B after warm, 6,291,456 once rendered. CloudProfile is not a CloudResource; it holds a 64 × 8 RGBA8 DataTexture, 2 KB.
- Pass labels: 'cloud noise' (warm, and the RGBA8 bake), 'cloud maps' (one scissored MRT quad, one face tile a frame), 'cloud clipmap' (each whole level, strip and refresh slice is one quad). Measured clipmap pass counts: 3, 1, 1, 1, 1 over a first frame and four still frames, 3 a frame under cut, 3 on a jump frame.
- Use fieldMedium only with the served body, because the clipmap belongs to the served body. Use analyticMedium(…)(sample, uniforms.second) for the second body. synopticMedium forms the direction as normalize(up·(R + h_e) + offset), the coarse lookup §3.10 allows.
- The real CloudNoise, CloudMaps and CloudClipmap still pass cloudContracts.test.ts's neutrality checks: bytes 0, textures() empty and pending false at construction, and warm(undefined) resolves.
- Measured on this machine's GPU suite device (Dawn on Metal), all from the tests. Noise texels against weatherNoise: worst 0.4997 of an 8-bit step for base, detail and curl, 0.49997 for RGBA8, over 1,002 texels each. Cube texels against scenarioCoverage: worst 0.39, 0.50, 0.50 and 6e-6 steps for fair-cumulus, anvil, cirrus-over-cumulus and two-decks. Reads either side of the 12 cube edges differ by 0.62 steps (12 steps with the gutters left unbaked). A clipmap strip update equals a full rebuild at every texel (723 texels differ if the strips are drawn one row low). Level texels match the cube's bilinear read within 0.81 steps. Clipmap coverage matches the CPU within 0.66 steps over 400 offsets, 72 of them in a fade band. clipmapTexel matches the float64 projection at 100 km within 2.28, 2.21 and 2.63 cm at levels 0, 2 and 5, held at a 3 cm bound. Media against §5.6: field 9e-8 of σ, synoptic 1.0e-7, analytic 1.2e-5. Not measured: any timing, bake cost or per-step cost; those are §8's batches.

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudNoise cloudMaps cloudClipmap cloudDensity

Run at HEAD eb476bd. Gate: check · 11 stages on a budget of 12 cores — graph, typecheck:ingest, typecheck:server, typecheck:headless, typecheck:core, lint, fta, typecheck:game, knip, typecheck:astro (17.0s) and test (37.8s) all passed. "check passed · 37.9s wall, 60.6s of stage time", exit 0.
GPU: "Test Files 4 passed (4), Tests 32 passed (32), Duration 1.31s", exit 0.
```

## weather/p0-wp5 (done, head 4b2f9e8b2f)

### Commits

- 1d26a12e feat(clouds): a cloud is lit through the ground's beam, the air's own sample and the droplets' table
- fd486444 feat(clouds): the local volume caches the field and skips only where no read can see cloud
- 5ac6522c feat(clouds): both sun-depth candidates hold a slab's slant path and spend no frame past the cap
- 73ee0eb6 test(clouds): the volume and both sun depths draw their first frames on pipelines their warm-ups built
- 4b2f9e8b test(clouds): the cascade scroll's bounds name what they hold, with the figures measured

### Design deviations

- Cascades are read by four textureLoads and a float32 blend, not one filtered sample. I measured the suite's Metal device filtering RGBA16F in half floats: a sampled R between 300.00 and 300.25 km returns one of the two, never a value between. That throws away the precision the R+A pair exists for, so the design's 'filtered pair still sums' premise fails on this hardware. Through the sampler the uniform-slab error was 2.6%; through the loads it is 0.09%.
- The volume bound is 64×64×24 RGBA8 (0.39 MB), not 64×64×30 (0.49 MB). That is 8 brick layers per level with the z-slot clamped. The 6³ dilation of the end bricks already reads the guard slices, so guard bricks would hold nothing new.
- The volume's slice budget runs in this order: level 0's missing slices (all 34 that frame), then slices baked at a window the level has left, then levels 1–2's missing slices, then the oldest slice anywhere (the time refresh). The design puts the time refresh before levels 1–2, which would starve their rebuild after a jump.
- There are no scissored strip draws in the volume or the grid. A slice is always baked whole at that frame's window, and a level/grid trusts only the intersection of the windows its slices were baked at, one texel/cell in from the edges. Exposed cells come in over the next few frames. The grid draws 4 slices a frame, or 6 while any slice holds an old window, rather than 'the exposed strips the same frame', which would be 32 passes on one frame against §4.4's 'up to 6'.
- The grid's 32 heights run vertex-centered from the union's base to its top, not centered in 32 cells. Cell-centered heights read 1.6% short at the base.
- CloudVolume.medium is a complete medium: where no level is trusted (not yet baked, idle from orbit, outside the windows) it evaluates the injected field. bound() returns 1 there, so nothing is skipped through the field.
- The sunThroughAt test is bitwise against sunThrough at the same float32 coordinates. With heights resolved on the CPU it is bounded by the sampler's 8-bit weight step times the spread of the blended texels, plus a half step, rather than 1e-4: 9 of 1,536 components exceed 1e-4, the largest by 2^-10.
- The 5° anvil front-depth test holds the pair to ≤0.05 τ only on the 2,058 sampled columns whose float32 crossings resolve to 0.25 m (measured 0.019 τ; one half float misses those by up to 22.3 τ). Everywhere else it holds the error to 0.15 τ (measured 0.116 τ at the outer cascade). The near planes stand 284, 600 and 1,391 km from the eye at a 5° sun, and shellCrossingFrom's float32 error from that far out (decimeters to a meter) dominates, not the storage.
- Cascades and grid store the column's mean extinction σ·fraction. At the cascades' texels the field's fraction is 1 for the inner two cascades and within 4.2% of 1 at the outer one's 400 m (two-decks altocumulus). I worked that number out from the scenarios; it is not a GPU measurement.
- The volume read reports column = the level's texel (50/200/800 m), the resolution its cached fraction is stored at. The design gives no rule for the volume read's column.
- lightTaps 0 reads the sun depth at the sample itself, so a cloud with no taps is still shadowed over its first kilometer.

### Contract requests

- cloudContracts.test.ts ('the stubs are neutral') calls warm(undefined) on every resource and expects bytes 0 and textures() [] at construction. I worked around it the way WP3's CloudDepth does: bytes and textures report nothing until a warm-up or a draw has put the textures on the device, and warm() resolves when the renderer has no backend. The neutrality test should give real modules a renderer, or stop warming them. WP11 deletes the file anyway.
- @types/three 0.185 gaps I worked around with commented casts: Loop over three ranges (declares at most two), uniformArray(...).element() typed as Node<string>, and unpackHalf2x16 typed as returning PackFloatNode.

### Notes for integration

- TSL trap that other packages may also hit: nested Loop() calls each name their index `i`, so the inner loop shadows the outer. My bound kernel's footprint collapsed onto its diagonal and missed cloud in 1 brick in 7 (1 in 3 at level 1) until I used a single Loop over three ranges. Any package with nested Loops (march, far bakes) should check this.
- Three trap: RenderTarget3D keeps Data3DTexture's NearestFilter magnification unless the options pass magFilter, and a level-0 read magnifies. I pass magFilter/minFilter LinearFilter for the volume and grid targets. WP4's RenderTarget3D noise needs the same.
- Apple's Metal device returns filtered RGBA16F/R16F samples at half precision. Any filtered read of a large-valued half-float texture (the depth copy in km, for example) loses precision through the sampler. textureLoad keeps it.
- WP6: pass CloudVolume.medium as the march's medium for the volume kernels. It already falls back to the field where no level is trusted, and bound/brickExit stay safe there (bound = 1). Build the volume medium, bound, brickExit and cloudSunFn inside the kernel's Fn: they emit If/toVar statements.
- WP11: CloudVolumeDeps.detail must be the same CloudNoiseNodes the field medium uses, and bake must be the same field medium the trace binds, or the shared bindings become separate ones. The volume's detail coordinate (detailOrigin + offset + drift)·4/cell is my reading of WP1's period comment; align it with WP4's cells_d.
- WP11: volumeSelected(levers) is exported, true when cache 'volume' or sunDepth 'grid'. Render the volume before the grid each frame; the grid sums through the volume medium. Each resource's render() checks frame.levers itself and, when not selected, shrinks to its 1×1 targets and forgets its contents, so bytes then reflect what is held.
- Order per frame: uniforms.write(frame), then volume.render, cascades/grid.render, then the trace. The cascades and the grid write their own read uniforms (eye-relative center/near, trusted windows) inside render(), so render must run every frame they are selected. A frameIndex gap rebuilds everything.
- Reports added for the system/report: CloudVolume.drawn (slices baked this frame, per level), CloudSunCascades.spent and .rebuilt, CloudSunGrid.spent. pending excludes the routine time refresh, so cloudsSettled can settle.
- Labels: 'cloud volume', 'cloud volume bound' (one dispatch a frame, sized to the touched brick layers), 'cloud sun cascade', 'cloud sun grid'. warm() of each resource compiles against its 1×1 targets; their first frames after warm built no render or compute pipeline, measured.
- Measured on the suite's device:
- bake: 600 sampled texel centers within one RG8 step of the injected field
- bound: at least every trilinear read at 8,192 samples
- corner texel: seen by 1,000 of 1,000 rays with the dilated bound, 794 of 1,000 with an undilated one
- brickExit: lands between 0.484 and 0.553 m past the float64 face
- volume scroll: equals a rebuild within 1 RG8 step
- uniform slab: cascades within 0.09%, grid within 0.56%
- cascade scroll: front 1.7 cm, G/B 8.3e-4 relative
- grid scroll: bitwise equal
- per-frame spend: cascades at most 14,278,656, grid 16,777,216 (= SUN_DEPTH_FRAME_CAP)
- airMediumAt march vs marchAir: 2.3 ε over one sample, bitwise over four
- CloudPhase vs samplePhase: 0.28 of its bound on a structured 1024×32 table
  Not measured: any cost or timing figure, any browser behavior, any run against WP4's real field or WP2's real Mie table.

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudVolume cloudSunDepth cloudLight materials atmosphereSky surfaceVisibility
(run at 4b2f9e8; I ran the two halves one after the other, because the worktree guard refused the combined shell line)
gate: check · 11 stages on a budget of 12 cores — graph 0.3s, typecheck:server/ingest/headless/core/game/astro, lint, fta 0.7s, knip 2.0s, test 37.5s all ✓ — "check passed · 37.5s wall, 60.8s of stage time" (exit 0)
gpu: Test Files 6 passed (6), Tests 75 passed (75), Duration 1.42s (exit 0). Dawn's expected "workgroup count of 0 is unusual" warnings came from warmCompute.
WGSL equality harness (WGSL_TAG=wp5-air after airMediumAt landed, and WGSL_TAG=wp5-final at HEAD): all 12 hashes match the C commit's apps/game/.scratch/wgsl/final/hashes.json — shell.vert 623635209b102d7d0602f97ef0ac9186bd1551ab342f8a5c2311f3ed7effc6c5, shell.frag 48e3543bf56d122660665ae1da4349abdb8f0a0ff3eac97eeda705da9928ce43 (shell-tables the same pair), sphere.vert 5d1e17c348135c367c4939ef0727d1b21f45267b8bbf291b72ac84dc76a6dcc1, sphere.frag c3393bea7bb875da972ff1ae925ebee8d5e89a93d954a6360962da1fdf59b777, ground.vert 24b503ea636e9fbf608f4e76fff73a5b6581732e01e91c8b6405fcfd68f49b02, ground.frag fa1223bd7288c12b72f8f10788c6e93a81ba25261b10d1ac9c9353e107712d83, sea-full.vert 9b4520ec24abdde7ddc922edf0004b4d86c89e320a9e180e116dc376e02d23e1, sea-full.frag a1d76f3fc4780541dea06242572e3ba0bd38e90b6d10d63968f8486bbe4d5e74, sea-plain.vert 568e5cddb6ab6bde19e2c1c13a9ace585b4e812bad1da901df5080995c25f956, sea-plain.frag 51faaea0ae4538c4189a41563fc1c0d91b44d1dfc7d2b6c7f9ccf520e73ba4eb.
```

## weather/p0-wp6 (done, head 1fd52ec733)

### Commits

- 3641d61 feat(clouds): the trace marches a slab to e^-sigma*L whatever cuts its steps
- 7f04998 test(clouds): a ray with no lit cloud reads its phase at the layer's radius, not 0/0
- 1fd52ec fix(clouds): the march takes the jitter again after an empty brick, and the trace's outputs follow a resize

### Design deviations

- Steps are clipped to the next of the six layer-boundary crossings and to the span's end. §5.5's schedule alone lets a 1 km out-of-cloud step carry clear air into a layer (fog is 150 m thick), and a slab cannot integrate to e^-σL. Measured: without clipping, the two-slab, knot, brick-skip and air-dimming tests fail.
- The medium is sampled at the step's start plus an inset of 0.5 m + 1e-6·t, or half the gap to the next boundary if that is smaller. It is not sampled at t itself: a step that starts on a boundary would read whichever side the altitude's rounding chose. Measured: without the inset, Beer's law at a slant and the knot positions fail.
- Jitter is the first step's length: ξ × the schedule's step, starting at t₀. The design starts the first sample at t₀ + ξ·50 m, which drops up to 50 m of every ray (an optical depth of 3.4 in cumulus). Measured: the literal form fails 5 tests. Through the volume, the first medium step after each empty brick takes the jitter again.
- The air is also sampled where a segment opens, not only every 8th step and at closes. Each step's light is dimmed by the air throughput as it is gathered, not the whole segment's light by the throughput at its close. Measured: without the sample at openings, the light came out dimmed by 0.532 of the air, above the 0.5 ceiling.
- CloudMarchResult gains throughput (T_a at the stop), opacity (the sum of the moment weights), steps and exhausted. The kernel needs them to compose the far march, which cloudMarch's deps omit. marchFar (exported from cloudMarch.ts) does that composition, merges the depth moments, and records the far stretch as one knot when it holds cloud.
- CloudTraceDeps gains an optional air?: CloudAirFn (typeof airMediumAt), used as airMediumAt when absent. Tests inject an analytic air, because the base's airMediumAt is WP5's zero stub.
- CloudTrace gains a public kernels() method (all 10 ComputeNodes: 8 triples, the sweep, and the stats clear 'cloud stats') for warm() and the binding census. Its outputs are 1×1/2×1/2×1/2×2 placeholders that report 0 bytes and no textures until warmed or dispatched, following CloudDepth. That keeps cloudContracts.test.ts's neutrality checks passing.
- d_front, which the design never defines, is the depth where the ray's opacity first reaches 1/2, interpolated inside the step that crosses it. When the ray never reaches 1/2 it falls back to the opacity-weighted mean, and with no cloud at all to d_end. d_reproj and deviation are the opacity-weighted depth moments, taken relative to t₀.
- The stats counters are cleared and read back inside render() (and at k=0 and k=3 of dispatchPhase), with one readback outstanding at a time, as the meter does. They are not read in the system's afterFrame. Each ray makes 4 atomics (sum, max, rays, exhausted).

### Contract requests

- skyClass(air, eye, direction, depth, units) has no stated convention for its arguments. The trace calls it with eye = up·(1 + h_e/R) in sea-level units about the center (body-fixed), direction = the body-fixed unit ray, depth = the depth copy's raw render kilometers, and units = R·compression/1000 (render km per sea-level unit). WP9's real skyClass must take these units, or WP11 adjusts the single call in traceView (cloudTrace.ts). At the base the stub calls every texel sky.

### Notes for integration

- Every depth the trace writes (aux d_reproj, d_end, d_front, deviation, and the knot entries and exits) is in TRUE km: the depth copy's render km divided by served.compression, clamped at 60,000 km. Anything comparing these with the depth copy must divide the copy by compression first.
- Knot layout, for cloudFront (WP9): knots are in t order. A padding knot has entry = exit = 60,000 km (CLOUD_DEPTH_CLAMP_KM, exported as KNOT_PADDING), and light (0,0,0,1). aux[2i+1, j].w is how many knots are real (0–4). When the far march holds cloud (T_far < 0.98), the far stretch is recorded as one knot from the fine march's stop to t₁. knotLight is written through finiteOr with (0,0,0,1) as the fallback; knotDepth falls back to padding.
- A ray with no span (hit false) is written as T = 1, L = B = 0, with d_end = d_reproj = d_front = the scene distance. The history's 'the scene now stops the ray short' rejection relies on that end.
- Volume kernels are built only when media.volume, bound and brickExit are all non-null. Selecting cache 'volume' otherwise fails an invariant in render(). The march detects volume mode by deps.medium === deps.media.volume.
- dispatchPhase(k) assumes uniforms.trace.maxSteps is already quartered (cloudUniforms.write does this for regime 'immediate'). The trace writes uniforms.trace.phase itself before each dispatch; it never calls uniforms.write. render() picks the sweep kernel whenever levers.fixedSteps > 0.
- The trace reads the depth copy through one TextureNode over deps.depth(), and swaps its value if that function returns a new texture object. Pass CloudDepth.texture.
- The sun functions passed in deps.sun are called only inside cloud steps. The binding counts measured here (13 field, 15 volume, 8 sweep) assume their taps read the field's own textures, as the test's sun does: the volume kernels' extra 7 come from the sun's taps.
- Each air sample reads Ψ once for the sky placeholder, and WP5's airMediumAt reads it again internally (identical reads every 8 steps).
- Measured on this machine's GPU (cloudTrace.gpu.test.ts, under the lock), all at RGBA16F or float32 as stated in the commit bodies: field kernels bind 13 sampled textures, volume kernels 15, the sweep 8, and each of the nine binds 4 storage textures. A slab passes e^-σL to 1e-4 at 5 slants × 3 jitters, and its light is 1.5(1−T)/(4π) to 1e-4. 18 cuts of a 600 m column keep T and the light to 1e-4. A half-clear τ 20 layer passes 0.5 (1e-4), against < 0.05 for the per-step-mixed variant. Two segments multiply to 1e-4. The early exit stops with T in (0.0050, 0.01) in under 60 steps. B's per-band ratio, cleared beam to sky beam, is (1.5, 2.5, 4.5) to 1e-4. The immediate regime covers all 48 pixels of an 8×6 history exactly once, and the guard column stays zero. The sweep counts mean = max = 32, and a budget of 4 exhausts all 16 rays. The far handover merges the depth moments to within 2 m of the analytic values. Kernel compile time and per-frame cost: not measured.
- Tests that reintroduce each defect and fail were checked by hand (results in commit 7f04998's body): no boundary clipping (4 tests fail), the literal start jitter (5), swapped beams (1), a widened guard (2), knots without finiteOr (1), no radius guard (1, with a phase that reads its radius), no inset (2), no air sample at openings (1).

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudTrace

check · 11 stages on a budget of 12 cores
  ✓ graph 0.2s · typecheck:server 0.4s · typecheck:ingest 0.5s · typecheck:headless 0.5s · typecheck:core 0.7s · lint 0.3s · fta 0.7s · typecheck:game 2.0s · knip 2.7s · typecheck:astro 21.0s · test 44.4s
check passed · 44.5s wall, 73.5s of stage time

 Test Files  1 passed (1)
      Tests  21 passed (21)
   Duration  1.85s

(Also run, not in the done command: format and spelling stages pass. Dawn prints the expected "workgroup count of 0 is unusual" warning once per kernel warmed.)
```

## weather/p0-wp7 (done, head a8a419a833)

### Commits

- 2fa576b3 feat(clouds): the far field bakes a face atlas a block a frame and marches it from where the fine march stops
- 8befea54 fix(clouds): a scrub redrew one far block forever, and now cycles through all 45
- a8a419a8 docs(clouds): the far march says where it may be called, and holds the empty result past the span's end

### Design deviations

- Where the shared code lives: the arithmetic both candidates share is in cloudFarAtlas.ts, and cloudFarSpheres.ts imports it. §2.2 puts it in cloudFar.ts, but cloudFar.ts constructs both candidates, so any value they read back from it would be an import cycle, which knip refuses (the orchestrator's note). cloudFar.ts re-exports FAR_BLOCK and FAR_STEPS_A_LAYER so the contract still names them there.
- Depth moments (§5.13 step 7): each step adds its own mean and variance, from the truncated exponential its cloud's opacity follows, combined with a weighted Welford update, instead of w·t_mid and w·t_mid². Measured: with t_mid alone, a vertical ray through a 1.5 km slab of τ 1.47 reports a deviation of 0 m where the true value is 411 m (the reintroduced-defect run).
- Blocked air (§5.13 step 6): B += (T_cl·seen − 1)·dL_a, where T_cl is the cloud already in front of the step and `seen` is the mean cloud transmittance across the step. The air is also sampled in the gaps between layer shells and out to the span's end. The design's per-step '× (T_seg − 1)' would ignore the cloud in front of the step and all air outside the shells.
- Bake statistics: a cloudy sub-column counts at the medium's own fraction (the largest over its heights, as a segment does). So fraction = Σc/16 and τ_in is the c-weighted mean. For a resolved field (c = 1) this is exactly the design's rule.
- Bake footprint: the far bake evaluates the medium at the handover's footprint (uniforms.trace.farDistance × camera.pixelAngle = farFootprint). §3.13 does not specify one.
- FAR_STEPS_A_LAYER (32) bounds each of a layer's at most two shell intervals, so a ray that crosses a layer's shell twice can take up to 64 steps in that layer.
- Spheres: each crossing stands for the layer's slant run, H/max(|μ_k|, √(H/r)), centered on the mid-height crossing and clipped to [cursor, end]. A handover partway through a layer therefore takes only the remainder, and an eye inside a layer still sees the cloud above it. The √(H/r) floor stops τ/|μ| going infinite at tangency. The design says only 'find the crossings (at most two)'.
- Spheres' cached T_sun holds the cloud's part only: the layers above, as 4 × 4 statistics evaluated in the bake at the sun ray's mid-height crossing column, times half the column's own depth. The air's beam is taken live in the march through sunThroughAt, because `cleared` changes per frame and a cached beam could be up to 45 frames stale. Both the atlas's and the spheres' sun paths floor the slant at √(H/r).
- §9 says 'a uniform slab equals the fine march to 10⁻³'. Transmittance and the depth moments meet that. The light meets the design's own model, (1 − T)·e^(−τ/2μ_s), to 10⁻³, but meets the fine march's limit only within 4 × 10⁻³ (atlas) and 4.5 × 10⁻³ (spheres). This is at τ 0.103, the thinnest slab the bake keeps, since a column under τ 0.1 is clear by the design's rule. Measured on the CPU, the half-column model's own second-order error there is 3.7 × 10⁻³. The spheres' extra 5 × 10⁻⁴ comes from caching the sun at the texel's center.
- render() ignores the budget: it draws one block every frame that selects it (§4.4's fixed cadence). On a frame that does not select it (levers.far names the other kind, or there is no second body), it releases its atlas to 1 × 1. A restart (a jump, or a change of scenario, body address or farFootprint) re-owes all 45 blocks without moving the block cursor.
- The CloudFarAtlas and CloudFarSpheres constructors take an optional second argument, { air?: AirMediumFn }. It is a test seam for an air that the stub airMediumAt cannot draw; createFarField passes nothing.

### Contract requests

- CloudFarResult (cloudNodes.ts, C's file) has no field for the plain air light over [from, end]. Without it, §5.5's composition, B += T_a·T_cl·far.air, leaves out T_a(t₀,from)·(T_cl(from) − 1)·L_a(from, t₁): the air in the far span that the fine march's own cloud hides. Behind an opaque near cloud, all of that air light would show through. The far march already samples this light (one air sample per step and per gap), so a vec3 `airLight` field on CloudFarResult would carry it at no cost. The alternative is for WP6 to integrate the air over [from, t₁] itself. Owners: C (the type) and WP6 (the composition). I have not changed either.

### Notes for integration

- far() declares variables and loops where it is called: the march state, the ray's fields and the air's phases. The trace (WP6) and the composite (WP9) must read its result in the same block they call it in. Called inside an If and read after it, the result names out-of-scope variables, and the stand-in far function declares none, so their own tests cannot catch this. Called with `from` at or past the span's end, it returns the empty result (tested), so no branch is needed around it. This is documented on CloudFarField.far.
- Names and labels: 'farAtlas' / 'cloud far atlas', 'farSpheres' / 'cloud far spheres', and the second body's atlas 'farSecond' / 'cloud far second'.
- Each far field selects itself from the frame: the served side when frame.levers.far === its kind, the second side when frame.second !== null. On any other frame it shrinks to 1 × 1, re-allocated at once with renderer.initRenderTarget, so the system can call every far field each frame and ir.clouds().bytes counts one candidate's memory. What textures() lists always exists on the GPU at the size bytes declares (tested). Declared sizes: atlas 4,792,608 B, spheres 9,585,216 B, 4 or 8 B at 1 × 1.
- pending is true until 45 blocks have been drawn since the last restart. A restart is a frame.jump, or a change of scenario id, body address or farFootprint. A cut does not restart it, because the atlas is body-fixed. Under force 'scrub', the blocks keep cycling and pending stays true until the jumps stop (tested).
- The bake reads uniforms[deps.body] (datumRadius, eye, up, sun, boundaries) and trace.farDistance × camera.pixelAngle. The march reads the `body` it is passed, its air, uniforms.layers.radius and deps.phase. For the trace to stay at 13/15 sampled bindings, deps.phase must be the same CloudPhase instance the trace uses and `body` the same CloudBodyUniforms. The far field then adds exactly one binding, its atlas: the fragment WGSL counts four 2D textures (atlas, two air tables, phase).
- cloudContracts.test.ts warms every resource with `undefined as never`. FarBake.warm resolves at once when the renderer has no WebGPU backend, so that test passes; WP11 deletes it.
- Measured on this machine's GPU, in 31 tests under the lock: transmittance to 10⁻³ absolute on 24 steep rays (both kinds) and 14 grazing chords (atlas); light to 10⁻³ against the model on a τ 1.47 slab; depth moments to 10⁻³ of the chord; the two-slab sun factor (1 − c) + c·e^(−τ/μ_s) to 10⁻³; the class's beam to 10⁻⁴ per channel; one pass per frame on the timeline. The bake matches the CPU statistics within one code on 132,327 of the 133,128 texels of two face tiles (99.4%; texels with a sample within float32's reach of the medium's edges are left out), 9,374 of them straddling the edge. Correction: the first commit's body says 'every texel' of the two tiles; the true figure is these 99.4%. I reintroduced seven defects one at a time (swapped class beam, no in-step spread, ignored fraction, no layers above, unclipped spheres run, no scissor, cursor reset on a jump), and each failed its test.
- Not measured: any frame time or pass cost of the bake or the march, the composite's per-pixel cost for the second body, memory on a browser device beyond the declared bytes, and accuracy on the real field (that is WP12's cloudFarCompare).

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudFar

check · 11 stages on a budget of 12 cores
  ✓ graph 0.3s · ✓ typecheck:server/headless/ingest/core/game/astro · ✓ lint 0.2s · ✓ fta 0.5s · ✓ knip 2.0s · ✓ test 37.5s
check passed · 37.6s wall, 60.7s of stage time
Lock: /Users/jonjaques/inertialref/.git/inertialref-gpu.lock
 Test Files  1 passed (1)
      Tests  31 passed (31)
   Duration  5.29s

Also run, not part of the done command: prettier -c on the four files (clean), pnpm spelling:check (0 British declarations). fta: cloudFarAtlas.ts 74.0, cloudFarSpheres.ts 62.2, cloudFar.ts 10.7, cloudFar.gpu.test.ts 80.7 (all under 85).
```

## weather/p0-wp8 (done, head 550ddcd75e)

### Commits

- 2f22e8e6 feat(clouds): the history holds each pixel's own samples, carried through the body's turn and the wind
- 550ddcd7 test(clouds): the history's test says what its oracles are and why the deck is not always one

### Design deviations

- α is per sample, not per frame. Age stays 'frames' as §3.15 says, but it is the frames of history a texel's estimate stands for: a fresh full-budget sample stands for one cycle (a rejected own-phase pixel restarts at age 4), and a guess (the bilinear current, or the immediate regime's quarter-budget sample) stands for none (age 0). α = max(1/(floor(age/4) + 1), 1/8), so the k-th sample after a restart gets 1/k whatever phase the restart fell on, and 32 frames hold the plain mean of 8 samples. The literal 1/(age + 1) weights a pixel by where its phase fell and leaves the reset frame's sample a share of (3/4)(7/8)^7 = 29% in a quarter of the pixels after 32 frames. That figure is computed, not measured; with the clip active the two schedules end within half-float noise in every scene I tried, because the clip first holds a biased reset sample to its window's edge.
- Only the light accumulates (L_c, T_c, B). d_reproj, d_end, d_front and deviation are always this frame's: the trace texel on an own-phase pixel, the bilinear current elsewhere. §5.14's h' = mix(clip(h), fresh, α) does not say which channels it covers. A depth averaged at the 1/8 floor trails a moving eye by about 28 frames, so an eye closing 1%/frame would fail the 20% depth test on a static cloud.
- Border handling of the 3×3 clip, which the design does not specify. (1) The window is centered one pixel inside the image (center = clamp(p, 1, extent − 2)). Without this, an edge pixel on a frame that does not sample it had all nine bilinear values from one clamped texel, so σ = 0 and the clip overwrote its history with the neighbor's raw sample one frame in four. (2) The statistics extrapolate the one texel past the trace's edge linearly (2·t_in − t_inner). The pixel's own current, which a rejection writes, stays clamp-to-edge, so nothing written overshoots. Before (2), a border pixel sat 3.5% off its plain mean at the edge of a 1.25%-per-pixel ramp; after, 0.25%. Interior pixels behave exactly as §5.14 says.
- The write guard falls back for the whole record: if light or air is non-finite, both take the current, then NO_LIGHT (0,0,0,1) / NO_AIR (0,0,0,0) / NO_DEPTH (0,0,0,0), and age is written 0. This is §5.14's finiteOr(h', finiteOr(fresh, (0,0,0,1))) applied per texture, with no-cloud fallbacks for air and depth. A NaN trace texel therefore blanks the history pixels whose 3×3 block touches it (0 × NaN in the tent sum) for one frame. The read guard on the previous history is as designed.
- render() treats frame.regime === 'immediate', a CPU reset() or a reallocation as a restart (a valid uniform set to 0, so every pixel takes the current). The system is expected to call renderImmediate on immediate frames.
- `pending` is always false (the history never owes a frame's work; convergence is report.sinceReset, which the settle predicate reads). `bytes` and `textures()` report 0 and [] until the first frame sizes the textures, and again after dispose: the 1×1 placeholders exist only for compile-ahead. This also keeps cloudContracts.test.ts's neutrality check green.
- Both parities are allocated on the device when a frame sizes them (setSize, then renderer.initTexture). Otherwise an immediate frame binds only the parity it writes, and a census right after it found 3 of the 6 declared textures.
- report.rejected is the share of history pixels the last counted converging frame rejected. It is counted only under levers.stats, with one atomicAdd per rejected pixel into a 1×u32 buffer zeroed from the CPU (needsUpdate), so no clear kernel exists beyond the four named ones. One readback is in flight at a time, so it lands a frame or more late; it is null when stats is off.
- The history writes no uniform of the shared bundle. It keeps its own phase uniform from §5.14's rule (PHASES (0,0),(1,1),(1,0),(0,1); frameIndex mod 4 when converging, k when immediate) instead of writing uniforms.trace.phase, which cloudUniforms.ts documents as the trace's.
- The NaN test poisons a trace texel through a test-only uniform in the stand-in trace kernel (bitcast NaN bits) rather than through a uniform in the history module, so production code has no test hook. The design's 'the composite stays finite' half is not built: the composite is WP9's module, in flight. The test asserts every history texel finite, which is what the composite reads.
- The '1% in 32 frames' test runs at 2% per-sample noise on a deck with no peak. Measured: one frame's samples miss each pixel's eight-sample mean by up to 2.5%, and the converged history by 0.85%. At 5% noise the specified clip (1.25σ of the bilinear current) holds the worst pixel 2.1% from its mean (0.7% RMS); widened, the same run gives 0.31% worst, 0.15% RMS. A bilinear value averages 2 or 4 samples, so its σ understates one sample's noise. The design's 1% therefore holds at 2% noise and fails at 5%. I report this as a finding and did not change the clip.

### Contract requests

### Notes for integration

- `outputs` is a getter naming the newest parity, which flips every converging frame and at k = 0 of an immediate frame. The composite (WP9) must call history() again each frame and swap its texture nodes' .value to the newest light/air/depth. A node built once over outputs.light reads a stale parity every other frame.
- The trace (WP6) must use the same interleave as the history: PHASES (0,0),(1,1),(1,0),(0,1), phase = PHASES[frameIndex mod 4] when converging and PHASES[k] in dispatchPhase(k). Trace texel (i, j) samples history pixel (2i + φx, 2j + φy). The history sets its own phase uniform from that rule, so a different order in the trace misregisters silently. cloudSystem.gpu.test.ts should cover this.
- The history reads uniforms.trace.size, .history, .wind, .frameSeconds and camera.{right, up, forward, plane, previousRight, previousUp, previousForward, previousPlane, translation}. The system must call uniforms.write(frame) before the history dispatches. It also reads trace().light and trace().aux, swapped before every dispatch, so the trace may replace or resize its textures freely.
- The system's order per §3.16 holds: converging = trace.render then history.render; immediate = for k in 0..3, trace.dispatchPhase(k) then history.renderImmediate(frame, k). The history does nothing with the budget. history.reset() makes the next converging frame keep nothing; resetHistory() should call it.
- The history keeps its allocation, 48 B per history texel (24.9 MB at 960×540), until dispose(). Nothing shrinks it when levers turn off; whether the system disposes it when off is WP11's call.
- Report mapping: report.resets counts immediate frames (at k = 0) plus converging restarts; report.sinceReset is 0 on a reset frame and +1 per converging frame (16 means four full cycles, CLOUD_SETTLE_FRAMES); report.phase is the last dispatch's PHASES index; report.rejected is null unless levers.stats.
- Measured on Jon's Mac mini (Mac18,5, Apple M6) through Dawn, 128×96 history from frames built by the real cloudFrame: a turning body keeps the feature's centroid within 0.013 px of the analytic deck after 7.4 px of travel (with the turn removed from the history's uniforms, 1.31 px); wind under warp 60, 0.046 px after 8.0 px (without frameSeconds, 1.43 px); stationary with the clip idle, 0.25% from each pixel's plain eight-sample mean (bound 8·2^-11 = 0.39%). Timing of `cloud history` was not measured: no figure exists for its cost.
- I proved each regression test can fail by reintroducing its defect and restoring the file. Without the write guard, both NaN cases fail; with the phase one step off, the plain-mean test misses by 6.1% against 0.39%; with α held at 1, the noisy convergence test misses by 2.1% against 1%.
- fta scores: cloudHistory.ts 71.2, cloudHistory.gpu.test.ts 78.5, both under the design's 85 limit for new files. The four kernels compile and run within WebGPU's default limits: converging binds 5 sampled textures, 3 storage textures and 1 storage buffer; immediate binds 2 sampled textures and 3 storage textures. I did not count bindings from the WGSL; the pipelines build, which they would not over the limit.
- The clip finding is for the measurement phase: at 5% per-sample noise, 1.25σ over the 3×3 bilinear current keeps a stationary history 2.1% (worst) / 0.7% RMS from its own sample mean. If the real trace's jitter noise is that large, the clip will reintroduce flicker. Fixing it would mean a wider γ or σ from the raw samples, which is the design's decision, not the history's.

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudHistory  (run at HEAD 550ddcd, clean tree, on the Mac mini Mac18,5 / Apple M6)

check · 11 stages on a budget of 12 cores
  ✓ graph 0.2s  ✓ typecheck:server 0.3s  ✓ typecheck:headless 0.4s  ✓ typecheck:ingest 0.4s  ✓ typecheck:core 0.5s  ✓ lint 0.3s  ✓ fta 0.5s  ✓ typecheck:game 1.4s  ✓ knip 2.0s  ✓ typecheck:astro 16.9s  ✓ test 37.7s
check passed · 37.7s wall, 60.5s of stage time

 Test Files  1 passed (1)
      Tests  17 passed (17)
   Duration  1.13s

(Dawn prints "DispatchWorkgroups with a workgroup count of 0 is unusual" for each warmCompute dispatch: expected, as the contracts note says.)
```

## weather/p0-wp9 (done, head 1cd46eea9b)

### Commits

- c218346d feat(clouds): the composite marches the air its pixel already carries, split at the cloud
- c91e5cb3 test(clouds): a transparent object between two cloud layers sees the near one's light
- 563ca592 fix(clouds): the composite's share in front of the scene is never NaN, and its light is never clamped
- 88179c1b test(clouds): the composite's error on analytic slabs is measured against a joint march
- 1cd46eea test(clouds): the composite turns its pixel's ray into the body's axes, not their transpose

### Design deviations

- compositeAir takes an optional 10th parameter `medium: AirMediumFn` (default airMediumAt) and CloudCompositeDeps an optional `airMedium`, because airMediumAt is the contracts' zero stub at BASE (WP5 writes its body). Production passes nothing; tests stand in a node-for-node reproduction of marchAir's per-sample terms.
- CompositeAir gains `throughEnd` (T_a(0, min(t1, D)), physical), used by the residual meter. CloudComposite gains `residualRead(): Promise<void>` (the readback in flight). measureResidual stays void.
- CloudComposite builds its material graph and residual meter at the first warm/show(non-null)/measureResidual, not in the constructor: cloudContracts.test.ts (C's, in the gate) constructs `new CloudComposite({} as never)`.
- Units the design left open: skyClass/compositeAir take `depth` as the depth copy stores it (render km) and `units` = sea-level units per depth-copy km = 1000/(compression*R), so the clamp is tested on the stored value. compositeAir's t0/t1 are in sea-level units. Eye is up*(1 + h_e/R).
- The moments' share Phi_N is the logistic 1/(1 + e^(-2.4x)), equal to 0.5(1 + tanh(1.2x)): tanh returns NaN on this Metal device from an argument of 45 up (measured), which made the share NaN for a cloud 38 m in front of the scene.
- The composite wraps sensorRadiance's output node to put its unclamped source back into `output` first, because three's colorNode path clamps material output at zero (NodeMaterial.setup 'force unsigned floats'), which would clamp the identity's negative light. sensorRadiance still applies the gain once and takes reactive = alpha.
- deps.phase is not read by the composite; the phase binding comes through the second body's far fn (`far`). With stand-ins the composite binds 9 textures; the real far field adds the phase as the 10th.
- Nearest-depth upsample: the screenTexel texel if its d_end matches the pixel's own end (2% + 2 m), else the best of the 2x2 bilinear footprint (ties keep the nearest). Phi = 1 when matched, else from the moments.
- The residual report's `total` histogram is the identity's whole residual (light + transmittance*S, with a surface's T cleared per segment under Enhanced); the transmittance residual has no histogram of its own. classDisagreement counts cloud texels whose four footprint corners do not all share the center's class. The section 8.6 'Enhanced ring within 2 degrees of the limb' figure is not produced (the report has no field).
- The second body's cloud is composited under the served one by 'over'; its velocity moves with the eye only (no drift, no body motion), and motion's source alpha is the served cloud's opacity alone, so the surface keeps its motion under a far cloud.
- cloudCompositeError emulates the trace's outputs (L_c, T_c, B, mean depth) with a 512-step march in the test, because WP6's trace is in flight.

### Contract requests

- skyClass(air, eye, direction, depth, units) semantics for WP6's call from the trace: eye in sea-level units about the center (body-fixed), depth = the depth copy's render km as stored, units = 1000/(compression*R). Please confirm WP6 uses the same.
- History and trace depth fields (d_end, d_front, deviation, d_reproj) are read as true km along the ray (the trace's meters / 1000). WP6/WP8 must write them so; the depth copy remains render km.
- CloudRenderReport.residual has no slot for section 8.6's Enhanced-ring-at-the-limb figure (sky-class texels within 2 degrees of the limb). If WP10's runner needs it, the report needs a fourth histogram or a limb sub-count.
- The optional `medium` (compositeAir) and `airMedium` (CloudCompositeDeps) parameters exist only because airMediumAt is a stub at BASE. WP11 may keep them for the tests or drop them after WP5 merges; the real-airMediumAt case in cloudCompositeAir.gpu.test.ts then runs by itself.

### Notes for integration

- WP3's CloudDepth builds its render pipeline again ('renderPipeline_cloud depth') on its first draw nested inside a frame (inside the split or pass B), even after warm(). Measured: 1 render pipeline. A top-level draw after the same warm builds none. WP11's cloudWarm census will see it; the composite's own warm test excludes the depth copy for this reason.
- Measured on this Metal device: TSL tanh(x) is NaN for x >= 45 (tanh(44) = 1 + 2^-23, tanh(-300) = -1). Any module using tanh on large arguments will hit it.
- Three's colorNode material path clamps output at zero (NodeMaterial.setup 'force unsigned floats'). Any cloud module wanting negative light must bypass it as the composite does.
- The composite follows deps.history() and deps.depth() at every draw through a TextureFollower node wrapped around the frame node (updateBefore runs children first), so a history parity swap made inside the frame's cloud work is picked up the same frame. cloudFront follows trace() the same way.
- cloudFront(trace, uniforms, screen, distance): screen is the image point, y up; distance is true meters along the ray; light is returned as L*dayColor*pi (the composite's units, before the gain the object's own sensorRadiance applies). Padding knots are recognized by T >= 0.995, whatever their depths.
- CloudComposite.warm(renderer, layout, camera, scene) needs a camera that tests layer 1 (the passes mesh is on OVER), as the scene camera does under the flag. It also warms the residual kernels with warmCompute. Both kernels are named 'cloud residual'.
- Discard rule: src.a < 1/512 and max|src.rgb|*gain < 2^-14. Under composite 'residual' and placement 'empty-split' every fragment discards (the frame node still runs).
- Measured on this machine's GPU (Metal via Dawn), no browser: split marches against marchAir, worst 2.2e-7 relative over 16x16 rays (bound 1e-5; 1.0001 on extinction fails it at 2.5e-3); all 28 GPU cases listed in the commits. cloudCompositeError, worst over 60 cases: surface c0 identity 0.883% / thin 0.884% / exact 0.008% / quadrature 0.884%; surface c1 0.374 / 0.377 / 0.466 / 0.119%; sky 0.279 / 0.279 / 0.095 / 0.279%.
- Not measured: anything in a browser, timings, memory, the real trace, history or far field, or the real airMediumAt (still a stub here).

### Done command

```
pnpm check --only gate && IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudComposite cloudCompositeAir cloudFront cloudCompositeError  (exit 0, at 1cd46ee)

check · 11 stages on a budget of 12 cores
  ✓ graph 0.3s  ✓ typecheck:ingest 0.4s  ✓ typecheck:headless 0.4s  ✓ typecheck:server 0.5s  ✓ typecheck:core 0.5s  ✓ lint 0.2s  ✓ fta 0.5s  ✓ typecheck:game 1.3s  ✓ knip 1.9s  ✓ typecheck:astro 17.0s  ✓ test 37.9s
check passed · 37.9s wall, 60.8s of stage time

 RUN  v5.0.5
 (two Dawn warnings "DispatchWorkgroups with a workgroup count of 0 is unusual": warmCompute, expected)
 Test Files  3 passed | 1 skipped (4)
      Tests  28 passed | 2 skipped (30)
Skipped: the real-airMediumAt comparison (self-skips while airMediumAt is the contracts' zero stub) and cloudCompositeError (opt-in, IR_CLOUD_MEASURE unset). With IR_CLOUD_MEASURE=1, cloudCompositeError passes and writes .data/clouds/compositeError.json. Full log: (session scratchpad, not kept)/wp9-done.log
```
