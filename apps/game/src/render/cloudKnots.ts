import type { Node, StorageTexture } from 'three/webgpu'
import {
  float,
  If,
  min,
  textureStore,
  uint,
  uvec2,
  vec3,
  vec4,
} from 'three/tsl'
import { CLOUD_DEPTH_CLAMP_KM } from './cloudDepth.ts'
import { finiteOr } from './cloudNodes.ts'

/*
 * What a transparent object between two layers needs of the trace: up to four
 * knots a ray, each a segment's entry and exit depth with the transmittance
 * and light so far at its exit (§5.12). The march records one at each
 * segment close whose transmittance falls under 0.98; past four, the fourth
 * absorbs the rest. `cloudFront` reads them directly, with no history between,
 * so they are written through `finiteOr`.
 *
 * The layout, per trace texel (i, j):
 *
 * - `knotDepth` (2w × h): (entry₀, exit₀, entry₁, exit₁) km at [2i, j] and
 *   (entry₂, exit₂, entry₃, exit₃) km at [2i + 1, j];
 * - `knotLight` (2w × 2h): knot k's (L.rgb, T) at its exit, at
 *   (2i + (k & 1), 2j + (k >> 1)).
 *
 * A knot the ray did not record is padding: T = 1, no light, and its entry
 * and exit at the depth copy's clamp, behind every distance a reader can ask
 * about, so a reader that walks the four in order finds the last real knot's
 * (T, L) flat across everything behind it. The aux texture's
 * [2i + 1, j].w carries how many are real.
 */

export interface CloudKnotWriter {
  record(
    entry: Node<'float'>,
    exit: Node<'float'>,
    transmittance: Node<'float'>,
    light: Node<'vec3'>,
  ): void
  /**
   * Writes the four knots through `finiteOr`, so a NaN the history would have
   * caught cannot reach `cloudFront`, which reads the knots directly.
   */
  flush(texel: Node<'uvec2'>): void
}

/** A segment that leaves more than this of the light it is given records no knot. */
export const KNOT_TRANSMITTANCE = 0.98
export const KNOT_COUNT = 4

/** What a padding knot holds: no cloud, behind everything. */
export const KNOT_PADDING = {
  depth: CLOUD_DEPTH_CLAMP_KM,
  light: [0, 0, 0, 1],
} as const

/** The two textures the knots are written into, the trace's own. */
export interface CloudKnotTextures {
  readonly knotDepth: StorageTexture
  readonly knotLight: StorageTexture
}

/** Meters → the textures' kilometers, held under the clamp a half float carries. */
const kilometers = (meters: Node<'float'>): Node<'float'> =>
  min(meters.mul(1e-3), CLOUD_DEPTH_CLAMP_KM)

interface Knot {
  readonly entry: Node<'float'>
  readonly exit: Node<'float'>
  readonly light: Node<'vec4'>
}

/**
 * The writer of one ray's knots. Its registers are statements, so it is made
 * inside the kernel's `Fn`, before the march that records into it; `count`
 * is how many knots the ray recorded, as a float (an integer select converted
 * to a float is a conversion r185 drops).
 */
export function cloudKnotWriter(
  textures: CloudKnotTextures,
): CloudKnotWriter & { readonly count: Node<'float'> } {
  const knots: Knot[] = Array.from({ length: KNOT_COUNT }, () => ({
    entry: float(KNOT_PADDING.depth).toVar(),
    exit: float(KNOT_PADDING.depth).toVar(),
    light: vec4(...KNOT_PADDING.light).toVar(),
  }))
  const count = float(0).toVar()
  const last = knots[KNOT_COUNT - 1]!

  function store(knot: Knot, entry: Node<'float'>, exit: Node<'float'>): void {
    knot.entry.assign(kilometers(entry))
    knot.exit.assign(kilometers(exit))
  }

  return {
    count,
    record(entry, exit, transmittance, light) {
      // A register, so the light and the phase fetch inside it are emitted
      // once and not once in each of the five branches below.
      const value = vec4(light, transmittance).toVar()
      If(count.lessThan(KNOT_COUNT), () => {
        knots.forEach((knot, k) => {
          If(count.equal(k), () => {
            store(knot, entry, exit)
            knot.light.assign(value)
          })
        })
        count.addAssign(1)
      }).Else(() => {
        // The fourth absorbs the rest: its entry stays where the fourth
        // segment began, and its exit, T and L follow the latest close.
        last.exit.assign(kilometers(exit))
        last.light.assign(value)
      })
    },
    flush(texel) {
      const x = texel.x.mul(uint(2))
      const y = texel.y.mul(uint(2))
      const padding = vec4(KNOT_PADDING.depth)
      const [k0, k1, k2, k3] = knots as [Knot, Knot, Knot, Knot]
      textureStore(
        textures.knotDepth,
        uvec2(x, texel.y),
        finiteOr(vec4(k0.entry, k0.exit, k1.entry, k1.exit), padding),
      )
      textureStore(
        textures.knotDepth,
        uvec2(x.add(uint(1)), texel.y),
        finiteOr(vec4(k2.entry, k2.exit, k3.entry, k3.exit), padding),
      )
      const clear = vec4(vec3(0), 1)
      knots.forEach((knot, k) => {
        textureStore(
          textures.knotLight,
          uvec2(x.add(uint(k & 1)), y.add(uint(k >> 1))),
          finiteOr(knot.light, clear),
        )
      })
    },
  }
}
