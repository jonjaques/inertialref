import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import {
  buildShapeMesh,
  decodeShapeField,
  generateShapeField,
  type RenderBody,
  type ShapeField,
} from '@inertialref/rendering'
import manifest from '../../../../data/shapes/manifest.json'

/*
 * Geometry for the bodies that are not spheres.
 *
 * `planetTextures.ts` is the model for this file and the two are deliberately
 * parallel: a manifest committed beside the data, `import.meta.glob` so the
 * bundler hashes and emits each file, a boot preload that fetches the whole set
 * behind the overlay, and a lazy path that is both the fallback and the retry.
 *
 * What is different is what happens when a body has no shipped model. A missing
 * *texture* is a body drawn in its base color, which is a degraded picture of
 * the same object. A missing *shape* would be a sphere, which is a picture of a
 * different object — so there is no missing case: a body with a `figure` and no
 * model gets a field generated from its own address, on its measured
 * half-extents. Twenty-four bodies in the Solar System have a published model
 * and sixty-seven do not, and every generated system in the galaxy is entirely in
 * the second class.
 *
 * ## Why the seed comes from the address
 *
 * The generated field is presentation: nothing in the simulation touches it,
 * because contact is tested against the datum sphere and no small body is
 * landable. So it does not need to come down the canonical seed path, and
 * putting it there would mean carrying a seed through the snapshot for a
 * purpose only the renderer has. It does need to be *stable* — a body that
 * changed shape when you looked away would be worse than a sphere — and
 * `rootSeed(address)` is exactly that: a pure function of a stable identifier,
 * the same on every machine and in every session.
 */

const log = getLogger('game.shapes')

const URLS = import.meta.glob<string>('../../../../data/shapes/*.irsm', {
  query: '?url',
  import: 'default',
  eager: true,
})

const byFile = new Map<string, string>()
for (const [path, url] of Object.entries(URLS)) {
  byFile.set(path.slice(path.lastIndexOf('/') + 1), url)
}

interface Entry {
  readonly key: string
  readonly file: string
  readonly width: number
  readonly height: number
}

const entries = manifest.shapes as readonly Entry[]
const byKey = new Map(entries.map((entry) => [entry.key, entry]))

/** Every citation the shipped models carry. Rendered by the About page. */
export const SHAPE_ATTRIBUTION = manifest.attribution as readonly string[]

/** How many models the manifest ships, for the boot census. */
export const SHIPPED_SHAPE_COUNT = entries.length

const fields = new Map<string, ShapeField>()
const pending = new Map<string, Promise<void>>()
const failed = new Set<string>()

/**
 * Generated fields, keyed by address alone — deliberately not by stride.
 *
 * A field is 8,320 samples of nine octaves of 3D noise and costs 23 ms;
 * subsampling it into a mesh costs 3 ms at stride 1 and 0.03 ms at stride 8.
 * Keying the *geometry* cache by `address#stride` is right, because the mesh
 * differs per tier — but the field does not, and generating it inside that
 * miss branch re-paid the 23 ms at every tier a body crossed. Four tiers is
 * four dropped frames per body, in `useFrame`, on the approach the player is
 * watching. Measured: 23.35 ms to generate, 0.03 ms to mesh at the coarsest
 * tier, so 99.9% of the work at that tier was the part being repeated.
 */
const generated = new Map<string, ShapeField>()

/**
 * The resolution a generated field is built at.
 *
 * The vendored models carry their own — from 128 columns for a 5° source to
 * 512 for Bennu — and this is what a body with no model gets. 128 × 65 is
 * 16,000 samples and about 16,000 triangles at full stride, which for a body
 * that is a hundred pixels across at its most generous is already more than
 * the screen can show. Raising it would buy detail the eye cannot reach and
 * cost every one of the sixty-seven bodies that use it.
 */
const GENERATED_WIDTH = 128

/**
 * How long a failed model is left alone before the lazy path tries again.
 *
 * `failed` exists to stop a retry storm — `shapeGeometryFor` runs per body per
 * frame, so an unguarded retry is sixty fetches a second. It must not be
 * permanent, which is what it was: the only `failed.delete` was on the success
 * path, and success needed a fetch that `failed` itself prevented, so one
 * dropped connection downgraded a body to its generated figure for the whole
 * session. `planetTextures.ts` drops a failed map after five seconds for
 * exactly this reason; this is the same cadence.
 */
const RETRY_AFTER_MS = 5_000
const failedAt = new Map<string, number>()

async function fetchField(key: string): Promise<void> {
  try {
    const entry = byKey.get(key)
    // A manifest entry with no emitted file, or none at all. Both mean the
    // manifest and the glob disagree, which is a build mistake rather than a
    // network one — so it is said out loud rather than retried forever.
    const url = entry === undefined ? undefined : byFile.get(entry.file)
    if (url === undefined)
      throw new Error(
        entry === undefined
          ? 'no manifest entry'
          : `manifest names ${entry.file}, which the bundler did not emit`,
      )
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`)
    fields.set(
      key,
      decodeShapeField(new Uint8Array(await response.arrayBuffer())),
    )
    failed.delete(key)
    failedAt.delete(key)
  } catch (cause) {
    // A model that fails to arrive falls through to the generated field, which
    // is still the right *size* and still not a sphere.
    failed.add(key)
    failedAt.set(key, Date.now())
    log.warn('shape model failed to load; using the generated figure', {
      body: key,
      cause: String(cause),
    })
  } finally {
    // In the `finally` so that every exit clears it. Two early returns used to
    // sit above the `try`, which left a resolved promise in `pending` forever
    // and blocked the key with no warning and no `failed` entry.
    pending.delete(key)
  }
}

/** Start a fetch if this is the first ask, or the first since the cooldown. */
function fieldFor(key: string): ShapeField | null {
  const ready = fields.get(key)
  if (ready !== undefined) return ready
  if (failed.has(key)) {
    if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS) return null
    failed.delete(key)
    failedAt.delete(key)
  }
  if (!pending.has(key) && byKey.has(key)) {
    pending.set(key, fetchField(key))
  }
  return null
}

/** Fetch and decode every shipped model. Resolves when the last byte is in. */
export async function preloadAllShapes(
  onOne: () => void = () => {},
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      fieldFor(entry.key)
      await pending.get(entry.key)
      onOne()
    }),
  )
}

/* ------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Stride by how much of the screen the body covers, mirroring `SPHERE_TIERS`.
 *
 * A stride is a subsample of the grid, so tier 1 is not a decimation of tier 0
 * — it is the same measurement at half the sampling. The thresholds are the
 * sphere's, one tier coarser across the board: a shape mesh at 128 columns
 * already has the silhouette right, and the reason the sphere needs 512 is that
 * a sphere's error is *entirely* in its limb.
 */
const STRIDE_TIERS: readonly { minAngle: number; stride: number }[] = [
  { minAngle: 0.02, stride: 1 },
  { minAngle: 0.004, stride: 2 },
  { minAngle: 0.0008, stride: 4 },
  { minAngle: 0, stride: 8 },
]

const strideFor = (angularRadius: number): number =>
  (
    STRIDE_TIERS.find((tier) => angularRadius >= tier.minAngle) ??
    STRIDE_TIERS[STRIDE_TIERS.length - 1]!
  ).stride

/**
 * Built geometries, keyed by what produced them, least-recently-used first.
 *
 * Each one is a build the renderer would otherwise redo whenever a body crossed
 * a tier boundary — for a moon on an eight-hour orbit, several times a minute.
 *
 * It is *capped*, which the first version was not. "Unbounded on purpose, and
 * small" was wrong twice: the key is the body's address, so a system's entries
 * are dead the moment it unloads and are never reused, and nothing evicted
 * them — `Bodies.tsx`'s `evictStale` disposes materials only ("the sphere and
 * ring geometries are shared tiers", which stopped being true when this file
 * started handing out per-body ones) and `disposeShapeGeometries` had no
 * caller. Measured: ~460 KB of attributes for one generated body at stride 1
 * and ~4 MB for Bennu, held on the CPU *and* the GPU, so a tour of a dozen
 * systems ran to hundreds of megabytes that nothing could ever release.
 *
 * 256 is four tiers for sixty-four bodies, which is more than can be on screen,
 * and a Map iterates in insertion order — so re-inserting on every hit makes
 * the first key the least recently used.
 */
const MAX_GEOMETRIES = 256
const geometries = new Map<string, BufferGeometry>()

/** Fetch and mark as most-recently-used, or undefined. */
function touch(key: string): BufferGeometry | undefined {
  const geometry = geometries.get(key)
  if (geometry === undefined) return undefined
  geometries.delete(key)
  geometries.set(key, geometry)
  return geometry
}

/**
 * Store, evicting the coldest entries past the cap.
 *
 * Safe to dispose one that a hidden mesh still points at: the map entry goes
 * with it, so the next ask rebuilds rather than handing back freed buffers,
 * and `Bodies.tsx` re-assigns `mesh.geometry` from this function on every frame
 * it draws a body. The key just built is inserted last and so is never the one
 * evicted.
 */
function remember(key: string, geometry: BufferGeometry): void {
  geometries.set(key, geometry)
  while (geometries.size > MAX_GEOMETRIES) {
    const coldest = geometries.keys().next().value
    if (coldest === undefined) break
    geometries.get(coldest)?.dispose()
    geometries.delete(coldest)
  }
}

const toGeometry = (
  field: ShapeField,
  referenceRadius: number,
  stride: number,
): BufferGeometry => {
  const mesh = buildShapeMesh(field, referenceRadius, stride)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  // The mesh is normalized to `referenceRadius`, so it never leaves the unit
  // sphere and the bounding sphere the culler wants is known without a pass
  // over the positions.
  geometry.boundingSphere = null
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * The geometry for one body, or null if it is a spheroid.
 *
 * Null means "use the sphere you were using", which is every planet, every
 * large moon and Pluto. Anything else gets a mesh, and gets one on the first
 * frame it is drawn: the *generated* field is synchronous, so a body whose
 * model has not arrived yet is drawn at the right size and the right elongation
 * immediately and gains its craters when the file lands.
 */
export function shapeGeometryFor(body: RenderBody): BufferGeometry | null {
  const figure = body.figure
  if (figure === null) return null
  const stride = strideFor(body.placement.angularRadius)

  if (figure.model !== null) {
    const field = fieldFor(figure.model)
    if (field !== null) {
      // `trueRadius` is in the key because `buildShapeMesh` normalizes every
      // position by it, so it is baked into the buffers. All 25 shipped models
      // map to one body each today; the moment two bodies share a key — a
      // generic nucleus, a stand-in for an unmeasured Trojan — the second would
      // otherwise be drawn at the first one's scale, and which is "first"
      // depends on draw order.
      const key = `${figure.model}#${body.trueRadius}#${stride}`
      let geometry = touch(key)
      if (geometry === undefined) {
        geometry = toGeometry(field, body.trueRadius, stride)
        remember(key, geometry)
      }
      return geometry
    }
  }

  const key = `${body.address}#${stride}`
  let geometry = touch(key)
  if (geometry === undefined) {
    // The field first, and cached without the stride: it is the expensive half
    // and it does not vary by tier. See `generated`.
    let field = generated.get(body.address)
    if (field === undefined) {
      field = generateShapeField(rootSeed(body.address), {
        semiAxes: figure.semiAxes,
        irregularity: figure.irregularity,
        width: GENERATED_WIDTH,
        // Half the columns plus the pole row, which is what makes the cells
        // square at the equator.
        height: GENERATED_WIDTH / 2 + 1,
      })
      generated.set(body.address, field)
    }
    geometry = toGeometry(field, body.trueRadius, stride)
    remember(key, geometry)
  }
  return geometry
}

/** Drop every built geometry. For a hot reload; the fields survive. */
export function disposeShapeGeometries(): void {
  for (const geometry of geometries.values()) geometry.dispose()
  geometries.clear()
  generated.clear()
}
