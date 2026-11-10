/*
 * The panel's answer form, and the rules that read one answer on its own
 * (weather rubric §3.2 to §3.6, `design/plans/weather/mvp.md`).
 *
 *   node scripts/panel/validate.mjs <round dir>
 *
 * A seat writes `review.json` in its packet. This reads each one against
 * the packet it was given and the key the seat never saw, and sorts what is
 * wrong with it three ways:
 *
 * - **malformed:** a score that is not an integer from 0 to 10, a dimension
 *   the picture does not have or one missing, a ranking with a tie or a
 *   letter missing, an artifact class or region outside the vocabulary, an
 *   observation about an image the packet does not hold;
 * - **unblinded:** a file opened outside the packet that is not the seat's
 *   own harness's skill files, which the brief names;
 * - **controls:** the duplicate pair more than a point apart on a dimension,
 *   the low anchor at 6 or more on Form, the withheld photograph under 7 on
 *   Form or Light.
 *
 * Any of the three discards the seat for the round. A false observation
 * discards it too, but only a look at the pixels finds one, so the
 * orchestrator enters it by hand and the ledger reads the entry.
 *
 * The rubric's own tables live here, so the packet builder, this and the
 * ledger read one copy: which dimensions each picture is scored on, which
 * it is ranked on, and the artifact vocabulary.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** The five dimensions of §3.4. `overall` is asked for and advisory. */
export const DIMENSIONS = Object.freeze([
  'form',
  'light',
  'shadow',
  'integration',
  'artifacts',
])

/**
 * §2's "How each picture passes", by the picture's tag. `optional` is the
 * "when present" of G3's Shadow: a seat may leave it null, and its absence
 * costs nothing. `rank` is the forced ranking against the deck; `gates`
 * says whether that ranking decides the pass (E1, E2) or is reported
 * (E3). `under` is how far E3's Form bar and floor sit under the others'.
 */
export const PICTURES = Object.freeze({
  e1: picture(DIMENSIONS, { rank: ['form', 'light', 'shadow'], gates: true }),
  e2: picture(DIMENSIONS, {
    rank: ['form', 'light', 'shadow'],
    gates: true,
    terminator: true,
  }),
  e3: picture(['form', 'light', 'integration', 'artifacts'], {
    rank: ['form'],
    under: 1,
  }),
  g1: picture(DIMENSIONS),
  g2: picture(['form', 'light', 'integration', 'artifacts']),
  g3: picture(DIMENSIONS, { optional: ['shadow'] }),
  g4: picture(['form', 'light', 'integration', 'artifacts']),
})

/** A guard is scored on Integration and Artifacts, and asked which is worse. */
export const GUARD = picture(['integration', 'artifacts'])

function picture(dimensions, rules = {}) {
  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    optional: Object.freeze(rules.optional ?? []),
    rank: Object.freeze(rules.rank ?? []),
    gates: rules.gates ?? false,
    under: rules.under ?? 0,
    terminator: rules.terminator ?? false,
  })
}

/** §3.6's nine classes, in the spelling a seat writes. */
export const CLASSES = Object.freeze([
  'banding',
  'grain',
  'ghosting',
  'seam',
  'stair-steps',
  'slicing',
  'tiling',
  'halo',
  'cutoff',
])

const ROWS = ['top', 'middle', 'bottom']
const COLUMNS = ['left', 'center', 'right']

/** The frame's 3 × 3 grid, as `top-left` to `bottom-right`. */
export const CELLS = Object.freeze(
  ROWS.flatMap((row) => COLUMNS.map((column) => `${row}-${column}`)),
)

/**
 * The cells a region covers, or null for a region outside the vocabulary.
 * A region is one cell, two cells that share an edge joined by `+`, or a
 * crop by its name; a crop covers no cell, and matches only itself.
 */
export function cellsOf(region, crops = ['crop']) {
  if (typeof region !== 'string') return null
  if (crops.includes(region)) return [region]
  const parts = region.split('+')
  if (parts.length > 2 || !parts.every((part) => CELLS.includes(part)))
    return null
  if (parts.length === 2 && !adjacent(parts[0], parts[1])) return null
  return parts
}

function adjacent(a, b) {
  const [ra, ca] = [ROWS.indexOf(a.split('-')[0]), cellColumn(a)]
  const [rb, cb] = [ROWS.indexOf(b.split('-')[0]), cellColumn(b)]
  return Math.abs(ra - rb) + Math.abs(ca - cb) === 1
}

const cellColumn = (cell) => COLUMNS.indexOf(cell.split('-')[1])

/** The rubric's rules for a scene, by its kind and picture tag. */
export const rulesOf = (scene) =>
  scene.kind === 'guard' ? GUARD : PICTURES[scene.tag]

const isScore = (value) => Number.isInteger(value) && value >= 0 && value <= 10

/** Everything wrong with the shape of one scene's answer. */
function sceneErrors(scene, answer) {
  const where = scene.scene
  if (answer === null || typeof answer !== 'object')
    return [`${where}: no answer`]
  const rules = rulesOf(scene)
  const letters = scene.images.map((image) => image.letter)
  const crops = scene.images[0]?.crops.map(cropName) ?? []
  return [
    ...scoreErrors(where, rules, letters, answer.scores),
    ...rankErrors(where, rules, letters, answer.rankings),
    ...artifactErrors(where, letters, ['crop', ...crops], answer.artifacts),
    ...(scene.kind === 'guard'
      ? worseErrors(where, letters, answer.worse)
      : []),
  ]
}

const cropName = (file) => path.basename(file).split('.')[1]

function scoreErrors(where, rules, letters, scores) {
  if (scores === null || typeof scores !== 'object')
    return [`${where}: no scores`]
  const wanted = [...rules.dimensions, 'overall']
  const errors = Object.keys(scores)
    .filter((letter) => !letters.includes(letter))
    .map((letter) => `${where}: scores an image ${letter} the scene lacks`)
  for (const letter of letters) {
    const row = scores[letter]
    if (row === null || typeof row !== 'object') {
      errors.push(`${where}/${letter}: no scores`)
      continue
    }
    for (const key of Object.keys(row))
      if (!wanted.includes(key))
        errors.push(`${where}/${letter}: ${key} is not scored on this picture`)
    for (const key of wanted) {
      const empty = row[key] === null && rules.optional.includes(key)
      if (!empty && !isScore(row[key]))
        errors.push(`${where}/${letter}: ${key} must be an integer 0–10`)
    }
  }
  return errors
}

function rankErrors(where, rules, letters, rankings) {
  if (rules.rank.length === 0) return []
  if (rankings === null || typeof rankings !== 'object')
    return [`${where}: no rankings`]
  return rules.rank.flatMap((dimension) => {
    const order = rankings[dimension]
    const strict =
      Array.isArray(order) &&
      order.length === letters.length &&
      new Set(order).size === order.length &&
      order.every((letter) => letters.includes(letter))
    return strict
      ? []
      : [`${where}: ${dimension} must rank every image once, with no tie`]
  })
}

function artifactErrors(where, letters, crops, artifacts) {
  if (artifacts === undefined) return []
  if (!Array.isArray(artifacts)) return [`${where}: artifacts is not a list`]
  return artifacts.flatMap((one, index) => {
    const at = `${where}: artifact ${index + 1}`
    if (one === null || typeof one !== 'object') return [`${at} is not one`]
    return [
      letters.includes(one.arm) ? null : `${at} names no image of the scene`,
      CLASSES.includes(one.class)
        ? null
        : `${at}: class ${one.class} is not one of the nine`,
      cellsOf(one.region, crops) ? null : `${at}: region ${one.region}`,
      typeof one.full === 'boolean'
        ? null
        : `${at}: full must be true or false`,
    ].filter(Boolean)
  })
}

function worseErrors(where, letters, worse) {
  return GUARD.dimensions
    .filter((dimension) => !letters.includes(worse?.[dimension]))
    .map((dimension) => `${where}: worse.${dimension} must name one image`)
}

function observationErrors(packet, observations) {
  if (!Array.isArray(observations) || observations.length !== 3)
    return ['three observations, no more and no fewer']
  const images = new Set(imagesOf(packet))
  return observations.flatMap((one, index) =>
    images.has(one?.image) &&
    typeof one.text === 'string' &&
    one.text.trim() !== ''
      ? []
      : [`observation ${index + 1} must name a packet image and say something`],
  )
}

/** Every image file a packet holds, as the seat names it. */
export const imagesOf = (packet) =>
  packet.scenes.flatMap((scene) => [
    ...scene.images.flatMap((image) => [image.full, ...image.crops]),
    ...scene.references.map((reference) => reference.file),
  ])

/** The seat's harnesses keep their skills here; the brief names them. */
export const HARNESS_FILES = Object.freeze([
  '~/.agents/skills/',
  '~/.claude/skills/',
  '~/.codex/skills/',
  '~/.config/muse/skills/',
])

const expand = (prefix) =>
  prefix.startsWith('~/') ? path.join(homedir(), prefix.slice(2)) : prefix

function unblinded(dir, opened, allowed) {
  if (!Array.isArray(opened)) return ['opened is not a list of files']
  const prefixes = allowed.map(expand)
  return opened.flatMap((file) => {
    if (typeof file !== 'string') return ['opened names something not a path']
    const full = path.resolve(dir, expand(file))
    const inside = !path.relative(dir, full).startsWith('..')
    return inside || prefixes.some((prefix) => full.startsWith(prefix))
      ? []
      : [`opened ${file}, outside the packet`]
  })
}

/** The letter a key gives an arm in a scene: the primary, never a copy. */
export const letterOf = (key, scene, arm) =>
  Object.entries(key.scenes[scene] ?? {}).find(
    ([, entry]) => entry.arm === arm,
  )?.[0]

/** Each control the rubric's §3.3 discards a seat for. */
function controlFailures(packet, key, review) {
  const failures = []
  for (const scene of packet.scenes) {
    const scores = review.scenes[scene.scene].scores
    for (const [letter, entry] of Object.entries(key.scenes[scene.scene])) {
      const row = scores[letter]
      const at = `${scene.scene}/${letter}`
      if (entry.arm === 'duplicate') {
        const twin = scores[entry.of]
        const apart = rulesOf(scene).dimensions.filter(
          (dimension) =>
            (row[dimension] === null) !== (twin[dimension] === null) ||
            Math.abs(row[dimension] - twin[dimension]) > 1,
        )
        if (apart.length > 0)
          failures.push(
            `the duplicate pair ${at} and ${entry.of} is more than a point apart on ${apart.join(', ')}`,
          )
      }
      if (entry.arm === 'low-anchor' && row.form >= 6)
        failures.push(`the low anchor ${at} scores ${row.form} on Form`)
      if (entry.arm === 'photograph' && (row.form < 7 || row.light < 7))
        failures.push(
          `the withheld photograph ${at} scores ${row.form} on Form and ${row.light} on Light`,
        )
    }
  }
  return failures
}

/**
 * Read one seat's answer. `dir` is its packet's directory, which is what
 * `opened` is resolved against.
 */
export function validateReview(review, { packet, key, dir, allowed }) {
  const result = { malformed: [], unblinded: [], controls: [] }
  if (review === null || typeof review !== 'object') {
    result.malformed.push('review.json is not an object')
    return { ...result, valid: false }
  }
  const scenes = review.scenes ?? {}
  result.malformed.push(
    ...Object.keys(scenes)
      .filter((name) => !packet.scenes.some((scene) => scene.scene === name))
      .map((name) => `answers a scene ${name} the packet lacks`),
    ...packet.scenes.flatMap((scene) =>
      sceneErrors(scene, scenes[scene.scene]),
    ),
    ...observationErrors(packet, review.observations),
  )
  result.unblinded.push(
    ...unblinded(dir, review.opened, allowed ?? HARNESS_FILES),
  )
  if (result.malformed.length === 0)
    result.controls.push(...controlFailures(packet, key, review))
  const valid = Object.values(result).every((list) => list.length === 0)
  return { ...result, valid }
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/** Each seat of a round directory: its packet, key and answer, if it wrote one. */
export async function seatsOf(roundDir) {
  const round = await readJson(path.join(roundDir, 'round.json'))
  const seats = []
  for (const seat of round.seats) {
    const key = await readJson(path.join(roundDir, 'keys', `${seat}.json`))
    const dir = path.join(roundDir, 'packets', key.packet)
    const packet = await readJson(path.join(dir, 'packet.json'))
    const file = path.join(dir, 'review.json')
    const review = existsSync(file)
      ? await readJson(file).catch(() => 'unreadable')
      : null
    seats.push({ seat, key, dir, packet, review })
  }
  return { round, seats }
}

/** Validate every seat of a round, and write `validation.json` beside it. */
export async function validateRound(roundDir) {
  const { round, seats } = await seatsOf(roundDir)
  const report = {}
  for (const { seat, key, dir, packet, review } of seats) {
    report[seat] =
      review === null
        ? { missing: true, valid: false }
        : validateReview(review, { packet, key, dir, allowed: round.allowed })
  }
  await writeFile(
    path.join(roundDir, 'validation.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  return report
}

if (import.meta.main) {
  const [roundDir] = process.argv.slice(2)
  if (roundDir === undefined) {
    console.error('node scripts/panel/validate.mjs <round dir>')
    process.exit(1)
  }
  const report = await validateRound(path.resolve(roundDir))
  for (const [seat, result] of Object.entries(report)) {
    const problems = result.missing
      ? ['no review.json']
      : [...result.malformed, ...result.unblinded, ...result.controls]
    console.log(
      `${seat}: ${result.valid ? 'valid' : 'not valid'}${problems.map((one) => `\n  ${one}`).join('')}`,
    )
  }
}
