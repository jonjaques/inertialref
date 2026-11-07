import type {
  SoundtrackCategory,
  SoundtrackLicense,
} from '@inertialref/protocol'

/*
 * Where every piece of the soundtrack comes from, and on whose word it may be
 * shipped.
 *
 * The textures' discipline, with one more column. A texture's license is a
 * property of an archive; a piece of music's is a statement its licensor made
 * about one release, and licensors change their minds — Kai Engel stepped away
 * from Creative Commons and FreePD.com closed while their pages were still
 * being cited. So each entry carries the statement as the licensor's own page
 * printed it, the day it was read, and an archived copy of that page where one
 * exists. A mirror's label is never the evidence: Internet Archive uploads by
 * third parties label the same Purrple Cat albums BY-ND that the artist
 * publishes as CC BY.
 *
 * ## What may be here
 *
 * The four licenses `SOUNDTRACK_LICENSES` lists, and nothing else: CC0, public
 * domain, CC BY 3.0 and 4.0. Each permits a public repository, a static site
 * and a recorded video of the game with nothing more than a credit. Out, and
 * not representable:
 *
 * - **CC BY-SA**, because CC 4.0 § 1(a) makes music synchronized to moving
 *   images an adaptation, and share-alike would then reach the game's picture.
 * - **Music registered in Content ID**, because a player who streams the game
 *   and leaves the credit out of a description gets a claim. The dispute is
 *   winnable — YouTube bars Creative Commons material from being a reference —
 *   but the player should not have to file it.
 * - **Releases whose own pages disagree** on a material term, until the artist
 *   settles it.
 * - NC, ND, and every library whose terms forbid standalone redistribution,
 *   which a public repository breaks by existing.
 *
 * `docs/spikes.md` § 6 is the survey these verdicts come from.
 *
 * ## The file
 *
 * `url` is the best copy the licensor offers openly: lossless where it can be
 * downloaded without an account, an email address or a payment, otherwise the
 * highest-bitrate original. A lossless master that sits behind one of those is
 * named in `gated`, for a person to fetch by hand; the pipeline never fills in
 * a form. `sha256` pins the bytes, so a re-fetch that returns a different file
 * fails rather than quietly re-mastering the soundtrack.
 */

export interface AudioSource {
  /** Stable across a retitle; the catalog and the player's preferences key on it. */
  readonly id: string
  readonly title: string
  /** The name the licensor publishes under. */
  readonly artist: string
  /** Who played it, for a recording of an older work. */
  readonly performer?: string
  readonly release: string
  readonly year: number
  readonly category: SoundtrackCategory
  readonly license: SoundtrackLicense
  /** The licensor's own page for this release: where the license was read. */
  readonly licensor: string
  /** The license as that page states it, verbatim. */
  readonly statement: string
  /** The day the statement was read, ISO 8601. */
  readonly checked: string
  /** An archived copy of the licensor's page, or null when none exists. */
  readonly snapshot: string | null
  /** The file this master was downloaded from. */
  readonly url: string
  /** Who serves `url`, and why that copy is the licensor's work. */
  readonly channel: string
  /** The master's filename under `data/audio/masters/`. */
  readonly master: string
  /** SHA-256 of the master as downloaded. */
  readonly sha256: string
  /**
   * The attribution, without the modification notice the pipeline appends.
   * In the form the licensor asks for where they ask for one.
   */
  readonly credit: string
  /** A lossless master that exists behind a sign-in, a form or a payment. */
  readonly gated?: string
  /**
   * How a copy that is not the licensor's own was shown to be the licensor's
   * recording: its correlation with, and residual against, a lossy file the
   * licensor published. `.scratch` holds the comparison; the figures are here.
   */
  readonly verified?: string
  /**
   * The master is not the downloaded file but something taken out of it
   * without re-encoding — a published video's audio stream. `sha256` is the
   * master's; this is the published file's, and what was done to it.
   */
  readonly derivedFrom?: { readonly sha256: string; readonly how: string }
  /**
   * Captured, and not shipped: in the archive and the manifest, never encoded
   * or listed in the catalog the game plays. The reason, for whoever lifts it.
   */
  readonly held?: string
  /** Anything a later reader needs to know about this entry. */
  readonly note?: string
}

/**
 * Spacecraft audio the survey found and the soundtrack does not ship yet,
 * with the terms that would govern it.
 *
 * Not public domain, which is the bar the soundtrack's spacecraft category
 * holds to. Recorded here so that adding one later is an entry in
 * `AUDIO_SOURCES` and a credit, rather than a second survey.
 */
export interface HeldBack {
  readonly id: string
  readonly title: string
  /** Who made it, with the affiliation that decides its status. */
  readonly producer: string
  /** The terms, verbatim. */
  readonly terms: string
  readonly termsUrl: string
  /** Where the recording is published, and where its terms were read. */
  readonly page: string
  /** The credit those terms ask for, or null where the page gives none. */
  readonly credit: string | null
  /** Why it is not public domain. */
  readonly why: string
  /** The best file the survey found. */
  readonly url: string
}

/* ------------------------------------------------------------------------- */
/* Releases                                                                   */
/* ------------------------------------------------------------------------- */

/** What one release says of all its tracks; a track adds its file. */
interface Release extends Omit<
  AudioSource,
  'id' | 'title' | 'url' | 'master' | 'sha256' | 'credit' | 'statement'
> {
  readonly statement: string | ((title: string) => string)
  readonly credit: (title: string) => string
}

type TrackFields = Pick<AudioSource, 'url' | 'master' | 'sha256'> &
  Partial<Omit<AudioSource, 'id' | 'title'>>

const release =
  (base: Release) =>
  (id: string, title: string, fields: TrackFields): AudioSource => ({
    ...base,
    statement:
      typeof base.statement === 'string'
        ? base.statement
        : base.statement(title),
    credit: base.credit(title),
    id,
    title,
    ...fields,
  })

/** The day every statement below was read on its licensor's page. */
const CHECKED = '2026-11-06'

/*
 * Stellardrone. His Bandcamp states the license on every release, and the
 * history is longer than the page: the artist published his early albums
 * BY-NC-ND 3.0 on the Internet Archive (2009–2011), his label Energostatic did
 * the same for *Light Years* (2013), and the Bandcamp block linked BY 3.0
 * until at least December 2024. A Creative Commons grant cannot be withdrawn,
 * and the one relied on here is the broadest he has made: CC BY 4.0, today, on
 * his own page. Energostatic no longer exists.
 */
const stellardrone = (
  album: string,
  year: number,
  slug: string,
  snapshot: string,
  channel: string,
): Release => ({
  artist: 'Stellardrone',
  release: album,
  year,
  category: 'ambient',
  license: 'cc-by-4.0',
  licensor: `https://stellardrone.bandcamp.com/album/${slug}`,
  statement:
    'Bandcamp license block: “some rights reserved”, linking https://creativecommons.org/licenses/by/4.0/; the artist’s bio on the same page: “Releasing all albums for free and promoting free sharing of digital copies. (CC BY 4.0)”',
  checked: CHECKED,
  snapshot,
  channel,
  credit: (title) =>
    `“${title}” by Stellardrone, from ${album} (${year}). CC BY 4.0. stellardrone.bandcamp.com`,
  note: 'First published BY-NC-ND 3.0; see the comment above the Stellardrone releases in apps/ingest/src/audioSources.ts.',
})

const ARTIST_UPLOAD = (item: string): string =>
  `Internet Archive item ${item}, uploaded by the artist: the archive’s own lossless FLAC of his WAV original`

const lightYears = release(
  stellardrone(
    'Light Years',
    2013,
    'light-years',
    'http://web.archive.org/web/20261019183917/https://stellardrone.bandcamp.com/album/light-years',
    'Internet Archive item Stellardrone-LightYears, a collector’s upload of the album’s FLAC. Each file was matched against the label’s own 320 kbps MP3 (item stasis017, uploaded by Energostatic Records); `verified` has the figures',
  ),
)
const invent = release(
  stellardrone(
    'Invent the Universe',
    2010,
    'invent-the-universe',
    'http://web.archive.org/web/20261019202013/https://stellardrone.bandcamp.com/album/invent-the-universe',
    ARTIST_UPLOAD('Stellardrone-InventTheUniverse'),
  ),
)
const beamOfLight = release(
  stellardrone(
    'On A Beam Of Light',
    2009,
    'on-a-beam-of-light',
    'http://web.archive.org/web/20261019170434/https://stellardrone.bandcamp.com/album/on-a-beam-of-light',
    ARTIST_UPLOAD('OnABeamOfLight'),
  ),
)
const sublime = release(
  stellardrone(
    'Sublime',
    2010,
    'sublime',
    'http://web.archive.org/web/20261019180637/https://stellardrone.bandcamp.com/album/sublime',
    ARTIST_UPLOAD('Stellardrone-Sublime'),
  ),
)
const stillness = release(
  stellardrone(
    'A Moment Of Stillness',
    2011,
    'a-moment-of-stillness',
    'http://web.archive.org/web/20261019202858/https://stellardrone.bandcamp.com/album/a-moment-of-stillness',
    ARTIST_UPLOAD('AMomentOfStillness'),
  ),
)

const cylinders = release({
  artist: 'Chris Zabriskie',
  release: 'Cylinders',
  year: 2014,
  category: 'ambient',
  license: 'cc-by-4.0',
  licensor: 'https://chriszabriskie.com/cylinders/',
  statement:
    '“All of my music is free to use in creative projects under the Creative Commons Attribution 4.0 license.” (https://chriszabriskie.com/use/); the album page: “The songs on this album are free to use in creative projects under a Creative Commons Attribution license.”, with the JSON-LD license https://creativecommons.org/licenses/by/4.0/',
  checked: CHECKED,
  snapshot:
    'http://web.archive.org/web/20261027061638/https://chriszabriskie.com/cylinders/',
  channel:
    'Internet Archive item chris-zabriskie-complete-discography, a collector’s upload of the album’s FLAC. Each file was matched against the artist’s own AAC on audio.chriszabriskie.com; `verified` has the figures',
  // The five lines his /use/ page asks for, as one sentence.
  credit: (title) =>
    `“${title}” by Chris Zabriskie. From the album Cylinders. Licensed under Creative Commons Attribution 4.0 (creativecommons.org/licenses/by/4.0/). chriszabriskie.com`,
  gated: 'His own FLAC, through Bandcamp’s name-your-price download.',
  note: 'On claims: “If you receive a copyright claim on my music, it did not come from me. Please contact me right away.”',
})

const dustTimeGravity = release({
  artist: 'The Ghost of an Alien',
  release: 'Dust. Time.. Gravity',
  year: 2016,
  category: 'ambient',
  license: 'cc-by-4.0',
  licensor: 'https://archive.org/details/Dust-Time-Gravity',
  statement:
    'Item page: “Usage Attribution 4.0 International”, linking http://creativecommons.org/licenses/by/4.0/',
  checked: CHECKED,
  snapshot: null,
  channel:
    'Internet Archive item Dust-Time-Gravity, uploaded by the label, Vacant Twelve, which is the artist’s own: the original FLAC',
  credit: (title) =>
    `“${title}” by The Ghost of an Alien, from Dust. Time.. Gravity (Vacant Twelve, 2016). CC BY 4.0.`,
})

const openGameArtCc0 = release({
  artist: 'Synth-thetic',
  release: 'OpenGameArt',
  year: 2026,
  category: 'ambient',
  license: 'cc0',
  licensor: 'https://opengameart.org/users/synth-thetic',
  statement:
    '“License(s): CC0”; “CC0 / Public Domain. No Rights Reserved. Free to use however you like with no attribution required.”',
  checked: CHECKED,
  snapshot: null,
  channel: 'OpenGameArt, the author’s own submission: FLAC, 24-bit 48 kHz',
  credit: (title) => `“${title}” by Synth-thetic (opengameart.org). CC0.`,
})

const podcastsAmbient = release({
  artist: 'Lee Rosevere',
  release: 'Music For Podcasts – Ambient',
  year: 2023,
  category: 'ambient',
  license: 'cc-by-4.0',
  licensor:
    'https://freemusicarchive.org/music/lee-rosevere/music-for-podcasts-ambient/',
  statement: (title) =>
    `${title} by Lee Rosevere is licensed under a Attribution 4.0 International License.`,
  checked: CHECKED,
  snapshot:
    'http://web.archive.org/web/20261031183152/https://freemusicarchive.org/music/lee-rosevere/music-for-podcasts-ambient',
  channel:
    'Free Music Archive: the file its player streams, 320 kbps MP3. Its Download button needs a sign-in',
  credit: (title) =>
    `“${title}” by Lee Rosevere, from Music For Podcasts – Ambient (2023). CC BY 4.0. freemusicarchive.org`,
  note: 'No statement about Content ID either way was found on his pages.',
})

const MUSICTRADE =
  'Internet Archive item uploaded by the label, Musictrade: its own VBR MP3 (LAME, --alt-preset extreme)'

const cosmicLullabies = release({
  artist: 'Doc & Lena Selyanina',
  release: 'Cosmic Lullabies',
  year: 2008,
  category: 'ambient',
  license: 'cc-by-3.0',
  licensor: 'https://archive.org/details/mt018',
  statement:
    'Item page: “Usage Attribution 3.0”; the label’s own MP3 tag: “Released on 23rd January 2008 under Creative Commons 3.0 Attribution License.”',
  checked: CHECKED,
  snapshot: null,
  channel: MUSICTRADE,
  credit: (title) =>
    `“${title}” by Doc & Lena Selyanina, from Cosmic Lullabies (Musictrade MT018, 2008). CC BY 3.0.`,
  gated: 'The label released 24-bit FLAC by torrent only; not pursued.',
})

const songsOfVastness = release({
  artist: 'Doc & Lena Selyanina',
  release: 'Songs of Vastness',
  year: 2010,
  category: 'ambient',
  license: 'cc-by-3.0',
  licensor: 'https://archive.org/details/DocLenaSelyanina-SongsOfVastnessmt027',
  statement:
    'Item metadata: license http://creativecommons.org/licenses/by/3.0/, on the label’s own upload',
  checked: CHECKED,
  snapshot: null,
  channel: MUSICTRADE,
  credit: (title) =>
    `“${title}” by Doc & Lena Selyanina, from Songs of Vastness (Musictrade MT027, 2010). CC BY 3.0.`,
  note: 'The label calls it “a meditative space ambient track”.',
})

const openGameArtBrylie = release({
  artist: 'brylie',
  release: 'OpenGameArt',
  year: 2021,
  category: 'ambient',
  license: 'cc-by-4.0',
  licensor: 'https://opengameart.org/users/brylie',
  statement:
    '“License(s): CC-BY 4.0”; the artist’s Bandcamp links https://creativecommons.org/licenses/by/4.0/ for the same recording',
  checked: CHECKED,
  snapshot: null,
  channel:
    'OpenGameArt, the author’s own submission (Brylie Christopher Oxley): FLAC',
  credit: (title) =>
    `“${title}” by brylie (Brylie Christopher Oxley). CC BY 4.0. opengameart.org`,
})

/*
 * HoliznaCC0. FMA says CC0 on every page; his Bandcamp, which offers nothing
 * more permissive than CC BY, badges the same recordings CC BY 4.0, and a
 * second, "royalty free" account sells some of them with a bio that says
 * "you can only use in non commercial projects at this price point". That
 * last is a material disagreement, so nothing it sells is here: every track
 * below is on FMA alone, or on FMA and nowhere that says otherwise.
 */
const holizna = (album: string, year: number, snapshot: string): Release => ({
  artist: 'HoliznaCC0',
  release: album,
  year,
  category: 'lofi',
  license: 'cc0',
  licensor: 'https://freemusicarchive.org/music/holiznacc0/',
  statement: (title) =>
    `${title} by HoliznaCC0 is licensed under a CC0 1.0 Universal License.`,
  checked: CHECKED,
  snapshot,
  channel:
    'Free Music Archive: the file its player streams, about 320 kbps MP3. Its Download button needs a sign-in',
  credit: (title) => `“${title}” by HoliznaCC0, from ${album} (${year}). CC0.`,
})

const lullabies = release(
  holizna(
    'Lullabies For The End Of The World',
    2026,
    'http://web.archive.org/web/20260827224619/https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/',
  ),
)
const milkyWay1 = release(
  holizna(
    'Only In The Milky Way Part 1',
    2022,
    'http://web.archive.org/web/20240914124651/https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-1',
  ),
)
const milkyWay2 = release(
  holizna(
    'Only In The Milky Way Part 2',
    2022,
    'http://web.archive.org/web/20240914124646/https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-2',
  ),
)
const milkyWay3 = release(
  holizna(
    'Only In The Milky Way Part 3',
    2022,
    'http://web.archive.org/web/20240914125049/https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-3',
  ),
)
const publicDomainLofi = release(
  holizna(
    'Public Domain Lofi',
    2024,
    'http://web.archive.org/web/20261010050223/https://freemusicarchive.org/music/holiznacc0/public-domain-lofi',
  ),
)

/*
 * Purrple Cat. freelofi.com is his own site, and for the records below it is
 * the only page that states a license, or every page he controls states the
 * same one. His Bandcamp labels most other records BY-SA, including *Above
 * the Clouds*, which is why its "Nocturne" is not here.
 */
const FREELOFI =
  'freelofi.com, the artist’s own site: “CC BY 4.0”, “No Content ID”, “Credit is the only price”; the record’s schema.org license is https://creativecommons.org/licenses/by/4.0/'

const purrpleCat = (album: string, year: number, slug: string): Release => ({
  artist: 'Purrple Cat',
  release: album,
  year,
  category: 'lofi',
  license: 'cc-by-4.0',
  licensor: `https://freelofi.com/albums/${slug}/`,
  statement: FREELOFI,
  checked: CHECKED,
  snapshot: null,
  channel:
    'purrplecat-audio.pages.dev, the file host behind freelofi.com: 192 kbps MP3, the only format it serves',
  credit: (title) =>
    `“${title}” by Purrple Cat, from ${album} (${year}). CC BY 4.0. freelofi.com`,
})

const sleepTight = release(purrpleCat('Sleep Tight', 2025, 'sleep-tight'))
const cityNights3 = release(purrpleCat('City Nights 3', 2026, 'city-nights-3'))
const memories = release(purrpleCat('Memories', 2025, 'memories'))
const whispersInTheDark = release({
  ...purrpleCat('Whispers in the Dark', 2019, 'whispers-in-the-dark'),
  statement: `${FREELOFI}; FMA: “Whispers In The Dark by Purrple Cat is licensed under a Attribution 4.0 International License.”; his own Internet Archive item: “Usage Attribution 4.0 International”`,
  channel:
    'Internet Archive item purrplecat-whispers-in-the-dark, uploaded by the artist: byte-identical to the file FMA streams',
})

/*
 * Signals: spacecraft audio, and only what is public domain. Not music, and
 * a category the playlist starts with switched off.
 */
const svs = release({
  artist: 'Parker Solar Probe · FIELDS',
  release: 'NASA Scientific Visualization Studio 13847',
  year: 2021,
  category: 'signals',
  license: 'public-domain',
  licensor: 'https://svs.gsfc.nasa.gov/13847/',
  statement:
    '“All of our content is in the public domain (unless otherwise noted), meaning that it is free to download, use, and redistribute for whatever purposes you see fit.” (https://svs.gsfc.nasa.gov/help/). The item credits no music or other licensed content.',
  checked: CHECKED,
  snapshot:
    'http://web.archive.org/web/20260511142130/https://svs.gsfc.nasa.gov/13847/',
  channel:
    'NASA SVS: the visualization’s 1080p MP4. The master is its audio stream, copied out without re-encoding',
  credit: () =>
    'Parker Solar Probe’s FIELDS instrument at Venus, July 2020; sonified by NASA’s Scientific Visualization Studio. Public domain.',
})

const cdaweb = release({
  artist: 'Parker Solar Probe · FIELDS',
  release: 'NASA CDAWeb audification',
  year: 2020,
  category: 'signals',
  license: 'cc0',
  licensor: 'https://cdaweb.gsfc.nasa.gov/audification_examples/',
  statement:
    '“Unless otherwise noted, the content, data, documentation, code, and related materials associated with HDRL, SDAC, and SPDF and its services is public domain and made available with a Creative Commons Zero (CC0) dedication.” (https://spdf.gsfc.nasa.gov/data_use_policy.html)',
  checked: CHECKED,
  snapshot:
    'http://web.archive.org/web/20251121163348/https://cdaweb.gsfc.nasa.gov/audification_examples/',
  channel:
    'NASA Goddard’s Space Physics Data Facility: CDAWeb’s own audification example, a 22 kHz WAV',
  credit: (title) =>
    `${title}: Parker Solar Probe FIELDS magnetometer, 29 January 2020, audified by NASA’s Space Physics Data Facility (CDAWeb). Data: S. D. Bale, UC Berkeley Space Sciences Laboratory. CC0.`,
  note: 'Four hours of ion-scale cyclotron waves near the Sun, played back as sound.',
})

const shuttleCabin = release({
  artist: 'NASA',
  release: 'NASA Audio Highlight Reels',
  year: 2011,
  category: 'signals',
  license: 'public-domain',
  licensor: 'https://archive.org/details/NasaAudioHighlightReels',
  statement:
    'Item metadata: license http://creativecommons.org/publicdomain/mark/1.0/ (“Usage Public Domain Mark 1.0”), uploaded by a nasa.gov account and crediting the Houston Audio Control Room at JSC',
  checked: CHECKED,
  snapshot: null,
  channel:
    'Internet Archive item NasaAudioHighlightReels, uploaded by NASA: the archive’s lossless FLAC of the 24-bit WAV original',
  credit: () =>
    'A Space Shuttle launch recorded in the cabin. NASA, Houston Audio Control Room. Public domain.',
})

export const AUDIO_SOURCES: readonly AudioSource[] = [
  lightYears('stellardrone-red-giant', 'Red Giant', {
    url: 'https://archive.org/download/Stellardrone-LightYears/Stellardrone%20-%20Light%20Years%20-%2001%20Red%20Giant.flac',
    master: 'stellardrone-red-giant.flac',
    sha256: '7c5a1d4a0b11527d24a419b5cb5a2a0de35efc812912c03de5dbf0bb3a619c8d',
    verified:
      'correlation 0.999996, residual −51.0 dB against 01_red_giant.mp3',
  }),
  lightYears('stellardrone-airglow', 'Airglow', {
    url: 'https://archive.org/download/Stellardrone-LightYears/Stellardrone%20-%20Light%20Years%20-%2002%20Airglow.flac',
    master: 'stellardrone-airglow.flac',
    sha256: '6ce2ad85232ba778a5732e6b9320fe1d38bd6eed18a49e592949414154b8aca0',
    verified: 'correlation 0.999973, residual −42.6 dB against 02_airglow.mp3',
  }),
  lightYears('stellardrone-comet-halley', 'Comet Halley', {
    url: 'https://archive.org/download/Stellardrone-LightYears/Stellardrone%20-%20Light%20Years%20-%2007%20Comet%20Halley.flac',
    master: 'stellardrone-comet-halley.flac',
    sha256: '9f5cf366d5ad5374693a37d8ec0b7b9a6ed9c6bcb345d5bb9449886af072ce72',
    verified:
      'correlation 0.999842, residual −35.0 dB against 07_comet_halley.mp3',
  }),
  lightYears('stellardrone-ultra-deep-field', 'Ultra Deep Field', {
    url: 'https://archive.org/download/Stellardrone-LightYears/Stellardrone%20-%20Light%20Years%20-%2008%20Ultra%20Deep%20Field.flac',
    master: 'stellardrone-ultra-deep-field.flac',
    sha256: '9b4dc3f636dd6bb9733fd3a3dc217ee7255c3d8f60e85e59abd2b659e82b31f0',
    verified:
      'correlation 1.000000, residual −63.1 dB against 08_ultra_deep_field.mp3',
  }),
  lightYears('stellardrone-messier-45', 'Messier 45', {
    url: 'https://archive.org/download/Stellardrone-LightYears/Stellardrone%20-%20Light%20Years%20-%2010%20Messier%2045.flac',
    master: 'stellardrone-messier-45.flac',
    sha256: '5db0b080297e53ca20ffb8637335a719b07dc521c616359bfe05bc2a58183a95',
    verified:
      'correlation 0.999999, residual −57.0 dB against 10_messier_45.mp3',
  }),
  invent('stellardrone-the-belt-of-orion', 'The Belt of Orion', {
    url: 'https://archive.org/download/Stellardrone-InventTheUniverse/Stellardrone-01-TheBeltOfOrion.flac',
    master: 'stellardrone-the-belt-of-orion.flac',
    sha256: '68e12fd9135e21125ff7d895b0f21950a91e61d0676f8e54e0c5c2c0e7c139fb',
  }),
  invent(
    'stellardrone-approaching-the-heliopause',
    'Approaching the Heliopause',
    {
      url: 'https://archive.org/download/Stellardrone-InventTheUniverse/Stellardrone-04-ApproachingTheHeliopause.flac',
      master: 'stellardrone-approaching-the-heliopause.flac',
      sha256:
        '13c9794f7935ed14e8006d365326328b12d9dd130a0130301023c97635fc5dca',
    },
  ),
  invent('stellardrone-pale-blue-dot', 'Pale Blue Dot', {
    url: 'https://archive.org/download/Stellardrone-InventTheUniverse/Stellardrone-06-PaleBlueDot.flac',
    master: 'stellardrone-pale-blue-dot.flac',
    sha256: 'aa98849171220081e0c595307b4fdcea2e1b68000e53b1d74ceea949a580281d',
  }),
  beamOfLight('stellardrone-the-earth-is-blue', 'The Earth Is Blue', {
    url: 'https://archive.org/download/OnABeamOfLight/Stellardrone-02-TheEarthIsBlue.flac',
    master: 'stellardrone-the-earth-is-blue.flac',
    sha256: '45e8aa15c63a759dbb4a20970ba6fee1750a96303e9ebc5659204c526d16f31c',
  }),
  beamOfLight('stellardrone-fermi-paradox', 'Fermi Paradox', {
    url: 'https://archive.org/download/OnABeamOfLight/Stellardrone-07-FermiParadox.flac',
    master: 'stellardrone-fermi-paradox.flac',
    sha256: '3e1acb28b145c0b091b854301d8e459bb89a397259204e5bc11f9186cca9996c',
  }),
  sublime('stellardrone-cosmic-sunrise', 'Cosmic Sunrise', {
    url: 'https://archive.org/download/Stellardrone-Sublime/Stellardrone-03-CosmicSunrise.flac',
    master: 'stellardrone-cosmic-sunrise.flac',
    sha256: '5504360e99c713f4cfb3019c0ec5f9b83e444785d4ff260787efd7dbe8063a7e',
  }),
  sublime('stellardrone-milky-way', 'Milky Way', {
    url: 'https://archive.org/download/Stellardrone-Sublime/Stellardrone-04-MilkyWay.flac',
    master: 'stellardrone-milky-way.flac',
    sha256: 'd234d77914e3ad0c72cac303c450151cc16b429c422f3f1b976566d6ef86c186',
  }),
  stillness('stellardrone-billions-and-billions', 'Billions and Billions', {
    url: 'https://archive.org/download/AMomentOfStillness/Stellardrone-02-BillionsAndBillions.flac',
    master: 'stellardrone-billions-and-billions.flac',
    sha256: '0ac7e5d9b8749b8adb6790c19d54fa95cb15118b4d59064b1bda1f7300217099',
  }),
  cylinders('chris-zabriskie-cylinder-one', 'Cylinder One', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2001%20Cylinder%20One.flac',
    master: 'chris-zabriskie-cylinder-one.flac',
    sha256: 'f4a7eacdcc0be1886cf42b37d141795cf8088dcc4747ac8a4d7c8d154c8ded91',
    verified:
      'correlation 0.999903, residual −37.1 dB against cylinders-01.m4a',
  }),
  cylinders('chris-zabriskie-cylinder-two', 'Cylinder Two', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2002%20Cylinder%20Two.flac',
    master: 'chris-zabriskie-cylinder-two.flac',
    sha256: '5804515ce564a41a10fae347a9065e001411fca9e8476c583d5089319b01bbe5',
    verified:
      'correlation 0.999827, residual −34.6 dB against cylinders-02.m4a',
  }),
  cylinders('chris-zabriskie-cylinder-four', 'Cylinder Four', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2004%20Cylinder%20Four.flac',
    master: 'chris-zabriskie-cylinder-four.flac',
    sha256: '66a99310755645bf6d90e6ea25f0e227092b3b87d28abfb84b328d877759db6f',
    verified:
      'correlation 0.999967, residual −41.8 dB against cylinders-04.m4a',
  }),
  cylinders('chris-zabriskie-cylinder-five', 'Cylinder Five', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2005%20Cylinder%20Five.flac',
    master: 'chris-zabriskie-cylinder-five.flac',
    sha256: 'b58d17d40dd7e261cfa340956d5f35d20489880a5fec4e1acca1969286447a87',
    verified:
      'correlation 0.999935, residual −38.9 dB against cylinders-05.m4a',
  }),
  cylinders('chris-zabriskie-cylinder-seven', 'Cylinder Seven', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2007%20Cylinder%20Seven.flac',
    master: 'chris-zabriskie-cylinder-seven.flac',
    sha256: '91aa9453b72e141b7fc4fff5cd6feb6fbe65ef30a3f44471a8085dd78f1ce869',
    verified:
      'correlation 0.998892, residual −26.6 dB against cylinders-07.m4a',
  }),
  cylinders('chris-zabriskie-cylinder-eight', 'Cylinder Eight', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2008%20Cylinder%20Eight.flac',
    master: 'chris-zabriskie-cylinder-eight.flac',
    sha256: 'df9ee99003b9003a188c190a4d4f293c531e7837616405296da847aaa3789ba7',
    verified:
      'correlation 0.998554, residual −25.4 dB against cylinders-08.m4a',
  }),
  cylinders('chris-zabriskie-cylinder-nine', 'Cylinder Nine', {
    url: 'https://archive.org/download/chris-zabriskie-complete-discography/Chris%20Zabriskie%20-%20Cylinders/Chris%20Zabriskie%20-%20Cylinders%20-%2009%20Cylinder%20Nine.flac',
    master: 'chris-zabriskie-cylinder-nine.flac',
    sha256: 'da26fc210472ff46f1f67f73eeafe4863d78fdf6b93c73d613253fbac2e8a992',
    verified:
      'correlation 0.999375, residual −29.0 dB against cylinders-09.m4a',
  }),
  dustTimeGravity(
    'the-ghost-of-an-alien-always-looking-up',
    'Always Looking Up',
    {
      url: 'https://archive.org/download/Dust-Time-Gravity/06%20-%20Always%20Looking%20Up.flac',
      master: 'the-ghost-of-an-alien-always-looking-up.flac',
      sha256:
        'de9ba98041f2e484dd651bf9243dbd10df25bca2374b4788d05cf82bec8a0eeb',
    },
  ),
  dustTimeGravity(
    'the-ghost-of-an-alien-polar-distance-displaced',
    'Polar Distance Displaced',
    {
      url: 'https://archive.org/download/Dust-Time-Gravity/04%20-%20Polar%20Distance%20Displaced.flac',
      master: 'the-ghost-of-an-alien-polar-distance-displaced.flac',
      sha256:
        '52ed448fdd05ee90431325e2f4d3eda89c6fa6e1e81338254cfd14fc9251ff34',
    },
  ),
  dustTimeGravity(
    'the-ghost-of-an-alien-drifting-further-and-further',
    'Drifting Further And Further',
    {
      url: 'https://archive.org/download/Dust-Time-Gravity/07%20-%20Drifting%20Further%20And%20Further.flac',
      master: 'the-ghost-of-an-alien-drifting-further-and-further.flac',
      sha256:
        'd8ee2e2b7db1960facea1ead1fc27f4dba654aef447bbd665fa95d48e5f30ae1',
    },
  ),
  openGameArtCc0('synth-thetic-cosmic-navigation', 'Cosmic Navigation', {
    url: 'https://opengameart.org/sites/default/files/cosmic_navigation.flac',
    master: 'synth-thetic-cosmic-navigation.flac',
    sha256: '16cb8764aed637306a7e3d8f911c748ce70f7d2b954beebf2cad3d21d5887661',
    year: 2026,
    licensor: 'https://opengameart.org/content/cosmic-navigation',
    snapshot:
      'http://web.archive.org/web/20260830075249/https://opengameart.org/content/cosmic-navigation',
    note: 'The full version. The page also offers a seamless loop of it, which a playlist does not need.',
  }),
  openGameArtCc0('synth-thetic-steller-dreams', 'Steller Dreams', {
    url: 'https://opengameart.org/sites/default/files/steller_dreams.flac',
    master: 'synth-thetic-steller-dreams.flac',
    sha256: 'dc8a1f0e494b84b6b2124ed66201dfc353b4121c234473db43b6fa7df43f8d88',
    year: 2025,
    licensor: 'https://opengameart.org/content/steller-dreams',
    snapshot: null,
    note: "The title is the author's spelling.",
  }),
  podcastsAmbient(
    'lee-rosevere-how-i-used-to-see-the-stars',
    'How I Used To See The Stars',
    {
      url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/eEYSeYrvxmNBOn3pjtVTDKSOb2q42FmporS3JT9e.mp3',
      master: 'lee-rosevere-how-i-used-to-see-the-stars.mp3',
      sha256:
        'bc7fb9ba5b7bac44fa5f24a12bd1754aaca1761c54ded520f1d730f1c0d54ca3',
      licensor:
        'https://freemusicarchive.org/music/lee-rosevere/music-for-podcasts-ambient/how-i-used-to-see-the-stars/',
      statement:
        'How I Used To See The Stars by Lee Rosevere is licensed under a Attribution 4.0 International License.',
    },
  ),
  podcastsAmbient('lee-rosevere-universe-calling', 'Universe Calling', {
    url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/o4BD6iHmcVhLvdC4fvjYIIFH0uWC4kgEPIeCiSLg.mp3',
    master: 'lee-rosevere-universe-calling.mp3',
    sha256: '887870f68826c64599ea48ea433a1dbba8e4e53e1970eb4bc0f7f0555c5d2586',
    licensor:
      'https://freemusicarchive.org/music/lee-rosevere/music-for-podcasts-ambient/universe-calling/',
    statement:
      'Universe Calling by Lee Rosevere is licensed under a Attribution 4.0 International License.',
  }),
  cosmicLullabies('doc-and-lena-selyanina-neptune', 'Neptune', {
    url: 'https://archive.org/download/mt018/02_-_Neptune.mp3',
    master: 'doc-and-lena-selyanina-neptune.mp3',
    sha256: '8106311d37f32aa2d3bb2f444a104895ec202586efdb67053e7faec8ad7de3e7',
  }),
  songsOfVastness('doc-and-lena-selyanina-mir', 'Mir', {
    url: 'https://archive.org/download/DocLenaSelyanina-SongsOfVastnessmt027/04_-_Mir.mp3',
    master: 'doc-and-lena-selyanina-mir.mp3',
    sha256: 'c3c566aa80886feb5490a9d7a9c102b713835fd93050bdfcfb9d860f582822cc',
  }),
  openGameArtBrylie(
    'brylie-star-song',
    'BCO – Star Song (deep space tranquility)',
    {
      url: 'https://opengameart.org/sites/default/files/bco-starsong-2021-02-17.flac',
      master: 'brylie-star-song.flac',
      sha256:
        '550a5806245e49e98f1e17cecc122486252076f1f0115453593bdb252813f834',
      licensor:
        'https://opengameart.org/content/bco-star-song-deep-space-tranquility',
      snapshot:
        'http://web.archive.org/web/20251118032247/https://opengameart.org/content/bco-star-song-deep-space-tranquility',
    },
  ),
  openGameArtBrylie('brylie-2021-07-10', 'bco – 2021-07-10', {
    url: 'https://opengameart.org/sites/default/files/bco-2021-07-10.flac',
    master: 'brylie-2021-07-10.flac',
    sha256: 'b5f3f4b265c854d4752ab46c10f302c7bceca273383206301e50a3a984610619',
    licensor: 'https://opengameart.org/content/bco-2021-07-10',
    snapshot: null,
    note: 'The author describes it as an ambient melody drifting across space. 24-bit.',
  }),
  lullabies(
    'holiznacc0-lullabies-for-the-end-of-the-world-1',
    'Lullabies For The End Of The World #1',
    {
      url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/8RwpuRIdNOdkazzkaujnrvXrcDybVrGYRfdYItKD.mp3',
      master: 'holiznacc0-lullabies-for-the-end-of-the-world-1.mp3',
      sha256:
        'f875477bd79039f6b69c09ce1685cc01b22a2e98c89efffeca9a84000e8caa4a',
      licensor:
        'https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-1/',
    },
  ),
  lullabies(
    'holiznacc0-lullabies-for-the-end-of-the-world-2',
    'Lullabies For The End Of The World #2',
    {
      url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/HEbOg2oJyXLOL7DcCJvIICTxz6YqPegW0PyGZ8vp.mp3',
      master: 'holiznacc0-lullabies-for-the-end-of-the-world-2.mp3',
      sha256:
        '560c94fee94f90490ab922560c783b9da0c1362f6a4ac1a2e8cd62360a9f0e91',
      licensor:
        'https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-2/',
    },
  ),
  lullabies(
    'holiznacc0-lullabies-for-the-end-of-the-world-3',
    'Lullabies For The End Of The World #3',
    {
      url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/l6ZWkm9tTlgersj9RkAJE40646fNo9x3UJrAr4UP.mp3',
      master: 'holiznacc0-lullabies-for-the-end-of-the-world-3.mp3',
      sha256:
        '5b8c4aaf252b4dce198abac40b7d1b7ea172875a7ca62d5954fde2a310c2d742',
      licensor:
        'https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-3/',
    },
  ),
  lullabies(
    'holiznacc0-lullabies-for-the-end-of-the-world-4',
    'Lullabies For The End Of The World #4',
    {
      url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/C5VONRgbqSGJG0zP0pPW1blqAVBaK9C20EQrF3UU.mp3',
      master: 'holiznacc0-lullabies-for-the-end-of-the-world-4.mp3',
      sha256:
        '4ccc5147700b2c882a38e27c51aa3813a0c8972e175c1c04c6a831b7ed94717b',
      licensor:
        'https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-4/',
    },
  ),
  lullabies(
    'holiznacc0-lullabies-for-the-end-of-the-world-5',
    'Lullabies For The End Of The World #5',
    {
      url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/QQ7qGFBa7XvQ4zoITcak0W3PPq4CIDuJpXDtb8BB.mp3',
      master: 'holiznacc0-lullabies-for-the-end-of-the-world-5.mp3',
      sha256:
        'd92076e65945f9703f99c45741cf09118c1a5d8bec54e1a1245f513f9f3134ed',
      licensor:
        'https://freemusicarchive.org/music/holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-5/',
    },
  ),
  milkyWay1('holiznacc0-old-age', 'Old Age', {
    url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/H6qP6CfBExLpo6O88Ii7E2WhzU0CI3klrE95FIxM.mp3',
    master: 'holiznacc0-old-age.mp3',
    sha256: '6931b7ae6e4f247132b7425977cb71cc6692af9ce7dc6141e7e382746407af75',
    licensor:
      'https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-1/old-age/',
  }),
  milkyWay2('holiznacc0-street-names', 'Street Names', {
    url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/gpJhOdSsQGabjtoXYifAqHDHJqPQ52nAyTUyR8qt.mp3',
    master: 'holiznacc0-street-names.mp3',
    sha256: '7a0dcc6dd46cd40a504a53e3ae2715837bdec38e86efd5fe82bdbef1fc0e9f1d',
    licensor:
      'https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-2/street-names/',
  }),
  milkyWay3('holiznacc0-night-driving', 'Night Driving', {
    url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/JesQEh2spMciE2gCLo9rt2EvNxugIvK4SVS2kJE5.mp3',
    master: 'holiznacc0-night-driving.mp3',
    sha256: 'a0ca6a568ad101fac8a12d94679f10b4011e8c05941b5dd7fc13770fcfae598d',
    licensor:
      'https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-3/night-driving/',
  }),
  milkyWay3('holiznacc0-quiet-houses', 'Quiet Houses', {
    url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/ovBx5OO8N5hBE3mgGOo5f4AvYOhus0axzaWFs2LL.mp3',
    master: 'holiznacc0-quiet-houses.mp3',
    sha256: 'fc1c22deaa9b6097bd9da8ba19dc8e2475b93594ee79b61ba00151ceaf2c8525',
    licensor:
      'https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-3/quiet-houses/',
  }),
  publicDomainLofi('holiznacc0-orbs-in-a-photo', 'Orbs In A Photo', {
    url: 'https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/8VYwiA4OCIwhSUIblz3LrYKmMwjbm0kqXE1ex72s.mp3',
    master: 'holiznacc0-orbs-in-a-photo.mp3',
    sha256: 'c756c55fdf759298283a88a005540b51665864cdc56ab1b7e27349351d270945',
    licensor:
      'https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/orbs-in-a-photo-lofi-chill-mp3/',
    statement:
      'Orbs In A Photo ( LoFi , Chill ).mp3 by HoliznaCC0 is licensed under a CC0 1.0 Universal License.',
    note: 'FMA titles it “Orbs In A Photo ( LoFi , Chill ).mp3”; the tags are dropped here.',
  }),
  whispersInTheDark(
    'purrple-cat-whispers-in-the-dark',
    'Whispers in the Dark',
    {
      url: 'https://archive.org/download/purrplecat-whispers-in-the-dark/Whispers%20In%20The%20Dark.mp3',
      master: 'purrple-cat-whispers-in-the-dark.mp3',
      sha256:
        '8c344b41a070a30d7500bafc5dd3a9f4d34b13f2170ab3923ac812d95a19bef6',
    },
  ),
  memories('purrple-cat-take-me-to-the-moon', 'Take Me to the Moon', {
    url: 'https://purrplecat-audio.pages.dev/audio/memories/04-take-me-to-the-moon.mp3',
    master: 'purrple-cat-take-me-to-the-moon.mp3',
    sha256: '270a3ac3ac77c230ed4b72695177bd5519fbd26fe30774917b46e6b307ddd1a5',
  }),
  sleepTight('purrple-cat-still-of-the-night', 'Still of the Night', {
    url: 'https://purrplecat-audio.pages.dev/audio/sleep-tight/03-still-of-the-night.mp3',
    master: 'purrple-cat-still-of-the-night.mp3',
    sha256: 'a8fd33734e3afc3e15491cd16d9b49af8235d186cf150a819c900fb47f4d7e0b',
  }),
  sleepTight('purrple-cat-dream-state', 'Dream State', {
    url: 'https://purrplecat-audio.pages.dev/audio/sleep-tight/06-dream-state.mp3',
    master: 'purrple-cat-dream-state.mp3',
    sha256: 'f6bfb2ad78c9c9513883bb1d8a6a1781605ccd3c67e220d7e168fa3eba1bcb5b',
  }),
  sleepTight('purrple-cat-night-light', 'Night Light', {
    url: 'https://purrplecat-audio.pages.dev/audio/sleep-tight/08-night-light.mp3',
    master: 'purrple-cat-night-light.mp3',
    sha256: 'b0fa9e3a0b7c2fcb651bac054b32f7f519b4881cd6d9fb6b4d2ba2adcbff361f',
  }),
  sleepTight('purrple-cat-astral-projection', 'Astral Projection', {
    url: 'https://purrplecat-audio.pages.dev/audio/sleep-tight/12-astral-projection.mp3',
    master: 'purrple-cat-astral-projection.mp3',
    sha256: 'bd91fe33e7ce7676e10d7033b93bc63920e9fd772a3fc2e8055c58bf7b9b9893',
  }),
  sleepTight('purrple-cat-weightless', 'Weightless', {
    url: 'https://purrplecat-audio.pages.dev/audio/sleep-tight/14-weightless.mp3',
    master: 'purrple-cat-weightless.mp3',
    sha256: 'a32e999f4c61b2e0c737c6012e4d0f1fbcf7e1a6ca79a179fbb1139a72584198',
  }),
  cityNights3('purrple-cat-insomnia', 'Insomnia', {
    url: 'https://purrplecat-audio.pages.dev/audio/city-nights-3/07-insomnia.mp3',
    master: 'purrple-cat-insomnia.mp3',
    sha256: 'd5da7a6b83a2f900e3a3dda9403db6ce56c78c416ff457ba647d603bacc13cb5',
  }),
  cityNights3('purrple-cat-3-a-m-radio', '3 A.M. Radio', {
    url: 'https://purrplecat-audio.pages.dev/audio/city-nights-3/12-3-a-m-radio.mp3',
    master: 'purrple-cat-3-a-m-radio.mp3',
    sha256: 'a723e315d3d5053677c7a19a770abedca8705394dd100a6607097a8bd2b4ba36',
  }),
  cityNights3('purrple-cat-starry-night', 'Starry Night', {
    url: 'https://purrplecat-audio.pages.dev/audio/city-nights-3/14-starry-night.mp3',
    master: 'purrple-cat-starry-night.mp3',
    sha256: '31bac23fb8332bb791f30d7c43f6ae8c51589f4ac9f374898f4cf06024f05323',
  }),
  svs(
    'parker-solar-probe-venus',
    'Venus’s ionosphere, heard by Parker Solar Probe',
    {
      url: 'https://svs.gsfc.nasa.gov/vis/a010000/a013800/a013847/13847_Parker_Venus.mp4',
      master: 'parker-solar-probe-venus.m4a',
      sha256:
        '4b99aec9058d576d8a523fd98cfc98889381591a88933453c6e762a267122115',
      derivedFrom: {
        sha256:
          '7fd94e20c990d96f5be9f88f58dde9a1e8036804ace86edeb797902cd7e34f20',
        how: 'the AAC audio stream, copied out of the published video without re-encoding',
      },
    },
  ),
  cdaweb(
    'parker-solar-probe-magnetometer-br',
    'Parker Solar Probe’s magnetic field near the Sun, radial',
    {
      url: 'https://cdaweb.gsfc.nasa.gov/audification_examples/PSP_FLD_L2_MAG_RTN_2020_0129_19-23_Br.wav',
      master: 'parker-solar-probe-magnetometer-br.wav',
      sha256:
        '9c68e5bf589ca9a92e41e04ad368116e9f0cd93556dfb0a5f66e74f3ba97c6a5',
      held: 'Its peaks reach full scale at −35 LUFS integrated, so a gain-only master would play it 18 LU under the rest of the soundtrack. Whether to compress a data audification to fix that is a decision, not a step in this pipeline.',
    },
  ),
  cdaweb(
    'parker-solar-probe-magnetometer-bt',
    'Parker Solar Probe’s magnetic field near the Sun, tangential',
    {
      url: 'https://cdaweb.gsfc.nasa.gov/audification_examples/PSP_FLD_L2_MAG_RTN_2020_0129_19-23_Bt.wav',
      master: 'parker-solar-probe-magnetometer-bt.wav',
      sha256:
        'b3c2832d1faf5e57dc69687423c78a136faacaf3710043e853bf04676c57289b',
      held: 'One component of the same four hours plays; the radial one. Captured so that choosing another is an edit, not a download.',
    },
  ),
  cdaweb(
    'parker-solar-probe-magnetometer-bn',
    'Parker Solar Probe’s magnetic field near the Sun, normal',
    {
      url: 'https://cdaweb.gsfc.nasa.gov/audification_examples/PSP_FLD_L2_MAG_RTN_2020_0129_19-23_Bn.wav',
      master: 'parker-solar-probe-magnetometer-bn.wav',
      sha256:
        '0a36d5a64a3ad06e2f6ec93679555a52d1df8c59fd5ab5f8b3125edaf0b9bd87',
      held: 'One component of the same four hours plays; the radial one. Captured so that choosing another is an edit, not a download.',
    },
  ),
  shuttleCabin(
    'shuttle-launch-in-cabin',
    'A Space Shuttle launch, recorded in the cabin',
    {
      url: 'https://archive.org/download/NasaAudioHighlightReels/Launch-Sound_Shuttle-Launch-IN-CABIN-FINALIZED.flac',
      master: 'shuttle-launch-in-cabin.flac',
      sha256:
        'aec9e2ec554ce1bf16246a06aa74e858e7ab5907f9c94bdd9f368a0de1a6866a',
      held: 'Captured and not shipped. Nobody has listened for crew voices, and an identifiable voice carries publicity rights that public domain does not clear.',
    },
  ),
]

/**
 * Twelve recordings the survey found, read literally against "public domain"
 * and held back: six from JPL/Caltech, whose credits name non-NASA partners
 * and whose pages make no public-domain statement, and six from the
 * University of Iowa's plasma-wave group, which licenses its own recordings
 * under CC BY. The terms are verbatim, from the day they were read.
 */
export const HELD_BACK: readonly HeldBack[] = [
  {
    id: 'r-mars-wind',
    title: 'Perseverance Rover’s SuperCam Records Wind on Mars (sol 4)',
    producer: 'JPL/Caltech (credit also names LANL, CNES, CNRS, ISAE-Supaero)',
    terms:
      "Sounds from Beyond: 'For sound file use policy, please see Media Usage Guidelines.' Guidelines: 'The NASA Insignia, Logotype, identifiers, and imagery are not in the public domain. The use of the Insignia, Logotype and NASA identifiers is protected by law, and imagery is made available for use consistent with Media Usage Guidelines.' 'NASA content – images, audio, video, and media files used in the rendition of 3-dimensional models, such as texture maps and polygon data in any format – generally are not subject to copyright in the United States. You may use this material for educational or informational purposes, including photo collections, textbooks, public exhibits, computer graphical simulations and Internet Web pages. This general permission extends to personal Web pages.' 'News outlets, schools, and text-book authors may use NASA content without needing explicit permission, subject to compliance with these guidelines. NASA content used in a factual manner that does not imply endorsement may be used without needing explicit permission. NASA should be acknowledged as the source of the material. NASA occasionally uses copyright-protected material of third parties with permission on its website. Those images will be marked identified as copyright protected with the name of the copyright holder. NASA’s use does not convey any rights to others to use the same material. Those wishing to use copyright protected material of third parties must contact the copyright holder directly.' Commercial use: 'If the NASA material is to be used for commercial purposes, including advertisements, it must not explicitly or implicitly convey NASA’s endorsement of commercial goods or services.'",
    termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    page: 'https://www.nasa.gov/sounds-from-beyond/',
    credit: 'NASA/JPL-Caltech/LANL/CNES/CNRS/ISAE-Supaero',
    why: "Made by JPL, which Caltech operates, so it is not a U.S. Government work; NASA's guidelines say only 'generally are not subject to copyright', and the credit names non-NASA partners.",
    url: 'https://www.nasa.gov/wp-content/uploads/2024/05/scam-mic-sol004-run001.wav',
  },
  {
    id: 'r-mars-devil',
    title: 'NASA’s Perseverance Records a Martian Dust Devil (sol 215)',
    producer:
      'JPL/Caltech (credit also names LANL, CNES, CNRS, INTA-CSIC, Space Science Institute, ISAE-Supaero)',
    terms:
      "Same NASA media guidelines text as r-mars-wind (the Sounds from Beyond page says 'For sound file use policy, please see Media Usage Guidelines.').",
    termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    page: 'https://www.nasa.gov/sounds-from-beyond/',
    credit:
      'NASA/JPL-Caltech/LANL/CNES/CNRS/INTA-CSIC/Space Science Institute/ISAE-Supaero',
    why: 'JPL/Caltech work with non-NASA partners in the credit; no explicit public domain statement.',
    url: 'https://www.nasa.gov/wp-content/uploads/2024/05/pia25657.wav',
  },
  {
    id: 'r-mars-laser',
    title: 'First Acoustic Recording of Laser Shots on Mars (sol 12)',
    producer: 'JPL/Caltech (credit also names LANL, CNES, CNRS, ISAE-Supaero)',
    terms:
      'Same NASA media guidelines text as r-mars-wind; the science.nasa.gov page carries no separate terms.',
    termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    page: 'https://science.nasa.gov/resource/first-acoustic-recording-of-laser-shots-on-mars/',
    credit: 'NASA/JPL-Caltech/LANL/CNES/CNRS/ISAE-Supaero',
    why: 'JPL/Caltech work with non-NASA partners in the credit; no explicit public domain statement.',
    url: 'https://www.nasa.gov/wp-content/uploads/2024/05/scam-mic-sol012-run001.wav',
  },
  {
    id: 'r-insight-dinks',
    title: '“Dinks and donks” from InSight’s seismometer (sol 226)',
    producer:
      "Not JPL alone: NASA's 2019 release says 'Charalambous and Nobuaki Fuji of Institut de Physique du Globe de Paris provided the audio samples for this story', Charalambous being 'an InSight science team member at Imperial College London'. SEIS was provided by CNES with the principal investigator at IPGP.",
    terms: 'Same NASA media guidelines text as r-mars-wind.',
    termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    page: 'https://www.nasa.gov/sounds-from-beyond/',
    credit: null,
    why: 'The audio samples came from scientists at Imperial College London and IPGP on a JPL mission; no explicit public domain statement.',
    url: 'https://www.nasa.gov/wp-content/uploads/2015/01/Cropped-Dinks-and-Donks-sample.wav',
  },
  {
    id: 'r-juno-gan',
    title: 'Audio of Juno’s Ganymede Flyby (PIA25030)',
    producer:
      'JPL/Caltech with SwRI and the University of Iowa (Waves instrument)',
    terms: 'Same NASA media guidelines text as r-mars-wind.',
    termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    page: 'https://science.nasa.gov/photojournal/audio-of-junos-ganymede-flyby/',
    credit: 'NASA/JPL-Caltech/SwRI/Univ of Iowa',
    why: 'JPL/Caltech, SwRI and University of Iowa work; no explicit public domain statement.',
    url: 'https://www.nasa.gov/wp-content/uploads/2024/05/e2-wave-ganymede-flyby-compressed.wav',
  },
  {
    id: 'r-cas-rings',
    title:
      'The Sound of Science: Comparison of Cassini Ring Crossings (PIA21446)',
    producer: 'JPL/Caltech and the University of Iowa (RPWS)',
    terms: 'Same NASA media guidelines text as r-mars-wind.',
    termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    page: 'https://science.nasa.gov/photojournal/the-sound-of-science-comparison-of-cassini-ring-crossings/',
    credit: 'NASA/JPL-Caltech/University of Iowa',
    why: 'JPL/Caltech and University of Iowa work; no explicit public domain statement.',
    url: 'https://science.nasa.gov/photojournal/the-sound-of-science-comparison-of-cassini-ring-crossings/',
  },
  {
    id: 'r-v2-jup',
    title: 'Voyager-2 PWS: Arrival at Jupiter (July 2, 1979, 15:56–16:45)',
    producer: 'University of Iowa, Radio and Plasma Wave Group',
    terms:
      "Item page: 'The audio and video are available under a Creative Commons Attribution 3.0 Unported License, with clear citation.' Citation page: 'The audio files found at this site are available under a Creative Commons Attribution 4.0 International License.' 'You have our permission to use or adapt any of these audio files for use in creative or artistic works, but please acknowledge us as the source of the orignial audio. A preferred citation for either commercial or non-commercial works would be: Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/' 'Check the details associated with individual audio clips. If you need a shorter version, we suggest: Original audio from space-audio.org' 'This license is recinded if you attempt to claim copyright to our material. If you attempt to claim copyright to our content, you must remove all such content from all of your platforms.'",
    termsUrl:
      'https://space.physics.uiowa.edu/plasma-wave/space-audio/citation.html',
    page: 'https://space.physics.uiowa.edu/plasma-wave/voyager/v2pws_jupiter_arrival.html',
    credit:
      'Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/',
    why: 'A University of Iowa work under a Creative Commons Attribution license; the item page says CC BY 3.0 Unported while the citation page says CC BY 4.0.',
    url: 'https://space.physics.uiowa.edu/plasma-wave/voyager/v2pws_jupiter_arrival.html',
  },
  {
    id: 'r-jov-chorus',
    title: 'Jupiter Chorus (Voyager 1, March 5, 1979)',
    producer: 'University of Iowa, Radio and Plasma Wave Group',
    terms:
      "Item page: 'Audio clips freely licensed.' (links to the citation page). Citation page: same text as r-v2-jup, CC BY 4.0.",
    termsUrl:
      'https://space.physics.uiowa.edu/plasma-wave/space-audio/citation.html',
    page: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/sounds/JupiterChorus/JovianChorus.html',
    credit:
      'Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/',
    why: 'University of Iowa work under CC BY 4.0.',
    url: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/sounds/JupiterChorus/JovianChorus.html',
  },
  {
    id: 'r-cas-skr',
    title:
      "The Eerie Sounds of Saturn's Radio Emissions (Cassini RPWS, SKR-03-324.wav, 73 s)",
    producer:
      'University of Iowa (Cassini RPWS team; the page is signed by Bill Kurth, RPWS Deputy Principal Investigator)',
    terms:
      "Item page: 'The audio files found at this site are available under a Creative Commons Attribution 3.0 Unported License.' Citation page: same text as r-v2-jup, CC BY 4.0.",
    termsUrl:
      'https://space.physics.uiowa.edu/plasma-wave/space-audio/citation.html',
    page: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/cassini/SKR1/',
    credit:
      'Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/',
    why: 'University of Iowa work under a Creative Commons Attribution license; the item page says CC BY 3.0 Unported, the citation page CC BY 4.0.',
    url: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/cassini/SKR1/',
  },
  {
    id: 'r-earth-chorus',
    title: 'Earth Chorus (Injun 3)',
    producer:
      "University of Iowa; the page says 'This example is from the University of Iowa Injun 3 spacecraft.'",
    terms:
      "Item page: 'Audio clips freely licensed.' (links to the citation page). Citation page: same text as r-v2-jup, CC BY 4.0.",
    termsUrl:
      'https://space.physics.uiowa.edu/plasma-wave/space-audio/citation.html',
    page: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/sounds/EarthChorus/EarthChorus.html',
    credit:
      'Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/',
    why: 'University of Iowa work, from a University of Iowa spacecraft, under CC BY 4.0.',
    url: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/sounds/EarthChorus/earchor.mp3',
  },
  {
    id: 'r-earth-whistlers',
    title: 'Earth Whistlers (Injun 3)',
    producer:
      "University of Iowa; the page says 'This example is from the University of Iowa Injun 3 spacecraft.'",
    terms:
      "Item page: 'Audio clips freely licensed.' (links to the citation page). Citation page: same text as r-v2-jup, CC BY 4.0.",
    termsUrl:
      'https://space.physics.uiowa.edu/plasma-wave/space-audio/citation.html',
    page: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/sounds/EarthWhistlers/EarthWhistlers.html',
    credit:
      'Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/',
    why: 'University of Iowa work, from a University of Iowa spacecraft, under CC BY 4.0.',
    url: 'https://space.physics.uiowa.edu/plasma-wave/space-audio/sounds/EarthWhistlers/ewhist.mp3',
  },
  {
    id: 'r-v1-ism',
    title: 'Voyager 1 PWS electron plasma oscillations beyond the heliopause',
    producer: 'University of Iowa, Radio and Plasma Wave Group',
    terms:
      "Item page: 'Audio clips freely licensed.' (links to the citation page) and '© The University of Iowa 2013. All rights reserved.' for the page itself. Citation page: same text as r-v2-jup, CC BY 4.0.",
    termsUrl:
      'https://space.physics.uiowa.edu/plasma-wave/space-audio/citation.html',
    page: 'https://space.physics.uiowa.edu/plasma-wave/voyager/v1pws_interstellar_epo.html',
    credit:
      'Original space audio recordings provided courtesy of NASA and The University of Iowa. https://space-audio.org/',
    why: 'University of Iowa work under CC BY 4.0.',
    url: 'https://space.physics.uiowa.edu/plasma-wave/voyager/v1pws_interstellar_epo.mp4',
  },
]
