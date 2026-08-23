# Appendix

The decisions taken, the spikes still open, the known gaps, the glossary, and
revision history.

---

## Decisions taken

All twenty-eight open design questions from v0.1 and v0.2 were resolved on
2026-08-19. They are recorded here as decisions, with the reasoning, so that
reopening one is a deliberate act rather than a drift.

### Flight and travel

| Decision                 | Resolution                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Ballistic transfers      | **Cut.** One travel verb is the strength. They only earn a place if in-system fuel is ever tight, and it is not. |
| Burn assist and the flip | **Assist never flips.** It holds the burn vector; the pilot flips every trip, with a cue.                        |
| Jump tunnel              | **Hold-to-skip after the first dozen**, with ~2 s retained for shader pre-warm.                                  |
| Canopy view control      | **Four presets plus hold-to-free-look.** Persistent free-look lives in photo mode.                               |

### Exploration and reward

| Decision                | Resolution                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Probe placement         | **Aimable, with a one-key auto-distribute at ~40% more probes.** Skill optional and rewarded.                         |
| Remote banking          | **The relay beacon** — one-shot, full value, consumed. Manufactured from banked data, so the one-resource rule holds. |
| Session anomaly seeding | **None.** Unfinished business happens naturally or not at all.                                                        |
| Global leaderboard      | **No ranking.** Personal statistics only; per-body attribution stays the social layer.                                |
| Commissions             | **Generated targets, authored voice.** Catalog queries wrapped in institutional correspondence with real personality. |

### Progression and economy

| Decision              | Resolution                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Cost of losing a ship | **Nothing beyond unbanked data.** Unlocks are permanent; refit is minutes.                           |
| Faction standing      | **Kept, minimal.** Permanent institutional specialties, no decay, nothing exclusively gated.         |
| Module damage         | **Two scales** — impact and thermal wear, tracked separately. A worn drive is a maintenance history. |
| Jump range spread     | **~7.7×**, 7.5 → 58 ly (decided in v0.2).                                                            |

### Combat and threat

| Decision                  | Resolution                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Hostile humanoids         | **Environmental threats only through M5.** The largest single scope saving available.                      |
| Matched-burn combat       | **Deferred past M6.** Opponents engage at rest or on maneuver thrust.                                     |
| The Hunter through a jump | **Once, with a visible tell.** Followed once is a story; followed forever is a punishment.                 |
| Rescue                    | **Self-scuttle in solo; distress beacon in the persistent universe.** Degrades gracefully with population. |

### Visual and interface

| Decision    | Resolution                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nebulae     | **Narrowband composite, declared on the canopy, filter selectable.** The license becomes a mechanic.                                                  |
| System map  | **Two tiers of one overlay** — compact for routine targeting (< 200 ms), planning for expeditions.                                                    |
| Pausing     | **Solo modes pause; the persistent universe does not.** Costs nothing architecturally — the host stops calling `advance`, and the clock is untouched. |
| Annunciator | **Synthesised speech, twelve fixed strings.** Nobody is performing; an instrument is annunciating.                                                    |

### World and naming

| Decision                 | Resolution                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hull naming              | **Astronomer class, maritime ship name.** Survey lineage takes astronomers; independent lineage takes maritime working-vessel names, so the convention is information. |
| Wrecks                   | **Recurring motifs, no resolution.** A mystery implies an answer; an answer implies an ending.                                                                         |
| Player naming            | **Filtered free text with a report path online; unfiltered in solo.**                                                                                                  |
| Catalog revision cadence | **Continuous ingest, event-shaped delivery** — revisions arrive on sync as one accumulated notice.                                                                     |

### Business and multiplayer

| Decision                                   | Resolution                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| License                                    | **Apache-2.0.** Write the LICENSE file first; it is the most overdue item in the bible.                                                        |
| PvP consent                                | **Opt-in, off by default.** Fragmentation accepted; there is no economy for PvP to distort.                                                    |
| Catalog version in the persistent universe | **One global version, advanced on an announced schedule.** Solo is the bleeding edge; the shared world is stable and agreed.                   |
| If hosting becomes unaffordable            | **Graceful degradation, published as a promise — and a self-hostable server.** The game does not depend on this project's continued existence. |

---

## The five engineering spikes — run 2026-08-19

Not decisions; measurements. **All five have been run**, and the full write-ups
with method and numbers are in [`docs/spikes.md`](../spikes.md).

| #   | Spike                               | Blocks | Result                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **HDR display detection**           | M2     | ✅ **Negative and useful.** `(dynamic-range: high)` is true on a 2×-headroom laptop panel in Chrome and Safari and false in Firefox, on the _same display_. There is no headroom API. `auto` becomes a WebGPU capability probe; the tone curve must be headroom-agnostic; the three-state override is mandatory. Firefox cannot output extended range at all. → [art](art.md#hdr) |
| 2   | **TSL and the atmosphere integral** | M2     | ✅ **Free.** TSL-generated WGSL runs at **1.000×** hand-written, pixel-identical, in an interleaved same-harness comparison. Take TSL everywhere. Sideways finding: 256 samples/pixel costs 7.27 ms at 1080p on an M5, **2.4× over budget**, so Bruneton LUTs are a requirement rather than an optimization. → [technical](technical.md#the-webgpu-migration)                     |
| 3   | **Catalog bundle size**             | M4     | ✅ **Cheap.** 150 ly = 7,529 stars + 861 planets = **159 KB brotli**, against a 260 KB client. Bundle everything; no streaming boundary needed. The real constraint is **completeness** — HYG holds ~52% of CNS5 within 25 pc. → [galaxy](galaxy.md#measured-the-local-tier-is-cheap)                                                                                             |
| 4   | **Gaia attribution terms**          | M4     | ⚠️ **Reverses a decision.** Gaia is **CC BY-NC 3.0 IGO**, not "open with attribution". Non-commercial is the exact clause this project refuses. Ship HYG + NASA; keep Gaia out of the bundle. The stated fallback was backwards. → [sustainability](sustainability.md#data-licensing-is-the-constraint-that-bites)                                                                |
| 5   | **WebHID / Gamepad for HOTAS**      | M3     | 🟡 **Software yes, hardware outstanding.** WebHID is Chromium-only (Mozilla: negative; WebKit: unshipped). Gamepad API caps at 16 axes / 32 buttons and **silently drops** buttons above HID usage 32. Promise HOTAS _with the browser named_. Dual-device and latency still need real hardware. → [ux](ux.md#what-a-browser-can-actually-do-with-a-hotas)                        |

---

## Known gaps

Named because they are absent rather than decided.

| Gap                              | Note                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cargo and passenger hauling**  | The brief asks for transportation and shipping, and the _Kapteyn_ hull and cargo modules exist for it — but there is no hauling activity designed anywhere in the bible: no contracts, no routes, no reason. It is the most likely candidate for the first activity added after the MVP, and the [planning tier](galaxy.md#the-system-map) of the system map was specified partly with it in mind. |
| **Passenger comfort under burn** | If passengers are hauled, felt g becomes a service constraint as well as a physical one — a hard burn is a bad ride. That is a genuinely interesting mechanic and it is not designed.                                                                                                                                                                                                              |

---

## Playtest values

Numbers written from reasoning, awaiting evidence. Each is tagged `[PLAYTEST]` at
its source.

| Value                             | Written as                          | What the test is                                                                                                                                      |
| --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Burn plan legibility              | One bar, three numbers              | Can a new player read time-against-fuel off it without being told?                                                                                    |
| Direct camera mode                | No interpretation, blown highlights | Does it read as "the hard mode" or "the broken mode"? If players try it once and never return, the fix is a better exposure control, not removing it. |
| Jump range spread                 | 7.5 → 58 ly (~7.7×)                 | Does the early curve leave the cage fast enough?                                                                                                      |
| Time to leave the cage            | 6–10 hours to reach ~18 ly          | The number that actually matters in progression                                                                                                       |
| Jump range mass exponent          | 0.6                                 | Do players ever voluntarily fly empty?                                                                                                                |
| Safe touchdown speed              | ≤ 3.0 m/s                           | May be too tight without a radar altimeter                                                                                                            |
| Time to "can go anywhere"         | 40–60 hours                         | The core pacing target                                                                                                                                |
| ~~Offline catalog cache, 150 ly~~ | ~~~2 MB~~ → **159 KB brotli**       | ✅ Measured, [spike 3](../spikes.md#3--catalog-bundle-size). The estimate was 12× too high                                                            |
| Relay beacon cost                 | 1,200 units                         | High enough to be a decision, low enough to be carried                                                                                                |

---

## Glossary

Terms specific to this design. Engine and architecture terms are in
[`docs/glossary.md`](../glossary.md).

| Term                      | Meaning                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Almanac**               | The player's permanent, local record of every body personally scanned. [exploration](exploration.md#the-almanac)                                                                             |
| **Ballistic transfer**    | An impulse, a long coast on a conic, and a capture burn. Nearly free in fuel, measured in weeks of simulated time. ⬜                                                                        |
| **Brachistochrone**       | The burn profile: accelerate half the distance, flip, decelerate the other half. The fastest transfer under a thrust limit.                                                                  |
| **Burn, the**             | The [micro loop](loops.md#micro-loop--the-burn-27-minutes): plot, burn, flip, burn, arrive, scan                                                                                             |
| **Banking**               | Uploading survey data at a station, converting it from provisional to real. Unbanked data is lost on death.                                                                                  |
| **Catalog revision**      | A published update to the astronomical dataset, delivered in-fiction as a Survey revision. [galaxy](galaxy.md#catalog-revisions)                                                             |
| **Canopy, the**           | The cockpit view. An image composited from hull sensors with gain, integration and a selectable response — not a window. The fiction that grants artistic license without falsifying data.   |
| **Composite**             | The Canopy mode that integrates and tone-maps. The default, and the one the game is art-directed in.                                                                                         |
| **Commission**            | An optional, generated directed goal issued by a research institution                                                                                                                        |
| **Direct**                | The Canopy mode with no interpretation. Blown highlights, crushed shadows, no license.                                                                                                       |
| **Flip, the**             | The mid-burn 180° rotation. ~4 s of freefall. The game's signature moment.                                                                                                                   |
| **Detail scan**           | [Tier 2](exploration.md#tier-2--detail-scan): the scan that converts a projection into a surveyed body                                                                                       |
| **Discovery credit**      | Permanent attribution of a body to the first player to survey and bank it                                                                                                                    |
| **Discovery scan**        | [Tier 1](exploration.md#tier-1--discovery-scan): the system-wide reveal on arrival                                                                                                           |
| **Frontier, the**         | The [meta loop](loops.md#meta-loop--the-frontier-weeks-to-months); also, informally, the edge of surveyed space                                                                              |
| **Ground truth**          | [Tier 4](exploration.md#tier-4--ground-truth): sampling on foot. The highest-value data in the game.                                                                                         |
| **Horizon of knowledge**  | The shell in the galaxy map beyond which catalog completeness collapses and everything is projection                                                                                         |
| **Issue ordinal**         | A body's address index, assigned in the order bodies were _issued_ rather than by orbit. [galaxy](galaxy.md#the-four-rules)                                                                  |
| **Inertial compensation** | The Reference Drive holding the crew near their original frame, so felt g is a fraction of the ship's proper acceleration. Why burns are minutes rather than days.                           |
| **Jump**                  | Discrete re-anchoring between star systems                                                                                                                                                   |
| **Maneuver**             | The low-power band: ordinary Newtonian 6-DoF flight. Compensation is weak here, so it is where g is felt.                                                                                    |
| **Observed**              | A body backed by a published catalog. Drawn solid.                                                                                                                                           |
| **Pips**                  | The six units of reactor allocation across DRIVE, SYS and PAY                                                                                                                                |
| **Projected**             | A generated body, presented in-fiction as the ship's prediction. Drawn dashed.                                                                                                               |
| **Provenance**            | Whether a body is observed, projected or surveyed. Visible everywhere the body appears.                                                                                                      |
| **Transit**               | The high-power band: superluminal coordinate velocity, comfortable felt g, used to cross a system                                                                                            |
| **Ratchet**               | One of the three progression axes: capability, knowledge, standing                                                                                                                           |
| **Reference Drive**       | The ship's drive. Holds the ship near a chosen inertial frame while re-anchoring that frame. Provides maneuver thrust, transit acceleration, inertial compensation and the jump — all four. |
| **Retired**               | A projected body superseded by a confirmed one. Tombstoned, never deleted; its address stays valid forever.                                                                                  |
| **Silent running**        | Radiators off. Near-invisible, and heat has nowhere to go.                                                                                                                                   |
| **Survey, the**           | The in-fiction institution that maintains the catalog and issues revisions                                                                                                                   |
| **Surveyed**              | A body the player has personally detail-scanned                                                                                                                                              |
| **Relay beacon**          | A one-shot transmitter that banks carried data remotely at full value. Manufactured from banked data and consumed on use.                                                                    |
| **Surveyor**              | The player's role. The hull the MVP is balanced around is the _Cannon_-class.                                                                                                                |
| **Thermal wear**          | Slow module degradation from sustained heat. Recovers only partially, and only at refit. A ship's maintenance history.                                                                       |
| **Tombstone**             | The record left by a retired body                                                                                                                                                            |

---

## Revision history

| Version | Date       | Author     | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1     | 2026-08-19 | Jon Jaques | First edition. Written against milestone 1 (12/12 capability checks passing). Establishes the four pillars, the Reference Drive fiction, the three-layer body model and catalog revisions, discovery credit as the economy, the on-foot scoping decision, and **The Explorer** as the named MVP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0.3     | 2026-08-19 | Jon Jaques | **All twenty-eight open design questions resolved** and recorded above as decisions. The consequential ones: ballistic transfers **cut**; burn assist **never performs the flip**; the **relay beacon** replaces a transmit module, manufactured from banked data so the one-resource rule holds; module damage split into **two scales**, impact and thermal wear; catalog revisions **continuous in ingest, event-shaped in delivery**, with the persistent universe pinned to one **globally scheduled** version; hulls renamed to an **astronomer-class / maritime-name** convention that encodes lineage; **Apache-2.0**; **opt-in PvP**; and hosting failure answered with **graceful degradation plus a self-hostable server**. Five engineering spikes remain, and two content gaps are named — cargo and passenger hauling has no design at all.                                                                                                                                             |
| 0.2     | 2026-08-19 | Jon Jaques | Three revisions, each reversing a v0.1 position. **(1) Travel** — the Elite-style cruise mode, in which a gravity gradient throttled top speed and the skill was a throttle correction, is replaced by _The Expanse_-style [brachistochrone burns](flight.md#the-burn): plot, burn, flip, burn. The old fiction had to be told to produce its behavior; a burn produces it from Newton. **(2) Visual direction** — v0.1 treated beauty with suspicion. The [Canopy](art.md#the-canopy-is-a-sensor-not-a-window) is now established as a sensor rather than a window, which grants full artistic license over the _image_ while keeping the _data_ inviolable, and the game targets genuine [HDR output](art.md#hdr). **(3) Progression** — jump range spread revised from 2.2× to **~7.7×**, comparable to Elite, because a large spread changes the character of play rather than merely its speed. Knock-on edits in loops, ships, ux, onfoot, combat, progression, production, technical and risk. |

---

## Related

- [README](README.md) — the index
- [`docs/glossary.md`](../glossary.md) — engine and architecture terms
- [`CONTEXT.md`](../../CONTEXT.md) — the build log
