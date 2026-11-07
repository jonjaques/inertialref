import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  decodeSoundtrackCatalog,
  SOUNDTRACK_CATEGORIES,
  SOUNDTRACK_CATEGORY_TITLES,
  SOUNDTRACK_LICENSES,
  SOUNDTRACK_VERSION,
  type SoundtrackCatalog,
  type SoundtrackFile,
  type SoundtrackTrack,
} from '@inertialref/protocol'
import { AUDIO_SOURCES, type AudioSource, HELD_BACK } from './audioSources.ts'
import {
  contourOf,
  type LoudnessFrame,
  type LoudnessSummary,
  parseLoudnessFrames,
  parseLoudnessSummary,
  parseSilenceCues,
  planGain,
} from './loudness.ts'
import { type Cutoff, findCutoff, SpectrumAccumulator } from './spectrum.ts'

/*
 * Masters to a soundtrack.
 *
 *     pnpm audio:fetch     download any master that is missing, and verify all
 *     pnpm audio:build     measure, normalize and encode; write the catalog
 *     pnpm audio:report    measure only, and print
 *
 * **Three places, three reasons.** The masters are the files as their
 * licensors published them, in `data/audio/masters/` under Git LFS: an archive,
 * because licensors leave Creative Commons and sites close. `.lfsconfig` keeps
 * them out of every default fetch, CI's and Workers Builds' included — LFS
 * bandwidth is metered on the repository owner, and a gigabyte pulled by every
 * preview build is the free allowance gone in a week. The delivery files are
 * this pipeline's output, written into `apps/game/public/media/music/`
 * (git-ignored) and published to the site's R2 bucket by `pnpm media:push`;
 * the Worker serves them from there with real byte ranges, which the static
 * asset store does not do and Safari's `<audio>` requires. `catalog.json` is
 * what the game and the Worker read; `manifest.json` is the provenance.
 *
 * **ffmpeg is required here and nowhere else.** Nothing about running the
 * game or the tests needs it — the catalog is committed — and the encode is
 * macOS-preferred: Apple's AudioToolbox AAC encoder (`aac_at`) is the best AAC
 * encoder there is at these rates, and ffmpeg's own `aac` stands in, recorded
 * as such in the manifest, where it is absent.
 */

const MASTERS = 'data/audio/masters'
const OUTPUT = 'data/audio'
const DELIVERY = 'apps/game/public/media/music'
const REVIEW = '.data/audio/review'

/**
 * Where every track is moved toward.
 *
 * −18 LUFS integrated is a background level: below the −14 to −16 the
 * streaming services normalize music to, because this plays under a sky
 * somebody is looking at rather than as the thing they came for, and above
 * the −23 broadcast reference, which on a laptop's speakers is a whisper. One
 * target for every category, because a shuffle crosses them and the spike
 * measured 17.7 LU between the loudest and the quietest source.
 *
 * −1 dBTP is the ceiling for a codec at these rates (AES TD1004). It is
 * measured on the delivered files, after the encode, not predicted.
 */
export const TARGET = { integrated: -18, truePeak: -1 } as const

/** Everything an encode is: the codec, its target, and how it is asked for. */
interface Encoding {
  readonly extension: 'm4a' | 'webm'
  readonly type: string
  /** Bits per second for a stereo source; a mono one gets half again less. */
  readonly bitrate: number
  readonly monoBitrate: number
}

/**
 * Two encodings of every track, AAC first.
 *
 * AAC-LC in MP4 is the one format every browser this game supports decodes
 * natively, and the one Safari seeks exactly — the reason the cutscene's track
 * is an `.m4a` (`apps/server/src/media.ts`). 256 kbit/s is where the iTunes
 * store settled, and transparent for this material. Opus at 160 kbit/s in
 * WebM is the fallback for a browser that has no AAC decoder at all, which is
 * Firefox on a Linux system without its codecs; it is transparent at that
 * rate too, and the player asks `canPlayType` with the codec named before it
 * picks either.
 */
const ENCODINGS: readonly Encoding[] = [
  {
    extension: 'm4a',
    type: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 256_000,
    monoBitrate: 128_000,
  },
  {
    extension: 'webm',
    type: 'audio/webm; codecs="opus"',
    bitrate: 160_000,
    monoBitrate: 96_000,
  },
]

/* ------------------------------------------------------------------------- */
/* Processes                                                                  */
/* ------------------------------------------------------------------------- */

interface Ran {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

/**
 * A child process, to completion.
 *
 * `onStdout` streams instead of collecting, for the one caller that reads a
 * whole track as samples; everything else is small.
 */
function run(
  command: string,
  args: readonly string[],
  onStdout?: (chunk: Buffer) => void,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (onStdout === undefined) out.push(chunk)
      else onStdout(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }),
    )
  })
}

async function must(
  command: string,
  args: readonly string[],
  what: string,
): Promise<Ran> {
  const result = await run(command, args)
  if (result.code !== 0) {
    throw new Error(
      `${what}: ${command} exited ${result.code}\n${result.stderr.slice(-1200)}`,
    )
  }
  return result
}

/** The encoders this machine's ffmpeg has, and its version line. */
async function tools(): Promise<{
  readonly version: string
  readonly aac: 'aac_at' | 'aac'
}> {
  const version = await run('ffmpeg', ['-hide_banner', '-version']).catch(
    () => null,
  )
  if (version === null || version.code !== 0) {
    throw new Error(
      'ffmpeg is not on PATH. `brew install ffmpeg` (see ~/Brewfile).',
    )
  }
  const encoders = await must(
    'ffmpeg',
    ['-hide_banner', '-encoders'],
    'encoders',
  )
  const list = encoders.stdout.toString()
  if (!/\blibopus\b/.test(list)) {
    throw new Error(
      'this ffmpeg was built without libopus, which the WebM encode needs',
    )
  }
  const aac = /\baac_at\b/.test(list) ? 'aac_at' : 'aac'
  if (aac === 'aac') {
    console.warn(
      "audio: AudioToolbox AAC is not available here; encoding with ffmpeg's own `aac`.\n" +
        '       The output is different and the manifest will say which encoder made it.',
    )
  }
  return { version: version.stdout.toString().split('\n')[0] ?? 'ffmpeg', aac }
}

/* ------------------------------------------------------------------------- */
/* Measurement                                                                */
/* ------------------------------------------------------------------------- */

interface Probe {
  readonly codec: string
  readonly rate: number
  readonly channels: number
  /** Bits per sample for a PCM or lossless source; null for a lossy one. */
  readonly bits: number | null
  readonly duration: number
  /** The container's stated bitrate, bits per second, when it states one. */
  readonly bitrate: number | null
  readonly lossless: boolean
}

const LOSSLESS = new Set([
  'flac',
  'alac',
  'wavpack',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
  'pcm_s16be',
  'pcm_s24be',
])

async function probe(path: string): Promise<Probe> {
  const { stdout } = await must(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-select_streams',
      'a:0',
      '-show_streams',
      '-show_format',
      path,
    ],
    `probe ${path}`,
  )
  const parsed = JSON.parse(stdout.toString()) as {
    streams?: Record<string, string | number | undefined>[]
    format?: Record<string, string | number | undefined>
  }
  const stream = parsed.streams?.[0]
  if (stream === undefined) throw new Error(`${path}: no audio stream`)
  const codec = String(stream['codec_name'])
  const lossless = LOSSLESS.has(codec)
  const bits = Number(
    stream['bits_per_raw_sample'] ?? stream['bits_per_sample'],
  )
  const bitrate = Number(stream['bit_rate'] ?? parsed.format?.['bit_rate'])
  return {
    codec,
    rate: Number(stream['sample_rate']),
    channels: Number(stream['channels']),
    bits: lossless && bits > 0 ? bits : null,
    duration: Number(stream['duration'] ?? parsed.format?.['duration']),
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    lossless,
  }
}

/**
 * The mean spectrum of the whole track, and where it falls off a cliff.
 * `spectrum.ts` says why the cliff is the evidence.
 */
async function spectrumOf(path: string): Promise<{
  readonly cutoff: Cutoff
  readonly frames: number
  readonly rate: number
}> {
  const { rate } = await probe(path)
  const accumulator = new SpectrumAccumulator()
  let carry: Buffer = Buffer.alloc(0)
  const samples = new Float32Array(16_384)
  const result = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      'pipe:1',
    ],
    (chunk) => {
      const bytes = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      const whole = bytes.length - (bytes.length % 4)
      for (let offset = 0; offset < whole;) {
        const count = Math.min(samples.length, (whole - offset) / 4)
        for (let i = 0; i < count; i += 1) {
          samples[i] = bytes.readFloatLE(offset + i * 4)
        }
        accumulator.push(samples.subarray(0, count))
        offset += count * 4
      }
      carry = bytes.subarray(whole)
    },
  )
  if (result.code !== 0)
    throw new Error(`spectrum ${path}: ${result.stderr.slice(-600)}`)
  return {
    cutoff: findCutoff(accumulator.mean(), rate),
    frames: accumulator.frames,
    rate,
  }
}

interface Loudness {
  readonly summary: LoudnessSummary
  readonly frames: readonly LoudnessFrame[]
  readonly cues: { readonly start: number; readonly end: number }
}

/**
 * EBU R128 over the whole file, with the frame log, and the silence at either
 * end, in one decode.
 *
 * `-v verbose` because that is the level `framelog=verbose` writes the frame
 * log at. −60 dBFS for half a second is the silence floor: below anything a
 * room lets through, above the dither a 16-bit master carries.
 */
async function loudnessOf(path: string, duration: number): Promise<Loudness> {
  const { stderr } = await must(
    'ffmpeg',
    [
      '-nostats',
      '-hide_banner',
      '-v',
      'verbose',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      'silencedetect=noise=-60dB:d=0.5,ebur128=peak=true:framelog=verbose',
      '-f',
      'null',
      '-',
    ],
    `loudness ${path}`,
  )
  return {
    summary: parseLoudnessSummary(stderr),
    frames: parseLoudnessFrames(stderr),
    cues: parseSilenceCues(stderr, duration),
  }
}

/* ------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* ------------------------------------------------------------------------- */

function metadata(source: AudioSource, modified: string): readonly string[] {
  const license = SOUNDTRACK_LICENSES[source.license]
  const tags: Record<string, string> = {
    title: source.title,
    artist:
      source.performer === undefined
        ? source.artist
        : `${source.artist}, played by ${source.performer}`,
    album: source.release,
    date: String(source.year),
    copyright: `${license.name} — ${license.url}`,
    comment: `${creditWithChange(source.credit, modified)} Source: ${source.licensor}`,
  }
  return Object.entries(tags).flatMap(([key, value]) => [
    '-metadata',
    `${key}=${value}`,
  ])
}

/**
 * One delivery file, written to `into`.
 *
 * The gain is applied in floating point and dithered on the way to the
 * encoder's input. AudioToolbox takes 16-bit samples and nothing wider, so a
 * gain change on a 16-bit master is requantized; triangular high-pass dither
 * puts that error above most of the band and below −90 dBFS, where truncation
 * would have left it correlated with the music.
 *
 * `-map_metadata -1` and `-vn` together: a source's tags are text from the
 * web, and its embedded cover art carries a license of its own that nobody
 * checked. Neither travels.
 */
async function encode(
  source: AudioSource,
  master: string,
  gain: number,
  encoding: Encoding,
  channels: number,
  aac: 'aac_at' | 'aac',
  modified: string,
  into: string,
): Promise<void> {
  const bitrate = channels === 1 ? encoding.monoBitrate : encoding.bitrate
  const common = [
    '-v',
    'error',
    '-y',
    '-i',
    master,
    '-map',
    '0:a:0',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-vn',
    '-sn',
    '-dn',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    ...metadata(source, modified),
  ]
  const codec =
    encoding.extension === 'm4a'
      ? [
          '-af',
          `volume=${gain}dB,aresample=osf=s16:dither_method=triangular_hp`,
          ...(aac === 'aac_at'
            ? ['-c:a', 'aac_at', '-aac_at_mode', 'cvbr', '-aac_at_quality', '0']
            : ['-c:a', 'aac']),
          '-b:a',
          String(bitrate),
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
        ]
      : [
          // Opus runs at 48 kHz only; a 44.1 kHz master is resampled here,
          // with a longer filter than the resampler's default.
          '-af',
          `volume=${gain}dB,aresample=48000:filter_size=64:phase_shift=10:cutoff=0.97`,
          '-c:a',
          'libopus',
          '-b:a',
          String(bitrate),
          '-vbr',
          'on',
          '-compression_level',
          '10',
          '-application',
          'audio',
          // The index at the front, so a seek does not first fetch the end.
          '-cues_to_front',
          '1',
          '-f',
          'webm',
        ]
  await must(
    'ffmpeg',
    [...common, ...codec, into],
    `encode ${source.id}.${encoding.extension}`,
  )
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const bytesOf = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Whether a master is an LFS pointer rather than audio.
 *
 * The masters are excluded from every default fetch, so a fresh checkout has
 * 130-byte text files where the music is, and ffmpeg's complaint about one is
 * "Invalid data found when processing input" — true and no help.
 */
function isPointer(path: string): boolean {
  if (bytesOf(path) > 1024) return false
  try {
    return readFileSync(path, 'utf8').startsWith('version https://git-lfs')
  } catch {
    return false
  }
}

const POINTER_HINT =
  "the masters are LFS objects that no default fetch includes (`.lfsconfig`). Run\n\n  git lfs pull --include='data/audio/masters/**' --exclude=''\n\nor `pnpm audio:fetch` to download them from their sources."

/* ------------------------------------------------------------------------- */
/* Fetch                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Every master, downloaded where it is missing and verified where it is not.
 *
 * A master whose digest is not the pinned one is an error rather than a
 * re-download: the pinned file is the one whose license was checked, and a
 * licensor who replaced the file under the same URL has published something
 * nobody has looked at.
 */
export async function fetchMasters(root: string): Promise<void> {
  const directory = join(root, MASTERS)
  mkdirSync(directory, { recursive: true })
  let failures = 0
  for (const source of AUDIO_SOURCES) {
    const path = join(directory, source.master)
    if (bytesOf(path) > 0 && !isPointer(path)) {
      const digest = await sha256Of(path)
      if (digest === source.sha256) {
        console.log(`  ok        ${source.master}`)
        continue
      }
      console.error(
        `  MISMATCH  ${source.master}\n            pinned ${source.sha256}\n            found  ${digest}`,
      )
      failures += 1
      continue
    }
    process.stdout.write(`  fetching  ${source.master} … `)
    const part = `${path}.part`
    try {
      const response = await fetch(source.url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; InertialRef ingest)',
        },
        signal: AbortSignal.timeout(600_000),
      })
      if (!response.ok || response.body === null) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      const hash = createHash('sha256')
      const sink = createWriteStream(part)
      for await (const chunk of response.body) {
        hash.update(chunk)
        if (!sink.write(chunk))
          await new Promise((drained) => sink.once('drain', drained))
      }
      await new Promise<void>((closed, failed) =>
        sink.end((cause?: Error | null) => (cause ? failed(cause) : closed())),
      )
      const digest = hash.digest('hex')
      const expected = source.derivedFrom?.sha256 ?? source.sha256
      if (digest !== expected) {
        rmSync(part, { force: true })
        console.log(`digest ${digest}, pinned ${expected}`)
        failures += 1
        continue
      }
      if (source.derivedFrom === undefined) {
        renameSync(part, path)
      } else {
        /*
         * The one derivation there is: a published video's audio stream,
         * copied out with no re-encode. The stream's packets are the
         * published ones; the container around them is ffmpeg's, so a
         * different ffmpeg can write different bytes, and a mismatch here
         * means "inspect and re-pin", not "the source changed".
         */
        await must(
          'ffmpeg',
          [
            '-v',
            'error',
            '-y',
            '-i',
            part,
            '-map',
            '0:a:0',
            '-c',
            'copy',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-fflags',
            '+bitexact',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            path,
          ],
          `derive ${source.master}`,
        )
        rmSync(part, { force: true })
        const derived = await sha256Of(path)
        if (derived !== source.sha256) {
          console.log(
            `derived ${derived}, pinned ${source.sha256}: the published file matched, so this ffmpeg wrote the container differently`,
          )
          failures += 1
          continue
        }
      }
      console.log(`${(bytesOf(path) / 1e6).toFixed(1)} MB`)
    } catch (cause) {
      rmSync(part, { force: true })
      console.log(
        `failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      failures += 1
    }
  }
  if (failures > 0)
    throw new Error(`${failures} master(s) missing or not the pinned file`)
}

/* ------------------------------------------------------------------------- */
/* Build                                                                      */
/* ------------------------------------------------------------------------- */

interface MasterReport {
  readonly file: string
  readonly sha256: string
  readonly bytes: number
  readonly codec: string
  readonly rate: number
  readonly channels: number
  readonly bits: number | null
  readonly bitrate: number | null
  readonly duration: number
  readonly lossless: boolean
  readonly cutoff: Cutoff
  readonly spectrumFrames: number
  readonly loudness: LoudnessSummary
}

interface DeliveredReport {
  readonly name: string
  readonly encoder: string
  readonly bytes: number
  readonly sha256: string
  readonly integrated: number
  readonly truePeak: number
}

interface TrackReport {
  readonly id: string
  readonly master: MasterReport
  readonly gain: {
    readonly wanted: number
    readonly applied: number
    readonly capped: boolean
  }
  readonly delivered: readonly DeliveredReport[]
}

/** What `modified` says for a gain: the change, in words a credit can carry. */
function describeChange(gain: number): string {
  const level =
    Math.abs(gain) < 0.05
      ? 'level unchanged'
      : `level ${gain > 0 ? 'raised' : 'lowered'} ${Math.abs(gain).toFixed(1)} dB`
  return `${level}, re-encoded as AAC and Opus`
}

/**
 * A licensor's credit line with the change appended, as one string.
 *
 * Credits are copied as their licensors wrote them, and several end on a bare
 * domain (`chriszabriskie.com`) with no stop, so a plain join runs the notice
 * into it — "chriszabriskie.com Modified: …" — and reads as part of the name.
 */
export function creditWithChange(credit: string, modified: string): string {
  const stop = /[.!?)]$/.test(credit.trim()) ? '' : '.'
  return `${credit.trim()}${stop} Modified: ${modified}.`
}

async function measureMaster(
  root: string,
  source: AudioSource,
): Promise<{
  readonly report: MasterReport
  readonly frames: readonly LoudnessFrame[]
  readonly cues: Loudness['cues']
}> {
  const path = join(root, MASTERS, source.master)
  if (bytesOf(path) === 0)
    throw new Error(`${source.master} is missing: ${POINTER_HINT}`)
  if (isPointer(path))
    throw new Error(`${source.master} is a pointer: ${POINTER_HINT}`)
  const digest = await sha256Of(path)
  if (digest !== source.sha256) {
    throw new Error(
      `${source.master} is not the pinned file (sha256 ${digest}, pinned ${source.sha256})`,
    )
  }
  const probed = await probe(path)
  const spectrum = await spectrumOf(path)
  const loudness = await loudnessOf(path, probed.duration)
  return {
    report: {
      file: source.master,
      sha256: digest,
      bytes: bytesOf(path),
      codec: probed.codec,
      rate: probed.rate,
      channels: probed.channels,
      bits: probed.bits,
      bitrate: probed.bitrate,
      duration: round(probed.duration, 3),
      lossless: probed.lossless,
      cutoff: spectrum.cutoff,
      spectrumFrames: spectrum.frames,
      loudness: loudness.summary,
    },
    frames: loudness.frames,
    cues: loudness.cues,
  }
}

const round = (value: number, places: number): number => {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/**
 * One track: measured, given its gain, encoded twice, and measured again.
 *
 * The second measurement is the one that ships. If an encode put the true
 * peak over the ceiling, the overshoot comes off the gain and both files are
 * encoded again — once, because the overshoot of a lossy codec is a property
 * of the material and barely moves with a fraction of a decibel of level.
 */
async function buildTrack(
  root: string,
  source: AudioSource,
  aac: 'aac_at' | 'aac',
): Promise<{ readonly track: SoundtrackTrack; readonly report: TrackReport }> {
  const { report: master, frames, cues } = await measureMaster(root, source)
  const plan = planGain(master.loudness, TARGET)
  let gain = plan.gain
  const masterPath = join(root, MASTERS, source.master)
  const directory = join(root, DELIVERY)
  mkdirSync(directory, { recursive: true })
  const scratch = join(root, '.data', 'audio', 'encode')
  mkdirSync(scratch, { recursive: true })

  let delivered: {
    readonly encoding: Encoding
    readonly path: string
    readonly loudness: LoudnessSummary
  }[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const modified = describeChange(gain)
    delivered = []
    for (const encoding of ENCODINGS) {
      const path = join(scratch, `${source.id}.${encoding.extension}`)
      await encode(
        source,
        masterPath,
        gain,
        encoding,
        master.channels,
        aac,
        modified,
        path,
      )
      const measured = await loudnessOf(path, master.duration)
      delivered.push({ encoding, path, loudness: measured.summary })
    }
    const worst = Math.max(...delivered.map((one) => one.loudness.truePeak))
    if (worst <= TARGET.truePeak) break
    gain = round(gain - (worst - TARGET.truePeak) - 0.1, 2)
  }

  const files: SoundtrackFile[] = []
  const reports: DeliveredReport[] = []
  for (const { encoding, path, loudness } of delivered) {
    const sha256 = await sha256Of(path)
    const name = `music/${source.id}.${sha256.slice(0, 10)}.${encoding.extension}`
    const bytes = bytesOf(path)
    renameSync(path, join(root, 'apps/game/public/media', name))
    files.push({
      name,
      type: encoding.type,
      bytes,
      sha256,
      bitrate: master.channels === 1 ? encoding.monoBitrate : encoding.bitrate,
    })
    reports.push({
      name,
      encoder:
        encoding.extension === 'm4a'
          ? aac === 'aac_at'
            ? 'AudioToolbox AAC-LC, constrained VBR'
            : 'ffmpeg AAC-LC'
          : 'libopus, VBR',
      bytes,
      sha256,
      integrated: loudness.integrated,
      truePeak: loudness.truePeak,
    })
  }

  const primary = await probe(
    join(root, 'apps/game/public/media', files[0]!.name),
  )
  const modified = describeChange(gain)
  const track: SoundtrackTrack = {
    id: source.id,
    title: source.title,
    artist: source.artist,
    performer: source.performer ?? null,
    release: source.release,
    year: source.year,
    category: source.category,
    license: source.license,
    credit: creditWithChange(source.credit, modified),
    licensor: source.licensor,
    modified,
    duration: round(primary.duration, 3),
    cues: {
      start: Math.min(cues.start, primary.duration),
      end: Math.min(cues.end, primary.duration),
    },
    loudness: {
      integrated: reports[0]!.integrated,
      truePeak: reports[0]!.truePeak,
    },
    // The master's contour moved by the gain, which is exact for a linear
    // gain and spares a third pass over each delivered file.
    contour: contourOf(
      frames.map((frame) => ({
        t: frame.t,
        shortTerm: frame.shortTerm + gain,
      })),
      master.duration,
    ),
    files,
  }
  return {
    track,
    report: {
      id: source.id,
      master,
      gain: {
        wanted: round(TARGET.integrated - master.loudness.integrated, 2),
        applied: gain,
        capped: plan.capped || gain < plan.gain,
      },
      delivered: reports,
    },
  }
}

/** Spectrograms of every master, for a person to look at. */
async function review(root: string): Promise<void> {
  const directory = join(root, REVIEW)
  mkdirSync(directory, { recursive: true })
  for (const source of AUDIO_SOURCES) {
    const path = join(root, MASTERS, source.master)
    if (bytesOf(path) === 0 || isPointer(path)) continue
    await must(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        path,
        '-lavfi',
        'showspectrumpic=s=1600x700:mode=combined:color=intensity:scale=log:legend=1',
        '-frames:v',
        '1',
        join(directory, `${source.id}.png`),
      ],
      `spectrogram ${source.id}`,
    )
  }
  console.log(`  spectrograms in ${REVIEW}/`)
}

/** `pnpm audio:report`: measure every master and print, writing nothing. */
export async function reportMasters(root: string): Promise<void> {
  await tools()
  console.log(header())
  for (const source of AUDIO_SOURCES) {
    const { report } = await measureMaster(root, source)
    const plan = planGain(report.loudness, TARGET)
    const id = source.held === undefined ? source.id : `${source.id} (held)`
    console.log(row(id, report, plan.gain, plan.capped, null))
  }
}

const header = (): string =>
  `${'id'.padEnd(34)} ${'master'.padEnd(22)} ${'I'.padStart(6)} ${'TP'.padStart(5)} ${'gain'.padStart(6)} ${'out I'.padStart(6)} ${'out TP'.padStart(6)}  cutoff`

function row(
  id: string,
  master: MasterReport,
  gain: number,
  capped: boolean,
  delivered: DeliveredReport | null,
): string {
  const format = `${master.codec} ${master.rate / 1000}k${master.bits === null ? '' : `/${master.bits}`}`
  const cutoff =
    master.cutoff.frequency === null
      ? `none (${master.cutoff.drop} dB)`
      : `${master.cutoff.frequency} Hz, −${master.cutoff.drop} dB`
  return `${id.padEnd(34)} ${format.padEnd(22)} ${master.loudness.integrated.toFixed(1).padStart(6)} ${master.loudness.truePeak.toFixed(1).padStart(5)} ${`${gain > 0 ? '+' : ''}${gain.toFixed(1)}${capped ? '*' : ''}`.padStart(6)} ${(delivered?.integrated.toFixed(1) ?? '').padStart(6)} ${(delivered?.truePeak.toFixed(1) ?? '').padStart(6)}  ${cutoff}`
}

/** `pnpm audio:build`: encode every track, then write the catalog and the provenance. */
export async function buildAudio(
  root: string,
  { spectrograms = false } = {},
): Promise<void> {
  const { version, aac } = await tools()
  console.log(header())
  const tracks: SoundtrackTrack[] = []
  const reports: TrackReport[] = []
  for (const source of AUDIO_SOURCES) {
    if (source.held !== undefined) continue
    const { track, report } = await buildTrack(root, source, aac)
    tracks.push(track)
    reports.push(report)
    console.log(
      row(
        source.id,
        report.master,
        report.gain.applied,
        report.gain.capped,
        report.delivered[0] ?? null,
      ),
    )
  }

  /*
   * Anything the catalog no longer names is deleted from the delivery
   * directory, as the textures pipeline does with its own: a re-encode is a
   * new name, and the old one would otherwise sit there to be pushed again.
   */
  const wanted = new Set(
    tracks.flatMap((track) =>
      track.files.map((file) => file.name.slice('music/'.length)),
    ),
  )
  const delivery = join(root, DELIVERY)
  for (const name of readdirSync(delivery)) {
    if (!wanted.has(name)) rmSync(join(delivery, name))
  }

  // A wall-clock read in a build tool; ADR-0006's ban is on canonical code.
  const generated = new Date().toISOString().slice(0, 10)
  const catalog: SoundtrackCatalog = {
    version: SOUNDTRACK_VERSION,
    generated,
    target: TARGET,
    tracks,
  }
  const checked = decodeSoundtrackCatalog(JSON.parse(JSON.stringify(catalog)))
  if (!checked.ok)
    throw new Error(
      `the catalog this build wrote does not decode: ${checked.error}`,
    )

  const manifest = {
    generated,
    target: TARGET,
    tools: {
      ffmpeg: version,
      aac: aac === 'aac_at' ? 'AudioToolbox (aac_at)' : 'ffmpeg aac',
    },
    tracks: reports.map((report) => {
      const source = AUDIO_SOURCES.find((one) => one.id === report.id)!
      return {
        id: report.id,
        title: source.title,
        artist: source.artist,
        license: source.license,
        licensor: source.licensor,
        statement: source.statement,
        checked: source.checked,
        snapshot: source.snapshot,
        url: source.url,
        channel: source.channel,
        ...(source.gated === undefined ? {} : { gated: source.gated }),
        ...(source.note === undefined ? {} : { note: source.note }),
        master: report.master,
        gain: report.gain,
        delivered: report.delivered,
      }
    }),
    // Captured and not shipped: measured, so the archive says what it holds.
    held: await Promise.all(
      AUDIO_SOURCES.filter((source) => source.held !== undefined).map(
        async (source) => ({
          id: source.id,
          title: source.title,
          artist: source.artist,
          license: source.license,
          licensor: source.licensor,
          statement: source.statement,
          checked: source.checked,
          url: source.url,
          channel: source.channel,
          held: source.held,
          master: (await measureMaster(root, source)).report,
        }),
      ),
    ),
    heldBack: HELD_BACK,
  }

  const output = join(root, OUTPUT)
  writeFileSync(
    join(output, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  )
  writeFileSync(
    join(output, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(join(output, 'LICENSE.md'), licenseNotice(tracks))
  /*
   * Prettier, because `data/` is formatted like the rest of the tree and a
   * generated file that is not would fail `format:check` on the commit that
   * adds it. Its own binary, run on exactly these three files.
   */
  await must(
    join(root, 'node_modules/.bin/prettier'),
    [
      '--write',
      ...['catalog.json', 'manifest.json', 'LICENSE.md'].map((name) =>
        join(output, name),
      ),
    ],
    'prettier',
  )
  if (spectrograms) await review(root)

  const minutes = tracks.reduce((sum, track) => sum + track.duration, 0) / 60
  const bytes = tracks.reduce(
    (sum, track) =>
      sum + track.files.reduce((total, file) => total + file.bytes, 0),
    0,
  )
  const capped = reports
    .filter((report) => report.gain.capped)
    .map((report) => report.id)
  console.log(`
  ${tracks.length} tracks, ${minutes.toFixed(1)} minutes, ${(bytes / 1e6).toFixed(1)} MB delivered in ${DELIVERY}/
  ${capped.length === 0 ? 'every track reached the target' : `held under the target by the true-peak ceiling (*): ${capped.join(', ')}`}
  catalog, manifest and LICENSE.md written to ${OUTPUT}/
  publish the delivery files with \`pnpm media:push\``)
}

/** A number as prose prints it: the sign is U+2212, which a hyphen is not. */
const minus = (value: number): string => String(value).replace('-', '−')

/** `data/audio/LICENSE.md`: every credit, grouped the way the player groups them. */
function licenseNotice(tracks: readonly SoundtrackTrack[]): string {
  const sections = SOUNDTRACK_CATEGORIES.map((category) => {
    const members = tracks.filter((track) => track.category === category)
    if (members.length === 0) return ''
    const lines = members.map((track) => {
      const license = SOUNDTRACK_LICENSES[track.license]
      return `- **${track.title}** — ${track.artist}${track.performer === null ? '' : `, played by ${track.performer}`}, _${track.release}_ (${track.year}). [${license.name}](${license.url}). [Source](${track.licensor}). Modified: ${track.modified}.`
    })
    return `## ${SOUNDTRACK_CATEGORY_TITLES[category].title}\n\n${lines.join('\n')}\n`
  }).filter((section) => section !== '')
  return `# Soundtrack — credits and licenses

The music and recordings the game plays, built by \`apps/ingest\` (\`pnpm audio:build\`)
from the masters in \`masters/\`. **Not covered by the Apache License.** Each piece
keeps the license its licensor published it under, linked beside it, and every
one of those licenses permits redistribution and synchronization with a credit
at most.

Every file the game serves was changed from its master in the way each entry
says: its level was moved toward ${minus(TARGET.integrated)} LUFS integrated under a ${minus(TARGET.truePeak)} dBTP ceiling,
and it was re-encoded. The masters themselves are unmodified.

Per-file provenance — the licensor's statement, the day it was read, the URL each
master came from, its digest and its measurements — is in \`manifest.json\`.

${sections.join('\n')}`
}

/** The committed catalog, read back through the decoder the game and the Worker use. */
export function readSoundtrackCatalog(root: string): SoundtrackCatalog {
  const decoded = decodeSoundtrackCatalog(
    JSON.parse(readFileSync(join(root, OUTPUT, 'catalog.json'), 'utf8')),
  )
  if (!decoded.ok) throw new Error(decoded.error)
  return decoded.value
}
