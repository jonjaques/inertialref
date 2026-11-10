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
 *
 * **It refuses a record a take of which lacks its provenance or its role**
 * (phase 1 design §3.8), as the panel's packet builder and `castSteps` do:
 * `RECORD_FIELDS` is the list, and `checkRecord` the one reading of it. A
 * plate whose commit, stance, fixtures, processing, levers or role is not
 * on record cannot be matched to anything, so it is laid beside nothing.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { verticalFov } from '../../packages/rendering/src/index.ts'
import { armsOfCast, castName, CASTS } from './descent.mjs'

const run = promisify(execFile)

/**
 * The roles a take can have (§3.8), each with what its comparison differs
 * by on purpose. A candidate and a guard pair differ from their comparator
 * by the commit and the levers alone, which the record already names.
 */
export const ROLES = Object.freeze({
  candidate: [],
  deck: ['no ?clouds=1: the textured deck, not the volume'],
  'last-accepted': [],
  'low-anchor': ['phase 0’s light on the placeholder density'],
  'guard-pair': [],
  'clouds-off': ['levers.on false'],
  'injected-defect': [],
  'reference-run': ['another boot of the same take'],
  'settled-sample': ['the path held at one frame and settled: no motion'],
})

/**
 * What every take in a record carries (§3.8), and a cast its rate besides:
 * the commit and whether the tree was clean, the stance as the page
 * resolved it, the fixtures' hashes, the processing mode, the levers' hash
 * at the capture's size, and the role with its differences.
 */
export const RECORD_FIELDS = Object.freeze([
  'commit',
  'clean',
  'stance',
  'fixtures',
  'processing',
  'levers',
  'role',
])

/** Refuse a take that lacks a field of the record, naming the take and the field. */
export function checkTake(take, cast = false) {
  const name = take?.name ?? take?.file ?? take?.id ?? 'a take'
  const refuse = (why) => {
    throw new Error(`${name}: ${why}; the record is refused`)
  }
  for (const field of [...RECORD_FIELDS, ...(cast ? ['rate'] : [])])
    if (take?.[field] === undefined) refuse(`it carries no ${field}`)
  if (typeof take.stance?.id !== 'string') refuse('its stance names no preset')
  for (const fixture of ['references', 'cornerstones'])
    if (!(fixture in (take.fixtures ?? {})))
      refuse(`its fixtures carry no ${fixture} hash`)
  if (typeof take.levers?.hash !== 'string') refuse('its levers carry no hash')
  if (!Object.hasOwn(ROLES, take.role?.name))
    refuse(
      `its role ${JSON.stringify(take.role?.name)} is not one of the record's`,
    )
  if (!Array.isArray(take.role.differences))
    refuse('its role names no differences')
  if (cast && typeof take.rate?.hz !== 'number')
    refuse('its rate carries no presented rate')
  return take
}

/** Every take of a record, each refused as `checkTake` refuses it. */
export function checkRecord(record) {
  for (const take of [
    ...(record.stills ?? []),
    ...(record.twice ?? []),
    ...(record.samples ?? []),
  ])
    checkTake(take)
  for (const take of record.casts ?? []) checkTake(take, true)
  return record
}

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * The levers as resolved at the capture's size (§4.6): their hash, in a key
 * order that does not depend on the order the page wrote them, beside the
 * scene target they were resolved for. A page without the flag has no
 * levers, and says so in the same field.
 */
export function leverHash(clouds) {
  if (clouds === null || clouds === undefined)
    return { hash: digest(null), size: null }
  const sorted = Object.fromEntries(
    Object.entries(clouds.levers).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  const size = clouds.extents?.render ?? null
  return { hash: digest({ levers: sorted, size }), size }
}

/** A take's provenance and role (§3.8), from what its page read back. */
export function provenance(run, id, read, role, rate = undefined) {
  return {
    commit: run.commit,
    clean: run.clean,
    stance: {
      id,
      address: read?.stance?.address ?? null,
      pose: {
        state: read?.stance?.state ?? null,
        look: read?.stance?.look ?? null,
        surface: read?.stance?.surface ?? null,
      },
      lens: read?.lens ?? null,
      time: read?.time ?? null,
    },
    fixtures: run.fixtures,
    processing: read?.processing ?? null,
    levers: leverHash(read?.clouds),
    role,
    ...(rate === undefined ? {} : { rate }),
  }
}

/** A role by name, with the differences its comparison exists to make. */
export const role = (name, more = []) => ({
  name,
  differences: [...ROLES[name], ...more],
})

/** The rig's plate (rubric §3.2), CSS pixels and the ratio: `capture.mjs`'s `RIG` is built on it. */
export const PLATE = Object.freeze({ width: 1440, height: 900, dpr: 2 })

/**
 * The sun in a still's camera, and where its antisolar point falls on the
 * plate: what the glory profiler centers its rings on. `ir.light()` gives
 * the sun's elevation and phase angle, which do not say which way it lies;
 * the stance's heading and pitch with the sun's elevation and azimuth over
 * the place do. In the camera's axes, x right, y up, z forward; the pixel is
 * the rig's plate, 2880 × 1800, from its top left. Null for a picture with
 * no surface stance or a turned head, and the antisolar pixel null where
 * the point is behind the camera.
 */
export function sunInFrame(read) {
  const stance = read?.stance?.surface
  const look = read?.stance?.look
  if (!stance || !read?.sun || !read?.lens) return null
  if (look && (look.yaw !== 0 || look.pitch !== 0)) return null
  const DEG = Math.PI / 180
  const [el, az, h, p] = [
    read.sun.elevation * DEG,
    read.sun.azimuth * DEG,
    stance.heading,
    stance.pitch,
  ]
  // East, north, up.
  const sun = [
    Math.cos(el) * Math.sin(az),
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
  ]
  const forward = [
    Math.cos(p) * Math.sin(h),
    Math.cos(p) * Math.cos(h),
    Math.sin(p),
  ]
  const right = [Math.cos(h), -Math.sin(h), 0]
  const up = [
    -Math.sin(p) * Math.sin(h),
    -Math.sin(p) * Math.cos(h),
    Math.cos(p),
  ]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const camera = [dot(sun, right), dot(sun, up), dot(sun, forward)]
  const tanV = Math.tan(verticalFov({ ...read.lens, focus: Infinity }) / 2)
  const tanH = (PLATE.width / PLATE.height) * tanV
  const [width, height] = [PLATE.width * PLATE.dpr, PLATE.height * PLATE.dpr]
  const [x, y, z] = camera.map((one) => -one)
  const antisolar =
    z > 0
      ? {
          x: (width / 2) * (1 + x / z / tanH),
          y: (height / 2) * (1 - y / z / tanV),
        }
      : null
  return {
    sunInCamera: camera,
    antisolar,
    inFrame:
      antisolar !== null &&
      antisolar.x >= 0 &&
      antisolar.x <= width &&
      antisolar.y >= 0 &&
      antisolar.y <= height,
  }
}

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

/**
 * The screencast frame nearest a path frame, by the instants: the frame
 * whose epoch-second instant is closest to the page's log entry for path
 * frame `k`. A clip's index is not a path frame: the tail and the
 * screencast's own pace move it, so two arms by index show two places on
 * the path side by side.
 */
export function shotOf(instants, log, k) {
  const at = log.find((entry) => entry.k === k)?.at
  if (at === undefined || instants.length === 0) return null
  let best = 0
  for (let i = 1; i < instants.length; i += 1)
    if (
      Math.abs(instants[i] * 1000 - at) < Math.abs(instants[best] * 1000 - at)
    )
      best = i
  return best
}

/** The frame a cast's sheet shows: halfway along its path, by the instants where it kept them. */
async function middleShot(dir, one) {
  const k = Math.floor((one.pathFrames ?? one.frames) / 2)
  const [instants, log] = ['timestamps.json', 'log.json'].map((file) =>
    path.join(dir, file),
  )
  if (existsSync(instants) && existsSync(log)) {
    const shot = shotOf(
      JSON.parse(await readFile(instants, 'utf8')),
      JSON.parse(await readFile(log, 'utf8')).log ?? [],
      k,
    )
    if (shot !== null) return shot
  }
  return Math.floor((one.frames - 1) / 2)
}

/** A cast's label: its speed, the clouds, its rate and the frames it dropped. */
export function castLabel(one) {
  const rate =
    typeof one.hz === 'number'
      ? `, ${one.hz.toFixed(1)} Hz${one.atSixty === false ? ', not held at 60' : ''}`
      : ''
  const dropped = one.dropped ?? []
  const own = dropped.filter((drop) => drop.cloudsOnly === true).length
  const drops =
    dropped.length === 0
      ? ''
      : `, ${dropped.length} dropped${own > 0 ? `, ${own} the clouds’` : ''}`
  return `${one.speed} ${one.clouds ? 'on' : 'off'}${rate}${drops}`
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
  const record = checkRecord(
    JSON.parse(await readFile(path.join(dir, 'record.json'), 'utf8')),
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
        clouds,
        kept: record.casts.find(match),
        refused: (record.refused ?? []).find(match),
      }
    })
    // A sheet needs one kept arm; a refused arm is a labeled blank beside it.
    if (taken.every((one) => one.kept === undefined)) continue
    const tiles = []
    for (const { clouds, kept: one, refused } of taken) {
      if (one === undefined) {
        tiles.push(
          ...tileArgs(
            null,
            refused !== undefined
              ? `${now}, ${refusedLabel(refused)}`
              : armsOfCast(cast).includes(clouds ? 'on' : 'off')
                ? `${now}: not taken`
                : `${now}: read against ${cast.control}`,
          ),
        )
        continue
      }
      const frame = path.join(
        dir,
        one.name,
        `${String(await middleShot(path.join(dir, one.name), one)).padStart(4, '0')}.jpg`,
      )
      tiles.push(
        ...tileArgs(
          existsSync(frame) ? frame : null,
          `${now}, ${castLabel(one)}`,
        ),
      )
    }
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
