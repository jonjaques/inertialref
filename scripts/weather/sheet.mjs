/*
 * The comparison sheets a weather pull request shows: per cornerstone, the
 * last phase's plate beside this phase's, and for E1 to E3 the deck beside
 * both; per cast and speed, its middle frame with the clouds off and on,
 * each labeled with the rate it was presented at; per cast, the two phases'
 * clips side by side; and `media.md`, one row a cornerstone, which the
 * orchestrator pastes into the pull request once the files are uploaded.
 *
 * A cast's rate is on its sheet and in `media.md` because a cast is kept at
 * the rate the rig presented it at until a 60 Hz hold exists (rubric §4),
 * and a path scheduled by frame runs in other seconds at another rate.
 *
 *   node scripts/weather/sheet.mjs --dir .data/weather/phase-1 [--base <dir|record.json|URL>]
 *
 * The base is the last phase's capture: its directory while it exists, or
 * its `record.json` once its plates have been uploaded and the record
 * carries their URLs (`urls`, file name to URL). A plate the base does not
 * have is a labeled blank, so the baseline's own sheets — which have no
 * phase before them — still lay every plate at one scale.
 *
 * It needs ImageMagick and ffmpeg, which the driver treats as optional, and
 * refuses without either rather than write half a sheet.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { castName, CASTS } from './descent.mjs'

const run = promisify(execFile)

/** The width a plate is laid at in a sheet, pixels: a quarter of a Retina plate. */
export const SHEET_WIDTH = 720
const SHEET_HEIGHT = Math.round((SHEET_WIDTH * 900) / 1440)

async function present(tool, flag) {
  try {
    await run(tool, [flag])
    return true
  } catch {
    return false
  }
}

/** The base's plate or clip for a file name: a path, a URL, or null. */
export function baseSource(base, file) {
  if (base === null) return null
  if (base.kind === 'dir') {
    const local = path.join(base.dir, file)
    return existsSync(local) ? local : null
  }
  return base.urls[file] ?? null
}

/** A base given as a directory, a record on disk, or a record's URL. */
export async function readBase(given) {
  if (given === null || given === undefined) return null
  if (/^https?:\/\//.test(given)) {
    const record = await fetch(given).then((response) => response.json())
    return {
      kind: 'record',
      phase: record.phase ?? null,
      urls: record.urls ?? {},
    }
  }
  if (given.endsWith('.json')) {
    const record = JSON.parse(await readFile(given, 'utf8'))
    return {
      kind: 'record',
      phase: record.phase ?? null,
      urls: record.urls ?? {},
    }
  }
  const record = path.join(given, 'record.json')
  const phase = existsSync(record)
    ? (JSON.parse(await readFile(record, 'utf8')).phase ?? null)
    : null
  return { kind: 'dir', dir: given, phase }
}

/*
 * ImageMagick has no default font for a label on this machine's build — it
 * fails with "unable to read font ''" — so a label names a file, the first
 * of these that exists.
 */
const FONTS = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]
const FONT = FONTS.find((one) => existsSync(one)) ?? null

/** One labeled tile: a plate resized to the sheet's width, or a blank. */
export function tileArgs(source, label) {
  const body =
    source === null
      ? ['-size', `${SHEET_WIDTH}x${SHEET_HEIGHT}`, 'xc:#202020']
      : [source, '-resize', `${SHEET_WIDTH}x${SHEET_HEIGHT}`]
  return [
    '(',
    ...body,
    ...(FONT === null ? [] : ['-font', FONT]),
    '-background',
    '#101010',
    '-fill',
    '#e0e0e0',
    '-pointsize',
    '22',
    '-gravity',
    'north',
    '-splice',
    '0x36',
    '-annotate',
    '+0+6',
    label,
    ')',
  ]
}

/** A cast's label: its speed, the clouds, and the rate it was presented at. */
export function castLabel(one) {
  const rate =
    typeof one.hz === 'number'
      ? `, ${one.hz.toFixed(1)} Hz${one.atSixty === false ? ', not held at 60' : ''}`
      : ''
  return `${one.speed} ${one.clouds ? 'on' : 'off'}${rate}`
}

/** A cast refused at every boot: its arm, and the rate and drops it was refused at. */
export function refusedLabel(one) {
  const rates = one.attempts
    .map((attempt) => attempt.hz)
    .filter((hz) => typeof hz === 'number')
  const hz = rates.length === 0 ? null : Math.max(...rates)
  const drops = one.attempts.map((attempt) => attempt.dropped.length)
  // Short enough for a tile's label at the sheet's width.
  return `${one.speed} ${one.clouds ? 'on' : 'off'} refused: drops ${drops.join(', ')}${hz === null ? '' : ` at ${hz.toFixed(1)} Hz`}`
}

/** The rows of `media.md`, one a cornerstone, with the files it names. */
export function mediaRows(record, sheets, pairs) {
  const rows = [
    '| Cornerstone | Sheet | Plates | Casts |',
    '| --- | --- | --- | --- |',
  ]
  const ids = [
    ...new Set([
      ...record.stills.map((one) => one.id),
      ...record.casts.map((one) => one.id),
      ...(record.refused ?? []).map((one) => one.id),
    ]),
  ]
  for (const id of ids) {
    const plates = record.stills
      .filter((one) => one.id === id)
      .map((one) => `[${one.arm}](${one.file})`)
      .join(', ')
    const casts = record.casts
      .filter((one) => one.id === id && one.clip !== null)
      .map((one) => `[${castLabel(one)}](${one.clip.file})`)
    for (const one of (record.refused ?? []).filter((one) => one.id === id))
      casts.push(refusedLabel(one))
    for (const pair of pairs.filter((one) => one.id === id))
      casts.push(`[${pair.speed}, beside the base](${pair.file})`)
    const sheet = sheets
      .filter((one) => one.id === id)
      .map(
        (one) =>
          `[${one.speed === undefined ? 'sheet' : `${one.speed} sheet`}](${one.file})`,
      )
      .join(', ')
    rows.push(
      `| \`${id}\` | ${sheet || '—'} | ${plates || '—'} | ${casts.join(', ') || '—'} |`,
    )
  }
  return rows.join('\n')
}

export async function buildSheets({ dir, base: given = null }) {
  if (!(await present('magick', '-version')))
    throw new Error('the sheets need ImageMagick (`magick`) on PATH')
  if (!(await present('ffmpeg', '-version')))
    throw new Error('the sheets need ffmpeg on PATH')
  const record = JSON.parse(
    await readFile(path.join(dir, 'record.json'), 'utf8'),
  )
  const base = await readBase(given)
  const before =
    base?.phase === null || base?.phase === undefined
      ? 'the base'
      : `phase ${base.phase}`
  const now = `phase ${record.phase}`
  const out = path.join(dir, 'sheets')
  await mkdir(out, { recursive: true })
  /*
   * A base by URL is fetched beside the sheets first: ImageMagick reads an
   * https source only through a delegate this machine may not have, and a
   * sheet built from a half-read plate is worse than one that refuses.
   */
  const local = async (source, file) => {
    if (source === null || !/^https?:\/\//.test(source)) return source
    const response = await fetch(source)
    if (!response.ok)
      throw new Error(`the base's ${file} answered ${response.status}`)
    const into = path.join(out, 'base', file)
    await mkdir(path.dirname(into), { recursive: true })
    await writeFile(into, Buffer.from(await response.arrayBuffer()))
    return into
  }

  const sheets = []
  for (const id of [...new Set(record.stills.map((one) => one.id))]) {
    const file = `${id}-volume.png`
    const earlier = await local(baseSource(base, file), file)
    const tiles = [
      ...tileArgs(
        earlier,
        base === null
          ? 'no earlier phase'
          : earlier === null
            ? `${before}: no plate`
            : `${before}, the volume`,
      ),
      ...tileArgs(path.join(dir, file), `${now}, the volume`),
    ]
    const deck = record.stills.find(
      (one) => one.id === id && one.arm === 'deck',
    )
    if (deck !== undefined)
      tiles.push(...tileArgs(path.join(dir, deck.file), `${now}, the deck`))
    const sheet = path.join(out, `${id}.png`)
    await run('magick', [...tiles, '+append', sheet], { maxBuffer: 1 << 24 })
    sheets.push({ id, file: path.relative(dir, sheet) })
  }

  /*
   * A cast's sheet: the frame halfway along its path, clouds off beside
   * clouds on, each labeled with its rate. The frames are the screencast's
   * own, numbered from 0 as `drive.mjs` writes them.
   */
  for (const cast of CASTS) {
    const taken = [false, true].map((clouds) => {
      const match = (one) =>
        one.id === cast.id && one.speed === cast.speed && one.clouds === clouds
      return {
        kept: record.casts.find(match),
        refused: (record.refused ?? []).find(match),
      }
    })
    // A sheet needs one kept arm; a refused arm is a labeled blank beside it.
    if (taken.every((one) => one.kept === undefined)) continue
    const tiles = taken.flatMap(({ kept: one, refused }) => {
      if (one === undefined)
        return tileArgs(
          null,
          refused === undefined
            ? `${now}: not taken`
            : `${now}, ${refusedLabel(refused)}`,
        )
      const frame = path.join(
        dir,
        one.name,
        `${String(Math.floor((one.frames - 1) / 2)).padStart(4, '0')}.jpg`,
      )
      return tileArgs(
        existsSync(frame) ? frame : null,
        `${now}, ${castLabel(one)}`,
      )
    })
    const sheet = path.join(out, `${cast.id}-${cast.speed}.png`)
    await run('magick', [...tiles, '+append', sheet], { maxBuffer: 1 << 24 })
    sheets.push({
      id: cast.id,
      speed: cast.speed,
      file: path.relative(dir, sheet),
    })
  }

  const pairs = []
  for (const cast of CASTS) {
    const name = castName(cast, true)
    const clip = path.join(dir, name, 'cast.mp4')
    const earlier = await local(
      baseSource(base, `${name}/cast.mp4`),
      `${name}/cast.mp4`,
    )
    if (!existsSync(clip) || earlier === null) continue
    const pair = path.join(out, `${name}.pair.mp4`)
    await run(
      'ffmpeg',
      [
        '-y',
        '-i',
        earlier,
        '-i',
        clip,
        '-filter_complex',
        // One height, so hstack accepts them; the base on the left.
        `[0:v]scale=-2:${SHEET_HEIGHT}[a];[1:v]scale=-2:${SHEET_HEIGHT}[b];[a][b]hstack=inputs=2:shortest=1`,
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        pair,
      ],
      { maxBuffer: 1 << 24 },
    )
    pairs.push({
      id: cast.id,
      speed: cast.speed,
      file: path.relative(dir, pair),
    })
  }

  const media = `${mediaRows(record, sheets, pairs)}\n`
  await writeFile(path.join(dir, 'media.md'), media)
  console.log(
    `${sheets.length} sheets and ${pairs.length} cast pairs in ${out}; media.md beside them`,
  )
  return { sheets, pairs, media }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      base: { type: 'string' },
    },
  })
  if (values.dir === undefined) {
    console.error(
      'node scripts/weather/sheet.mjs --dir <capture> [--base <dir|record>]',
    )
    process.exit(1)
  }
  await buildSheets({ dir: values.dir, base: values.base ?? null }).catch(
    (error) => {
      console.error(error.message)
      process.exit(1)
    },
  )
}
