import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { CORNERSTONES } from '../../packages/devtools/src/index.ts'
import { RIG, STILLS } from '../weather/capture.mjs'
import { provenance, role } from '../weather/sheet.mjs'
import {
  adaptBaseline,
  buildRound,
  canonical,
  checkArm,
  gather,
  GROUND,
  layouts,
  OVERLAY_GUARD,
  parseAnchors,
  parseReferences,
  platesOf,
  PROVENANCE,
  rectOf,
} from './packet.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const hash = (data) => createHash('sha256').update(data).digest('hex')
const cropsJson = JSON.parse(
  await readFile(path.join(ROOT, 'scripts/panel/crops.json'), 'utf8'),
)
const crops = cropsJson.crops
const references = parseReferences(
  await readFile(path.join(ROOT, 'design/plans/weather/references.md'), 'utf8'),
)

describe('crops.json', () => {
  it('gives every still cornerstone a crop inside its frame, and E2 a terminator', () => {
    // The overlay guard is taken as a still and judged as a pair, on
    // Integration and Artifacts over the whole plate: it has no crop.
    expect(Object.keys(crops).sort()).toEqual(
      STILLS.filter((id) => id !== OVERLAY_GUARD).sort(),
    )
    for (const [id, named] of Object.entries(crops)) {
      expect(Object.keys(named)[0], id).toBe('crop')
      for (const crop of Object.values(named)) {
        expect(crop.w > 0 && crop.h > 0, id).toBe(true)
        expect(crop.x >= 0 && crop.y >= 0, id).toBe(true)
        expect(crop.x + crop.w <= 1 && crop.y + crop.h <= 1, id).toBe(true)
        const rect = rectOf(crop, RIG.width * RIG.dpr, RIG.height * RIG.dpr)
        expect(rect.width * rect.height, id).toBeGreaterThan(0)
      }
    }
    expect(Object.keys(crops['weather-e2-limb-dusk'])).toEqual([
      'crop',
      'terminator',
    ])
  })

  it('gives every frozen anchor its own crops, inside its image and no larger than the cell', () => {
    const frozen = Object.values(references.anchors).flat()
    expect(frozen).toHaveLength(9)
    expect(Object.keys(cropsJson.anchors).sort()).toEqual(
      frozen.map((one) => one.file).sort(),
    )
    for (const one of frozen) {
      const own = cropsJson.anchors[one.file]
      const picture = own.picture
      expect(own.sha256, one.file).toBe(one.sha256)
      // The pixels the rectangles are checked against are the frozen row's.
      expect(own.pixels.join(' × '), one.file).toBe(one.about.Pixels)
      const names = Object.keys(crops[picture])
      const [width, height] = own.pixels
      for (const name of names) {
        const r = own[name]
        const cell = rectOf(
          crops[picture][name],
          RIG.width * RIG.dpr,
          RIG.height * RIG.dpr,
        )
        expect(r.x >= 0 && r.y >= 0, one.file).toBe(true)
        expect(r.x + r.w <= width && r.y + r.h <= height, one.file).toBe(true)
        expect([r.w, r.h], one.file).toEqual([
          Math.min(cell.width, width),
          Math.min(cell.height, height),
        ])
        expect(r.why.length, one.file).toBeGreaterThan(20)
      }
    }
  })
})

describe('references.md', () => {
  it('reads the frozen 40 in rank order, each with a hash and a caption', () => {
    const { pictures, notes } = references
    const all = Object.values(pictures).flat()
    expect(all).toHaveLength(40)
    expect(pictures.e1[0].file).toBe('e1/iss061-e-59841-amazon-210mm.jpg')
    for (const one of all) {
      expect(one.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(one.caption).toMatch(/\. Misleads: \S/)
    }
    // The dated notes are about the file, and stay out of a brief.
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.some((note) => note.startsWith('**2026'))).toBe(false)
  })

  it('reads the anchor table, a picture with none recorded as having none', () => {
    const table = [
      '| Picture | File | Engine | SHA-256 |',
      '| --- | --- | --- | --- |',
      '| E1 | `a-e1.png` | Unreal | `aa` |',
      '| E3 | no matched anchor | none | none |',
      '| G1 | `a-g1-1.jpg` | Decima | `bb` |',
      '| G1 | `a-g1-2.png` | Unity | `cc` |',
    ].join('\n')
    expect(parseAnchors(`## Anchors\n\n${table}\n\nprose`)).toEqual({
      e1: [{ file: 'a-e1.png', sha256: 'aa', about: { Engine: 'Unreal' } }],
      e3: [],
      g1: [
        { file: 'a-g1-1.jpg', sha256: 'bb', about: { Engine: 'Decima' } },
        { file: 'a-g1-2.png', sha256: 'cc', about: { Engine: 'Unity' } },
      ],
    })
    // The frozen nine, E3 with none.
    expect(references.anchors.e3).toEqual([])
    expect(references.anchors.e2.map((one) => one.file)).toEqual([
      'a-e2-ue4-1.jpg',
    ])
  })

  /*
   * A seat knows nothing of the project, so no caption or note a packet
   * carries may use its words: the preset, the render, the scenario, the
   * MVP, the rubric, a cornerstone, a phase, the continuity check, or a
   * regime's name. "Render" in any form is on the list, since a seat cannot
   * tell the project's sense from a camera's.
   */
  const PROJECT_WORDS =
    /\b(presets?|render\w*|scenarios?|MVP|rubric|cornerstones?|phases?|continuity|fair-cumulus|cirrus-over-cumulus|dusk-altocumulus)\b/i

  it('carries no project word in a caption or a note a packet reads', () => {
    const captions = Object.values(references.pictures)
      .flat()
      .map((one) => one.caption)
    for (const text of [...captions, ...references.notes])
      expect(text).not.toMatch(PROJECT_WORDS)
  })
})

// ------------------------------------------------------------ the fixture

const ID = {
  e1: 'weather-e1-cumulus-orbit',
  e2: 'weather-e2-limb-dusk',
  g1: 'weather-g1-fair',
}
const TAGS = Object.keys(ID)

const solid = (file, width, height, [r, g, b], format = 'png') =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .toFormat(format)
    .toFile(file)

let fx
beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-packet-'))
  const photos = path.join(dir, 'photos')
  const anchors = path.join(dir, 'anchors')
  const plates = path.join(dir, 'plates')
  for (const sub of [anchors, plates, ...TAGS.map((t) => path.join(photos, t))])
    await mkdir(sub, { recursive: true })
  // Three photographs a picture, each a JPEG with its own color.
  const frozen = []
  const rows = []
  for (const [i, tag] of TAGS.entries()) {
    const files = []
    for (const n of [1, 2, 3]) {
      const file = `${tag}/photo-${n}.jpg`
      await solid(
        path.join(photos, file),
        2048,
        1365,
        [40 * i, 30 * n, 200],
        'jpeg',
      )
      const sha = hash(await readFile(path.join(photos, file)))
      files.push(`\`${file}\``)
      rows.push({
        tag,
        line: `| ${n} | \`${file}\` | \`${sha}\` | Nikon, ${n}00 mm | Cells. **Misleads:** haze ${n} |`,
      })
    }
    frozen.push(`| ${tag.toUpperCase()} | 3 | ${files.join(', ')} |`)
  }
  // Two anchors: one smaller than its cell, one larger. G1 has none.
  // Two anchors: one smaller than its cell, and one 4K still whose every
  // pixel differs from its neighbors, so a crop that was scaled shows.
  await solid(path.join(anchors, 'a-e1.png'), 400, 250, [250, 10, 10])
  const pattern = Buffer.alloc(3840 * 2160 * 3)
  for (let i = 0; i < 3840 * 2160; i++) {
    const x = i % 3840
    const y = Math.floor(i / 3840)
    pattern.set([x % 251, y % 241, (x * 7 + y * 13) % 256], i * 3)
  }
  await sharp(pattern, { raw: { width: 3840, height: 2160, channels: 3 } })
    .png()
    .toFile(path.join(anchors, 'a-e2.png'))
  const anchorSha = {
    e1: hash(await readFile(path.join(anchors, 'a-e1.png'))),
    e2: hash(await readFile(path.join(anchors, 'a-e2.png'))),
  }
  const fixtureCrops = {
    crops,
    anchors: {
      'a-e1.png': {
        picture: ID.e1,
        sha256: anchorSha.e1,
        pixels: [400, 250],
        crop: { x: 0, y: 0, w: 400, h: 250, why: 'the whole small still' },
      },
      'a-e2.png': {
        picture: ID.e2,
        sha256: anchorSha.e2,
        pixels: [3840, 2160],
        crop: { x: 100, y: 200, w: 720, h: 450, why: 'one place' },
        terminator: { x: 3000, y: 1700, w: 720, h: 450, why: 'another' },
      },
    },
  }
  await writeFile(path.join(dir, 'crops.json'), JSON.stringify(fixtureCrops))
  const references = [
    '# Fixture references',
    '',
    '## The frozen set',
    '',
    '| Picture | Frozen | Files (under `candidates/`) |',
    '| --- | --- | --- |',
    ...frozen,
    '',
    "What the panel's brief carries with them:",
    '',
    '- **2026-11-10, a correction:** about the file.',
    '- E1’s frames are taken through longer lenses,',
    '  so their cells look larger.',
    '- G4 has no aircraft.',
    '',
    ...TAGS.flatMap((tag) => [
      `## ${tag.toUpperCase()} — a picture`,
      '',
      '| # | File | SHA-256 | Capture | Shows / misleads |',
      '| --- | --- | --- | --- | --- |',
      ...rows.filter((row) => row.tag === tag).map((row) => row.line),
      '',
    ]),
    '## Real-time anchors',
    '',
    '| Picture | File | Engine | SHA-256 |',
    '| --- | --- | --- | --- |',
    `| E1 | \`a-e1.png\` | Unreal | \`${anchorSha.e1}\` |`,
    `| E2 | \`a-e2.png\` | Unreal | \`${anchorSha.e2}\` |`,
    '| G1 | no matched anchor | — | — |',
    '',
  ].join('\n')
  const referencesFile = path.join(dir, 'references.md')
  await writeFile(referencesFile, references)
  const referencesSha = hash(references)
  // Phase 0's record as it was taken, and a candidate record with roles.
  const plate = async (name, color) => {
    const file = path.join(plates, name)
    await solid(file, RIG.width * RIG.dpr, RIG.height * RIG.dpr, color)
    return { file: name, sha256: hash(await readFile(file)) }
  }
  const baseline = {
    commit: 'b0',
    clean: true,
    rig: RIG,
    references: referencesSha,
    stills: [],
  }
  // The candidate is a record as the capture writes it: each still carries
  // its provenance and its role from `sheet.mjs`'s own builders.
  const run = {
    commit: 'c1',
    clean: true,
    fixtures: { references: referencesSha, cornerstones: 'x' },
  }
  const candidate = { ...run, phase: 1, rig: RIG, stills: [], casts: [] }
  const taken = (id, read, as) => provenance(run, id, read, role(as))
  const pageOf = (id, levers) => ({
    stance: { address: `g:${id}`, state: {}, look: {}, surface: null },
    lens: { focalLength: 20 },
    time: 0,
    processing: 'enhanced',
    clouds: levers && { levers, extents: { render: [2880, 1800] } },
  })
  for (const [i, tag] of TAGS.entries()) {
    const levers = { on: true, scenario: tag }
    baseline.stills.push({
      id: ID[tag],
      arm: 'volume',
      ...(await plate(`${tag}-base.png`, [10, 10, 20 * i])),
      taken: { commit: 'b0' },
      read: { clouds: { levers } },
    })
    if (tag.startsWith('e'))
      baseline.stills.push({
        id: ID[tag],
        arm: 'deck',
        ...(await plate(`${tag}-deck.png`, [60, 60, 20 * i])),
        read: { clouds: { levers: null } },
      })
    candidate.stills.push({
      id: ID[tag],
      arm: 'volume',
      ...(await plate(`${tag}-cand.png`, [120, 120, 20 * i])),
      ...taken(ID[tag], pageOf(ID[tag], levers), 'candidate'),
    })
  }
  // The overlay guard as the capture takes it: a guard pair in the volume
  // arm and its first accepted plate, the deck, beside it.
  const guard = { ...candidate, stills: [] }
  guard.stills.push(
    {
      id: OVERLAY_GUARD,
      arm: 'volume',
      ...(await plate('guard-volume.png', [200, 90, 90])),
      ...taken(
        OVERLAY_GUARD,
        pageOf(OVERLAY_GUARD, { on: true }),
        'guard-pair',
      ),
    },
    {
      id: OVERLAY_GUARD,
      arm: 'deck',
      ...(await plate('guard-deck.png', [90, 90, 200])),
      ...taken(OVERLAY_GUARD, pageOf(OVERLAY_GUARD, null), 'deck'),
    },
  )
  // An experiment record as the capture writes it: every run takes E1's and
  // E2's deck beside the volume, with no flag to leave it out.
  const experiment = { ...candidate, commit: 'x1', stills: [] }
  for (const [i, tag] of TAGS.entries()) {
    const levers = { on: true, scenario: tag, sun: false }
    experiment.stills.push({
      id: ID[tag],
      arm: 'volume',
      ...(await plate(`${tag}-exp.png`, [160, 120, 20 * i])),
      ...taken(ID[tag], pageOf(ID[tag], levers), 'candidate'),
    })
    if (tag.startsWith('e'))
      experiment.stills.push({
        id: ID[tag],
        arm: 'deck',
        ...(await plate(`${tag}-exp-deck.png`, [70, 70, 20 * i])),
        ...taken(ID[tag], pageOf(ID[tag], null), 'deck'),
      })
  }
  await writeFile(path.join(plates, 'baseline.json'), JSON.stringify(baseline))
  await writeFile(
    path.join(plates, 'candidate.json'),
    JSON.stringify(candidate),
  )
  fx = {
    dir,
    baselineRecord: baseline,
    candidateRecord: candidate,
    guardRecord: guard,
    experimentRecord: experiment,
    referencesSha,
    pattern,
    options: (out, kind, seed = 'fixture') => ({
      crops: path.join(dir, 'crops.json'),
      round: `${kind}-1`,
      kind,
      seed,
      out: path.join(dir, out),
      photos,
      anchors,
      references: referencesFile,
      baseline: path.join(plates, 'baseline.json'),
      record: kind === 'judged' ? [path.join(plates, 'candidate.json')] : [],
    }),
  }
})

async function tree(dir, under = '') {
  const out = {}
  for (const entry of await readdir(path.join(dir, under), {
    withFileTypes: true,
  })) {
    const rel = path.join(under, entry.name)
    if (entry.isDirectory()) Object.assign(out, await tree(dir, rel))
    else out[rel] = hash(await readFile(path.join(dir, rel)))
  }
  return out
}

const keysOf = async (out) =>
  Promise.all(
    ['seat-1', 'seat-2', 'seat-3'].map(async (seat) =>
      JSON.parse(
        await readFile(path.join(out, 'keys', `${seat}.json`), 'utf8'),
      ),
    ),
  )

describe('the record reader', () => {
  it('supplies and names every provenance field of phase 0’s record', async () => {
    const cornerstonesHash = 'h'
    const { record, supplied } = adaptBaseline(fx.baselineRecord, {
      cornerstones: CORNERSTONES,
      cornerstonesHash,
    })
    expect(supplied.map((line) => line.split(':')[0]).sort()).toEqual(
      [...PROVENANCE].sort(),
    )
    const plates = platesOf(record, path.join(fx.dir, 'plates/baseline.json'), {
      adapted: true,
    })
    expect(plates.map((p) => [p.picture, p.role])).toContainEqual([
      ID.e1,
      'deck',
    ])
    expect(plates.find((p) => p.role === 'low-anchor')).toMatchObject({
      processing: 'enhanced',
      levers: { hash: expect.stringMatching(/^[0-9a-f]{64}$/), size: null },
      stance: { id: ID.e1 },
    })
    expect(plates.find((p) => p.role === 'deck').levers).toBeNull()
    expect(() =>
      adaptBaseline(record, { cornerstones: CORNERSTONES, cornerstonesHash }),
    ).toThrow(/roles already/)
  })

  it('reads a capture record as written: the role by name, the levers as their hash and size', () => {
    const plates = platesOf(fx.candidateRecord, '/r.json')
    expect(plates).toHaveLength(TAGS.length)
    for (const plate of plates) {
      expect(plate.role).toBe('candidate')
      expect(plate.levers).toEqual({
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        size: [2880, 1800],
      })
      expect(plate.stance.id).toBe(plate.picture)
      expect(plate.processing).toBe('enhanced')
    }
  })

  it('refuses a plate whose record lacks a field, by the capture’s own check', () => {
    const [first] = fx.candidateRecord.stills
    const { levers: _, ...take } = first
    const record = { ...fx.candidateRecord, stills: [take] }
    expect(() => platesOf(record, '/r.json')).toThrow(
      /\/r\.json: weather-e1-cumulus-orbit \(volume\): .*carries no levers/,
    )
    const named = { ...first, role: 'candidate' }
    expect(() =>
      platesOf({ ...fx.candidateRecord, stills: [named] }, '/r.json'),
    ).toThrow(/its role undefined is not one of the record's/)
  })

  it('finds the overlay guard by its id, its deck the old plate and its volume the new', () => {
    const inputs = [{ file: '/g.json', record: fx.guardRecord, as: 'record' }]
    const [scene] = gather(inputs, {
      kind: 'judged',
      only: null,
      references: fx.referencesSha,
    })
    expect(scene).toMatchObject({
      picture: OVERLAY_GUARD,
      tag: null,
      kind: 'guard',
    })
    expect(scene.arms.new.role).toBe('guard-pair')
    expect(scene.arms.old.role).toBe('deck')
    // A moved guard's last accepted plate, named, stands as the old plate.
    const base = {
      ...fx.guardRecord,
      commit: 'c0',
      stills: fx.guardRecord.stills.filter((one) => one.arm === 'volume'),
    }
    const [moved] = gather(
      [...inputs, { file: '/base.json', record: base, as: 'guard-base' }],
      { kind: 'judged', only: null, references: fx.referencesSha },
    )
    expect(moved.arms.old.record).toBe('/base.json')
    expect(moved.arms.new.record).toBe('/g.json')
  })

  it('forms the experiment from its record’s volume plates, its deck plates left to the deck arm', () => {
    const { record, supplied } = adaptBaseline(fx.baselineRecord, {
      cornerstones: CORNERSTONES,
      cornerstonesHash: 'h',
    })
    const inputs = [
      { file: '/base.json', record, as: 'record', supplied },
      { file: '/cand.json', record: fx.candidateRecord, as: 'record' },
      { file: '/exp.json', record: fx.experimentRecord, as: 'experiment' },
    ]
    const scenes = gather(inputs, {
      kind: 'judged',
      only: null,
      references: fx.referencesSha,
    })
    expect(scenes.map((scene) => scene.picture)).toEqual(
      [ID.e1, ID.e2, ID.g1].sort(),
    )
    for (const scene of scenes) {
      expect(scene.arms.experiment).toMatchObject({
        record: '/exp.json',
        role: 'candidate',
      })
      expect(scene.arms.experiment.file).toMatch(/-exp\.png$/)
      expect(scene.arms.candidate.record).toBe('/cand.json')
    }
    // The deck arm is the baseline's, never the experiment record's.
    for (const tag of ['e1', 'e2']) {
      const scene = scenes.find((one) => one.picture === ID[tag])
      expect(scene.arms.deck.record).toBe('/base.json')
    }
  })

  it('still refuses, by name, an experiment record whose only plates are decks', () => {
    const decks = {
      ...fx.experimentRecord,
      stills: fx.experimentRecord.stills.filter((one) => one.arm === 'deck'),
    }
    expect(decks.stills).toHaveLength(2)
    expect(() =>
      gather([{ file: '/exp.json', record: decks, as: 'experiment' }], {
        kind: 'judged',
        only: null,
        references: fx.referencesSha,
      }),
    ).toThrow(
      '/exp.json: weather-e1-cumulus-orbit cannot be the experiment: its role is deck',
    )
  })

  it('refuses a plate with the wrong role, rig, stance, fixtures or processing for its arm', () => {
    const good = {
      record: '/r.json',
      picture: ID.g1,
      role: 'candidate',
      rig: RIG,
      stance: { id: ID.g1 },
      processing: 'enhanced',
      fixtures: { references: 'f' },
    }
    const refs = { references: 'f' }
    expect(() => checkArm(good, 'candidate', refs)).not.toThrow()
    expect(() => checkArm(good, 'deck', refs)).toThrow(/role is candidate/)
    expect(() =>
      checkArm({ ...good, role: 'settled-sample' }, 'settled-sample', refs),
    ).toThrow(/no arm/)
    expect(() =>
      checkArm({ ...good, rig: { ...RIG, dpr: 1 } }, 'candidate', refs),
    ).toThrow(/rig/)
    expect(() =>
      checkArm({ ...good, stance: { id: ID.e1 } }, 'candidate', refs),
    ).toThrow(/stance/)
    expect(() =>
      checkArm({ ...good, processing: 'standard' }, 'candidate', refs),
    ).toThrow(/taken under standard/)
    expect(() =>
      checkArm({ ...good, fixtures: { references: 'g' } }, 'candidate', refs),
    ).toThrow(
      'its record carries references.md at g, and the file is f now. A plate is compared only under the references it was taken with; the baseline is retaken in the next machine window, on the capture’s second pass',
    )
  })
})

describe('the layout', () => {
  it('draws a seat again until no two seats share one', () => {
    // One scene of three arms and two photographs has twelve layouts, so ten
    // seats drawn once each would almost surely repeat one.
    const scene = {
      picture: ID.g1,
      tag: 'g1',
      kind: 'still',
      anchors: [],
      arms: { 'low-anchor': { sha256: 'l', file: '/l.png' } },
    }
    const photos = {
      [ID.g1]: [
        { sha256: 'p1', path: '/p1' },
        { sha256: 'p2', path: '/p2' },
      ],
    }
    const seats = Array.from({ length: 10 }, (_, i) => `seat-${i}`)
    const drawn = layouts(
      { round: 'r', kind: 'calibration', seed: 's', seats },
      [scene],
      photos,
    )
    const signatures = drawn.map(({ layout }) =>
      canonical(layout[0].sources.map((one) => [one.arm, one.sha256])),
    )
    expect(new Set(signatures).size).toBe(10)
  })
})

describe('a judged round’s packets', () => {
  let out
  let keys
  beforeAll(async () => {
    out =
      (await buildRound(fx.options('judged-a', 'judged'))) &&
      path.join(fx.dir, 'judged-a')
    keys = await keysOf(out)
  })

  it('are byte-equal when built twice from one seed', async () => {
    await buildRound(fx.options('judged-b', 'judged'))
    const a = await tree(out)
    const b = await tree(path.join(fx.dir, 'judged-b'))
    const kept = (files) =>
      Object.fromEntries(
        Object.entries(files).filter(([file]) => !file.startsWith('tasks')),
      )
    expect(kept(b)).toEqual(kept(a))
    expect(Object.keys(a).length).toBeGreaterThan(50)
  })

  it('give each seat its own letters, and each round its own', async () => {
    const layouts = keys.map((key) => canonical(key.scenes))
    expect(new Set(layouts).size).toBe(3)
    await buildRound({
      ...fx.options('judged-c', 'judged', 'another seed'),
      round: 'judged-2',
    })
    const again = await keysOf(path.join(fx.dir, 'judged-c'))
    expect(canonical(again[0].scenes)).not.toBe(layouts[0])
  })

  it('carry each control once a seat, and the deck on E1 and E2', () => {
    for (const key of keys) {
      const arms = Object.values(key.scenes).flatMap((scene) =>
        Object.values(scene).map((one) => one.arm),
      )
      for (const control of ['duplicate', 'low-anchor', 'photograph'])
        expect(
          arms.filter((arm) => arm === control),
          `${key.seat} ${control}`,
        ).toHaveLength(1)
      expect(arms.filter((arm) => arm === 'candidate')).toHaveLength(3)
      expect(
        Object.values(key.scenes.e2).some((one) => one.arm === 'deck'),
      ).toBe(true)
      expect(arms).not.toContain('anchor')
      const [letter, dup] = Object.entries(key.scenes)
        .flatMap(([, s]) => Object.entries(s))
        .find(([, one]) => one.arm === 'duplicate')
      const scene = Object.values(key.scenes).find((s) => s[letter] === dup)
      expect(scene[dup.of].sha256).toBe(dup.sha256)
    }
  })

  it('withhold the photograph arm from that seat’s own references', async () => {
    for (const key of keys) {
      const [name, scene] = Object.entries(key.scenes).find(([, s]) =>
        Object.values(s).some((one) => one.arm === 'photograph'),
      )
      const photo = Object.values(scene).find((one) => one.arm === 'photograph')
      const packet = JSON.parse(
        await readFile(
          path.join(out, 'packets', key.packet, 'packet.json'),
          'utf8',
        ),
      )
      expect(
        packet.scenes.find((s) => s.scene === name).references,
      ).toHaveLength(2)
      expect(key.references[name]).toHaveLength(2)
      for (const file of key.references[name])
        expect(
          hash(await readFile(path.join(fx.dir, 'photos', file))),
        ).not.toBe(photo.sha256)
    }
  })

  it('name no arm by a file name, a word, metadata, size or order', async () => {
    const sources = JSON.parse(
      await readFile(path.join(out, 'round.json'), 'utf8'),
    ).scenes.flatMap((scene) => Object.values(scene.arms))
    for (const key of keys) {
      const dir = path.join(out, 'packets', key.packet)
      const packet = JSON.parse(
        await readFile(path.join(dir, 'packet.json'), 'utf8'),
      )
      const text =
        (await readFile(path.join(dir, 'brief.md'), 'utf8')) +
        JSON.stringify(packet)
      expect(text).not.toMatch(
        /candidate|baseline|anchor|withheld|duplicate|experiment|last-accepted|control|judged-1/i,
      )
      for (const source of sources) {
        expect(text).not.toContain(path.basename(source.file))
        expect(text).not.toContain(source.sha256)
      }
      for (const scene of packet.scenes)
        for (const image of scene.images) {
          expect(Object.keys(image)).toEqual(['letter', 'full', 'crops'])
          const full = await sharp(path.join(dir, image.full)).metadata()
          expect([full.width, full.height, full.format, full.channels]).toEqual(
            [1440, 900, 'png', 3],
          )
          expect([full.exif, full.icc, full.xmp, full.iptc]).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
          ])
          for (const crop of image.crops) {
            const cut = await sharp(path.join(dir, crop)).metadata()
            expect([cut.width, cut.height]).toEqual([720, 450])
          }
        }
      // The letters run A, B, C… in the listing, whatever stands behind them.
      for (const scene of packet.scenes)
        expect(scene.images.map((i) => i.letter).join('')).toBe(
          'ABCDEFGH'.slice(0, scene.images.length),
        )
    }
  })

  it('refuses a judged scene with no candidate, and a calibration round with one', async () => {
    await expect(
      buildRound({ ...fx.options('judged-d', 'judged'), record: [] }),
    ).rejects.toThrow(/no candidate plate/)
    await expect(
      buildRound({
        ...fx.options('cal-x', 'calibration'),
        record: fx.options('x', 'judged').record,
      }),
    ).rejects.toThrow(/before any candidate/)
  })
})

describe('the calibration round’s packets', () => {
  let out
  let keys
  beforeAll(async () => {
    await buildRound(fx.options('cal-a', 'calibration'))
    out = path.join(fx.dir, 'cal-a')
    keys = await keysOf(out)
  })

  it('show the low anchor and a withheld photograph in every scene', () => {
    for (const key of keys)
      for (const scene of Object.values(key.scenes)) {
        const arms = Object.values(scene).map((one) => one.arm)
        expect(arms).toContain('low-anchor')
        expect(arms).toContain('photograph')
      }
  })

  it('show an anchor only in its own picture’s scene, and record a picture with none', async () => {
    const record = JSON.parse(
      await readFile(path.join(out, 'round.json'), 'utf8'),
    )
    const anchorsOf = (scene) =>
      Object.values(scene)
        .filter((one) => one.arm === 'anchor')
        .map((one) => one.sha256)
    for (const key of keys) {
      const e1 = record.scenes.find((s) => s.picture === ID.e1).anchors
        .stills[0].sha256
      expect(anchorsOf(key.scenes.e1)).toEqual([e1])
      expect(anchorsOf(key.scenes.g1)).toEqual([])
      expect(anchorsOf(key.scenes.e2)).not.toContain(e1)
    }
    expect(record.scenes.find((s) => s.picture === ID.g1).anchors).toEqual({
      stills: [],
      unmatched: 'no matched anchor',
    })
    expect(
      record.scenes.find((s) => s.picture === ID.e2).anchors.unmatched,
    ).toMatch(/the band: no matched anchor/)
    expect(record.records[0].supplied).toHaveLength(7)
  })

  it('scale a larger still down to its cell and never a smaller one up', async () => {
    const key = keys[0]
    const dir = path.join(out, 'packets', key.packet)
    const letter = (scene) =>
      Object.entries(key.scenes[scene]).find(
        ([, one]) => one.arm === 'anchor',
      )[0]
    const pixel = async (file, x, y) => {
      const { data, info } = await sharp(path.join(dir, file))
        .raw()
        .toBuffer({ resolveWithObject: true })
      return [
        ...data.subarray(
          (y * info.width + x) * 3,
          (y * info.width + x) * 3 + 3,
        ),
      ]
    }
    const ground = [GROUND.r, GROUND.g, GROUND.b]
    // 400 × 250 stays 400 × 250, centered on the ground of a 1440 × 900 cell.
    const small = `e1/${letter('e1')}.png`
    expect(await pixel(small, 519, 324)).toEqual(ground)
    expect(await pixel(small, 520, 325)).toEqual([250, 10, 10])
    expect(await pixel(small, 919, 574)).toEqual([250, 10, 10])
    expect(await pixel(small, 920, 575)).toEqual(ground)
    // 3840 × 2160 fits as 1440 × 810, with the ground above and below.
    const large = `e2/${letter('e2')}.png`
    expect(await pixel(large, 720, 44)).toEqual(ground)
    expect(await pixel(large, 720, 45)).not.toEqual(ground)
  })

  it('cut each anchor at its own rectangle, at native pixels, never scaled', async () => {
    const key = keys[1]
    const dir = path.join(out, 'packets', key.packet)
    const [letter] = Object.entries(key.scenes.e2).find(
      ([, one]) => one.arm === 'anchor',
    )
    const region = (x, y) => {
      const rows = []
      for (let row = y; row < y + 450; row++)
        rows.push(
          fx.pattern.subarray((row * 3840 + x) * 3, (row * 3840 + x + 720) * 3),
        )
      return Buffer.concat(rows)
    }
    for (const [crop, x, y] of [
      ['crop', 100, 200],
      ['terminator', 3000, 1700],
    ]) {
      const cut = await sharp(path.join(dir, `e2/${letter}.${crop}.png`))
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect([cut.info.width, cut.info.height]).toEqual([720, 450])
      expect(cut.data.equals(region(x, y)), crop).toBe(true)
    }
    // A still smaller than its cell is cut whole and sits on the ground.
    const [small] = Object.entries(key.scenes.e1).find(
      ([, one]) => one.arm === 'anchor',
    )
    const { data } = await sharp(path.join(dir, `e1/${small}.crop.png`))
      .raw()
      .toBuffer({ resolveWithObject: true })
    const at = (x, y) => [
      ...data.subarray((y * 720 + x) * 3, (y * 720 + x) * 3 + 3),
    ]
    expect(at(159, 99)).toEqual([GROUND.r, GROUND.g, GROUND.b])
    expect(at(160, 100)).toEqual([250, 10, 10])
    const record = JSON.parse(
      await readFile(path.join(out, 'round.json'), 'utf8'),
    )
    const e2 = record.scenes.find((one) => one.picture === ID.e2)
    expect(e2.anchors.stills[0].crops.terminator).toMatchObject({
      x: 3000,
      y: 1700,
    })
  })

  it('refuse an anchor with no crop of its own', async () => {
    const bare = path.join(fx.dir, 'bare-crops.json')
    await writeFile(bare, JSON.stringify({ crops, anchors: {} }))
    await expect(
      buildRound({ ...fx.options('cal-bare', 'calibration'), crops: bare }),
    ).rejects.toThrow(
      'the anchor a-e1.png has no crop of its own in crops.json',
    )
  })
})
