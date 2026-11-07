---
paths:
  - 'apps/game/src/audio/**'
  - 'apps/ingest/src/audio*.ts'
  - 'apps/ingest/src/loudness*.ts'
  - 'apps/ingest/src/spectrum*.ts'
  - 'data/audio/**'
  - 'packages/protocol/src/soundtrack*.ts'
  - 'apps/game/public/sw.js'
---

# The soundtrack

Reasoning: [ADR-0059](../../docs/adr/0059-the-planetarium-plays-music-anyone-may-share.md),
[spike 6](../../docs/spikes.md#6--licensed-music-and-spacecraft-audio).

- **Never widen the license set.** CC0, the Public Domain Mark, CC BY 3.0 and 4.0, and
  nothing else: a public repository and a static site redistribute every file they hold.
  No BY-SA, NC, ND, Content ID music, or a work whose pages disagree. A source enters
  `audioSources.ts` with its licensor's statement verbatim, read on the licensor's page.
- **Never bundle it.** Its files are `bundled: false` in `apps/server/src/media.ts` and
  the build strips `dist/media/music`; the static assets ignore `Range` and cap files at
  25 MiB. `pnpm media:push music/` before the deploy that ships a catalog.
- **Never edit `data/audio/` by hand.** `catalog.json`, `manifest.json` and `LICENSE.md`
  are `pnpm audio:build`'s. A delivery file is named for its content's digest, so a
  changed file is a new name and never an overwrite of a key a cache already holds.
- **Gain only.** Every track is moved toward −18 LUFS under −1 dBTP by one gain, measured
  after the encode. No compressor and no limiter; a track the ceiling caps sits under.
- **`soundtrack.ts` reads no preference and no route.** `SoundtrackRuntime.tsx` hands
  the controller its settings, presence and voice, and `soundtrack.test.ts` drives it with
  `fakeAudio.ts`. The player is one module singleton (`soundtrackPlayer()`), never one
  per mount.
