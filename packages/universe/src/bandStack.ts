import type { Meters } from '@inertialref/shared'
import type { TerrainSketch } from './sketch.ts'
import type { SurfaceParameters } from './system.ts'
import type { SCALAR, WORD } from './terrainKernel.ts'

/*
 * The band stack's composition: which stages there are, in what order, and
 * behind which gate.
 *
 * The stack is evaluated twice — `evaluate` in `terrain.ts` on the CPU, which
 * is canon, and the TSL kernel in `apps/game/src/render/terrainKernel.ts`,
 * which is its port (ADR-0023) — and the two bodies of each band are, by that
 * decision, two implementations. What must not be two things is the
 * *structure* around them: a band gaining a gate, a gate moving, a stage
 * changing order. A gate the CPU spells against the grammar and the kernel
 * spells against a packed scalar the packer zeroes to mean the same thing is
 * three spellings of one fact, and nothing mechanical relates a TSL graph to
 * a TypeScript function — so the tolerance test was the only thing that could
 * notice a drift between them, and it needs a physical adapter.
 *
 * This table is the one description. `evaluate` asks `stageOn` for the gated
 * canonical stages and the drawn field asks it for the clamp; the tail's own
 * guard is inside `microRelief`, which is the band's body rather than the
 * stack's structure. The kernel builds each gate from the packed slot named
 * beside it; the band test isolates a band through the same gate; and
 * `packedStageOn` in `terrainKernel.ts` reads a gate back out of a packed
 * record, so `bandStack.test.ts` holds the packer's encoding to the body's
 * gate over the whole zoo, in Node, in milliseconds.
 *
 * It is a description and not a third executable spelling of the stack. The
 * bodies stay where they are, and the order here is documentary: both
 * evaluations are explicit code that cites it, because a kernel that walked
 * a table would be the scalar mirror ADR-0023 refuses, one level up.
 */

/** The stages, in the order both evaluations apply them. */
export type StageId =
  | 'hypsometry'
  | 'belts'
  | 'volcanism'
  | 'relief'
  | 'ice'
  | 'drainage'
  | 'craters'
  | 'coast'
  | 'tail'
  | 'grit'
  | 'clamp'

/**
 * How a stage combines into the running elevation.
 *
 * `share`: a landform band, scaled by its share of the budget and summed.
 * `carve`: subtracts from what the landform bands made — the valleys.
 * `limited`: a lattice sum folded through its soft ceiling and added.
 * `remap`: rewrites the elevation around a level — the coast.
 * `additive`: added as is — the grit.
 * `clamp`: the sea's `max`, on the drawn field alone.
 */
export type StageKind =
  'share' | 'carve' | 'limited' | 'remap' | 'additive' | 'clamp'

/**
 * What a gate reads: the fields of the body both evaluations have in hand.
 *
 * `sea` is passed in rather than derived, because deriving it is
 * `seaDatumElevation` in `terrain.ts` and this module sits under that one.
 * `seabed` is the request's flag — the same `HeightfieldRequest.seabed` the
 * packer takes — and only the clamp reads it.
 */
export interface StageContext {
  readonly surface: SurfaceParameters
  readonly sketch: TerrainSketch
  readonly sea: Meters | null
  readonly seabed: boolean
}

/**
 * The packed slot the kernel gates on: the stage runs where the slot is above
 * the threshold. Null for a stage that always runs.
 */
export type PackedGate =
  | { readonly scalar: keyof typeof SCALAR; readonly above: number }
  | { readonly word: keyof typeof WORD }
  | null

export interface Stage {
  readonly id: StageId
  readonly kind: StageKind
  /** Whether the stage is part of the canonical field or of the drawn tail. */
  readonly canonical: boolean
  /** The gate, as the body spells it. Null for a stage that always runs. */
  readonly on: ((context: StageContext) => boolean) | null
  /** The same gate, as the kernel reads it off the packed record. */
  readonly packed: PackedGate
}

/**
 * Whether the whole stack is skipped: a body whose relief budget is zero has
 * bare ground and no stage runs — on either side, the kernel's `Else` branch
 * is the stack and the CPU returns before it.
 */
export const bareGround = (surface: SurfaceParameters): boolean =>
  surface.maxElevation <= 0

export const BAND_STACK: readonly Stage[] = [
  { id: 'hypsometry', kind: 'share', canonical: true, on: null, packed: null },
  { id: 'belts', kind: 'share', canonical: true, on: null, packed: null },
  { id: 'volcanism', kind: 'share', canonical: true, on: null, packed: null },
  { id: 'relief', kind: 'share', canonical: true, on: null, packed: null },
  {
    id: 'ice',
    kind: 'share',
    canonical: true,
    on: ({ surface }) => surface.grammar.bands.ice > 0,
    packed: { scalar: 'SHARE_ICE', above: 0 },
  },
  {
    // The valleys, cut into the landform before the craters land on it.
    id: 'drainage',
    kind: 'carve',
    canonical: true,
    on: ({ surface }) => surface.grammar.drainage > 0,
    packed: { scalar: 'DRAINAGE', above: 0 },
  },
  {
    id: 'craters',
    kind: 'limited',
    canonical: true,
    on: ({ sketch }) => sketch.craterLevels.length > 0,
    packed: { word: 'CRATER_LEVELS' },
  },
  {
    // After the craters, so a crater on the shore is a bay; before the tail,
    // which is a meter of grit the remap has no business flattening.
    id: 'coast',
    kind: 'remap',
    canonical: true,
    on: ({ surface, sea }) => sea !== null && surface.grammar.liquid > 0,
    packed: { scalar: 'COAST_WIDTH', above: 0 },
  },
  {
    id: 'tail',
    kind: 'limited',
    canonical: false,
    on: ({ sketch }) => sketch.microLevels.length > 0,
    packed: { scalar: 'MICRO_CEILING', above: 0 },
  },
  {
    // Always on inside the stack: `gritRelief` bottoms out at 0.29 with the
    // air's loss capped, so the amplitude is never zero on a body with a
    // budget. The kernel reads the amplitude, not a gate.
    id: 'grit',
    kind: 'additive',
    canonical: false,
    on: null,
    packed: null,
  },
  {
    // The sea's `max`, before the cover and after the tail — under the clamp,
    // submarine grit is flattened by the same `max` that flattens the seabed.
    // Off for a seabed tile, which is the ground under a sheet.
    id: 'clamp',
    kind: 'clamp',
    canonical: false,
    on: ({ sea, seabed }) => sea !== null && !seabed,
    packed: { scalar: 'SEA_CLAMP', above: 0.5 },
  },
]

const STAGES: ReadonlyMap<StageId, Stage> = new Map(
  BAND_STACK.map((stage) => [stage.id, stage]),
)

/** One stage of the stack, by name. */
export function stageOf(id: StageId): Stage {
  const stage = STAGES.get(id)
  if (stage === undefined) throw new Error(`no stage ${id} in the band stack`)
  return stage
}

/** Whether a stage runs on this body, as the body spells it. */
export function stageOn(id: StageId, context: StageContext): boolean {
  const stage = stageOf(id)
  return stage.on === null ? true : stage.on(context)
}
