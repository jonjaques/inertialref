#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  DEFAULT_PICTURE_PROCESSING,
  encodePictures,
  findPicture,
  openSession,
} from '../../packages/devtools/src/index.ts'
import { LENS_PRESETS } from '../../packages/rendering/src/index.ts'
import { pictureLink } from '../../apps/game/src/planetarium/presetUrl.ts'

const SURFACE_LENS = {
  ...LENS_PRESETS.flight,
  fStop: 2.8,
  shutter: 1 / 40_000,
  iso: 100,
  zoom: 1,
}

/** Solve recipes once so every review link carries a complete camera and lens. */
export function cameraReviewPictures() {
  let lens = SURFACE_LENS
  const session = openSession({
    seed: 'inertialref',
    workers: null,
    render: {
      framingLens: () => lens,
      setFlightLens: (next) => {
        lens = next
      },
    },
  })
  try {
    const ir = session.harness
    const before = session.world.stateHash()
    const targets = ir.targets({ lightYears: 0 })
    const addressOf = (name) => {
      const found = targets.find((one) => one.name === name)
      if (found === undefined)
        throw new Error(`The review needs ${name} in the session catalog.`)
      return found.address
    }
    const recipe = findPicture('blue-marble')
    const scenes = [
      { id: 'earth', label: 'Sunlit Earth', picture: recipe },
      {
        id: 'earth-band',
        label: 'Earth and Milky Way',
        picture: recipe,
        band: true,
      },
      {
        id: 'luna',
        label: 'Sunlit Luna',
        picture: {
          ...recipe,
          address: addressOf('Luna'),
          framing: { kind: 'compose', composition: 'gibbous' },
        },
      },
      {
        id: 'night',
        label: 'Earth night side',
        picture: findPicture('night-side'),
      },
      {
        id: 'bennu',
        label: 'Bennu',
        picture: {
          ...recipe,
          address: addressOf('Bennu'),
          framing: { kind: 'compose', composition: 'gibbous' },
        },
      },
    ]
    const pictures = []
    for (const scene of scenes) {
      lens = SURFACE_LENS
      ir.takePicture(scene.picture)
      if (scene.band) {
        ir.observatory.setAngles(-Math.PI / 2, 0, false)
        ir.observatory.setDistance(25_000_000, false)
        lens = { ...SURFACE_LENS, focalLength: 18.84 }
      }
      const base = ir.capturePicture(
        `camera-review-${scene.id}`,
        scene.label,
        'Matched camera review at a held photographic instant.',
      )
      for (const mode of ['enhanced', 'automatic', 'manual']) {
        pictures.push({
          ...base,
          id: `${base.id}-${mode}`,
          label: `${base.label} · ${mode}`,
          processing: { ...DEFAULT_PICTURE_PROCESSING, mode },
        })
      }
      pictures.push({
        ...base,
        id: `${base.id}-manual-long`,
        label: `${base.label} · Manual 2400 s`,
        lens: { ...base.lens, shutter: 2400 },
        processing: { ...DEFAULT_PICTURE_PROCESSING, mode: 'manual' },
      })
    }
    if (session.world.stateHash() !== before)
      throw new Error('Camera review setup changed canonical state.')
    return pictures
  } finally {
    session.dispose()
  }
}

export function reviewMarkdown(pictures, origin) {
  const target = new URL(origin)
  if (
    !['https:', 'http:'].includes(target.protocol) ||
    target.username ||
    target.password
  )
    throw new Error(
      '--origin needs an HTTP or HTTPS preview origin without credentials.',
    )
  const link = (picture, label) =>
    `[${label}](${new URL(pictureLink(picture), target.origin)})`
  const rows = []
  for (let offset = 0; offset < pictures.length; offset += 4) {
    const [enhanced, automatic, manual, long] = pictures.slice(
      offset,
      offset + 4,
    )
    const lens = enhanced.lens
    rows.push(
      `| ${enhanced.label.replace(' · enhanced', '')} | ${enhanced.time} | ${lens.focalLength.toFixed(2)} mm · f/${lens.fStop} · 1/40000 s · ISO ${lens.iso} | ${link(enhanced, 'Enhanced')} · ${link(automatic, 'Automatic')} · ${link(manual, 'Manual')} | ${link(long, 'Manual 2400 s')} |`,
    )
  }
  return [
    'Camera review links use the same pose, photographic time and lens in each mode triplet. The separate long Manual view changes only shutter to 2400 s.',
    '',
    'All views use a 24 mm gauge, zoom 1, infinite focus and D65 white balance. Automatic uses compensation 0, adaptation rate 1, bright range 24 EV and dark range 16 EV. Links contain no adaptation history or display settings; begin review in standard SDR and compare at the same window size.',
    '',
    '| Scene | Time, seconds from J2000 | Matched lens | Matched modes | Separate long exposure |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Allow Automatic to settle. Check bright-world detail, star visibility, dark lanes and foreground occlusion. These links reproduce the views; image acceptance remains a manual review.',
    '',
    'Journey endpoints are not saved-picture framings. Use the galaxy travel controls to check outward and return transitions while retaining the chosen camera mode.',
    '',
  ].join('\n')
}

function main() {
  const { values } = parseArgs({
    options: {
      origin: { type: 'string', default: 'http://localhost:5173' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Usage: node scripts/camera/preview.mjs [--origin https://preview.example] [--json]\nPrints matched camera review links as Markdown. --json prints a version 2 preset library for import. Runs headlessly, opens no browser and writes no files.',
    )
    return
  }
  const pictures = cameraReviewPictures()
  process.stdout.write(
    values.json
      ? encodePictures(pictures)
      : reviewMarkdown(pictures, values.origin),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
