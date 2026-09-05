# M4: Earth to the galaxy through the sensor

Status: implementation plan, 5 Sep 2026.

This is the execution plan for M4 of [the galaxy plan](the-galaxy.md). The
requested result is a new branch containing the implemented and verified
milestone. The four supplied Galaxium screenshots are visual references. They
suggest soft unresolved light, coherent perspective during retreat, and a
readable transition from nearby stars to the whole disk. They do not establish
which rendering techniques Galaxium uses.

## Outcome and scope

A person in the planetarium can travel continuously from 64,000 km above Earth
to 30 kpc above the galactic center, hold any intermediate view, and return
along the same route. Ordinary orbit navigation also reaches galactic distances.
The existing observatory produces the camera, the existing engine resolves the
lens, and the existing sensor processes the galaxy together with foreground
bodies and stars. Camera travel does not move the ship or advance a frozen world.

The milestone includes interior ray sampling, bounded local star selection,
inspectable camera and exposure state, controls for the journey, response
comparison plates, and a recording of the outward and return motion.

Dust transport belongs to M5, local clouds and photometric calibration to M6,
cached skies to M7, GPU star projection to M8, population expansion and
resolved-light subtraction to M9, stellar extinction to M10, and temporal
volume reuse to M11. M4 preserves those boundaries. It does not add a painted
sky, a second stellar field, artificial travel streaks, or a new rendering
pipeline. The current emission includes light that later resolved-population
work must subtract. The images' dark lanes therefore remain absent in M4.

## Branch and current work

- Working directory: `/Users/jonjaques/Developer/inertialref`.
- New branch: `codex/galaxy-earth-to-the-disk`, already checked out.
- Exact base: `d980228`, the current M3 tip on
  `codex/galaxy-the-disk-is-visible`.
- M3's dependent-branch workflow applies because its implementation is not on
  the integration tip. Preserve the predecessor's history and every other
  worktree. Do not transplant this work onto `origin/main` while that would
  remove M1 through M3.
- Node is 26.5.0; pnpm is 11.22.0.
- Baseline command: `VITEST_MAX_WORKERS=2 pnpm check`, with output in
  `/tmp/inertialref-m4-baseline.log`. The log records 1,723 regular tests, five
  slow tests, and successful production bundling. The process exits with code
  zero; the complete baseline gate passes.
- The only implementation artifact so far is the uncommitted
  `packages/devtools/src/galaxyJourney.test.ts`. Its valid journey case fails
  because `ir.galaxyJourney` does not exist. Its invalid-input case currently
  catches that same missing-method error, so it is not yet evidence of input
  validation. Tighten it to the implemented validation message.
- No production code has changed. No remote branch, PR, review, or media upload
  is part of the current authorization. Make local commits as the repository
  requires. Shipping is a separate user request.

## Existing mechanisms to retain

`packages/devtools/src/observatory.ts` owns the planetarium camera. Its ordinary
orbit is an `ObserverState`, its pose comes from `observerPose`, and its target
position resolves at `world.clock.renderTime`. The frame loop samples it once.
`GameEngine.#step` selects cinematic, observatory, then ship. `CameraRig` remains
the sole writer of the Three.js camera's FOV.

`packages/rendering/src/galaxyView.ts` declares the two fixed M3 instruments and
their lenses. They remain reproducible. `GalaxyVolumeNode` owns one quarter-width,
quarter-height rgba16f target and draws the shared field once per scene
submission. `createGalaxyBackdrop` places its output behind full-resolution
scene geometry. `scene/Sensor.tsx` already pins a galaxy instrument to the
lens's exposure, and the sensor performs pre-exposure, optics, and response.

The local survey in `GameEngine.#maybeSurveyStars` asks for a radius of two
cells, a 5 × 5 × 5 cube, after 8 ly of movement. One request may be pending.
`selectStars` caps the sprite selection at 20,000. The sky catalog joins that
local selection without enlarging the cell query.

## 1. Camera route and navigation range

Add pure route arithmetic in `packages/rendering/src/galaxyJourney.ts`, exported
from the package's existing index. Keep absolute points as `UniverseVector`.
Derive displacements with `UV.difference` and positions with `UV.translate`.
Use double-precision displacement arithmetic only where the spatial contract
permits it.

The route has these endpoints:

- Start: Earth center plus an outward offset of Earth's radius + 64,000 km.
- Destination: galactocentric `(0, 30000 pc, 0)`.
- Direction: the normalized displacement from Earth to that destination.
- Orbit azimuth and elevation: derived from that displacement, within the
  observatory's existing elevation constraint.
- Distance: interpolate logarithmically between the two positive standoffs.
  Return the exact endpoint distance for progress zero and one.
- Orientation: the existing orbit pose continues looking toward Earth with
  the existing galactic up convention. It does not switch orientation at an
  arbitrary distance. The whole disk remains within the chosen wide lens at
  the destination, although Earth rather than the galactic center is the aim.

Resolve Earth through the existing address and frame code at presentation time.
Do not reconstruct the Solar System or assemble a second session. Hold route
parameters during a trip; the ordinary target resolver still follows Earth
when simulation time runs. A frozen world makes the route exactly reversible.

Raise `MAX_OBSERVER_DISTANCE` to 110,000 ly. The current implementation is
120 ly, despite the parent plan's approximate 100 ly description. The target
above the center is approximately 101,400 ly from Earth because Sol is 8.178 kpc
from the center; a literal 100,000 ly ceiling clips this endpoint. Document that
geometric reason. Check sector limits against supported catalog targets and the
new offset, and retain finite positive distance clamps. Do not enlarge the
universe coordinate representation.

## 2. Journey ownership and public controls

Add `Harness.galaxyJourney(progress = 0, seconds = 0)` and a corresponding
observatory method. Progress is a finite number in `[0, 1]`; duration is finite
and nonnegative. Reject invalid input before stopping a cutscene, setting a
lens, focusing Earth, or changing the journey.

On first entry, select Earth through the existing focus path, initialize the
route, set the named instrument lens through `setFlightLens`, and hold progress
zero. An immediate request seeks to its requested progress. A timed request
starts at the currently displayed progress and moves to the requested endpoint
or intermediate value. Reversing an active request starts from the current
position. It must not restart from Earth or jump to an endpoint.

Store journey presentation state in the observatory, not React. Advance its
elapsed presentation time inside the existing `sample(dt)` call. Ease progress
with a smooth endpoint function over the requested duration, then derive the
logarithmic distance. A full journey defaults to 36 seconds in the product
controls. Duration zero means an exact held view for tests and comparison plates.
The simulation clock remains independent.

The journey writes the existing orbit state and uses the same final
`observerPose` call. It does not install another engine camera producer.
Publish progress, destination, remaining duration, and whether it is moving in
`ObserverStatus`. Inspection and `eye` must not advance the animation.

Define interruption behavior explicitly:

- A new journey target replaces the active travel from its current progress.
- The Hold control stops at the displayed progress.
- A slider seek holds the selected progress immediately.
- Direct orbit or distance manipulation stops automatic travel before applying
  the gesture, so the next animation frame cannot undo the user's input.
- Selecting a body, entering a fixed galaxy view, or clearing the observatory
  clears journey state through existing focus/clear paths.
- A cutscene retains its camera and lens precedence. Journey diagnostics and
  the galaxy instrument flag must report the resolved producer, not a hidden
  observatory arm.
- Returning to a normal body view releases the instrument exposure pin. The
  flight lens remains subject to the existing preset/preference behavior.

Add a small `GalaxyJourneyControls.tsx` under the existing Milky Way section.
Use the registry's `Action` and `Slider`; one component per file. Provide Earth
Orbit, Travel Out, Return, Hold, and a labeled progress slider, with availability
based on the published journey state. Display distance and the declared
instrument exposure. Subscribe to narrow fields through the existing 8 Hz
engine sampler; add no timer, keyboard listener, or persistent journey store.

## 3. Resolved camera and live volume

Publish the selected camera's universe pose once from `GameEngine.#step` so
volume rendering can read the same eye and orientation as scene construction.
Clear it when there is no camera. Do not call `observatory.sample` again from a
component or infer the pose from a fixed view record.

Enable the live volume whenever the observatory actually owns the frame,
including ordinary planetarium orbits, fixed instruments, and the journey.
Keep its cinematic precedence explicit. Preserve inactive behavior for routes
whose presentation stance does not select the observatory. Use the resolved
lens for ray projection and the actual drawing-buffer aspect ratio.

Preserve the target's current lifetime contract: one owner, quarter dimensions
rounded up, warm-up through `render/warmup.ts`, renderer-state restoration after
a throw, no draw before readiness, resize of the owned target, and idempotent
retirement. A late warm-up cannot revive a retired target. Do not introduce
history or a second background resource.

## 4. Interior sampling shared with the CPU

The existing reference march limits steps using height above the warped plane
and a 100 pc cap. Extend `GalaxyRayOptions` with an explicit sampling profile,
keeping the default CPU reference profile unchanged so the M2 numerical plates
remain comparable.

For the observer profile, additionally cap the interval by
`max(1 pc, 1 pc + 0.1 * t)`, where `t` is distance along the ray from the actual
observer. Apply this cap together with the existing plane-sensitive limit,
100 pc maximum, remaining ray length, and slab clipping. The near part of an
interior ray then gets finer intervals; an exterior ray does not spend those
intervals crossing empty space before it enters the volume.

Port the identical interval rule to the TSL integral. Expose the profile to GPU
checks and use the observer profile for the live target. Increase the port
revision to `galaxy-tsl@2`; the stellar field remains `galaxy-field@2` and active
population generation remains unchanged. If measured convergence requires a
different step law, change both CPU and GPU together and update this plan and
the recorded sampling constants.

Keep front-to-back ray order deterministic and bounded by the existing maximum
iteration count. Tests must show complete rays reach their clipped endpoint
under the supported profiles. Do not conceal truncation by accepting a darker
integral. No random start offset, temporal jitter, or history enters M4.

## 5. Sensor behavior and diagnostics

Give the journey an explicit wide instrument lens, initially the M3 face-on
lens: 90° vertical FOV, f/2, 2,400 s, ISO 400, focus at infinity. Set it on entry
through the existing lens request port; do not persist a different lens every
animation frame. User lens changes continue to go through that same port.

Define a resolved galaxy-instrument predicate covering fixed instruments and
the journey. Use it consistently for the sensor's lens exposure pin, physical
resolved-star flux, and suppression of the relative-brightness analytic Sun
flare. Preserve ordinary Natural behavior outside this declared instrument.
The three sensor responses process the same scene radiance. Do not brighten the
galaxy separately inside a response or insert a tone map before the sensor.

This long exposure can clip a bright Earth while revealing faint diffuse light.
That is a declared comparison limitation, not a reason to hide the body or
change its radiance. Capture both a galaxy-exposed and a body-exposed view when
necessary to make the dynamic-range limitation understandable. Any further
exposure behavior justified by those measurements must be documented and tested
before adoption. M4 does not claim an instantaneous preview actually accumulates
2,400 seconds of photons.

Extend `ir.galaxy().render()` without adding a separate diagnostic producer.
Report the observer's galactocentric parsecs and orientation, coordinate-frame
name, selected view or journey state, field and kernel versions, sample profile
and bounds, resolved lens, effective sensor exposure and response, target bytes
and dimensions, and submission count. Report the local survey radius, cell
ceiling, selected sprite count and ceiling, and pending status from their actual
owners. Keep unavailable GPU or sensor values nullable in a headless session.

Foreground bodies must cover the backdrop at full scene resolution in every
view. M4 retains the documented approximation that scene geometry masks the
whole background integral rather than ending transport at an object's true
physical distance. Diffuse foreground transport through an internal occluder
is not implemented. State that limitation beside the occlusion evidence.

## 6. Behavior and numerical verification

Write focused tests before the corresponding production code and observe the
missing behavior fail. Use `openSession` and the existing headless engine.
Do not create a second session constructor or CPU imitation of a shader.

Camera and host tests:

- Exact starting altitude and destination height/center, positive finite
  distance, usable lens, normalized orientation, and coordinate bounds.
- Monotonic outward and return travel with bounded adjacent logarithmic steps;
  no orientation flip or endpoint jump.
- Frame partition independence for timed travel, exact held endpoints, partial
  reversal, interruption by gestures, and clearing by focus/fixed views.
- State-hash equality for a frozen world's complete outward and return path,
  including held camera samples and diagnostic reads.
- One resolved pose shared by scene and volume, cinematic precedence, and
  truthful instrument exposure activation/release.
- Invalid inputs reject before side effects, with specific validation errors.
- Ordinary zoom reaches the new ceiling and retains the lower body-clearance
  bound. Property tests cover logarithmic route interpolation and coordinates.

Sampling and GPU tests:

- Existing CPU reference-profile plates and field tests remain unchanged.
- Observer-profile interior rays are finite and nonnegative and converge
  within 1% of a finer reference over center, anticenter, poles, arm tangencies,
  near-plane, warped-rim, and outside-to-inside rays.
- Short clipped rays preserve path length for a homogeneous emitter; misses
  and zero distance return zero; iteration budgets cover the supported domain.
- Run the actual TSL graph with the existing GPU harness and compare RGB and
  stellar columns to the CPU observer profile within 1%, with declared absolute
  tolerances near zero. Include nonsymmetric orientations and multiple observer
  positions along the route, not only axial fixed views.
- Extend the composed-orientation GPU test to an interior observer. Preserve
  foreground-depth, alpha, pre-exposure, resize, retirement, and late-warm tests.
- Verify a bright foreground object and the faint field share one sensor
  exposure and preserve opaque output. Exercise Direct, Neutral, and Natural.

Survey tests inspect real task requests or a narrow diagnostic seam. At local,
regional, and galactic route points, every request remains a 125-cell cube,
there is at most one pending sweep, and selected sprites never exceed 20,000.
Do not request cells based on the disk's visible size. Exercise return travel
and save/world replacement so stale work cannot become current selection.

## 7. Browser evidence and measurements

Use the drive skill and `node scripts/drive.mjs` exclusively. Inspect the
existing Game and Worker terminal before starting a server. Reuse a suitable
server; otherwise start the existing client command. Every invocation carries
its full URL, viewport, DPR, setup, and measurement. Reload after source edits.
Use a dedicated driver profile and shut it down after verification.

Run measurements after tests/builds finish on a quiet machine. Primary rig:
Chrome WebGPU, 1920 × 1080 drawing buffer at DPR 1, GPU and browser version
reported from the actual run. Also check a DPR 2 resize for presentation and
lifetime behavior. Identify dev versus production in every timing record;
prefer the production build for cost claims.

Create evidence under `.scratch/galaxy-m4/`:

1. A complete outward and return `--cast`, using the real timed journey with
   chrome and labels hidden. Include brief endpoint holds and diagnostic
   samples at each scale. Record compositor capture rate; a low-rate cast
   cannot establish absence of a one-frame strobe.
2. Fixed-progress plates near Earth, in the local sky, at regional separation,
   and above the disk. Verify galaxy orientation against CPU rays and fixed M3
   instruments. Inspect the actual images, not only successful capture exits.
3. Direct, Neutral, and Natural plates at identical pose and lens for an
   interior view and the outside view. Save their exposure diagnostics beside
   the images so a display difference cannot be mistaken for a field change.
4. A bright Earth beside the faint field under the same three responses,
   with an additional body exposure if clipping prevents assessment. Check
   foreground coverage and explicitly record visibility/clipping limitations.
5. Resize and renderer-lifetime observations, zero unhandled page/GPU errors,
   nonblack presented frames, and continuous camera/lens diagnostics.
6. GPU measurements at an interior view and the outside endpoint, including
   the complete sensor frame, isolated added-volume cost where the existing
   harness supports it, target memory, and bounded survey counts.

The 2 ms volume target is not an M4 promise. M3 measures approximately 10.6 ms
face-on and 23.2 ms edge-on on its stated M5 rig. Record M4's actual costs and
any added interior-sampling cost. Temporal optimization remains M11. A failed
continuity, numerical, or lifecycle check is work to fix in M4, not a limitation
to transfer to another milestone.

## 8. Documentation, commits, and completion

Use small, coherent local commits, with conventional declarative subjects and
extended bodies explaining the constraint. Intended boundaries are:

1. Camera route, range, observatory journey, harness, and focused tests.
2. Resolved volume pose, observer sampling, sensor instrument state,
   diagnostics, and their CPU/GPU checks.
3. Product controls and any integration fixes required by visual verification.
4. Accepted implementation account, evidence ledger, and durable findings.

Keep a shared interface and its required callers in the same commit. Format
changed files explicitly before committing. A checkpoint may precede the full
gate; its report must state which verification remains. Fixes found by the
checks become follow-up commits.

Update the existing stellar-field ADR with M4's camera, sampling, exposure,
composition limitations, and version decisions. Use the ADR skill when changing
that architectural account and the context-log skill for measured findings.
Update the parent galaxy plan's M4 ledger with the actual local commit and
verified evidence, clearly distinguishing implementation from a merged PR.
Update implementation guides that otherwise retain the 120 ly ceiling or
fixed-view-only claim. Search for those claims across the repository before
finishing. Plans stay under `design/plans/`; any new published document needs a
matching entry in `scripts/docs/wings.mjs`.

Final checks, after the last relevant code change:

- Focused route, observatory, engine, survey, and integral tests.
- Relevant galaxy and sensor GPU suites on the real GPU.
- `VITEST_MAX_WORKERS=2 pnpm check`.
- `pnpm sim --self-test`.
- The visual and motion evidence above, taken against the final implementation.
- Clean working tree, local commits on the requested branch, and no accidental
  changes to another agent's work or active population versions.

Completion requires all M4 behavior and evidence, including the complete return
trip. The final report states what changed, the branch and commit, which gates
passed, where the recording and plates live, and the measured exposure and
performance limitations. Do not claim a PR is open or a milestone merged unless
that separate action actually occurs.
