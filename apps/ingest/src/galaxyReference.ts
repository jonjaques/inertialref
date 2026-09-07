import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { invariant } from '@inertialref/shared'

export const DUST_SOURCE =
  'https://cdsarc.cds.unistra.fr/ftp/J/A+A/661/A147/cube_ext.fits.gz'
export const SKY_SOURCE = 'https://doi.org/10.1093/mnras/staa4005'

/** Selection windows identify complexes; the map supplies the fitted geometry and column. */
export const CLOUD_WINDOWS = [
  ['Aquila Rift', 20, 50, -5, 20, 180, 650],
  ['Cygnus Rift', 65, 90, -5, 15, 400, 1000],
  ['Ophiuchus', 350, 360, 10, 25, 90, 200],
  ['Taurus', 155, 180, -25, -5, 90, 220],
  ['Perseus', 150, 165, -25, -10, 230, 400],
  ['Orion', 195, 220, -25, -5, 300, 550],
  ['Chamaeleon', 290, 315, -25, -10, 120, 250],
  ['Lupus', 330, 350, 5, 25, 100, 250],
  ['Coalsack', 295, 305, -5, 5, 120, 250],
] as const

export function readDustCube(bytes: Buffer) {
  const header = new Map<string, string>()
  let end = 0
  for (let i = 0; i + 80 <= bytes.length; i += 80) {
    const card = bytes.toString('ascii', i, i + 80)
    const key = card.slice(0, 8).trim()
    if (key === 'END') {
      end = Math.ceil((i + 80) / 2880) * 2880
      break
    }
    if (card[8] === '=') header.set(key, card.slice(10).split('/')[0]!.trim())
  }
  invariant(
    end > 0 && header.get('BITPIX') === '-32',
    'Dust map must be a float32 FITS image',
  )
  invariant(header.get('NAXIS') === '3', 'Dust map must have three axes')
  // UNIT contains a slash inside its quoted value; read that card intact.
  const cards = bytes.toString('ascii', 0, end).match(/.{80}/g) ?? []
  invariant(
    cards.some(
      (c) => c.startsWith('UNIT    ') && c.includes("'A0(550nm)/parsec'"),
    ),
    'Dust map must use A0 magnitudes per parsec',
  )
  const sizes = [1, 2, 3].map((i) => Number(header.get(`NAXIS${i}`)))
  const step = Number(header.get('STEP'))
  invariant(
    sizes.every((n) => Number.isInteger(n) && n > 1) && step > 0,
    'Invalid dust grid',
  )
  const count = sizes.reduce((a, b) => a * b, 1)
  invariant(bytes.length >= end + count * 4, 'Truncated dust map')
  const sun = ['X', 'Y', 'Z'].map((a) => Number(header.get(`SUN_POS${a}`)))
  invariant(sun.every(Number.isFinite), 'Missing solar grid origin')
  return {
    sizes,
    step,
    sun,
    at(x: number, y: number, z: number) {
      return bytes.readFloatBE(end + 4 * ((z * sizes[1]! + y) * sizes[0]! + x))
    },
  }
}

const round = (v: number) => Number(v.toPrecision(9))
export function extractClouds(bytes: Buffer) {
  const cube = readDustCube(bytes)
  const samples = CLOUD_WINDOWS.map(() => [] as number[][])
  // FITS SUN_POS marks cell centers at half indices. The 601 samples span -3000..3000 pc.
  for (let iz = 0; iz < cube.sizes[2]!; iz++)
    for (let iy = 0; iy < cube.sizes[1]!; iy++)
      for (let ix = 0; ix < cube.sizes[0]!; ix++) {
        const p = [ix, iy, iz].map(
          (v, a) => (v + 0.5 - cube.sun[a]!) * cube.step,
        )
        const d = Math.hypot(...p)
        if (d < 90 || d > 1100) continue
        const l = ((Math.atan2(p[1]!, p[0]!) * 180) / Math.PI + 360) % 360
        const b = (Math.asin(p[2]! / d) * 180) / Math.PI
        // Separate cloud excess from the smooth disk. This threshold is a fit choice, in mag/pc.
        const weight = Math.max(0, cube.at(ix, iy, iz) - 0.001)
        if (weight === 0) continue
        CLOUD_WINDOWS.forEach((w, i) => {
          if (
            l >= w[1] &&
            l < w[2] &&
            b >= w[3] &&
            b < w[4] &&
            d >= w[5] &&
            d < w[6]
          )
            samples[i]!.push([...p, weight])
        })
      }
  return CLOUD_WINDOWS.map((window, i) => {
    const rows = samples[i]!
    invariant(rows.length > 10, `No resolved dust in ${window[0]}`)
    const total = rows.reduce((sum, p) => sum + p[3]!, 0)
    const center = [0, 1, 2].map(
      (a) => rows.reduce((s, p) => s + p[a]! * p[3]!, 0) / total,
    )
    const sigma = center.map((c, a) =>
      Math.max(
        12.5,
        Math.sqrt(
          rows.reduce((s, p) => s + (p[a]! - c) ** 2 * p[3]!, 0) / total,
        ),
      ),
    )
    const amplitude =
      (total * cube.step ** 3) /
      ((2 * Math.PI) ** 1.5 * sigma.reduce((a, b) => a * b, 1))
    const distance = Math.hypot(...center)
    const chordSigma =
      1 /
      Math.sqrt(
        center.reduce((s, v, a) => s + (v / distance / sigma[a]!) ** 2, 0),
      )
    return {
      name: window[0],
      window: window.slice(1),
      voxels: rows.length,
      centerParsecs: center.map(round),
      sigmaParsecs: sigma.map(round),
      extinctionMagnitudePerParsec: round(amplitude),
      centralColumnMagnitudes: round(
        amplitude * Math.sqrt(2 * Math.PI) * chordSigma,
      ),
    }
  })
}

export const SKY_WINDOWS = [
  { name: 'Mid-latitudes', longitude: [0, 360], absoluteLatitude: [30, 60] },
  { name: 'Polar caps', longitude: [0, 360], absoluteLatitude: [60, 90] },
  { name: 'Aquila sightline', longitude: [40, 50], absoluteLatitude: [0, 5] },
] as const

export function extractSky(csv: string) {
  const sums = SKY_WINDOWS.map(() => ({ pixels: 0, v: 0, photopic: 0 }))
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const row = line.split(',').map(Number)
    invariant(
      row.length === 7 && row.every(Number.isFinite),
      'Invalid GAMBONS row',
    )
    const [, l, b, v, , , photopic] = row
    SKY_WINDOWS.forEach((w, i) => {
      if (
        l! >= w.longitude[0] &&
        l! < w.longitude[1] &&
        Math.abs(b!) >= w.absoluteLatitude[0] &&
        Math.abs(b!) < w.absoluteLatitude[1]
      ) {
        sums[i]!.pixels++
        sums[i]!.v += v! * 1e9
        sums[i]!.photopic += photopic! * 1e9
      }
    })
  }
  return SKY_WINDOWS.map((window, i) => {
    const s = sums[i]!
    invariant(s.pixels > 0, `No sky pixels in ${window.name}`)
    return {
      ...window,
      pixels: s.pixels,
      vNanowatts: round(s.v / s.pixels),
      photopicNanowatts: round(s.photopic / s.pixels),
    }
  })
}

export function buildGalaxyReference(dustPath: string, skyPath: string) {
  const dust = readFileSync(dustPath),
    sky = readFileSync(skyPath)
  const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const reference = {
    version: 1,
    dust: {
      source: DUST_SOURCE,
      sha256: digest(dust),
      units: 'A0(550nm) mag/pc',
      resolutionParsecs: 25,
      excessFloor: 0.001,
      clouds: extractClouds(dust),
    },
    sky: {
      source: SKY_SOURCE,
      file: 'RadianceOut.csv',
      sha256: digest(sky),
      components: ['ISL', 'DGL', 'EBL'],
      regions: extractSky(sky.toString('utf8')),
    },
  }
  mkdirSync('data/reference', { recursive: true })
  writeFileSync(
    'data/reference/galaxy.json',
    JSON.stringify(reference, null, 2) + '\n',
  )
  writeFileSync(
    'packages/universe/src/galaxy/localClouds.generated.ts',
    '// Generated by apps/ingest/src/galaxyReference.ts; source digests and fit windows are in data/reference/galaxy.json.\n' +
      'export const LOCAL_CLOUD_RECORDS = ' +
      JSON.stringify(reference.dust.clouds, null, 2) +
      ' as const\n',
  )
  writeFileSync(
    'packages/universe/src/galaxy/skyCalibration.generated.ts',
    '// Generated by apps/ingest/src/galaxyReference.ts from GAMBONS RadianceOut.csv.\n' +
      'export const SKY_REGION_REFERENCES = ' +
      JSON.stringify(reference.sky.regions, null, 2) +
      ' as const\n',
  )
  console.log(JSON.stringify(reference, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  invariant(
    process.argv[2] && process.argv[3],
    'Pass the decompressed Lallement FITS and GAMBONS RadianceOut.csv paths',
  )
  buildGalaxyReference(process.argv[2], process.argv[3])
}
