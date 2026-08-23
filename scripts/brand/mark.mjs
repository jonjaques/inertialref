/*
 * The mark, read out of `design/brand/brandmark.svg`.
 *
 * Everything downstream — the favicon, the PWA icons, the share card and the
 * `<Logomark>` component — is a transform of what this module returns, so this
 * is the only place that knows the file's shape.
 *
 * The content box is **measured, not declared**. A redraw that moves the
 * extents would otherwise sit off-centre in every icon, and off-centre by two
 * units in a 32-unit drawing is a favicon that looks subtly broken and reads as
 * a rendering bug rather than as a stale constant. Measuring it means
 * rasterizing once and asking `sharp` where the opaque pixels stop — which is
 * exact for any path data, where a hand-rolled `d`-attribute parser is exact
 * for the subset somebody remembered to implement.
 */
import { readFile } from 'node:fs/promises'

const SOURCE = new URL('../../design/brand/brandmark.svg', import.meta.url)

/** How finely the content box is measured. 32 viewBox units over 1024 px. */
const PROBE = 1024

/**
 * `<path d fill>`, in document order, plus the viewBox they are drawn in.
 *
 * Deliberately a regex rather than an XML parser: the source file is one
 * `<svg>` and a handful of `<path>`s and is documented to stay that way, and a
 * dependency that can parse arbitrary XML would be a licence to make it
 * arbitrary. If this ever throws, the fix is to simplify the SVG, not to
 * generalise the parser.
 */
export async function readMark() {
  // Comments first, and not as tidiness: the file documents its own contract in
  // prose that names the very tags this parses, so `<path d fill>` inside a
  // comment is otherwise read as a path with no `d`.
  const text = (await readFile(SOURCE, 'utf8')).replace(/<!--[\s\S]*?-->/g, '')

  const viewBox = /<svg[^>]*\sviewBox="([^"]+)"/.exec(text)?.[1]
  if (viewBox === undefined) throw new Error('brandmark.svg has no viewBox')
  const [x, y, width, height] = viewBox.trim().split(/\s+/).map(Number)
  if (![x, y, width, height].every(Number.isFinite))
    throw new Error(`brandmark.svg has an unreadable viewBox: ${viewBox}`)

  const paths = [...text.matchAll(/<path\b[^>]*>/g)].map((match) => {
    const tag = match[0]
    const d = /\sd="([^"]+)"/.exec(tag)?.[1]
    const fill = /\sfill="([^"]+)"/.exec(tag)?.[1]
    if (d === undefined || fill === undefined)
      throw new Error(`a <path> in brandmark.svg has no d or no fill: ${tag}`)
    return { d, fill }
  })
  if (paths.length === 0) throw new Error('brandmark.svg has no <path>')

  return { view: { x, y, width, height }, paths }
}

/** The paths as markup, ready to drop inside an `<svg>` or a `<g>`. */
export const markup = (paths, indent = '  ') =>
  paths
    .map(({ d, fill }) => `${indent}<path d="${d}" fill="${fill}" />`)
    .join('\n')

/**
 * Where the drawing actually is inside its viewBox, in viewBox units.
 *
 * Needs a rasterizer, so it is imported lazily — `--check` re-derives the text
 * artefacts and must stay runnable without `sharp` present.
 */
export async function measure(mark) {
  const { default: sharp } = await import('sharp')
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.view.x} ${mark.view.y} ${mark.view.width} ${mark.view.height}" width="${PROBE}" height="${PROBE}">\n${markup(mark.paths)}\n</svg>`,
  )
  // threshold 0: any pixel that is not fully transparent is content. The mark
  // is flat fills with antialiased edges, and a higher threshold would eat the
  // shear on every bar's corner — a degree of skew, which is the whole form.
  const { info } = await sharp(svg)
    .trim({ background: '#00000000', threshold: 0 })
    .toBuffer({ resolveWithObject: true })

  /*
   * `trimOffset*` is what you would translate the *cropped* image by to put it
   * back where it was, so it is the negative of the crop origin. Taken at face
   * value the mark comes out mirrored about the viewBox — and the only symptom
   * is a favicon sitting a couple of units off centre, which reads as a
   * rendering artefact rather than as a sign error.
   */
  const unit = mark.view.width / PROBE
  return {
    x: mark.view.x - info.trimOffsetLeft * unit,
    y: mark.view.y - info.trimOffsetTop * unit,
    width: info.width * unit,
    height: info.height * unit,
  }
}

/**
 * The transform that fits the measured drawing into `size` units of a square
 * `canvas`, centred.
 *
 * Returned as a transform rather than as rewritten coordinates so that a diff
 * of any generated file is a diff of the mark. The scale is uniform and taken
 * from the longer side, so a mark that is not square keeps its proportions.
 */
export function fit(box, { canvas, size }) {
  const scale = size / Math.max(box.width, box.height)
  return {
    scale,
    x: (canvas - box.width * scale) / 2 - box.x * scale,
    y: (canvas - box.height * scale) / 2 - box.y * scale,
    attribute(precision = 4) {
      const round = (value) => Number(value.toFixed(precision))
      return `translate(${round(this.x)} ${round(this.y)}) scale(${round(scale)})`
    },
  }
}
