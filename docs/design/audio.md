# Audio design

Music, effects, and the problem of silence — which in a game set mostly in vacuum
is the central design question rather than an aesthetic one.

---

## The silence problem

Space is silent. A game that honors that is authentic and, handled badly, feels
broken; a game that ignores it sounds like every other space game.

**The resolution: everything you hear is something you could plausibly hear.**
Every sound in the game is one of four kinds, and the player is never asked to
accept a sound with no source.

| Kind            | Heard through                | Examples                                                  |
| --------------- | ---------------------------- | --------------------------------------------------------- |
| **Structural**  | The hull, by conduction      | Thrusters, the reactor, the drive spinning up, an impact  |
| **Atmospheric** | Air, when there is any       | Wind on a surface, the airlock cycling, atmospheric entry |
| **Interior**    | Your own suit or the cockpit | Breathing, gauges, switches, fabric, footfalls            |
| **Interface**   | The ship's own annunciators  | Warnings, scan completion, lock tones                     |

**Vacuum is genuinely silent**, and the transitions across that boundary are the
most important audio moments in the game: the airlock cycling down, the wind
dying, and being left with your own breathing.

Structural conduction is the trick that makes it work. You hear your own drive
because it is bolted to the hull you are sitting in. You do not hear the other
ship's drive at all — you hear it only through your instruments, which is why
[the contacts panel](ships.md#sensors-and-targeting) has a sound and the ship
does not.

---

## Music

**Sparse, ambient, and mostly absent.** Long stretches with none, which is what
makes the moments with it land.

| Game state                          | Music                                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Under burn                          | The drive through the hull — low, industrial, felt more than heard. Under it, sparse tonal pads. The dominant state. |
| The flip                            | **Everything stops.** Four seconds of hull noise and breathing, then the drive relights. The score does not fill it. |
| Arrival in a new system             | A single motif on the discovery scan resolve. Eight seconds. Then silence.                                           |
| Surface, first egress on a new body | A low sustained drone; texture, not melody                                                                           |
| First discovery confirmed           | One chord. Not a fanfare.                                                                                            |
| Combat                              | Percussive, low, and it fades out as soon as the threat resolves — including when the player runs                    |
| Anything else                       | Nothing                                                                                                              |

**Adaptive triggers** are on _state_, not on timers: entering an atmosphere,
falling below a heat threshold, acquiring a lock, completing a scan. There is no
looping combat track and no background music bed.

_Reference:_ the ambient work in _Elite Dangerous_ (Erasmus Talbot) for the
in-space register, and _Outer Wilds_ for the discipline of using very little.
**Not** _No Man's Sky_ — 65daysofstatic's score is excellent and it is
continuously present, which is the opposite decision.

---

## Effects

| Principle                                                 |                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Every mechanic has a sound before it has a UI element** | A player should know the heat is climbing before they look at the gauge                                                   |
| **Warnings are pitched, not loud**                        | Three annunciator tones — advisory, caution, critical — distinguished by pitch and repetition rate, never by volume       |
| **Physical objects have mass in the mix**                 | A sample core set down sounds heavy; in low gravity it sounds heavy and _slow_                                            |
| **The suit is always audible**                            | Breathing, at a rate that tracks exertion and oxygen. It is the on-foot layer's heartbeat and it must never loop audibly. |
| **Nothing is stereo-panned that should not be**           | Sound conducted through the hull comes from everywhere, because it does                                                   |

---

## Voice

**Flight and Survey correspondence have no performed narrator.** The
Planetarium's optional Guide is an explicit exception.

This is a scope decision and a tonal one, and they agree. All
[correspondence](world.md#voice) is text. The Survey communicates by message, not
by radio, which is both cheaper and more consistent with a setting where the
nearest other person is usually several light-years away.

The [Planetarium guide](planetarium.md#the-optional-guide) performs an
explanation when the visitor asks for one or starts a tour. Its delivery can
vary in rhythm and emphasis, and its silence gives the view time to register.
Voice starts with a deliberate action and an AI voice disclosure. Muting the
guide preserves readable explanations; muting the microphone and pausing the
tour remain separate controls.

GPT Live supports conversation and interruptions while automatic tours use
controlled `gpt-4o-mini-tts` clips with `marin`. Live output stays quiet during a
tour clip and its looking pause; the microphone remains available. Speaking
pauses the tour and makes the conversational reply audible. Manual tours use
Next.
Only playback completion for the current view can satisfy the runner's audio
gate. Captions and an estimated duration cannot. Provider access, pronunciation,
device behavior, and listening quality remain measured acceptance work, not
properties established by a model name.

**The ship's annunciator has twelve fixed synthesized strings.**

The annunciator is an instrument and sounds like a machine. Its fixed delivery
is independent of the Planetarium guide's performance.
Real aircraft do this for the same reason it is wanted here: under load, when you
cannot look at a gauge, a spoken word is the fastest channel there is.

The twelve: `life support`, `hull breach`, `thermal critical`, `fuel reserve`,
`drive offline`, `reactor overload`, `pull up`, `terrain`, `collision`,
`lock warning`, `oxygen`, `pressure`. Flat, unhurried, and identical every time.

---

## Budget

The whole audio requirement is roughly **120 effects, 8 ambient beds, 6 music
cues, and 12 annunciator tones**. That is achievable with a licensed library plus
targeted recording, and it is deliberately sized to be one person's work over a
few weeks rather than a discipline.

**Procedural audio is the leverage.** Thruster and drive sound should be
synthesized from actual thrust and RPM state rather than sample-triggered, which
is both cheaper in assets and dramatically better in a game where thrust is
continuously variable. The Web Audio API is well-suited to it and this is one
place the browser is an advantage rather than a constraint.

---

## Related

- [onfoot](onfoot.md#the-suit) — breathing, and the vacuum boundary
- [world](world.md#tone) — why there is no swelling score on arrival
- [technical](technical.md) — Web Audio budget
