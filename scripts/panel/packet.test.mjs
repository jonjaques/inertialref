import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { CORNERSTONES } from '../../packages/devtools/src/index.ts'
import { RIG, STILLS } from '../weather/capture.mjs'
import {
  adaptBaseline,
  buildRound,
  canonical,
  checkArm,
  GROUND,
  parseAnchors,
  parseReferences,
  platesOf,
  PROVENANCE,
  rectOf,
} from './packet.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const hash = (data) => createHash('sha256').update(data).digest('hex')
const crops = JSON.parse(
  await readFile(path.join(ROOT, 'scripts/panel/crops.json'), 'utf8'),
).crops

describe('crops.json', () => {
  it('gives every still cornerstone a crop inside its frame, and E2 a terminator', () => {
    expect(Object.keys(crops).sort()).toEqual([...STILLS].sort())
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
})

describe('references.md', () => {
  it('reads the frozen 40 in rank order, each with a hash and a caption', async () => {
    const text = await readFile(
      path.join(ROOT, 'design/plans/weather/references.md'),
      'utf8',
    )
    const { pictures, notes } = parseReferences(text)
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

  it('reads an anchor table, a picture with none recorded as having none', () => {
    const table = [
      '| Picture | Anchor | Engine | SHA-256 |',
      '| --- | --- | --- | --- |',
      '| E1 | `a-e1.png` | Unreal | `aa` |',
      '| E3 | no matched anchor | — | — |',
      '| G1 | `a-g1-1.jpg` | Decima | `bb` |',
      '| G1 | `a-g1-2.png` | Unity | `cc` |',
    ].join('\n')
    expect(parseAnchors(`# Frozen\n\n${table}\n\nprose`)).toEqual({
      e1: [
        {
          file: 'a-e1.png',
          sha256: 'aa',
          about: { Anchor: '`a-e1.png`', Engine: 'Unreal' },
        },
      ],
      e3: [],
      g1: [
        {
          file: 'a-g1-1.jpg',
          sha256: 'bb',
          about: { Anchor: '`a-g1-1.jpg`', Engine: 'Decima' },
        },
        {
          file: 'a-g1-2.png',
          sha256: 'cc',
          about: { Anchor: '`a-g1-2.png`', Engine: 'Unity' },
        },
      ],
    })
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
  await solid(path.join(anchors, 'a-e1.png'), 400, 250, [250, 10, 10])
  await solid(path.join(anchors, 'a-e2.jpg'), 3840, 2160, [10, 250, 10], 'jpeg')
  const anchorSha = {
    e1: hash(await readFile(path.join(anchors, 'a-e1.png'))),
    e2: hash(await readFile(path.join(anchors, 'a-e2.jpg'))),
  }
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
    `| E2 | \`a-e2.jpg\` | Unreal | \`${anchorSha.e2}\` |`,
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
  const candidate = { commit: 'c1', clean: true, rig: RIG, stills: [] }
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
      role: 'candidate',
      stance: { id: ID[tag] },
      fixtures: { references: referencesSha, cornerstones: 'x' },
      processing: 'enhanced',
      levers: `levers-${tag}`,
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
    referencesSha,
    options: (out, kind, seed = 'fixture') => ({
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
    const plates = platesOf(record, path.join(fx.dir, 'plates/baseline.json'))
    expect(plates.map((p) => [p.picture, p.role])).toContainEqual([
      ID.e1,
      'deck',
    ])
    expect(plates.find((p) => p.role === 'low-anchor')).toMatchObject({
      processing: 'enhanced',
      levers: expect.stringMatching(/^[0-9a-f]{64}$/),
      stance: { id: ID.e1 },
    })
    expect(plates.find((p) => p.role === 'deck').levers).toBeNull()
    expect(() =>
      adaptBaseline(record, { cornerstones: CORNERSTONES, cornerstonesHash }),
    ).toThrow(/roles already/)
  })

  it('refuses a plate whose record lacks a field', () => {
    const record = {
      rig: RIG,
      commit: 'c',
      clean: true,
      stills: [
        {
          id: ID.g1,
          arm: 'volume',
          file: 'x.png',
          role: 'candidate',
          stance: { id: ID.g1 },
          fixtures: {},
          processing: 'enhanced',
        },
      ],
    }
    expect(() => platesOf(record, '/r.json')).toThrow(/has no levers/)
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
    ).toThrow(/references hash/)
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
    expect(await pixel(large, 720, 40)).toEqual(ground)
    expect((await pixel(large, 720, 50))[1]).toBeGreaterThan(240)
  })
})
