import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { GalaxyInspector, GalaxyPlate } from '@inertialref/devtools'

/** A fixed instrument gain shared by every plate; raw radiance accompanies the PNG. */
const DISPLAY_SCALE = 30
const DISPLAY_CEILING = 500000
const srgb = (linear: number): number =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055

export async function writeGalaxyPlates(
  inspector: GalaxyInspector,
  directory: string,
  width = 192,
) {
  mkdirSync(directory, { recursive: true })
  const report = {
    sample: inspector.sample(),
    count: inspector.count(),
    tangencies: inspector.tangencies(),
    display: {
      scaleNanowatts: DISPLAY_SCALE,
      ceilingNanowatts: DISPLAY_CEILING,
      response:
        'asinh(channel / scale) / asinh(ceiling / scale), then sRGB; illustrative RGB with wavelength-dependent dust transport',
    },
    plates: [] as unknown[],
  }
  const views = [
    { name: 'face-on', view: 'face-on' },
    { name: 'edge-on', view: 'edge-on' },
    { name: 'observer', view: 'observer' },
    { name: 'young-arms', view: 'face-on', population: 'youngArms' },
    { name: 'bar-bulge', view: 'face-on', population: 'barBulge' },
    { name: 'halo', view: 'edge-on', population: 'halo' },
  ] as const
  for (const entry of views) {
    const { view, name } = entry
    const started = performance.now()
    const plate = inspector.plate({
      view,
      ...('population' in entry ? { population: entry.population } : {}),
      width,
      height: view === 'face-on' ? width : Math.round(width / 2),
    })
    const elapsedMs = performance.now() - started
    const pixels = displayPixels(plate)
    await sharp(pixels, {
      raw: { width: plate.width, height: plate.height, channels: 3 },
    })
      .png()
      .toFile(join(directory, `${name}.png`))
    // Little-endian float64 makes the raw reference portable and lossless.
    const raw = Buffer.alloc(plate.rgb.length * 8)
    for (let i = 0; i < plate.rgb.length; i++)
      raw.writeDoubleLE(plate.rgb[i]!, i * 8)
    writeFileSync(join(directory, `${name}.f64`), raw)
    const { rgb: _rgb, ...metadata } = plate
    report.plates.push({
      name,
      ...metadata,
      elapsedMs,
      sha256: createHash('sha256').update(raw).digest('hex'),
      rawFormat: 'interleaved RGB float64 little-endian',
    })
    console.log(
      `galaxy ${name}: ${plate.width}×${plate.height}, ${plate.samples} samples, ${elapsedMs.toFixed(0)} ms`,
    )
  }
  writeFileSync(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(
    `galaxy: ${report.count.totalStars.toExponential(6)} stars; normalization ${report.sample.normalization}; plates in ${directory}`,
  )
}

function displayPixels(plate: GalaxyPlate): Uint8Array {
  const pixels = new Uint8Array(plate.rgb.length)
  for (let i = 0; i < plate.rgb.length; i++) {
    const value = plate.rgb[i]!
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Invalid radiance at channel ${i}: ${value}`)
    pixels[i] = Math.round(
      255 *
        srgb(
          Math.min(
            1,
            Math.asinh(value / DISPLAY_SCALE) /
              Math.asinh(DISPLAY_CEILING / DISPLAY_SCALE),
          ),
        ),
    )
  }
  return pixels
}
