import assert from 'node:assert/strict'
import {
  globSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  SOFTWARE_CREDITS,
  TECHNIQUE_CREDITS,
  THIRD_PARTY_LICENSES,
} from '../apps/game/src/pages/creditsData.ts'

const root = join(import.meta.dirname, '..')
const dist = join(root, 'apps/game/dist')
const inventoryFile = join(dist, 'bundled-licenses.json')
const noticesFile = THIRD_PARTY_LICENSES.slice(1)
const noticeFile = join(root, 'NOTICE')

const softwarePackages = new Set(
  SOFTWARE_CREDITS.flatMap((credit) => credit.packages ?? []),
)

// CSS assets and the bits Vite and Astro inline in the browser have no
// module IDs. Rough.js includes its own geometry dependencies in its bundle.
const clientExtras = [
  'astro',
  'vite',
  'tailwindcss',
  'tw-animate-css',
  '@fontsource-variable/archivo',
  '@fontsource-variable/ibm-plex-sans',
  '@fontsource/ibm-plex-mono',
  '@fontsource/noto-sans-math',
  '@fontsource/noto-sans-symbols',
  'hachure-fill',
  'path-data-parser',
  'points-on-curve',
  'points-on-path',
  'dnd-core',
]

// The Worker ships beside the client assets. This set comes from the Worker
// build's source map, including sources in bundles published by Clerk.
const workerPackages = [
  '@clerk/backend',
  '@clerk/shared',
  '@stablelib/base64',
  'change-case@5.4.4',
  'cookie@1.1.1',
  'fast-sha256',
  'map-obj@5.0.2',
  'snakecase-keys@9.0.2',
  'standardwebhooks',
]

// These exact releases omit a license file in their published package or
// include the code only through a prebundled dependency.
const supplements = {
  '@react-dnd/invariant@4.0.2': 'react-dnd-invariant-4.0.2.LICENSE',
  '@react-dnd/shallowequal@4.0.2': 'react-dnd-shallowequal-4.0.2.LICENSE',
  '@react-three/fiber@9.8.2': 'react-three-fiber-9.8.2.LICENSE',
  '@takram/three-atmosphere@0.19.1+fork.7':
    '../takram-three-geospatial.LICENSE',
  '@takram/three-geospatial@0.9.1+fork.7': '../takram-three-geospatial.LICENSE',
  'change-case@5.4.4': 'change-case-5.4.4.LICENSE',
  'map-obj@5.0.2': 'map-obj-5.0.2.LICENSE',
  'snakecase-keys@9.0.2': 'snakecase-keys-9.0.2.LICENSE',
  'standardwebhooks@1.1.1': 'standardwebhooks-1.1.1.LICENSE',
}

const read = (path) => readFileSync(path, 'utf8')
const json = (path) => JSON.parse(read(path))
const divider = '-'.repeat(80)
const section = (title) => `${divider}\n${title}\n${divider}\n\n`
const software = section('Software')
const astronomy = section('Astronomical data')

function creditLines(credits) {
  return credits
    .map(({ name, authors, url, use, license, packages }) =>
      [
        name,
        `  ${authors}, ${url}`,
        ...(license ? [`  Licensed ${license}.`] : []),
        ...use
          .match(/.{1,76}(?:\s|$)|\S+(?:\s|$)/g)
          .map((line) => `  ${line.trimEnd()}`),
        ...(packages ? [`  Packages: ${packages.join(', ')}`] : []),
      ].join('\n'),
    )
    .join('\n\n')
}

function repositoryNotice() {
  const notice = read(noticeFile)
  const existingSoftware = notice.indexOf(software)
  const data = notice.indexOf(astronomy)
  assert(data !== -1, 'NOTICE has no Astronomical data section')
  const start = notice.slice(
    0,
    existingSoftware === -1 ? data : existingSoftware,
  )
  return (
    start +
    software +
    'The browser and Worker include the works below. Their upstream terms and\n' +
    'copyright notices travel with the production build in third-party-licenses.txt.\n\n' +
    creditLines(SOFTWARE_CREDITS) +
    '\n\n' +
    section('Techniques') +
    creditLines(TECHNIQUE_CREDITS) +
    '\n\n' +
    notice.slice(data)
  )
}

function packageDirectory({ name, version }) {
  const paths = globSync(
    `node_modules/.pnpm/${name.replace('/', '+')}@*/node_modules/${name}/package.json`,
    { cwd: root },
  ).sort()
  const path = paths.find(
    (path) => !version || json(join(root, path)).version === version,
  )
  return path === undefined ? null : dirname(join(root, path))
}

function packageSpec(spec) {
  const at = spec.lastIndexOf('@')
  return at > 0
    ? { name: spec.slice(0, at), version: spec.slice(at + 1) }
    : { name: spec }
}

function buildNotices(notice) {
  const bundled = json(inventoryFile)
  const legal = new Map()
  const add = (heading, text) => {
    const body = text.trimEnd()
    const headings = legal.get(body) ?? new Set()
    headings.add(heading)
    legal.set(body, headings)
  }

  for (const entry of [
    ...bundled,
    ...[...clientExtras, ...workerPackages].map(packageSpec),
  ]) {
    const { name } = entry
    assert(
      softwarePackages.has(name),
      `Add a credit in creditsData.ts for ${name}`,
    )
    const dir = packageDirectory(entry)
    const metadata = dir ? json(join(dir, 'package.json')) : {}
    const version = entry.version ?? metadata.version
    const key = `${name}@${version}`
    const supplemental = supplements[key]
    // Khroma's LICENSE declares MIT although its manifest omits the field.
    const license =
      entry.identifier ??
      metadata.license ??
      (supplemental || name === 'khroma' ? 'MIT' : undefined)
    assert(license, `No verified license identifier for ${key}`)
    const heading = `${key} (${license})`
    assert(
      dir || supplemental,
      `No installed package or verified license for ${key}`,
    )
    const files = dir
      ? readdirSync(dir)
          .filter(
            (file) =>
              /^(?:licen[cs]e(?:[-.].*)?|copying(?:\..*)?|notice(?:\..*)?|third.party.notices\.md)$/i.test(
                file,
              ) && !file.endsWith('.mjs'),
          )
          .sort()
      : []
    assert(files.length || supplemental, `No upstream license text for ${key}`)
    for (const file of files) add(`${heading}, ${file}`, read(join(dir, file)))
    if (supplemental)
      add(heading, read(join(root, 'vendor/third-party', supplemental)))
  }

  const fromPackage = (name, file) =>
    read(join(packageDirectory({ name }), file))
  const header = (name, file) =>
    fromPackage(name, file).match(/\/\*\*[\s\S]*?\*\//)[0]
  const takramAir = '@takram/three-atmosphere'
  add(
    'Eric Bruneton and INRIA (BSD-3-Clause)',
    header(takramAir, 'src/webgpu/common.ts'),
  )
  add(
    'Epic Games, Inc. (MIT)',
    header(takramAir, 'src/webgpu/multiscattering.ts'),
  )
  add(
    'Intel Corporation (Apache-2.0)',
    header(takramAir, 'src/webgpu/ShadowLengthNode.ts'),
  )
  add(
    'Sony Interactive Entertainment (Apache-2.0)',
    header('@takram/three-geospatial', 'src/webgpu/ScreenSpaceShadowNode.ts'),
  )
  for (const [name, file] of [
    ['three-csm', 'src/shadow/CascadedShadowMaps.ts'],
    ['OpenGL Mathematics', 'src/textures/perlin.ts'],
    ['TileableVolumeNoise', 'src/textures/tileableNoise.ts'],
    ['Structured Volume Sampling', 'src/march/structuredSampling.ts'],
    ['Playdead temporal reprojection', 'src/resolve/varianceClipping.ts'],
    ['MJP Catmull-Rom sampling', 'src/resolve/catmullRom.ts'],
  ])
    add(name, header('three-clouds-webgpu', file))
  const stretchyGlyphs = fromPackage('katex', 'src/fonts/lib/Space.ttx')
  add(
    'KaTeX stretchy glyphs (OFL-1.1)',
    [0, 13]
      .map((id) =>
        stretchyGlyphs
          .match(
            new RegExp(
              `<namerecord nameID="${id}"[^>]*>([\\s\\S]*?)</namerecord>`,
            ),
          )[1]
          .trim(),
      )
      .join('\n\n'),
  )
  add(
    'web-worker in elkjs (Apache-2.0)',
    fromPackage('elkjs', 'lib/elk.bundled.js').match(
      /\/\*\*\s*\* Copyright 2020 Google LLC[\s\S]*?\*\//,
    )[0],
  )
  add('InertialRef (Apache-2.0)', read(join(root, 'LICENSE')))
  add(
    'Eclipse Modeling Framework for GWT (EPL-1.0)',
    read(join(root, 'vendor/third-party/EPL-1.0.LICENSE')),
  )
  add(
    'shadcn/ui (MIT)',
    read(join(root, 'vendor/third-party/shadcn-ui.LICENSE')),
  )

  return (
    notice.trimEnd() +
    '\n\n' +
    section('License texts') +
    [...legal]
      .map(([body, headings]) => `${[...headings].join('\n')}\n\n${body}`)
      .join(`\n\n${divider}\n\n`) +
    '\n'
  )
}

function checkWorker() {
  const output = join(root, 'apps/server/.cloudflare/output/v0/workers/default')
  const sources = json(join(output, 'bundle/index.js.map')).sources
  const expected = workerPackages
    .map((spec) => {
      const entry = packageSpec(spec)
      const version =
        entry.version ??
        json(join(packageDirectory(entry), 'package.json')).version
      return `${entry.name}@${version}`
    })
    .sort()
  const actual = new Set()
  for (const source of sources) {
    if (!source.includes('/node_modules/')) continue
    const match = source.match(
      /\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/(?!.*\/node_modules\/))/,
    )
    assert(match, `Cannot identify the package version for ${source}`)
    const encodedName = match[2].replace('/', '+')
    const version = match[1].slice(encodedName.length + 1).split('_')[0]
    actual.add(`${match[2]}@${version}`)
  }
  assert.deepEqual(
    [...actual].sort(),
    expected,
    'Refresh the Worker package inventory',
  )
  assert.equal(
    read(join(output, 'assets', noticesFile)),
    read(join(dist, noticesFile)),
  )
  console.log(
    `notices: Worker bundle and assets verified (${actual.size} packages)`,
  )
}

const notice = repositoryNotice()
if (process.argv[2] === '--write-notice') {
  writeFileSync(noticeFile, notice)
} else if (process.argv[2] === '--check-worker') {
  checkWorker()
} else {
  assert.equal(
    read(noticeFile),
    notice,
    'Run node scripts/third-party-notices.mjs --write-notice',
  )
  assert(
    read(join(dist, 'credits.html')).includes(`href="${THIRD_PARTY_LICENSES}"`),
    'The pre-rendered credits must link to the shipped notices',
  )
  writeFileSync(join(dist, noticesFile), buildNotices(notice))
  unlinkSync(inventoryFile)
  console.log(`notices: wrote ${noticesFile}`)
}
