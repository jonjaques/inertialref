import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  type MapKind,
  TEXTURE_SOURCES,
  type TextureSource,
} from './textureSources.ts'

/*
 * Downloads to shipped textures.
 *
 * Two transforms do the work that matters. Everything else is a resize.
 *
 * **Elevation to normals.** A height field is not a normal map, and turning one
 * into the other on an *equirectangular* projection is not the textbook Sobel:
 * a degree of longitude at 80° north is a sixth of a degree at the equator, so
 * the horizontal gradient has to be divided by cos(latitude) or the poles come
 * out as a smeared mess of vertical stripes. That division goes to infinity at
 * the pole itself, which is why it is clamped — and why the clamp is a named
 * constant rather than a magic number.
 *
 * **Luminance to alpha.** A cloud map published as a greyscale JPEG is a
 * *coverage* mask wearing a colour image's clothes. Drawn as colour it is a grey
 * shell over the whole planet; moved into alpha it is weather.
 */

export interface TextureEntry {
  readonly body: string
  readonly map: MapKind
  readonly file: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly licence: string
  readonly credit: string
  readonly source: string
  /** Digest of the *output*, so a rebuild that changes nothing changes nothing. */
  readonly sha256: string
}

export interface TextureManifest {
  readonly generated: string
  readonly attribution: readonly string[]
  readonly textures: readonly TextureEntry[]
}

/**
 * WebP rather than PNG or JPEG.
 *
 * PNG is lossless and four times the size for imagery that came off a camera.
 * JPEG has no alpha, and two of these maps need one — a cloud deck and a ring.
 * AVIF is smaller again and decodes slowly enough to be visible as a stall
 * when eight bodies stream in at once.
 *
 * Quality 82 is where the belts on Jupiter stop showing ringing. Below about 75
 * they do, and a compression artefact on a planet reads as a real feature —
 * which is the one kind of visual error this project cannot tolerate.
 */
const WEBP = { quality: 82, effort: 6 } as const

/*
 * Normal maps are encoded losslessly, and this is not an optimisation knob.
 *
 * Lossy WebP is a *photographic* codec: VP8 quantises per block, and on the
 * smooth slope fields of a normal map that quantisation lands as whole 8-pixel
 * rows of the green channel offset by up to ±39 around neutral — measured on
 * the Moon's map, worst at high latitude where equirectangular stretching
 * makes the data smoothest. Each such row is a band of surface tilted ~15°
 * north or south. Face-on it is invisible; under the grazing light at the limb
 * (every full-phase shot) it renders as black latitude-parallel scratches, and
 * the relief exaggeration multiplies it. Quality 82 was tuned on Jupiter's
 * *albedo*, where ringing hides in the clouds; data has nowhere to hide.
 * Lossless VP8L on these maps is a few MB against the artefact that motivated
 * the "cannot tolerate" rule above.
 */
const WEBP_DATA = { lossless: true, effort: 6 } as const

/** Elevation only: cos(latitude) below this is treated as this. */
const POLE_CLAMP = 0.15

const cacheDir = (root: string): string => join(root, '.data', 'textures')

async function download(source: TextureSource, root: string): Promise<Buffer> {
  const path = join(cacheDir(root), source.file)
  mkdirSync(cacheDir(root), { recursive: true })
  try {
    if (statSync(path).isFile()) return readFileSync(path)
  } catch {
    /* not cached */
  }
  const response = await fetch(source.url)
  if (!response.ok)
    throw new Error(
      `${source.body}/${source.map}: ${response.status} ${response.statusText} from ${source.url}`,
    )
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(path, bytes)
  return bytes
}

/*
 * `limitInputPixels` off, and deliberately.
 *
 * sharp refuses images above ~268 megapixels by default, which is a sensible
 * guard against a decompression bomb arriving from a user. Every input here is a
 * pinned URL at a NASA or USGS domain, and several of them are legitimately
 * larger than that: the Europa mosaic is 19200x9600 and GEBCO is 21600x10800.
 */
const open = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: false, unlimited: true })

/**
 * A height field to a tangent-space normal map, with an ocean mask in alpha.
 *
 * Central differences on the *resized* field rather than on the source: the
 * output is what will be sampled, and computing gradients at 21600 wide and then
 * throwing 80% of them away produces a normal map full of detail the albedo
 * underneath it does not have.
 */
async function elevationToNormal(
  bytes: Buffer,
  source: TextureSource,
): Promise<Buffer> {
  const width = source.width
  const height = width / 2
  const radius = source.radius ?? 6_371_000
  const relief = source.relief ?? 1_000

  /*
   * `grey16`, not `b-w`, and this is the whole reason the Moon was flat.
   *
   * libvips calls 8-bit greyscale `b-w`, so `toColourspace('b-w')` on LOLA's
   * 16-bit product *downcasts* it, and a following `raw({depth:'ushort'})`
   * widens the container back to two bytes without restoring the range. The
   * result is a valid file, a plausible-looking pipeline, and every gradient 256
   * times too small.
   */
  const sixteen = (await open(bytes).metadata()).depth === 'ushort'
  const data = await open(bytes)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace(sixteen ? 'grey16' : 'b-w')
    .raw({ depth: sixteen ? 'ushort' : 'uchar' })
    .toBuffer()

  const at = (x: number, y: number): number => {
    // Longitude wraps; latitude clamps at the poles.
    const cx = ((x % width) + width) % width
    const cy = Math.min(height - 1, Math.max(0, y))
    const index = cy * width + cx
    return sixteen ? data.readUInt16LE(index * 2) : (data[index] as number)
  }

  // The field's own range, so the metres-per-value scale calibrates itself
  // against a number that is measured rather than documented.
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < width * height; i += 1) {
    const value = sixteen ? data.readUInt16LE(i * 2) : (data[i] as number)
    if (value < low) low = value
    if (value > high) high = value
  }
  const metresPerValue = high > low ? relief / (high - low) : 0
  const oceanLevel =
    source.oceanBelow === undefined
      ? -Infinity
      : low + (high - low) * source.oceanBelow

  // Metres per pixel on the ground, north–south. The equirectangular grid is
  // uniform in angle, so this is a constant; east–west is this times
  // cos(latitude), which is the whole reason for the correction below.
  const metresPerPixel = (Math.PI * radius) / height

  const out = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI
    const cosLatitude = Math.max(POLE_CLAMP, Math.cos(latitude))
    for (let x = 0; x < width; x += 1) {
      const east =
        ((at(x + 1, y) - at(x - 1, y)) * metresPerValue) /
        (2 * metresPerPixel * cosLatitude)
      const south =
        ((at(x, y + 1) - at(x, y - 1)) * metresPerValue) / (2 * metresPerPixel)

      /*
       * Tangent space, +X east, +Y north, +Z out of the surface.
       *
       * The gradients are slopes — rise over run in the same units — so the
       * normal is `(-dh/deast, -dh/dnorth, 1)` normalised. `south` is the
       * gradient going *down* the image, and north is the opposite direction,
       * so `-dh/dnorth` is `+south`. That sign is the difference between craters
       * and domes, and it is invisible until the terminator crosses one.
       *
       * Only X and Y are stored; the shader reconstructs Z as √(1 − x² − y²),
       * which is exact for a unit normal. That frees the blue channel for the
       * ocean mask — and the mask must NOT ride in alpha, which is where it
       * used to be. Alpha is semantic to every codec and canvas in the path:
       * libwebp's lossless encoder "cleans" the RGB under transparent pixels
       * to compress better, which zeroed the *entire* Moon map (no ocean, so
       * alpha 0 everywhere) and every land normal on Earth. A mask in a colour
       * channel is just data, and nothing in the pipeline has opinions about
       * data.
       */
      const nx = -east
      const ny = south
      const inverseLength = 1 / Math.hypot(nx, ny, 1)

      const index = (y * width + x) * 3
      out[index] = Math.round((nx * inverseLength * 0.5 + 0.5) * 255)
      out[index + 1] = Math.round((ny * inverseLength * 0.5 + 0.5) * 255)
      // The ocean mask where the body has one, and zero otherwise. Packed here
      // rather than shipped as a fifth file: it is one bit per texel and it is
      // always sampled at the same coordinate as the normal.
      out[index + 2] = at(x, y) <= oceanLevel ? 255 : 0
    }
  }

  return sharp(out, { raw: { width, height, channels: 3 } })
    .webp(WEBP_DATA)
    .toBuffer()
}

/** Brightness into alpha, for a layer that must be transparent where it is dark. */
async function luminanceToAlpha(
  bytes: Buffer,
  source: TextureSource,
): Promise<Buffer> {
  const width = source.width
  const height = width / 2
  const grey = await open(bytes)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('b-w')
    .raw()
    .toBuffer()

  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const value = grey[i] as number
    // White cloud, alpha from brightness. Cloud tops are very nearly a perfect
    // Lambertian white — the brightest natural surface there is — so the colour
    // channels are constant and only the coverage varies.
    out[i * 4] = 255
    out[i * 4 + 1] = 255
    out[i * 4 + 2] = 255
    out[i * 4 + 3] = value
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
    .webp(WEBP)
    .toBuffer()
}

async function plainImage(
  bytes: Buffer,
  source: TextureSource,
): Promise<Buffer> {
  const image = open(bytes).resize(source.width, source.width / 2, {
    fit: 'fill',
    kernel: 'lanczos3',
  })
  const meta = await open(bytes).metadata()
  // Keep alpha only where the source had it — a ring is mostly transparent and
  // a planet never is, and an unnecessary alpha channel is 25% of the file.
  return (meta.hasAlpha === true ? image.ensureAlpha() : image.removeAlpha())
    .webp(WEBP)
    .toBuffer()
}

export interface TextureBuildOptions {
  readonly root: string
  readonly outputDirectory: string
  /** Rebuild every entry rather than skipping ones whose output already matches. */
  readonly force?: boolean
  readonly onProgress?: (message: string) => void
}

export async function buildTextures(
  options: TextureBuildOptions,
): Promise<TextureManifest> {
  const directory = join(options.root, options.outputDirectory)
  mkdirSync(directory, { recursive: true })

  const entries: TextureEntry[] = []
  for (const source of TEXTURE_SOURCES) {
    const raw = await download(source, options.root)
    const output =
      source.transform === 'elevation'
        ? await elevationToNormal(raw, source)
        : source.transform === 'luminance'
          ? await luminanceToAlpha(raw, source)
          : await plainImage(raw, source)

    const name = `${source.body}_${source.map}.webp`
    writeFileSync(join(directory, name), output)
    entries.push({
      body: source.body,
      map: source.map,
      file: name,
      width: source.width,
      height: source.width / 2,
      bytes: output.length,
      licence: source.licence,
      credit: source.credit,
      source: source.url,
      sha256: createHash('sha256').update(output).digest('hex').slice(0, 16),
    })
    options.onProgress?.(
      `  ${`${source.body}/${source.map}`.padEnd(24)} ${String(source.width).padStart(5)}px  ${(output.length / 1024).toFixed(0).padStart(6)} KB   ${source.licence}`,
    )
  }

  /*
   * Anything the manifest no longer names is deleted.
   *
   * The output directory is committed, so a renamed key leaves an orphan behind
   * that nothing loads and everybody ships — which is exactly what happened when
   * Venus's cloud deck moved from being its own body to being Venus's `clouds`
   * map. The manifest is the list; the directory follows it.
   */
  const wanted = new Set(entries.map((entry) => entry.file))
  for (const name of readdirSync(directory))
    if (name.endsWith('.webp') && !wanted.has(name))
      rmSync(join(directory, name))

  return {
    // A wall clock read, in a build tool, that nothing in the simulation ever
    // sees. ADR-0006's ban is on canonical code.
    generated: new Date().toISOString().slice(0, 10),
    attribution: [
      'Earth and Moon imagery: NASA Earth Observatory (Blue Marble Next ' +
        'Generation, Black Marble) and NASA Scientific Visualization Studio ' +
        '(LRO LROC colour, LOLA topography). Public domain.',
      'Io, Europa, Ganymede and Callisto: NASA / JPL / USGS Astrogeology ' +
        'Science Center global mosaics, from Voyager and Galileo. Public domain.',
      'Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune and Saturn’s ' +
        'rings: Solar System Scope (https://www.solarsystemscope.com/textures/), ' +
        'licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). ' +
        'Modified: resized and re-encoded.',
    ],
    textures: entries,
  }
}
