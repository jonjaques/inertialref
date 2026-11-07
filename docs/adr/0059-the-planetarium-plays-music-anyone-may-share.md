# ADR-0059: The Planetarium plays a soundtrack of music anyone may share, streamed by range and kept on request

Status: accepted · 6 Nov 2026. Supersedes the music half of
[the audio bible](../design/audio.md#music) for the Planetarium, and its
"licensed library" budget everywhere.

## Context

The audio bible designed music as **sparse cues and mostly absent**: a motif on
a scan resolving, one chord on a discovery, no bed under anything. That is a
design for flight, where the drive through the hull is the soundtrack and the
silence is what makes a cue land. The Planetarium is a different room. It is a
place to sit and look at the sky for an hour, nothing in it makes a sound, and
an hour of nothing is a tab that feels broken rather than authentic. What it
needs is full tracks — playlists, crossfades, credits, a settings panel — with
cues for arrivals left to the runtime.

The bible's budget assumed **a licensed library plus targeted recording**.
[Spike 6](../spikes.md#6--licensed-music-and-spacecraft-audio) read the libraries'
licenses and that assumption does not survive them: Sonniss, Pixabay, ZapSplat,
Mixkit, Uppbeat and the rest permit use _in_ a production and forbid
redistributing the files _as files_, and this repository is public and its site
is static. Anyone can download a track from either. The only licenses that
survive a public repository are the ones that permit redistribution outright:
CC0, the public-domain mark, and CC BY. CC BY-SA was left out, because CC 4.0
§ 1(a) makes music synchronized with moving images an adaptation, and the game
is moving images. So were NC, ND, Content ID registration — a creator's video
of the game would be claimed — and any artist page whose labels disagree.

The survey's picks then failed a second reading. Kevin MacLeod's catalog is
pre-registered in Content ID. A public-domain Satie recording rested on an
uploader's template citing a site FAQ, with the performer an ASCAP member who
sells it. Seven HoliznaCC0 tracks are sold as "non commercial at this price
point" on a second account. Purrple Cat's _Above the Clouds_ is BY-SA on
Bandcamp and BY on the label's site. What remains is fifty-two tracks, 251
minutes: Stellardrone, Chris Zabriskie, Lee Rosevere, Doc & Lena Selyanina,
The Ghost of an Alien, Synth-thetic and brylie as ambient (CC BY and CC0),
HoliznaCC0 and Purrple Cat as lofi (CC0 and CC BY), and one NASA
sonification as signals (public domain).

Then delivery. A soundtrack is 820 MB in two encodings, its longest file is
32.2 MiB, and an `<audio>` element seeks by byte range. **Cloudflare's static
assets ignore `Range`** — measured on production: a ranged GET answers 200 with
the whole body — and refuse any file over 25 MiB. Safari will not play an
`<audio>` source that answers a range with 200. And the masters behind it —
954 MB: FLAC where the licensor offers it, the licensor's own MP3 where it does
not — must be kept, because a delivery file is a lossy encode of a gain change
and is not a source.

## Decision

**The Planetarium plays full-length tracks licensed CC0, public domain, CC BY
3.0 or CC BY 4.0 and nothing else; their masters are kept in Git LFS out of
every default fetch; two loudness-matched encodings are served from R2 through
the Worker, by range; and a listener may keep any of them in a cache that
outlives builds.**

- **The license is a closed set.** `packages/protocol/src/soundtrack.ts` names
  four licenses and the decoder refuses anything else, so a BY-SA, NC or ND
  track is not representable in the catalog, rather than caught by review.
  Every track carries its licensor's credit with the change appended
  ("Modified: level lowered 2.3 dB, re-encoded as AAC and Opus"), printed on
  the card as it starts, on the Soundtrack panel and on `/credits`, and in
  `data/audio/LICENSE.md`. Spacecraft audio ships only when public domain is
  stated, read literally: twelve JPL and University of Iowa recordings are
  held back in `apps/ingest/src/audioSources.ts` with their terms verbatim.
- **The best original each licensor offers, proved.** Lossless where the
  licensor publishes it without a sign-in; a third party's lossless copy only
  after it matches the licensor's own lossy file by waveform correlation at
  the native rate (≥ 0.9985 for every one used). Every master is checked for
  a lossy codec's spectral cliff. The masters are byte-pinned by SHA-256.
- **Masters in LFS, fetched only on purpose.** `data/audio/masters/**` is an
  LFS path and `.lfsconfig` excludes it from every default fetch, so a clone,
  a CI run and a Workers Build never download it.
  `git lfs pull --include='data/audio/masters/**' --exclude=''` does.
- **Two encodings, loudness-matched by gain alone.** AAC-LC at 256 kbit/s
  through AudioToolbox, and Opus at 160 kbit/s in WebM for a browser with no
  AAC decoder (Firefox on Linux without its codecs), each normalized to
  −18 LUFS integrated under a −1 dBTP ceiling by a single gain, dithered. No
  compressor and no limiter: the masters' dynamics
  are the artists'. The spread across the delivered set is 1.9 LU, from 15.5
  across the masters. Each file is named for its content
  (`music/<id>.<sha10>.m4a`), so a name never changes meaning and a cache
  never holds a stale one.
- **Served from R2 by the Worker.** The soundtrack's files are entries in
  `apps/server/src/media.ts`'s allow-list, built from the committed catalog,
  marked `bundled: false`: the build never pulls them into `dist`, and the
  Worker answers each from the bucket with a 206 for a range.
  `pnpm media:push music/` uploads what the bucket does not hold.
- **Two tiers, and the second is the listener's choice.** Online, a track
  streams by range and the browser's HTTP cache keeps what it keeps. A track
  the listener _keeps_ — one, a category, or all of it, with the size beside
  the switch — is downloaded whole into `inertialref-music`, a cache the
  service worker serves 206 slices from and does not clear on a new build.
  Offline, only kept tracks are candidates, and the player says so.
- **One player, beside the canvas, for the session.** Two decks crossfade with
  an equal-power curve; a bus per kind of sound; the music faded out and
  paused under a cutscene's own track, and held 12 dB down while the guide is
  talking; the Media Session for the operating system's controls; resume
  across a reload. It plays in the Planetarium and nowhere else, and `cue()` is the
  hook an arrival will use.

## Alternatives considered

**A licensed library.** The bible's plan. Every library surveyed forbids
standalone redistribution, which a public repository and a static site are.

**CC BY-SA music.** Plentiful, and CC 4.0 treats music synced to moving images
as an adaptation, which would put the share-alike on whatever the game is
judged to be. Held out until somebody decides that in writing.

**Bundling the files as static assets.** One deploy, no bucket. The assets ignore
`Range`, which Safari needs for `<audio>`, refuse files over 25 MiB, and every
build would upload 820 MB.

**One encoding.** AAC alone plays in every browser this game supports but one:
Firefox on a Linux system without its codecs has no AAC decoder, and would
play nothing. The Opus set is 330 MB of bucket and costs nobody else anything:
the player asks each browser which codec it decodes, names the codec in the
question, and takes AAC wherever the answer is `probably`.

**Normalizing with a limiter.** A louder, flatter set, made by shaving the
peaks that are most of what an ambient piece has. Six tracks sit under the
target instead, because the true-peak ceiling caps their gain (the quietest at
−19.8 LUFS), and that is the better failure.

**Caching every track automatically.** Offline by default, and 490 MB taken
from somebody's phone without asking.

**The masters outside the repository.** Smaller clones, and a re-encode would
then depend on a bucket nobody can audit. LFS with a fetch exclusion costs
nothing to anybody who does not ask for them.

## Consequences

- The Planetarium is no longer silent, and the bible's flight design is
  unchanged: flight and the cinema play no soundtrack.
- The catalog is short of the bible's "six cues" for flight, which remain to
  be written or found under the same four licenses.
- A track is added by an entry in `audioSources.ts`, `pnpm audio:fetch`,
  `pnpm audio:build` and `pnpm media:push music/`; the deploy that ships the
  catalog has to follow the push, or the Worker allow-lists a file the bucket
  does not hold and the player skips it as unplayable.
- LFS storage grows by 954 MB of masters. Nothing fetches them by default, so
  bandwidth is spent only by whoever rebuilds the soundtrack.
- Nobody has listened to the set end to end. Loudness, the cliff check and the
  authentication are measurements; whether a track belongs under the sky is
  not, and two CC0-versus-CC BY conflicts ("Love", "Moon Unit") are held for
  that decision.

## Related

- [The audio bible](../design/audio.md) — the silence the rest of the game keeps
- [Spike 6](../spikes.md#6--licensed-music-and-spacecraft-audio) — the survey and the reversals
- [Hosting](../hosting.md) — the bucket, the allow-list and the service worker
- [ADR-0011](0011-application-shell-and-modes.md) — the shell the player lives beside
