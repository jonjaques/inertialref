import { createHash } from 'node:crypto'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeCatalog, isUnstableId, readCatalog } from '@inertialref/universe'
import { fetchSource, SOURCES } from './sources.ts'
import { buildCatalog, type BuildReport } from './build.ts'
import { buildTextures } from './textures.ts'
import { buildSolarReference } from './solarReference.ts'
import { buildShapes } from './shapes.ts'

/*
 * The ingest.
 *
 * `fetch` → `build` → an asset the game ships. Run it when astronomy publishes
 * something; the artifact it writes is committed, so nobody needs to run it to
 * play the game or to run the tests.
 *
 * Everything it did is printed. An ingest that quietly drops a third of the
 * catalog looks exactly like one that does not, so the counts are the output
 * and the file is a side effect.
 */

const RADIUS_LIGHT_YEARS = 150
/*
 * Inside this radius the catalog is treated as complete and procedural fill is
 * switched off. See `CellContext.completeRadius` in `packages/universe`.
 *
 * 25 ly is where HYG stops being volume-complete: it holds 166 systems there
 * against the ~188 the density model expects, and both of those are within the
 * noise of a count that small. By 50 ly the ratio is 978 against ~1,509 and the
 * gap is real, so that is where the fill has to start.
 */
const COMPLETE_RADIUS_LIGHT_YEARS = 25
const OUTPUT_DIRECTORY = 'data/catalog'
const TEXTURE_DIRECTORY = 'data/textures'
const REFERENCE_DIRECTORY = 'data/reference'
const SHAPE_DIRECTORY = 'data/shapes'
const OUTPUT_FILE = 'stars-150ly.irsc'

const root = new URL('../../../', import.meta.url).pathname

const pad = (value: number | string, width = 8): string =>
  String(value).padStart(width)

const percent = (part: number, whole: number): string =>
  whole === 0 ? '   —' : `${((100 * part) / whole).toFixed(1)}%`

async function load(refresh: boolean) {
  const fetched = []
  for (const source of SOURCES) {
    const result = await fetchSource(source, root, { refresh })
    console.log(
      `  ${source.name.padEnd(38)} ${pad((result.bytes / 1e6).toFixed(1))} MB  ` +
        `${result.sha256.slice(0, 12)}  ${result.cached ? 'cached' : 'downloaded'}`,
    )
    fetched.push(result)
  }
  return fetched
}

function printReport(report: BuildReport): void {
  const s = report.starsKept
  console.log(`
  systems                 ${pad(report.systems)}   from ${report.starsConsidered} rows inside ${RADIUS_LIGHT_YEARS} ly
  dropped, no parallax    ${pad(report.droppedNoParallax)}   the dist >= 100000 sentinel, across the whole file
  multiple-star systems   ${pad(report.multiples)}   ${percent(report.multiples, s)}

  with a proper name      ${pad(report.withProperName)}   ${percent(report.withProperName, s)}
  with a spectral type    ${pad(report.withSpectralType)}   ${percent(report.withSpectralType, s)}
  with a color index      ${pad(report.withColourIndex)}   ${percent(report.withColourIndex, s)}
  with a magnitude        ${pad(report.withMagnitude)}   ${percent(report.withMagnitude, s)}

  unparsed spectral types ${pad(report.spectralUnparsed)}   had a string the parser could not read
  sentinel proper motions ${pad(report.sentinelProperMotions)}   |pm| > 9000 mas/yr, i.e. not a measurement
  ids only HYG can supply ${pad(report.unstableIds)}   ${percent(report.unstableIds, s)} — these move if HYG renumbers
  duplicate ids dropped   ${pad(report.duplicateIds.length)}   ${report.duplicateIds.slice(0, 6).join(', ')}

  planets matched         ${pad(report.planetsMatched)}   across ${report.hostSystems} host systems
    by HIP designation    ${pad(report.matchedBy['hip'] ?? 0)}
    by HD designation     ${pad(report.matchedBy['hd'] ?? 0)}
    by name               ${pad(report.matchedBy['name'] ?? 0)}
    by sky position       ${pad(report.matchedBy['position'] ?? 0)}
  planets unmatched       ${pad(report.planetsUnmatched.length)}   around ${report.unmatchedHosts.length} hosts HYG does not contain
                                   not a matching failure: HYG is magnitude-limited and these
                                   hosts are below it. This is the horizon of knowledge, and
                                   the star map is supposed to draw it.
                                   e.g. ${report.unmatchedHosts.slice(0, 6).join(', ')}`)
}

async function build({ write, refresh }: { write: boolean; refresh: boolean }) {
  console.log('sources')
  const [hyg, exoplanets] = await load(refresh)
  if (hyg === undefined || exoplanets === undefined)
    throw new Error('missing a source')

  const { catalog, report } = buildCatalog(hyg.text, exoplanets.text, {
    radiusLightYears: RADIUS_LIGHT_YEARS,
    completeRadiusLightYears: COMPLETE_RADIUS_LIGHT_YEARS,
    version: 'pending',
  })

  /*
   * The version digests the *packed output*, not the sources.
   *
   * `docs/design/galaxy.md` Rule 1 makes it a generation input, so it has to
   * change exactly when the shipped data changes and never otherwise. Hashing the
   * downloads fails that in both directions: the NASA archive's TAP service
   * returned two different digests an hour apart for a query whose 702 matched
   * planets were identical, and a version that churns on its own turns a future
   * revision notice into noise. Metadata is excluded because it contains the
   * version — with one exception: the complete radius *is* a generation input
   * (it decides where procedural fill is suppressed) and is not derivable from
   * the stars, so retuning it must change the version or the universe shifts
   * under existing saves with no way to notice.
   */
  const version = `hyg-4.4+nea-${createHash('sha256')
    .update(
      encodeCatalog({
        metadata: {
          version: '',
          radiusLightYears: 0,
          completeRadiusLightYears: COMPLETE_RADIUS_LIGHT_YEARS,
          attribution: [],
          sources: [],
        },
        stars: catalog.stars,
        planets: catalog.planets,
      }),
    )
    .digest('hex')
    .slice(0, 8)}`
  const withSources = {
    ...catalog,
    metadata: {
      ...catalog.metadata,
      version,
      sources: SOURCES.map((source, i) => ({
        name: source.name,
        url: source.url,
        licence: source.licence,
        // The digest of what was actually read, so a changed artifact can always
        // be traced to the input that changed it.
        retrieved: [hyg, exoplanets][i]?.sha256.slice(0, 16) ?? '',
      })),
    },
  }

  printReport(report)

  const bytes = encodeCatalog(withSources)
  const compressed = brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  })
  console.log(`
  packed                  ${pad((bytes.length / 1024).toFixed(1))} KB
  brotli                  ${pad((compressed.length / 1024).toFixed(1))} KB   what it costs over the wire
  per system              ${pad((compressed.length / report.systems).toFixed(1))} B`)

  // Decode what was just encoded, every time. The codec's two halves live in one
  // file precisely so they cannot drift, and this is the assertion that says so.
  const reread = readCatalog(bytes)
  if (reread.stars.length !== catalog.stars.length)
    throw new Error(
      `round trip lost stars: wrote ${catalog.stars.length}, read ${reread.stars.length}`,
    )
  const unstable = reread.stars.filter((s) => isUnstableId(s.id)).length
  console.log(
    `  round trip              ${pad('ok')}   ${reread.stars.length} systems, ${reread.metadata.version}`,
  )

  console.log('\n  a sample of what came back:')
  for (const name of [
    'Sol',
    'Alpha Centauri',
    'Sirius',
    'Tau Ceti',
    '61 Cygni',
    "Barnard's Star",
    'Trappist-1',
  ]) {
    const star = reread.find(name)
    if (star === undefined) {
      console.log(`    ${name.padEnd(18)} not found`)
      continue
    }
    const p = star.physical
    console.log(
      `    ${star.name.padEnd(18)} ${(star.id as string).padEnd(10)} ` +
        `${star.spectralSource.padEnd(8)} ${pad(p.temperature.toFixed(0), 6)} K  ` +
        `${pad(p.solarLuminosities.toPrecision(3), 9)} L☉  ` +
        `${pad(p.solarRadii.toFixed(3), 7)} R☉  ${pad(p.solarMasses.toFixed(2), 5)} M☉  ` +
        `${pad(star.distanceLightYears.toFixed(2), 7)} ly  ` +
        `${star.planets.length} planets  ` +
        `[${star.designations.map((d) => d.text).join(' · ')}]`,
    )
  }

  if (!write) return
  const directory = join(root, OUTPUT_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, OUTPUT_FILE), bytes)
  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify(
      {
        version,
        radiusLightYears: RADIUS_LIGHT_YEARS,
        completeRadiusLightYears: COMPLETE_RADIUS_LIGHT_YEARS,
        file: OUTPUT_FILE,
        bytes: bytes.length,
        brotliBytes: compressed.length,
        systems: report.systems,
        planets: report.planetsMatched,
        hostSystems: report.hostSystems,
        unstableIds: unstable,
        sources: withSources.metadata.sources,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(directory, 'LICENSE.md'),
    licenceText(withSources.metadata.attribution, version),
  )
  console.log(`\n  written to ${OUTPUT_DIRECTORY}/`)
}

/**
 * The notice that has to sit beside the asset.
 *
 * CC BY-SA 4.0 § 3(a)(1) sets what it must contain: who made it, a license
 * reference, a warranty disclaimer reference, a link to the source, and a
 * statement that it was modified. § 4(b) is why it attaches to *this file* and
 * not to the code that reads it — the database is Adapted Material, its
 * individual contents are not.
 */
const licenceText = (attribution: readonly string[], version: string): string =>
  `# Star catalog — license and attribution

This directory contains a **derived database** built from published astronomical
catalogs by \`apps/ingest\`. It is not part of the Apache-2.0 licensed source
code that reads it, and it carries different terms.

**Catalog version:** \`${version}\`

## Terms

The packed catalog (\`${OUTPUT_FILE}\`) is a database derived substantially from
the HYG Database and is therefore Adapted Material under CC BY-SA 4.0 § 4(b).
**It is licensed CC BY-SA 4.0.** The share-alike obligation attaches to this
database, not to its individual contents and not to the software that reads it.

${attribution.map((line) => `- ${line}`).join('\n\n')}

## Warranty

These works are provided "as-is" and without warranties of any kind, to the
extent permitted by the respective licenses. Positions, magnitudes and orbital
elements are measurements with published uncertainties; the values derived from
them here (temperature, luminosity, radius, mass) are estimates and are marked as
such in the game where they are shown.

## Rebuilding

\`\`\`
pnpm catalog:build
\`\`\`

Sources and their exact digests are recorded in \`manifest.json\`.
`

/**
 * Planetary surface maps.
 *
 * Separate from `build` because the two have nothing in common but a manifest
 * convention: the catalog is 34 MB in and 458 KB out and takes seconds, and
 * this is 600 MB in and ~20 MB out and takes minutes. Bundling them would mean
 * re-downloading half a gigabyte of Voyager imagery every time NASA publishes a
 * new exoplanet.
 */
async function textures() {
  console.log('textures')
  const manifest = await buildTextures({
    root,
    outputDirectory: TEXTURE_DIRECTORY,
    onProgress: (message) => console.log(message),
  })
  const total = manifest.textures.reduce((n, t) => n + t.bytes, 0)
  writeFileSync(
    join(root, TEXTURE_DIRECTORY, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(
    join(root, TEXTURE_DIRECTORY, 'LICENSE.md'),
    textureLicence(manifest.attribution),
  )
  console.log(`
  ${manifest.textures.length} maps, ${(total / 1024 / 1024).toFixed(1)} MB
  written to ${TEXTURE_DIRECTORY}/`)
}

const textureLicence = (attribution: readonly string[]): string =>
  `# Planetary textures — license and attribution

Surface maps for the Solar System, built by \`apps/ingest\` from published
imagery. **Not covered by the Apache-2.0 license on the source code.**

Most of these are **public domain**: NASA and USGS imagery is not subject to
copyright. The exceptions are marked \`cc-by-4.0\` in \`manifest.json\` and are
listed below; CC BY 4.0 requires attribution but imposes no share-alike, so
unlike the star catalog these do not make anything downstream of them
CC-licensed.

${attribution.map((line) => `- ${line}`).join('\n\n')}

Per-file provenance — source URL, license and output digest — is in
\`manifest.json\`. Rebuild with \`pnpm textures:build\`; see
\`docs/guides/catalogue.md\`.
`

/**
 * The Solar System's published measurements, as the reference the tests use.
 *
 * Not an asset the game loads. `packages/universe/src/solar` carries the
 * numbers transcribed into source, because facts are not a licensed database;
 * this writes the same numbers straight out of JPL so that
 * `apps/headless/src/solarSystem.test.ts` can tell a typo from a decision.
 * See `solarSources.ts` for why it is committed rather than fetched at test
 * time.
 */
async function solar(refresh: boolean) {
  console.log('solar system reference')
  const reference = await buildSolarReference({
    root,
    refresh,
    today: new Date().toISOString().slice(0, 10),
    onProgress: (message) => console.log(message),
  })
  const directory = join(root, REFERENCE_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'solar-system.json')
  writeFileSync(file, `${JSON.stringify(reference, null, 2)}\n`)

  const irregular = reference.smallBodies.filter(
    (body) => body.physical.extentKm !== null,
  ).length
  const shaped = reference.smallBodies.filter(
    (body) => body.physical.diameterKm !== null,
  ).length
  console.log(`
  with a measured diameter  ${pad(shaped)} of ${reference.smallBodies.length}
  with a tri-axial extent   ${pad(irregular)}   these are the ones that are not spheres
  written to ${REFERENCE_DIRECTORY}/solar-system.json`)
}

/**
 * Shape models for the bodies gravity never rounded off.
 *
 * Separate from `textures` for the same reason `textures` is separate from
 * `build`: different inputs, different runtime, and no reason for one to
 * re-download the other. The whole set is about 20 MB in and 900 KB out.
 */
async function shapes(refresh: boolean) {
  console.log('shape models')
  const manifest = await buildShapes({
    root,
    outputDirectory: SHAPE_DIRECTORY,
    refresh,
    onProgress: (message) => console.log(message),
  })
  const total = manifest.shapes.reduce((n, s) => n + s.bytes, 0)
  writeFileSync(
    join(root, SHAPE_DIRECTORY, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(
    join(root, SHAPE_DIRECTORY, 'LICENSE.md'),
    shapeLicence(manifest.attribution),
  )
  console.log(`
  ${manifest.shapes.length} shape models, ${(total / 1024).toFixed(0)} KB
  written to ${SHAPE_DIRECTORY}/`)
}

const shapeLicence = (attribution: readonly string[]): string =>
  `# Shape models — provenance

Measured figures of Solar System bodies, built by \`apps/ingest\` from models
archived at the NASA Planetary Data System Small Bodies Node.

**These are United States Government works and are in the public domain.** There
is no license to comply with. What is here instead is *provenance*, which for a
shape model matters more than a license does: a body's figure is a measurement,
and a measurement with no citation is a guess.

${attribution.map((line) => `- ${line}`).join('\n\n')}

Per-model provenance — the source URL, the publication the model comes from, the
reconstructed volume against the source's own, and the output digest — is in
\`manifest.json\`. Rebuild with \`pnpm shapes:build\`.
`

const command = process.argv[2] ?? 'build'
const refresh = process.argv.includes('--refresh')

try {
  if (command === 'fetch') {
    console.log('sources')
    await load(refresh)
  } else if (command === 'report') {
    await build({ write: false, refresh })
  } else if (command === 'build') {
    await build({ write: true, refresh })
  } else if (command === 'textures') {
    await textures()
  } else if (command === 'solar') {
    await solar(refresh)
  } else if (command === 'shapes') {
    await shapes(refresh)
  } else {
    console.error(
      `unknown command "${command}"\n\n  fetch     download the catalog sources into .data/raw\n  report    build the catalog and print, without writing\n  build     build the catalog and write data/catalog\n  textures  build the planetary surface maps into data/textures\n  solar     refresh data/reference/solar-system.json from JPL\n  shapes    build the measured shape models into data/shapes\n\n  --refresh  re-download rather than using the cache`,
    )
    process.exit(2)
  }
} catch (cause) {
  console.error(
    `\ningest failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
  )
  process.exit(1)
}
