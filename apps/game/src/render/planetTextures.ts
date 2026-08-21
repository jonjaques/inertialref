import {
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import manifest from '../../../../data/textures/manifest.json'

/*
 * Planetary surface maps, fetched when a body is worth looking at.
 *
 * Twenty-odd megabytes of imagery that must not be in the initial bundle and
 * must not all be resident at once. The rule is the one the terrain streamer
 * already follows: load what the player can see, and let the browser's cache and
 * the service worker keep it. A body's maps are requested the first time it is
 * drawn as more than a few pixels, and are never released — there are
 * twenty-eight bodies in the Solar System and a texture you evict is one you
 * will re-fetch the moment the player turns around.
 *
 * `import.meta.glob` rather than a path built at runtime, so the bundler hashes
 * every file, emits it as an asset and rewrites the URL. A hand-built
 * `/textures/...` path works in development and 404s in production the first
 * time anything about the asset pipeline changes.
 */

const log = getLogger('game.textures')

const URLS = import.meta.glob<string>('../../../../data/textures/*.webp', {
  query: '?url',
  import: 'default',
  eager: true,
})

const byFile = new Map<string, string>()
for (const [path, url] of Object.entries(URLS)) {
  byFile.set(path.slice(path.lastIndexOf('/') + 1), url)
}

export type MapKind = 'albedo' | 'normal' | 'night' | 'clouds' | 'ring'

export interface BodyTextures {
  readonly albedo: Texture | null
  /** Tangent-space slopes in RG, Z reconstructed; an ocean mask in blue. */
  readonly normal: Texture | null
  readonly night: Texture | null
  readonly clouds: Texture | null
  readonly ring: Texture | null
}

export const NO_TEXTURES: BodyTextures = {
  albedo: null,
  normal: null,
  night: null,
  clouds: null,
  ring: null,
}

interface Entry {
  readonly body: string
  readonly map: string
  readonly file: string
}

const entries = manifest.textures as readonly Entry[]

/** Every attribution the shipped maps require. */
export const TEXTURE_ATTRIBUTION = manifest.attribution as readonly string[]

const loader = new TextureLoader()
const loaded = new Map<string, Texture>()
const announced = new Set<string>()
const sets = new Map<string, BodyTextures>()

/*
 * Colour space is not a detail here.
 *
 * An albedo map and a night map are photographs and are sRGB-encoded. A normal
 * map and a cloud mask are *data* wearing an image's clothes, and must not be
 * de-gammaed — do it anyway and every normal bends toward the pole and every
 * cloud edge moves. The result looks almost right, which is the worst kind of
 * wrong to debug.
 */
const COLOUR_SPACE: Readonly<Record<string, string>> = {
  albedo: SRGBColorSpace,
  night: SRGBColorSpace,
  ring: SRGBColorSpace,
  normal: NoColorSpace,
  clouds: NoColorSpace,
}

function load(entry: Entry, anisotropy: number): Texture | null {
  const cached = loaded.get(entry.file)
  if (cached !== undefined) return cached
  const url = byFile.get(entry.file)
  if (url === undefined) return null

  const texture = loader.load(url, undefined, undefined, () => {
    /*
     * A failed fetch must not stay cached. The loader hands back its Texture
     * before the image arrives, so on error the object exists, samples as
     * black, and — being non-null — beats the material's base-colour fallback
     * for the rest of the session. Evict it, and drop the body's assembled
     * set a few seconds later so the per-frame ask retries without hammering
     * a dead network once per frame.
     */
    loaded.delete(entry.file)
    setTimeout(() => sets.delete(entry.body), 5_000)
    log.warn('surface map failed to load, will retry', { file: entry.file })
  })
  texture.colorSpace = COLOUR_SPACE[entry.map] ?? NoColorSpace
  // Longitude wraps and latitude does not. Clamping longitude leaves a seam down
  // the anti-meridian; repeating latitude mirrors the arctic onto the antarctic.
  texture.wrapS = RepeatWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = true
  texture.minFilter = LinearMipmapLinearFilter
  // A planet from orbit is the textbook case for anisotropic filtering: the
  // texture compresses to nothing towards the limb, and without it the edge of
  // every body is a band of aliased mush — which is exactly where the eye looks.
  texture.anisotropy = anisotropy
  loaded.set(entry.file, texture)
  return texture
}

const find = (
  mine: readonly Entry[],
  map: MapKind,
  anisotropy: number,
): Texture | null => {
  const entry = mine.find((candidate) => candidate.map === map)
  return entry === undefined ? null : load(entry, anisotropy)
}

/**
 * The maps for one body, starting the fetch if this is the first ask.
 *
 * Returns whatever is ready. Textures arrive asynchronously and the material
 * reads this every frame, so a body is drawn in its base colour first and gains
 * its surface a moment later — strictly better than blocking the frame or
 * holding the body back until it is complete.
 */
export function texturesFor(
  key: string | null,
  anisotropy: number,
): BodyTextures {
  if (key === null) return NO_TEXTURES
  const existing = sets.get(key)
  if (existing !== undefined) return existing

  const mine = entries.filter((entry) => entry.body === key)
  if (mine.length === 0) {
    sets.set(key, NO_TEXTURES)
    return NO_TEXTURES
  }
  if (!announced.has(key)) {
    announced.add(key)
    log.info('loading surface maps', { body: key, maps: mine.length })
  }

  const set: BodyTextures = {
    albedo: find(mine, 'albedo', anisotropy),
    normal: find(mine, 'normal', anisotropy),
    night: find(mine, 'night', anisotropy),
    clouds: find(mine, 'clouds', anisotropy),
    ring: find(mine, 'ring', anisotropy),
  }
  sets.set(key, set)
  return set
}

/** True when the manifest has anything at all for this key. */
export const hasTextures = (key: string | null): boolean =>
  key !== null && entries.some((entry) => entry.body === key)
