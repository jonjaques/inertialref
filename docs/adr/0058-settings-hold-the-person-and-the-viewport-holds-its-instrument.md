# ADR-0058: Settings hold the person's choices, and a viewport holds its own instrument

Status: accepted · 6 Nov 2026. Moves the lens controls [ADR-0018](0018-the-instrument.md)
gave the planetarium into a panel of their own, and takes them off the settings page.

## Context

The lens had two homes. The planetarium's Camera panel drew `LensSection` and
`OpticsSection`, and `/settings/camera` drew the same two components, on the
argument that one preference reached from two places must not look like two
things. Each half of that arrangement had failed on its own terms.

**The settings copy could not show what it set.** The page is a dialog over a
70% scrim, and it opens over the menu as readily as over a mode — so a focal
length chosen there was chosen against a picture that was dimmed, or absent.
It was also **flight's only lens control**: flight's workspace registers the
Navigator and nothing else, so a pilot reached the lens by leaving the cockpit
for a page.

**The planetarium copy was the back half of a seven-section panel.** Target,
aim, orbit, ground, canopy, lens with its glare, optics: two questions — where
the eye is, and what it looks through — in one column, with Fit, Closer and
Farther, the verbs the panel is opened for, in the middle of it.

**One record held two owners.** `render.sensor` carries a photograph's
processing — camera mode, compensation, white balance — beside the exposure's
comfort clamps and the display's peak luminance. The clamps are the promise
[PRODUCT.md](../../PRODUCT.md) makes to somebody for whom a star filling the frame
after interstellar dark is uncomfortable; they are a property of that person,
and they were reachable only through a section named for a ship's canopy.

## Decision

**A setting lives with its owner. What belongs to the person — the display,
their comfort, their bindings, the interface, their data — is on the settings
page. What belongs to a viewport — its lens and its exposure, its framing, its
layers — is a panel beside the picture it shapes, registered in every mode that
has that viewport.**

- **The lens is a Lens panel** (`hud/LensPanel.tsx`): exposure, the lens
  channels, and the derived optics. The planetarium and flight both register
  it, as both register the Navigator, closed on arrival. The planetarium passes
  its glare; flight has none, because how much of the flare a photograph shows
  is a choice about a picture. `/settings/camera` is gone and opens the display
  page, as every unknown section does.
- **The panel says when another instrument owns the lens.** While a fixed Milky
  Way view is held, `engine.lens` is the view's ([rule 32](../agents/invariants.md#rule-32)):
  the panel names it, disables sliders that would move the kept lens, and the
  optics describe the lens in use.
- **The sensor record is split by field, not by key.** Settings › Display draws
  peak luminance and the comfort clamps. The clamps are live in every camera
  mode, with a line saying they apply in Automatic: the default mode is
  Enhanced, and a protection that could only be set after switching modes in a
  viewport would tie the person's choice back to the instrument. Peak luminance
  is drawn under every output and live only with headroom to cap. The Lens
  panel draws mode, compensation and white balance. Each side restores only its
  own fields (`restoreFields`), and removes the key when what remains is the
  default.
- **The Camera panel is where the eye is**: the subject and its target, a Frame
  section that opens on the three verbs, and the ground.
- **A settings page restores what it draws, and restoring removes the key.**
  `resetPreference` leaves "never chose" meaning the default, so a default that
  later moves still reaches everybody who never chose.

## Alternatives considered

**Both homes, as before.** Kept the duplicate and the dimmed picture, and kept
flight's lens on a page.

**The lens in Settings only.** Settings is where a person sets things once.
A focal length is set per picture, against the picture.

**The lens inside the View panel.** View is layers — names, traces, the ship —
which change pixels the scene does not own, and the split between Camera and
View is by what a control changes ([the planetarium bible](../design/planetarium.md#the-tools)).
The lens changes the picture.

**The lens left inside Camera, collapsed.** Seven sections behind collapsed
headings are still seven sections, and flight would still have had no lens.

**The comfort clamps in the Lens panel.** They would have been a person's
protection reachable only from a panel nobody opens until they want a
photograph, in a mode most sessions never enter.

## Consequences

- Flight's menu gains a glyph, and the planetarium's grows from six panels to
  seven (eight with the guide), so the keymap has an eighth panel key.
- The lens is still one lens: a preset fits its own and writes it, so the ship
  flies at the preset's focal length afterward. The Lens section says "custom"
  when it is, and Reset lens is the primary verb then — a cue, not a fix; a
  per-mode lens would be a second producer to reconcile.
- `render.sensor` now has two writers that must each use the updater form and
  touch only their own fields ([rule 43](../agents/invariants.md#rule-43)). A test
  pins the display page's half.
- "Reset everything" keeps the planetarium's saved shots, which live in the
  registry but are something a person made rather than a setting they chose.

## Related

- [ADR-0017](0017-the-lens.md) — the lens, and its one producer
- [ADR-0018](0018-the-instrument.md) — the instrument this moves
- [ADR-0012](0012-dockable-panels.md) — the workspace the Lens panel docks in
- [ADR-0037](0037-the-enhanced-camera.md) — the camera modes and the comfort limits
