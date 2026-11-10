/*
 * Build each seat's packet for one round of the blind picture panel
 * (weather rubric §3.2 to §3.5, phase 1 design §8.6).
 *
 *   node scripts/panel/packet.mjs --round <id> --kind calibration|judged
 *     --seed <text> --out <dir> --photos <candidates dir>
 *     --baseline <as-built record.json>     phase 0's plates: low anchor, deck
 *     --record <record.json> ...            plates by their role
 *     [--experiment <record.json>]          its candidates are the experiment
 *     [--deck <record.json>]                take the deck arm from this one only
 *     [--guard-base <record.json>]          a moved guard's last accepted plate
 *     [--anchors <dir>]                      the real-time anchor stills
 *     [--references <md>] [--only e1,g1]
 *     [--seats a,b,c] [--allow <path prefix>] ...
 *
 * **A packet holds everything a seat sees and nothing else.** Per scene: the
 * arms as lettered images, each the full plate at packet size and a crop at
 * native pixels; the scene's frozen photographs with their captions, less
 * the one withheld from that seat; and the brief. What a letter is lives in
 * `keys/<seat>.json`, beside the packets and never in one, and the packets'
 * directories are named by a hash, so a seat's path names neither its seat
 * nor the round.
 *
 * **Blind means nothing but the pixels tells one arm from another.** Every
 * arm is decoded and written again as an 8-bit sRGB PNG with no metadata,
 * a photograph arm included, so neither a file's type, its EXIF nor its
 * name says which arm it is. Letters are drawn per seat and per round from
 * the seed, and a seat whose letters came out the same as another's is
 * drawn again: two seats sharing a layout share a position effect.
 *
 * **The same seed gives the same bytes.** Draws are SHA-256 of the seed and
 * a counter, never `Math.random`, and nothing written carries a time, so a
 * round can be rebuilt to show what its seats were given.
 *
 * **The controls (rubric §3.3)** are a duplicate pair, the low anchor (phase
 * 0's plate) and a photograph withheld from the seat's own references, each
 * once a seat in a scene the seed chooses. The calibration round shows the
 * low anchor and a withheld photograph in every scene, because what it
 * fixes the bar from is those and the real-time anchor stills (§3.5).
 *
 * **Plates come from capture records** (design §3.8), read as the capture
 * writes them: each still is refused by the capture's own `checkTake`, so
 * the record's form is decided in one place, and a plate is refused when
 * its role, rig, stance, fixtures or processing cannot stand in its arm.
 * Phase 0's baseline record predates the role and the provenance;
 * `adaptBaseline` supplies them and names each field it supplied, and
 * `round.json` carries that list.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { CORNERSTONES } from '../../packages/devtools/src/index.ts'
import { RIG, STILLS, tagOf } from '../weather/capture.mjs'
import { checkTake } from '../weather/sheet.mjs'
import { HARNESS_FILES, PICTURES, rulesOf, skeletonOf } from './validate.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HERE = path.join(ROOT, 'scripts/panel')

export const SEATS = Object.freeze(['seat-1', 'seat-2', 'seat-3'])

/** The overlay guard (rubric §2): judged as a guard, scored at F. */
export const OVERLAY_GUARD = 'weather-guard-station'

/** The processing mode every plate of a round is taken under (rubric §3.2). */
export const PROCESSING = 'enhanced'

/** The fields every plate's record carries (design §3.8). */
export const PROVENANCE = Object.freeze([
  'commit',
  'clean',
  'stance',
  'fixtures',
  'processing',
  'levers',
  'role',
])

/** The record roles that can stand in each arm. */
export const ARM_ROLES = Object.freeze({
  candidate: ['candidate'],
  experiment: ['candidate'],
  'last-accepted': ['last-accepted'],
  deck: ['deck'],
  'low-anchor': ['low-anchor'],
  new: ['guard-pair', 'candidate'],
  old: ['guard-pair', 'last-accepted', 'deck'],
})

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hashFile = async (file) => sha256(await readFile(file))
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/** JSON with its keys sorted, so a hash of it does not depend on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}

// ---------------------------------------------------------------- the seed

/** A stream of uniform draws in [0, 1) from the seed and a purpose. */
export function drawer(...parts) {
  let counter = 0
  return () =>
    createHash('sha256')
      .update(JSON.stringify([...parts, counter++]))
      .digest()
      .readUInt32BE(0) /
    2 ** 32
}

export function shuffle(list, draw) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const pick = (list, draw) => list[Math.floor(draw() * list.length)]

// ------------------------------------------------------------ references.md

const cells = (line) =>
  line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1])

/** The `## ` sections of a Markdown file, by title. */
function sectionsOf(text) {
  const sections = []
  for (const line of text.split('\n')) {
    if (line.startsWith('## '))
      sections.push({ title: line.slice(3), lines: [] })
    else sections.at(-1)?.lines.push(line)
  }
  return sections
}

/** A Markdown table's rows as objects keyed by its header. */
function tableOf(lines) {
  const rows = lines.filter((line) => line.startsWith('|'))
  if (rows.length < 2) return []
  // A header may carry a note in parentheses, as the frozen set's `Files` does.
  const header = cells(rows[0]).map((cell) => cell.split(' (')[0])
  return rows
    .slice(2)
    .map((row) =>
      Object.fromEntries(cells(row).map((cell, i) => [header[i], cell])),
    )
}

/** The bullets under a lead-in line, continuation lines joined. */
function bulletsAfter(lines, lead) {
  const start = lines.findIndex((line) => line.startsWith(lead))
  const bullets = []
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.startsWith('- ')) bullets.push(line.slice(2))
    else if (line.startsWith('  ') && bullets.length > 0)
      bullets[bullets.length - 1] += ` ${line.trim()}`
  }
  return bullets
}

/**
 * The frozen photographs, their captions and notes, and the real-time
 * anchor stills, from `design/plans/weather/references.md`.
 *
 * The frozen set is the table at the top, each picture's files in rank
 * order. A photograph's caption is its capture line, which carries its lens
 * or field, and its "misleads" note (rubric §3.1). The anchors are read by
 * `parseAnchors`. The dated notes are about the file, not the photographs,
 * and stay out of a brief.
 */
export function parseReferences(text) {
  const sections = sectionsOf(text)
  const frozen = sections.find((one) => one.title === 'The frozen set')
  if (frozen === undefined) throw new Error('references.md has no frozen set')
  const rows = new Map()
  for (const section of sections.filter((one) => /^[EG]\d /.test(one.title)))
    for (const row of tableOf(section.lines)) rows.set(ticked(row.File)[0], row)
  const pictures = {}
  for (const row of tableOf(frozen.lines)) {
    pictures[row.Picture.toLowerCase()] = ticked(row.Files).map((file) => {
      const found = rows.get(file)
      if (found === undefined)
        throw new Error(`references.md freezes ${file} and lists no row for it`)
      const [, misleads = ''] = found['Shows / misleads'].split('**Misleads:**')
      return {
        file,
        sha256: ticked(found['SHA-256'])[0],
        caption: `${found.Capture}. Misleads: ${misleads.trim()}`,
      }
    })
  }
  const anchors = parseAnchors(text)
  const notes = bulletsAfter(
    frozen.lines,
    "What the panel's brief carries",
  ).filter((note) => !/^\*\*\d{4}-\d{2}-\d{2}/.test(note))
  return { pictures, anchors, notes }
}

/**
 * The real-time anchor stills by picture tag, from references.md's table
 * whose header has both `Picture` and `SHA-256`, the one table there that
 * does. The file is the `File` cell's code span; a row with none ("no
 * matched anchor") records that its picture has none. The other columns
 * ride along into the round's record. An anchor is never captioned in a
 * packet: it is an arm, and a caption would name it.
 */
export function parseAnchors(text) {
  const anchors = {}
  const blocks = text.split(/\n(?!\|)/).map((block) => block.split('\n'))
  for (const lines of blocks) {
    const rows = tableOf(lines)
    if (!rows[0] || !('Picture' in rows[0]) || !('SHA-256' in rows[0])) continue
    for (const row of rows) {
      const tag = row.Picture.toLowerCase()
      const [file] = ticked(row.File)
      anchors[tag] ??= []
      if (file === undefined) continue
      const { Picture: _, File: __, 'SHA-256': hash, ...about } = row
      anchors[tag].push({ file, sha256: ticked(hash)[0], about })
    }
  }
  return anchors
}

// ------------------------------------------------------------------ records

/**
 * A record's levers as `{ hash, size }`: the capture writes that, and the
 * baseline adapter a bare hash with no size, which is read as one. The
 * deck's null stays null.
 */
const leversOf = (levers) =>
  typeof levers === 'string' ? { hash: levers, size: null } : levers

/**
 * One plate per still of a record, its provenance read field by field. A
 * capture record's stills are held to `checkTake` first; `adapted` names
 * the baseline adapter's record, whose role and levers are the adapter's
 * own and which `checkTake` would refuse for that alone.
 */
export function platesOf(record, file, { adapted = false } = {}) {
  return record.stills.map((still) => {
    if (!adapted)
      try {
        checkTake(still)
      } catch (error) {
        throw new Error(`${file}: ${still.id} (${still.arm}): ${error.message}`)
      }
    const plate = {
      picture: still.id,
      file: path.resolve(path.dirname(file), still.file),
      sha256: still.sha256,
      rig: record.rig,
      record: file,
    }
    for (const field of PROVENANCE) {
      const value = field in still ? still[field] : record[field]
      if (value === undefined)
        throw new Error(
          `${file}: ${still.id} (${still.arm}) has no ${field}; a record missing a field is refused (design §3.8)`,
        )
      plate[field] = value
    }
    plate.processing = plate.processing?.mode ?? plate.processing
    plate.role = plate.role?.name ?? plate.role
    plate.levers = leversOf(plate.levers)
    return plate
  })
}

/**
 * Read phase 0's baseline record as it was taken, before the record carried
 * a role or provenance. Each field supplied is named in `supplied`, which
 * goes into the round's own record.
 */
export function adaptBaseline(record, { cornerstones, cornerstonesHash }) {
  if (record.stills.some((still) => 'role' in still))
    throw new Error('the record carries roles already: read it as it stands')
  const supplied = [
    'role: the volume arm is phase 0’s plate, the low anchor; the deck arm is the deck',
    'commit: the still’s own taken.commit, which is the bundle it was drawn by',
    'clean: the record’s',
    'stance: the preset of that id in this tree’s cornerstones.json',
    'fixtures: the record’s references hash, and this tree’s cornerstones.json',
    'processing: the preset’s processing mode',
    'levers: SHA-256 of read.clouds.levers as canonical JSON; null on the deck, which draws no volume',
  ]
  const stills = record.stills.map((still) => {
    const preset = cornerstones.find((one) => one.id === still.id)
    if (preset === undefined)
      throw new Error(`${still.id} is not a cornerstone of this tree`)
    const levers = still.read?.clouds?.levers
    return {
      ...still,
      role: still.arm === 'deck' ? 'deck' : 'low-anchor',
      commit: still.taken?.commit ?? record.commit,
      clean: record.clean,
      stance: {
        id: preset.id,
        address: preset.address,
        time: preset.time,
        framing: preset.framing,
        lens: preset.lens,
      },
      fixtures: {
        references: record.references,
        cornerstones: cornerstonesHash,
      },
      processing: preset.processing.mode,
      levers: levers ? sha256(canonical(levers)) : null,
    }
  })
  return { record: { ...record, stills }, supplied }
}

/**
 * A guard is the overlay guard, by its id, or a preset that is no
 * cornerstone and moved (rubric §3.8). The overlay guard is in `STILLS`,
 * since the capture takes it as a still, so absence from that list does not
 * find it.
 */
const isGuard = (picture) =>
  picture === OVERLAY_GUARD || !STILLS.includes(picture)

/**
 * The arm a plate stands in, by the flag its record came under. A guard's
 * deck plate is its first accepted plate (design §3.8), so it stands as the
 * old plate beside the volume's new one until a `--guard-base` names a later.
 */
function armOf(plate, as) {
  if (as === 'guard-base') return 'old'
  if (isGuard(plate.picture)) return plate.role === 'deck' ? 'old' : 'new'
  if (as === 'experiment') return 'experiment'
  return plate.role
}

/** Refuse a plate that cannot stand in its arm (design §8.6, "The arms"). */
export function checkArm(plate, arm, { references }) {
  const refuse = (why) => {
    throw new Error(
      `${plate.record}: ${plate.picture} cannot be the ${arm}: ${why}`,
    )
  }
  if (!(arm in ARM_ROLES)) refuse(`a ${plate.role} has no arm in a round`)
  if (!ARM_ROLES[arm].includes(plate.role)) refuse(`its role is ${plate.role}`)
  if (canonical(plate.rig) !== canonical(RIG))
    refuse(`its rig is ${canonical(plate.rig)}, not the rubric's`)
  if (plate.stance?.id !== plate.picture)
    refuse(`its stance is ${plate.stance?.id}`)
  if (plate.processing !== PROCESSING)
    refuse(`it was taken under ${plate.processing}`)
  // A plate is compared only under the references it was taken with
  // (rubric §3.2). A record taken before references.md last changed is
  // retaken, never let through: phase 0's baseline is retaken in the next
  // machine window, on the capture's second pass.
  if (plate.fixtures?.references !== references)
    refuse(
      `its record carries references.md at ${plate.fixtures?.references}, and the file is ${references} now. ` +
        'A plate is compared only under the references it was taken with; the baseline is retaken in the next machine window, on the capture’s second pass',
    )
}

/**
 * Every scene of the round and the plates in its arms. `inputs` are
 * `{ file, record, as }`, `as` one of `record`, `experiment`, `deck` and
 * `guard-base`.
 */
export function gather(inputs, { kind, only, references }) {
  const deckNamed = inputs.some((input) => input.as === 'deck')
  const guardBased = inputs.some((input) => input.as === 'guard-base')
  const scenes = new Map()
  for (const { file, record, as, supplied } of inputs) {
    const adapted = supplied !== undefined
    for (const plate of platesOf(record, file, { adapted })) {
      const arm = armOf(plate, as)
      if (deckNamed && arm === 'deck' && as !== 'deck') continue
      if (as === 'deck' && arm !== 'deck') continue
      // A guard's last accepted plate, named, stands in place of its first.
      if (guardBased && arm === 'old' && as !== 'guard-base') continue
      const tag = isGuard(plate.picture) ? null : tagOf(plate.picture)
      if (tag && only && !only.includes(tag)) continue
      checkArm(plate, arm, { references })
      const scene = scenes.get(plate.picture) ?? {
        picture: plate.picture,
        tag,
        arms: {},
      }
      if (scene.arms[arm])
        throw new Error(
          `two plates for ${plate.picture}'s ${arm}: ${scene.arms[arm].record} and ${file}`,
        )
      scene.arms[arm] = plate
      scenes.set(plate.picture, scene)
    }
  }
  const all = [...scenes.values()]
  for (const scene of all) requireArms(scene, kind)
  return all.sort((a, b) => (a.picture < b.picture ? -1 : 1))
}

function requireArms(scene, kind) {
  const { picture, tag, arms } = scene
  const need = (arm, why) => {
    if (!arms[arm]) throw new Error(`${picture} has no ${arm} plate: ${why}`)
  }
  if (tag === null) {
    scene.kind = 'guard'
    need('new', 'a guard is a pair')
    need('old', 'a guard is a pair')
    return
  }
  scene.kind = 'still'
  need('low-anchor', 'every still picture carries phase 0’s plate')
  if (tag.startsWith('e')) need('deck', 'E1 to E3 carry the deck')
  const candidates = ['candidate', 'experiment', 'last-accepted']
  if (kind === 'calibration' && candidates.some((arm) => arms[arm]))
    throw new Error(
      `${picture}: the calibration round runs before any candidate plate exists`,
    )
  if (kind === 'judged') need('candidate', 'a judged round judges one')
}

// -------------------------------------------------------------- the layout

/**
 * One seat's scenes: the arms in lettered order, and the references it is
 * shown. Each source is `{ arm, sha256, file, of? }`.
 */
function layoutOf(round, scenes, photos, seat, attempt) {
  const draw = drawer(round.seed, round.round, seat, attempt)
  const stills = scenes.filter((scene) => scene.kind === 'still')
  const everyScene = round.kind === 'calibration'
  const lowAnchorAt = everyScene ? null : pick(stills, draw).picture
  const photographAt = everyScene ? null : pick(stills, draw).picture
  const duplicateAt = pick(stills, draw).picture
  return scenes.map((scene) => {
    const sources = Object.entries(scene.arms)
      .filter(
        ([arm]) =>
          arm !== 'low-anchor' || everyScene || lowAnchorAt === scene.picture,
      )
      .map(([arm, plate]) => ({ arm, sha256: plate.sha256, file: plate.file }))
    for (const anchor of scene.anchors ?? [])
      sources.push({
        arm: 'anchor',
        sha256: anchor.sha256,
        file: anchor.path,
        own: anchor.crops,
      })
    let references = photos[scene.picture] ?? []
    if (everyScene || photographAt === scene.picture) {
      const withheld = references[draw() < 0.5 ? 0 : 1]
      sources.push({
        arm: 'photograph',
        sha256: withheld.sha256,
        file: withheld.path,
      })
      references = references.filter((one) => one !== withheld)
    }
    if (duplicateAt === scene.picture) {
      const twin = pick(
        sources.filter((one) => one.arm !== 'photograph'),
        draw,
      )
      sources.push({ ...twin, arm: 'duplicate', twin })
    }
    return { scene, sources: shuffle(sources, draw), references }
  })
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const signature = (layout) =>
  canonical(layout.map((one) => one.sources.map((s) => [s.arm, s.sha256])))

/** Each seat's layout, drawn again until no two seats share one. */
export function layouts(round, scenes, photos) {
  const seen = new Set()
  return round.seats.map((seat) => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const layout = layoutOf(round, scenes, photos, seat, attempt)
      if (!seen.has(signature(layout))) {
        seen.add(signature(layout))
        return { seat, layout }
      }
    }
    throw new Error('the scenes are too few to give each seat its own letters')
  })
}

// ------------------------------------------------------------------ images

/** A crop's pixel rectangle in a frame of `width` × `height`. */
export function rectOf(crop, width, height) {
  const left = Math.round(crop.x * width)
  const top = Math.round(crop.y * height)
  return {
    left,
    top,
    width: Math.min(Math.round(crop.w * width), width - left),
    height: Math.min(Math.round(crop.h * height), height - top),
  }
}

/**
 * Every image meets the seat in a cell of one size: the full frame in the
 * rig's CSS frame, a crop in the rectangle that crop cuts from the rig's
 * native frame. A larger image is scaled down into its cell and a smaller
 * one is never scaled up; it sits at its own size, centered on the cell's
 * ground. So a 4K anchor and a 1,000 px one meet the seat at one size, and
 * no image's dimensions tell it from the plates beside it. The ground is a
 * dark neutral gray, which no plate's sky or night side is mistaken for.
 */
export const GROUND = Object.freeze({ r: 64, g: 64, b: 64 })
export const FULL_CELL = Object.freeze({ width: RIG.width, height: RIG.height })
export const cropCell = (crop) => {
  const { width, height } = rectOf(
    crop,
    RIG.width * RIG.dpr,
    RIG.height * RIG.dpr,
  )
  return { width, height }
}

const pixelRect = ({ x, y, w, h }) => ({ left: x, top: y, width: w, height: h })

async function inCell(pipeline, cell) {
  const { data, info } = await pipeline
    .resize({ ...cell, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })
  // A composite always writes an alpha channel; the second pass takes it
  // out, so every image is the same 8-bit RGB whatever stood in its cell.
  const placed = await sharp({
    create: { ...cell, channels: 3, background: GROUND },
  })
    .composite([
      {
        input: data,
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels,
        },
        left: Math.floor((cell.width - info.width) / 2),
        top: Math.floor((cell.height - info.height) / 2),
      },
    ])
    .raw()
    .toBuffer({ resolveWithObject: true })
  return sharp(placed.data, { raw: placed.info }).removeAlpha().png().toBuffer()
}

/**
 * One source as the packet shows it: the full frame, then each crop. `own`
 * is an anchor's own rectangles in its pixels, which replace the scene's
 * shared fractions for that image alone.
 */
async function render(file, crops, own = {}) {
  const { data, info } = await sharp(file)
    .rotate()
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const raw = () => sharp(data, { raw: info })
  const full = await inCell(raw(), FULL_CELL)
  const cut = {}
  for (const [name, crop] of Object.entries(crops))
    cut[name] = await inCell(
      raw().extract(
        own[name]
          ? pixelRect(own[name])
          : rectOf(crop, info.width, info.height),
      ),
      cropCell(crop),
    )
  return { full, crops: cut }
}

// ------------------------------------------------------------------- brief

/** The template's head, and its blocks by picture tag. */
export function parseTemplate(text) {
  const [head] = text.split('<!-- Picture notes')
  const blocks = {}
  for (const m of text.matchAll(
    /<!-- picture (\w+) -->\n([\s\S]*?)<!-- end -->/g,
  ))
    blocks[m[1]] = m[2].trim()
  return { head: head.trimEnd(), blocks }
}

function sceneText(entry, blocks) {
  const rules = rulesOf(entry)
  const lines = [
    `### \`${entry.scene}\``,
    '',
    blocks[entry.kind === 'guard' ? 'guard' : entry.tag],
  ]
  lines.push(
    '',
    `Lettered pictures: ${entry.images.map((one) => one.letter).join(', ')}.`,
  )
  const scored = rules.dimensions.map((d) =>
    rules.optional.includes(d) ? `${d} (when present)` : d,
  )
  lines.push(`Score: ${scored.join(', ')}, and overall.`)
  if (rules.rank.length > 0)
    lines.push(`Rank every picture, best first, on: ${rules.rank.join(', ')}.`)
  if (entry.kind === 'guard')
    lines.push('Say which picture is worse on: integration, artifacts.')
  if (entry.references.length > 0) lines.push('', 'Photographs:', '')
  entry.references.forEach((one, i) =>
    lines.push(`${i + 1}. \`${one.file}\`: ${one.caption}`),
  )
  return lines.join('\n')
}

export function briefOf(template, packet, { notes, allowed }) {
  const { head, blocks } = parseTemplate(template)
  const tags = packet.scenes.map((one) => one.scene.toUpperCase())
  const relevant = notes.filter((note) =>
    tags.some((tag) => note.includes(tag)),
  )
  return `${head
    .replace('{{cell}}', `${FULL_CELL.width} × ${FULL_CELL.height}`)
    .replace('{{allowed}}', allowed.map((one) => `\`${one}\``).join(', '))
    .replace(
      '{{scenes}}',
      packet.scenes.map((one) => sceneText(one, blocks)).join('\n\n'),
    )
    .replace(
      '{{notes}}',
      relevant.map((note) => `- ${note}`).join('\n') || 'None.',
    )
    .replace('{{example}}', skeletonOf(packet))}\n`
}

// ------------------------------------------------------------------- round

async function verified(dir, file, sha) {
  const full = path.join(dir, file)
  if (!existsSync(full)) throw new Error(`${full} is missing`)
  if ((await hashFile(full)) !== sha)
    throw new Error(`${full} does not hash to the frozen ${sha}`)
  return full
}

async function readInputs(options) {
  const inputs = []
  if (options.baseline) {
    const cornerstonesHash = await hashFile(
      path.join(ROOT, 'packages/devtools/src/cornerstones.json'),
    )
    const adapted = adaptBaseline(await readJson(options.baseline), {
      cornerstones: CORNERSTONES,
      cornerstonesHash,
    })
    inputs.push({
      file: options.baseline,
      record: adapted.record,
      as: 'record',
      supplied: adapted.supplied,
    })
  }
  const flags = [
    ['record', options.record ?? []],
    ['experiment', [options.experiment]],
    ['deck', [options.deck]],
    ['guard-base', [options.guardBase]],
  ]
  for (const [as, files] of flags)
    for (const file of files.filter(Boolean))
      inputs.push({ file, record: await readJson(file), as })
  return inputs
}

/** Every photograph and anchor of the round's scenes, read and checked. */
/**
 * An anchor's own crops from crops.json, refused unless they are frozen for
 * this very image, name exactly the picture's crops, and fit both the image
 * and the picture's crop cell, so the cut is never scaled.
 */
function anchorCrops(one, scene, { crops, anchors }) {
  const own = anchors[one.file]
  const names = Object.keys(crops[scene.picture] ?? {})
  const refuse = (why) => {
    throw new Error(`the anchor ${one.file} has ${why} in crops.json`)
  }
  if (own === undefined) refuse('no crop of its own')
  if (own.sha256 !== one.sha256 || own.picture !== scene.picture)
    refuse('a crop frozen for another image or picture')
  if (
    canonical(Object.keys(own).filter((k) => names.includes(k))) !==
    canonical(names)
  )
    refuse(`not the crops ${names.join(' and ')}`)
  const [width, height] = own.pixels
  for (const name of names) {
    const r = own[name]
    const cell = cropCell(crops[scene.picture][name])
    if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height)
      refuse(`a ${name} outside its ${width} × ${height} frame`)
    if (r.w > cell.width || r.h > cell.height)
      refuse(`a ${name} larger than its ${cell.width} × ${cell.height} cell`)
  }
  return Object.fromEntries(names.map((name) => [name, own[name]]))
}

async function sourcesOf(scenes, refs, options, cropsJson) {
  const photos = {}
  for (const scene of scenes.filter((one) => one.kind === 'still')) {
    photos[scene.picture] = []
    for (const one of refs.pictures[scene.tag] ?? [])
      photos[scene.picture].push({
        ...one,
        path: await verified(options.photos, one.file, one.sha256),
      })
    if (photos[scene.picture].length < 2)
      throw new Error(`${scene.picture} has fewer than two frozen photographs`)
    scene.anchors = []
    if (options.kind !== 'calibration') continue
    for (const one of refs.anchors[scene.tag] ?? [])
      scene.anchors.push({
        ...one,
        path: await verified(options.anchors, one.file, one.sha256),
        crops: anchorCrops(one, scene, cropsJson),
      })
  }
  return photos
}

async function writeSeat(out, round, { seat, layout }, context) {
  const id = sha256(`${round.seed}\0${round.round}\0${seat}`).slice(0, 12)
  const dir = path.join(out, 'packets', id)
  const key = { packet: id, seat, scenes: {}, references: {} }
  const packet = {
    format: 'inertialref/panel-packet',
    version: 1,
    scenes: [],
    review: 'review.json',
  }
  for (const { scene, sources, references } of layout) {
    const name = sceneNameOf(scene)
    const crops = context.crops[scene.picture] ?? {}
    await mkdir(path.join(dir, name, 'references'), { recursive: true })
    const letters = new Map(sources.map((one, i) => [one, LETTERS[i]]))
    const images = []
    key.scenes[name] = {}
    for (const [source, letter] of letters) {
      const drawn = await context.render(
        source.file,
        source.sha256,
        crops,
        source.own,
      )
      const full = `${name}/${letter}.png`
      await writeFile(path.join(dir, full), drawn.full)
      const cut = []
      for (const [crop, data] of Object.entries(drawn.crops)) {
        cut.push(`${name}/${letter}.${crop}.png`)
        await writeFile(path.join(dir, cut.at(-1)), data)
      }
      images.push({ letter, full, crops: cut })
      const of = source.twin && letters.get(source.twin)
      key.scenes[name][letter] = {
        arm: source.arm,
        sha256: source.sha256,
        ...(of ? { of } : {}),
      }
    }
    const shown = []
    for (const [i, one] of references.entries()) {
      const file = `${name}/references/${i + 1}.png`
      const drawn = await context.render(one.path, one.sha256, {})
      await writeFile(path.join(dir, file), drawn.full)
      shown.push({ file, caption: one.caption })
    }
    key.references[name] = references.map((one) => one.file)
    packet.scenes.push({
      scene: name,
      tag: scene.tag,
      kind: scene.kind,
      images,
      references: shown,
    })
  }
  await writeFile(
    path.join(dir, 'packet.json'),
    `${JSON.stringify(packet, null, 2)}\n`,
  )
  await writeFile(
    path.join(dir, 'brief.md'),
    briefOf(context.template, packet, context),
  )
  await writeFile(
    path.join(out, 'keys', `${seat}.json`),
    `${JSON.stringify(key, null, 2)}\n`,
  )
  const task = `You are a judge in a blind review of rendered pictures. Open ${path.join(dir, 'brief.md')}, read it whole, and follow it exactly. Write your answer to ${path.join(dir, 'review.json')}.\n`
  await writeFile(path.join(out, 'tasks', `${seat}.md`), task)
}

/** A scene's folder in a packet: the still's tag, or the guard's name. */
export const sceneNameOf = (scene) =>
  scene.tag ?? scene.picture.replace(/^weather-/, '')

const PLATE_FIELDS = ['file', 'sha256', 'role', 'commit', 'levers']

/**
 * What a picture's anchors were, for the round's record. A picture with
 * none says so (rubric §3.5). E2's still is matched to its terminator crop
 * alone, so its band is recorded as unmatched too (references.md, "The
 * real-time anchor").
 */
function anchorRecord(scene) {
  // The local path differs by machine; the record keeps the file and hash.
  const stills = scene.anchors.map(({ file, sha256: hash, about, crops }) => ({
    file,
    sha256: hash,
    crops,
    about,
  }))
  const unmatched =
    stills.length === 0
      ? 'no matched anchor'
      : PICTURES[scene.tag].terminator
        ? 'the band: no matched anchor; the stills match the terminator crop'
        : null
  return { stills, unmatched }
}

function sceneRecord(scene, photos, kind) {
  return {
    scene: sceneNameOf(scene),
    picture: scene.picture,
    kind: scene.kind,
    arms: Object.fromEntries(
      Object.entries(scene.arms).map(([arm, plate]) => [
        arm,
        Object.fromEntries(PLATE_FIELDS.map((k) => [k, plate[k]])),
      ]),
    ),
    photographs: (photos[scene.picture] ?? []).map((one) => ({
      file: one.file,
      sha256: one.sha256,
    })),
    anchors:
      scene.kind === 'still' && kind === 'calibration'
        ? anchorRecord(scene)
        : null,
  }
}

/** Build a round's packets, keys, tasks and record in `out`. */
export async function buildRound(options) {
  const out = path.resolve(options.out)
  if (existsSync(out) && (await readdir(out)).length > 0)
    throw new Error(`${out} is not empty: a round's packets are written once`)
  const referencesFile =
    options.references ?? path.join(ROOT, 'design/plans/weather/references.md')
  const refs = parseReferences(await readFile(referencesFile, 'utf8'))
  const references = await hashFile(referencesFile)
  const inputs = await readInputs(options)
  const scenes = gather(inputs, {
    kind: options.kind,
    only: options.only,
    references,
  })
  if (!scenes.some((scene) => scene.kind === 'still'))
    throw new Error('a round needs at least one still picture')
  const cropsJson = await readJson(
    options.crops ?? path.join(HERE, 'crops.json'),
  )
  const crops = cropsJson.crops
  const photos = await sourcesOf(scenes, refs, options, cropsJson)
  const templateFile = options.template ?? path.join(HERE, 'brief.template.md')
  const round = {
    format: 'inertialref/panel-round',
    version: 1,
    round: options.round,
    kind: options.kind,
    seed: options.seed,
    seats: options.seats ?? SEATS,
    allowed: options.allow ?? HARNESS_FILES,
  }
  const cache = new Map()
  const context = {
    crops,
    notes: refs.notes,
    allowed: round.allowed,
    template: await readFile(templateFile, 'utf8'),
    render: (file, sha, picked, own) => {
      const id = `${sha}:${canonical([picked, own ?? null])}`
      if (!cache.has(id)) cache.set(id, render(file, picked, own))
      return cache.get(id)
    },
  }
  for (const dir of ['packets', 'keys', 'tasks'])
    await mkdir(path.join(out, dir), { recursive: true })
  for (const seat of layouts(round, scenes, photos))
    await writeSeat(out, round, seat, context)
  const record = {
    ...round,
    references: { file: referencesFile, sha256: references },
    crops: sha256(canonical(cropsJson)),
    template: await hashFile(templateFile),
    records: await Promise.all(
      inputs.map(async (one) => ({
        file: one.file,
        as: one.as,
        sha256: await hashFile(one.file),
        supplied: one.supplied ?? null,
      })),
    ),
    scenes: scenes.map((scene) => sceneRecord(scene, photos, round.kind)),
  }
  await writeFile(
    path.join(out, 'round.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  return record
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      round: { type: 'string' },
      kind: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      photos: { type: 'string' },
      anchors: { type: 'string' },
      references: { type: 'string' },
      baseline: { type: 'string' },
      record: { type: 'string', multiple: true },
      experiment: { type: 'string' },
      deck: { type: 'string' },
      'guard-base': { type: 'string' },
      only: { type: 'string' },
      seats: { type: 'string' },
      allow: { type: 'string', multiple: true },
    },
  })
  const missing = ['round', 'kind', 'seed', 'out', 'photos'].filter(
    (k) => values[k] === undefined,
  )
  if (missing.length > 0 || !['calibration', 'judged'].includes(values.kind)) {
    console.error(
      'node scripts/panel/packet.mjs --round <id> --kind calibration|judged --seed <text> --out <dir> --photos <dir> --baseline <record> [--record <record> …]',
    )
    process.exit(1)
  }
  const resolve = (file) => file && path.resolve(file)
  try {
    const round = await buildRound({
      ...values,
      out: resolve(values.out),
      photos: resolve(values.photos),
      anchors: resolve(values.anchors),
      references: resolve(values.references),
      baseline: resolve(values.baseline),
      record: values.record?.map(resolve),
      experiment: resolve(values.experiment),
      deck: resolve(values.deck),
      guardBase: resolve(values['guard-base']),
      only: values.only?.split(','),
      seats: values.seats?.split(','),
    })
    console.log(
      `${round.seats.length} packets of ${round.scenes.length} scenes in ${values.out}`,
    )
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
