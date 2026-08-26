# ADR-0014: An unmeasured field is a row, and it says so in the universe's voice

Status: accepted · 2026-08-25

## Context

The planetarium's object panel showed five things about the body in frame: its
name, its kind, its radius, the range from the camera to it, and how much of
the frame it filled. Two of those are about the body. Three are about the
telescope.

Meanwhile `packages/universe` holds a great deal more. Every body carries a
mass, a mean density that follows from it, orbital elements at J2000, a
rotation period and an axial tilt, an atmosphere as a surface density and a
scale height, a geometric albedo, a measured figure where gravity never rounded
the body off, and — for a confirmed exoplanet — a discovery year, a method and
a record of which of its mass and radius were measured rather than inferred.
None of it was on screen.

Writing that panel forced the question the project had not had to answer:
**what does the interface do about the astronomy it does not have?**

Because the list is long, and it is not a list of obscure things. It is
composition. Surface temperature as opposed to equilibrium temperature.
Magnetic field. Atmospheric chemistry. Age. Proper motion. Metallicity. Orbital
resonance. Which constellation a star falls in. Every one of those is on the
first page of a real planetarium's record for Mars, and this build has a value
for none of them.

Two answers were available and the cheap one is wrong.

## Decision

**A field the universe has no value for is drawn as a row, marked _no data_,
carrying the reason.** `Fact.value` is `string | null`; null requires
`pending`, a sentence saying why the field is empty. The panel renders it in a
muted grade with the reason behind a tooltip, and the header counts them —
_12 unmeasured_ on Earth.

**The reason is written in the universe's voice and never in the engine's.**
"No spectrometer has resolved this body's interior" and "the generator does not
produce a composition" are the same fact about the same missing field, and only
the first one may be shown. `packages/devtools/src/dossier.test.ts` greps every
reason on four representative pages for `generator`, `procedural`, `not
modeled`, `this build`, `engine` and `TODO`, and fails on any of them.

## Alternatives rejected

**Omit the row.** The obvious answer, and it is the one that destroys
information. An absent "Atmosphere" row cannot distinguish _this body has no
atmosphere_ from _nobody has measured this body's atmosphere_, and those are
opposite claims about the same world. Mercury and a projected super-Earth
eleven light years away would render identically, and the second is the one the
game is making a promise about.

It also removes the only pressure that keeps the gap visible. A field that is
not on screen is a field nobody remembers is missing; a field that is on screen
saying _no data_ is a specification for the survey that will fill it.

**Show a plausible number.** Rejected without much argument —
[art](../design/art.md) puts composition-adjacent facts on the list of things a
player can check against a catalog, and inventing one is the failure mode the
whole `observed` / `projected` split exists to prevent. A projection is
labelled; a fabrication is not a projection.

**Say "not implemented".** This is the one that took a deliberate decision
rather than a shrug, because it is _true_ and it is what an engineer writes
without noticing.

The planetarium is a reading room for a galaxy that is **there**. A `projected`
world is not a fake world — [galaxy](../design/galaxy.md) is precise about
this: it is "projected from stellar parameters, not confirmed", which is a
statement about the _record_, and it is the same statement a real catalog makes
about a candidate planet. The mode has no ship, no fuel and no discovery
credit, and that is what makes it free to browse; it does not make it a
debugger with a starfield behind it. A row reading "not modeled yet" tells the
reader the sky is a program, and it does so on the one screen whose entire
subject is that the sky is not.

The in-fiction sentence is also the more useful one. "No magnetometer has been
flown through it" says what would have to happen for the field to be filled,
which is both the honest astronomy and, as it happens, the engineering ticket.

## Consequences

**The panel is longer than its data.** Earth's record is about forty rows and a
dozen of them are empty. That is the intended shape: the page is the record a
survey produces, not a dump of what the generator happens to hold.

**Every new field arrives twice.** A fact starts as a `noData` row with a
reason and becomes a value when the data lands. The row's label and its place
in the group do not move, so filling one in is a diff of two lines.

**`pendingCount` is a project metric that is visible in the product.** It goes
down as the universe gets richer, and there is no separate document to keep in
step with it — a list of gaps in `docs/` would be stale within a month.
[planetarium](../design/planetarium.md) § "The record that is not filled in
yet" carries the engineering half: for each field, where the value will come
from. That table is about _sources_ and does go stale; the rows in the panel
are generated from the code that draws them and cannot.

**The voice rule costs a sentence per field and is enforced.** It is easy to
write "the generator does not carry this" at two in the morning, and the test
is what stops it reaching a player. It walks every page this build can produce
— Sol, its 129 bodies, and a projected system with its own — rather than a
hand-listed few, because the population whose reasons are most tempting to
write in the engine's voice is the one the generator invents.

**The test checks the voice and cannot check the truth, and that gap has
already been paid for.** `Published insolation` shipped with the reason "quoted
for a planet whose host star has a measured luminosity. This one's has not" —
printed on Earth, whose star's own page renders 1.000 L☉ two clicks away. It is
in the universe's voice, it names an instrument, it passes the grep, and it is
false about the universe. A reason is a _claim_, and the only thing that
catches a wrong one is somebody reading it beside the rest of the record. Write
them against the body in front of you, not against the branch you are in.

## Related

- [ADR-0009](0009-issue-ordinal-addressing.md) — the other place the record's
  shape is protected from what is convenient today
- [ADR-0013](0013-measured-figures.md) — `figure: null` means _round_, never
  _unknown_; the same distinction, in the data rather than in the panel
- [planetarium](../design/planetarium.md) — the mode, and the list of fields
- [galaxy](../design/galaxy.md) — `observed` and `projected`, and what each claims
- [art](../design/art.md) — where artistic license is granted and where it is not
