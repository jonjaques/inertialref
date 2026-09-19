/** Edge resolution and reconstruction are one choice because temporal input cannot be multisampled. */
export interface Picture {
  readonly aa: 'off' | 'msaa' | 'supersample' | 'temporal'
  readonly scale: 'native' | 'quality' | 'balanced' | 'performance' | 'ultra'
  readonly sharpness: 'off' | 'standard' | 'crisp'
}

export const PICTURE_AA = ['off', 'msaa', 'supersample', 'temporal'] as const
export const PICTURE_SCALES = [
  'native',
  'quality',
  'balanced',
  'performance',
  'ultra',
] as const
export const PICTURE_SHARPNESS = ['off', 'standard', 'crisp'] as const

export const PICTURE_LABELS = {
  aa: {
    off: 'Off',
    msaa: 'MSAA',
    supersample: '2× supersample',
    temporal: 'Temporal',
  },
  scale: {
    native: 'Native',
    quality: 'Quality',
    balanced: 'Balanced',
    performance: 'Performance',
    ultra: 'Ultra performance',
  },
  sharpness: { off: 'Off', standard: 'Standard', crisp: 'Crisp' },
} as const

export const DEFAULT_PICTURE: Picture = {
  aa: 'msaa',
  scale: 'native',
  sharpness: 'standard',
}

const RATIOS: Readonly<Record<Picture['scale'], number>> = {
  native: 1,
  quality: 1.5,
  balanced: 1.7,
  performance: 2,
  ultra: 3,
}
const SHARPNESS: Readonly<Record<Picture['sharpness'], number>> = {
  off: 0,
  standard: 0.8,
  crisp: 1,
}

export function isPicture(value: unknown): value is Picture {
  if (typeof value !== 'object' || value === null) return false
  const picture = value as Picture
  return (
    PICTURE_AA.includes(picture.aa) &&
    PICTURE_SCALES.includes(picture.scale) &&
    PICTURE_SHARPNESS.includes(picture.sharpness) &&
    (picture.aa !== 'supersample' || picture.scale === 'native')
  )
}

/** A preference survives a backend fallback so it can apply on the next capable device. */
export function resolvePicture(
  picture: Picture,
  backend: 'webgpu' | 'webgl',
): Picture {
  if (
    backend === 'webgpu' ||
    (picture.scale === 'native' && picture.aa !== 'temporal')
  )
    return picture
  return {
    ...picture,
    aa: picture.aa === 'temporal' ? 'msaa' : picture.aa,
    scale: 'native',
  }
}

export const pictureRatio = (picture: Picture): number => RATIOS[picture.scale]
export const pictureSamples = (picture: Picture): 0 | 4 =>
  picture.aa === 'msaa' || picture.aa === 'supersample' ? 4 : 0
export const pictureDprFactor = (picture: Picture): number =>
  picture.aa === 'supersample' ? 2 : 1
export const pictureSharpness = (picture: Picture): number =>
  SHARPNESS[picture.sharpness]

/** Display dimensions exclude supersampling; terrain refinement reads the same display. */
export function pictureDimensions(
  picture: Picture,
  width: number,
  height: number,
) {
  const factor = pictureDprFactor(picture) / pictureRatio(picture)
  return {
    display: { width, height },
    render: {
      width: Math.max(1, Math.floor(width * factor)),
      height: Math.max(1, Math.floor(height * factor)),
    },
  }
}

/** The bilinear plate is a diagnostic, never a stored reconstruction option. */
export function parsePictureQuery(value: string | null): Picture | null {
  if (value === 'native') return DEFAULT_PICTURE
  if (value === null) return null
  const fields = value.split(':')
  const [aa, scale, sharpness = 'standard', extra] = fields
  if (extra !== undefined) return null
  if (aa === 'bilinear' && fields.length !== 2) return null
  const picture =
    aa === 'bilinear'
      ? { aa: 'off', scale, sharpness: 'off' }
      : { aa, scale, sharpness }
  return isPicture(picture) ? picture : null
}
