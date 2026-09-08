# The sensor

[The camera plan](the-camera.md) owns Enhanced, Automatic and Manual: camera
policy, sensor composition, controls, saved views and image acceptance.
[The galaxy plan](the-galaxy.md) owns physical light, dust, star populations,
cached skies and the continuous journey. Camera C5 and galaxy M11 share the
final visible-sky acceptance gate. The
[camera completion record](the-camera.md#camera-completion-record) records the
current image review, exposure continuity, real backend fallback, display
lifecycle and measured return-frame costs. C1–C5 are complete: sixteen matched
stills, four final descent casts, camera transitions and regenerated preset
plates pass review. Assembled checks and complete-frame measurements record
the bounded sky and optical quality choices plus the native Retina ground
limit.

The implemented chain is recorded in
[ADR-0029](../../docs/adr/0029-the-sensor-spine.md) and
[ADR-0031](../../docs/adr/0031-the-sensor-response.md). The accepted three-mode
direction is [ADR-0037](../../docs/adr/0037-the-enhanced-camera.md).

The camera plan also owns the [deferred sensor work](the-camera.md#scope-that-waits):
iris sampling, FFT diffraction, spectral filters, export, tether controls and
headroom discovery. Those features do not hold the galaxy integration open.
This page preserves the existing sensor-plan URL without duplicating milestones.
