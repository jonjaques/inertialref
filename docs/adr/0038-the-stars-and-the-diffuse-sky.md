# ADR-0038: Resolved stars and diffuse sky share one population and dust field

Status: accepted · 7 Sep 2026

Supersedes the population-preview restriction and initial cache configuration
in [ADR-0032](0032-the-stellar-field.md). Its source conventions, linear
photometry and historical M1–M6 measurements remain recorded there.
[ADR-0037](0037-the-enhanced-camera.md) continues to own camera processing.

## Context

A fixed local survey does not cover the stars visible from a distant observer.
Increasing its radius generates too many faint systems, and increasing its
sprite ceiling makes every camera translation rewrite more positions. Drawing
those sources over the integrated stellar field also counts their light twice.

Dust must end at each star. A background sky column would obscure foreground
stars, while applying an observer-to-star column directly to a catalogue's
observed magnitude would count the Solar observer's extinction a second time.
Sixteen integration samples miss thin and nearby clouds. Starting a new cache
cycle on every observer movement prevents any distant column from completing.

The physical sky needs more than a settled-image hold. Free look can reuse an
angular field, translation can invalidate it, and long rays still cost several
milliseconds. A finished cube is expensive enough to keep across a reload, but
it is regenerable data and does not belong in a save. Fine temporal detail must
survive after the eye stops; clamping a stationary history to a coarse current
ray erases the detail that preceding phases already measured.

## Decision

**Generate resolved sources from disjoint luminosity bands of the calibrated
field, subtract their expected emission from the diffuse field, and transport
both through the same dust.**

Nine logarithmic Johnson V luminosity bands own independent `(level, cell)`
seeds. Their number weights reproduce each population's calibrated mean V
luminosity. Cell widths double from 20 light-years; luminosity bounds grow by
four, so a magnitude query can bound the cells relevant to each level. Travel
queries remain independent of the sky draw. New `Q` system addresses identify
these levels; old `P` addresses retain their legacy generation path.

The shipped sky query requests unextinguished V ≤ 8, at most 100,000 sprites,
one million candidates and 2,000 cells. Budget pressure lowers the requested
magnitude or omits whole levels; it cannot pretend an unfinished level is
complete. The returned selection origin, actual magnitude threshold and level
mask define the diffuse subtraction. Luminosity moments remove the expected
emission of exactly those bands. Omitted levels remain diffuse. This conserves
ensemble light; individual stochastic realizations retain finite sampling
noise and do not guarantee identical radiance in every pixel.

Catalogue completeness is a magnitude-and-distance envelope, independent of
search UI. Known faint neighbors remain protected inside 25 light-years;
Hipparcos supplies a conservative V 7.3 envelope inside 150 light-years and the
shipped distant sky supplies V 6.5 beyond it. Sparse catalogue counts outside
the complete envelope reduce the corresponding procedural cell and band.
Catalogue records retain their measured identities and flux convention.

A source upload carries integer sectors, integer 1,024 m subcells and bounded
float remainders. Observer uniforms produce directions in the vertex stage;
ordinary translation uploads no source positions. Stable IDs preserve previous
coordinates through reorder and rebasing. Per-source motion flags distinguish
a moving source from a new source. Retained names and appearance update only
where the selection changes. Enhanced's visibility response uses transported
absolute V, so a different brightest star cannot brighten every other sprite.

The resolved-star dust cache integrates only to the source. It uses 32 samples
through 64 pc, 64 through 512 pc and 512 for longer paths, concentrating work
around the shared warped dust plane. A catalogue source uses
`T(observer, source) / T(Sol, source)`; a procedural source uses the full current
transmission. At Sol the catalogue correction is exactly unity. Optical-depth
storage preserves strongly obscured channels, with an explicit finite gain
ceiling for catalogue corrections.

A frozen observer starts each finite update cycle. Its queue completes before
another cycle starts, including during continuous travel. Unchanged sources
retain their last physical column until its replacement arrives; new sources
begin hidden. Six submissions interpolate old and new optical depths. WebGPU
updates at most 1,024 sources per submission; the WebGL CPU fallback updates
one. The latter converges slowly during large moves and reports that lag.
Source IDs, field versions and queue epochs prevent stale work from attaching
to a reused buffer slot. One renderer shares one 2,048² RG16F arm table between
resolved transport and diffuse light; reference-counted leases own its lifetime.

### Physical cubes and temporal history

Ordinary nearby views refine complete 32², 128² and 512² cubemaps. Two 32² tiles
are submitted per frame; the boot census ends after the 128² tier, while the
512² tier continues in the background. Three target slots retain two completed
locations and one replacement. Only six complete faces publish. Canceled work,
changed fields or source partitions, renderer retirement and late storage
reads cannot publish into a different generation.

Cube reuse is limited to 0.15 pc, measured against local cloud gradients. A
disk-restored source envelope can have a slightly different origin, so envelope
displacement and eye displacement spend one combined allowance. The restored
entry retains the remaining eye allowance for all later reuse. Magnitude or
level-mask changes reject the entry. A mode, lens, exposure or display-gamut
change does not change physical sky light.

The regenerable IndexedDB store retains at most two finished cubes in a
separate database. Records contain a versioned field fingerprint, kernel and
backend, quality, observer and source envelope, and all six physical RGBA16F
faces. Reads validate metadata, finite nonnegative radiance and complete faces.
Writes wait for transaction completion. Unsupported, blocked or failed storage
is a cache miss. GPU readback and upload preserve native cube-face orientation
and padded row strides; temporary transfer textures are disposed.

Outside the nearby disk, or beyond a valid cube, live rays fill half-resolution
physical history using an eight-by-eight interleaved pattern. At 1920×1080
this traces 120×68 primary rays per submission and retains 960×540 history.
RGB remains V-anchored nW m⁻² sr⁻¹ divided by 1,000; alpha carries
emission-weighted distance for reprojection. Foreground occlusion remains in
the full-resolution scene.

History rejects camera cuts, large parallax, disocclusion, changed fields or
source partitions, resize and renderer retirement. Moving history is bounded
by current neighboring radiance; stationary history retains already measured
fine samples. Exposure does not invalidate physical history. After the eye
settles and every phase completes, the target is held until something changes.

## Alternatives considered

**Generate a larger uniform local survey.** Faint stars dominate its work and
memory before its visible reach approaches the galaxy. The sky and travel
catalogue answer different queries.

**Subtract the whole population inside a distance sphere.** Bright distant
sources and faint nearby sources cross that sphere differently. Luminosity
bands permit the same selection rule in source generation and diffuse transport.

**Normalize sprite appearance to the currently brightest source.** A replacement
selection changes the rest of the sky's brightness. Absolute transported V
provides a stable response and removes GPU maximum reductions.

**Use sixteen dust samples or restart them on movement.** The first misses
physical columns; the second starves a moving observer's queue. Distance-aware
quadrature and finite cycles bound the work without discarding foreground dust.

**Persist generated stars or put cubes in saves.** Both can be regenerated.
A small independent cache improves reload cost without changing canonical
state or making save compatibility depend on a GPU texture.

**Clamp every history sample.** The coarse current grid has not measured the
fine stationary feature it is clamping. Restricting that clamp to motion keeps
its ghost-rejection purpose without erasing converged angular detail.

## Consequences

The active population spends a generation version. Legacy procedural addresses
remain resolvable, while new selection and portable-picture manifests identify
the active algorithm. The source model and camera response remain independently
inspectable and tested.

The 100,000-source capacity reserves about 24.4 MB of GPU source, appearance and
dust data, in addition to the shared 16 MiB arm table. A 512² physical cube is
12 MiB. Half-resolution temporal resources add 9.33 MB over the measured
quarter-resolution alternative at 1080p. These are declared allocations,
excluding driver overhead and temporary JavaScript generation memory.

The live 2 ms target is not a universal bound. The final performance record in
[the galaxy plan](../../design/plans/the-galaxy.md) names the measured operating
points and the chosen quality budget. Typical retained source replacement fits
5 ms of main-thread preparation; cold entirely new populations and garbage
collection can exceed it. GPU source updates and diffuse cache refinement are
bounded separately from worker generation.

The field still uses illustrative RGB stellar colors and absorption-only dust.
Scattering, H II line emission, globular clusters and neighboring galaxies are
separate physical additions. Finite source realizations, angular interpolation,
and delayed moving-star dust refresh are observable approximation limits.
