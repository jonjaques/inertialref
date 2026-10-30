import { DataTexture, FloatType, type Node, RedFormat } from 'three/webgpu'
import {
  clamp,
  exp2,
  float,
  floor,
  If,
  int,
  ivec2,
  log2,
  max,
  min,
  mix,
  oneMinus,
  sqrt,
  texture,
  textureLoad,
} from 'three/tsl'
import {
  DEPOSIT_SLOPE_KNOTS,
  DEPOSIT_SLOPE_LOG_HIGH,
  DEPOSIT_SLOPE_LOG_LOW,
  type DepositSlopeTable,
  depositSlopeKnot,
  MAX_REGION_LEVEL,
} from '@inertialref/universe'

/*
 * A body's deposit slope table on the GPU, and the read the ground's deposits
 * make through it.
 *
 * The table is measured by a worker (`packages/universe/src/depositSlope.ts`,
 * which also holds `depositSlopeAt`, the CPU arithmetic this graph is held to
 * by `slopeTable.gpu.test.ts`). It is one texture written in place rather
 * than swapped: a texture node's binding is frozen at compile, so a second
 * object would bind nothing. It is read with `textureLoad` and interpolated
 * in the graph, so it is nearest on purpose — float32 is not filterable on
 * every adapter, and a texture that is never sampled needs no sampler.
 */

/** Rows of the texture: one per region level a patch can be drawn at. */
const ROWS = MAX_REGION_LEVEL + 1

export interface SlopeTable {
  /**
   * The slope a deposit reads, `1 − cos θ` in and out, for a drawn slope on
   * a level-`level` patch slid `morph` of the way onto its parent's grid; a
   * negative level reads the slope as drawn. Built inside a `Fn`.
   */
  read(
    slope: Node<'float'>,
    level: Node<'float'>,
    morph: Node<'float'>,
  ): Node<'float'>
  /**
   * Write the body's table, or null for none — every row then the identity.
   * Compares by identity before it uploads, so writing it every frame is
   * free.
   */
  set(table: DepositSlopeTable | null): void
}

export function createSlopeTable(): SlopeTable {
  const rows = new Float32Array(DEPOSIT_SLOPE_KNOTS * ROWS)
  identity(rows, 0)
  const map = new DataTexture(
    rows,
    DEPOSIT_SLOPE_KNOTS,
    ROWS,
    RedFormat,
    FloatType,
  )
  map.needsUpdate = true
  const lut = texture(map)
  let held: DepositSlopeTable | null = null

  return {
    read(slope, level, morph) {
      const read = float(slope).toVar()
      If(float(level).greaterThanEqual(0), () => {
        // tan² and back in the forms that do not cancel near flat, where
        // every threshold the material draws against sits.
        const cosine = max(oneMinus(slope), float(1e-4))
        const tan2 = max(
          float(slope).mul(float(2).sub(slope)).div(cosine.mul(cosine)),
          float(1e-12),
        )
        const at = clamp(
          log2(tan2)
            .div(Math.log2(10))
            .sub(DEPOSIT_SLOPE_LOG_LOW)
            .div(DEPOSIT_SLOPE_LOG_HIGH - DEPOSIT_SLOPE_LOG_LOW)
            .mul(DEPOSIT_SLOPE_KNOTS - 1),
          float(0),
          float(DEPOSIT_SLOPE_KNOTS - 1),
        )
        const knot = min(floor(at), float(DEPOSIT_SLOPE_KNOTS - 2))
        const along = at.sub(knot)
        const left = int(knot)
        const right = left.add(1)
        const row = (index: Node<'int'>): Node<'float'> =>
          mix(
            textureLoad(lut, ivec2(left, index)).x,
            textureLoad(lut, ivec2(right, index)).x,
            along,
          )
        const own = row(int(level))
        const parent = row(int(max(float(level).sub(1), float(0))))
        const t = exp2(mix(own, parent, morph).mul(Math.log2(10)))
        const s = sqrt(t.add(1))
        read.assign(t.div(s.mul(s.add(1))))
      })
      return read
    },
    set(table) {
      if (table === held) return
      held = table
      const written = table === null ? 0 : Math.min(table.levels, ROWS)
      if (table !== null)
        rows.set(table.table.subarray(0, written * DEPOSIT_SLOPE_KNOTS))
      identity(rows, written)
      map.needsUpdate = true
    },
  }
}

/** Fill rows from `first` on with the identity: each knot maps to itself. */
function identity(rows: Float32Array, first: number): void {
  for (let row = first; row < ROWS; row += 1) {
    for (let k = 0; k < DEPOSIT_SLOPE_KNOTS; k += 1) {
      rows[row * DEPOSIT_SLOPE_KNOTS + k] = Math.log10(depositSlopeKnot(k))
    }
  }
}
