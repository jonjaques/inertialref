import type { SourceForm } from './slabForms.ts'
import type { IceTransportRow } from './slabIce.ts'
import {
  judgeValues,
  type JudgedRow,
  type JudgedValue,
  type SlabScale,
} from './slabJudge.ts'
import {
  OUTSIDE_SETS,
  deepFigures,
  outsideFigures,
  type OutsideJudgment,
} from './slabOutside.ts'
import type { SourceTable } from './slabSource.ts'
import { loadStage } from './slabStages.ts'
import { percent } from './slabText.ts'

/*
 * What the view table is judged on beyond the rubric's domain, from the
 * stages `outside`, `sample` and `ice`: the figures `write` puts in the
 * generated file's header and fields, and the slow test's ceilings.
 */

/** The sets judged a set at a time: the deep one is judged a face and a depth at a time. */
export const OUTSIDE_JUDGED = ['views', 'between', 'low', 'thin'] as const

/** A set's figures on the generator's whole set, and on the slow test's sample of it. */
export interface OutsideEntry extends OutsideJudgment {
  readonly sample: OutsideJudgment
}

/** Past the last node: each face's worst at each depth, extended and held. */
export interface DeepVerdict {
  readonly depths: readonly number[]
  readonly transmitted: readonly number[]
  readonly reflected: readonly number[]
  readonly held: {
    readonly transmitted: readonly number[]
    readonly reflected: readonly number[]
  }
  readonly sample: {
    readonly transmitted: readonly number[]
    readonly reflected: readonly number[]
  }
}

/** The table read at an ice row's own transport scale, against the oracle on that row's phase. */
export interface IceVerdict extends OutsideJudgment {
  /** µm: the judged rows' effective diameters. */
  readonly diameters: readonly number[]
  readonly depths: readonly number[]
  /** The worst at each depth, over every judged row. */
  readonly byDepth: readonly number[]
}

export interface OutsideVerdict {
  readonly sets: Record<(typeof OUTSIDE_JUDGED)[number], OutsideEntry>
  /** The low suns' worst with the sun's coordinate read on the first slice, not held inside it. */
  readonly lowOnSlice: number
  readonly deep: DeepVerdict
  readonly ice: IceVerdict
}

/** A set's stage rows at every radius it is solved at. */
function stageRows(prefix: string, radii: readonly number[]): JudgedRow[] {
  return radii.flatMap((radius) =>
    loadStage<JudgedRow[]>(`${prefix}-${radius}`),
  )
}

function deepVerdict(
  table: SourceTable,
  form: SourceForm,
  scales: readonly SlabScale[],
): DeepVerdict {
  const { radii, depths } = OUTSIDE_SETS.deep
  const faces = (values: readonly JudgedValue[]) => {
    const figures = deepFigures(values)
    const of = (side: 'transmitted' | 'reflected'): number[] =>
      depths.map(
        (depth) =>
          figures.find((item) => item.side === side && item.depth === depth)!
            .worst,
      )
    return { transmitted: of('transmitted'), reflected: of('reflected') }
  }
  const rows = stageRows('outside-deep', radii)
  return {
    depths,
    ...faces(judgeValues(table, form, scales, rows)),
    held: faces(judgeValues(table, form, scales, rows, { extend: false })),
    sample: faces(
      judgeValues(table, form, scales, stageRows('sample-deep', radii)),
    ),
  }
}

/** An ice row's scale, as the table is read for it: its own f_δ and χ′₁. */
export function iceScale(row: IceTransportRow): SlabScale {
  return { radius: row.radius, share: row.share, asymmetry: row.moment }
}

function iceVerdict(
  table: SourceTable,
  form: SourceForm,
  ice: readonly IceTransportRow[],
  judged: readonly number[],
  depths: readonly number[],
): IceVerdict {
  const values = judged.flatMap((row) =>
    judgeValues(
      table,
      form,
      [iceScale(ice[row]!)],
      loadStage<JudgedRow[]>(`ice-${row}`),
    ),
  )
  const figures = outsideFigures(values)
  return {
    ...figures,
    // A row names its radius; an ice row is known by its diameter.
    where: figures.where.replace(
      /^([\d.]+) µm/,
      (_, radius: string) => `ice ${2 * Number(radius)} µm across`,
    ),
    diameters: judged.map((row) => 2 * ice[row]!.radius),
    depths,
    byDepth: depths.map(
      (depth) =>
        outsideFigures(values.filter((value) => value.row.depth === depth))
          .worst,
    ),
  }
}

/** Every judgment outside the domain, from the stages. */
export function outsideVerdict(
  table: SourceTable,
  form: SourceForm,
  scales: readonly SlabScale[],
  ice: readonly IceTransportRow[],
  iceRows: readonly number[],
  iceDepths: readonly number[],
): OutsideVerdict {
  const entry = (name: (typeof OUTSIDE_JUDGED)[number]): OutsideEntry => {
    const { radii } = OUTSIDE_SETS[name]
    const judged = (prefix: string): OutsideJudgment =>
      outsideFigures(
        judgeValues(table, form, scales, stageRows(`${prefix}-${name}`, radii)),
      )
    return { ...judged('outside'), sample: judged('sample') }
  }
  return {
    sets: {
      views: entry('views'),
      between: entry('between'),
      low: entry('low'),
      thin: entry('thin'),
    },
    lowOnSlice: outsideFigures(
      judgeValues(
        table,
        form,
        scales,
        stageRows('outside-low', OUTSIDE_SETS.low.radii),
        { holdSun: false },
      ),
    ).worst,
    deep: deepVerdict(table, form, scales),
    ice: iceVerdict(table, form, ice, iceRows, iceDepths),
  }
}

const four = (value: number): number => Number(value.toPrecision(4))

/** A judgment's figures as a generated file holds them. */
function figures(judged: OutsideJudgment): Record<string, number> {
  return {
    count: judged.count,
    worst: four(judged.worst),
    rms: four(judged.rms),
    over: judged.over,
  }
}

/** The fields `SLAB_VIEW_SOURCE` carries of the judgment outside the domain, as text. */
export function outsideFields(verdict: OutsideVerdict): string[] {
  const sets = Object.fromEntries(
    OUTSIDE_JUDGED.map((name) => {
      const entry = verdict.sets[name]
      return [name, { ...figures(entry), sample: figures(entry.sample) }]
    }),
  )
  const { deep, ice } = verdict
  return [
    '  /** The reconstruction off the domain: each set’s figures, and the slow test’s sample of it. */',
    `  outside: ${JSON.stringify(sets)},`,
    '  /** Past the last depth node: each face’s worst at each depth, extended, held, and the slow test’s. */',
    '  deep: ' +
      JSON.stringify({
        depths: deep.depths,
        transmitted: deep.transmitted.map(four),
        reflected: deep.reflected.map(four),
        held: {
          transmitted: deep.held.transmitted.map(four),
          reflected: deep.held.reflected.map(four),
        },
        sample: {
          transmitted: deep.sample.transmitted.map(four),
          reflected: deep.sample.reflected.map(four),
        },
      }) +
      ',',
    '  /** The table at an ice row’s own transport scale against the oracle on the ice phase. */',
    '  ice: ' +
      JSON.stringify({
        ...figures(ice),
        diameters: ice.diameters,
        depths: ice.depths,
        byDepth: ice.byDepth.map(four),
      }) +
      ',',
  ]
}

const list = (values: readonly number[]): string =>
  values.map(percent).join(', ')

/** The header's paragraphs on what the table holds off the domain, and what it does not hold. */
export function outsideHeader(verdict: OutsideVerdict): string[] {
  const { views, between, low, thin } = verdict.sets
  const { deep, ice } = verdict
  const line = (label: string, entry: OutsideEntry): string =>
    `${label}: ${percent(entry.worst)} worst, ${percent(entry.rms)} RMS, ${entry.over} of ${entry.count} radiances over 5%, at ${entry.where}.`
  return [
    'Off the domain, the same reconstruction at 6, 10 and 16 µm in every band,',
    'against the oracle at the same streams (`slabOutside.ts`, the `outside`',
    'stages):',
    '',
    line('- The domain’s slabs at views and bearings between its own', views),
    '',
    line(
      '- Depths, suns, views and bearings all between the domain’s',
      between,
    ),
    '',
    line('- Suns of 0.05 to 0.16, under the domain’s lowest', low),
    '',
    line('- Slabs of τ 0.25 to 4, under the domain’s thinnest', thin),
    '',
    'The slow test solves each set at its first and last depths at 64 streams',
    `and holds it to its own figures: ${percent(views.sample.worst)} worst and ${percent(views.sample.rms)} RMS between the`,
    `views, ${percent(between.sample.worst)} and ${percent(between.sample.rms)} all between, ${percent(low.sample.worst)} and ${percent(low.sample.rms)} under low suns, and`,
    `${percent(thin.sample.worst)} and ${percent(thin.sample.rms)} on thin slabs.`,
    '',
    'What the table does not hold:',
    '',
    '- Any shape but the droplets’. It is cut at 10 µm, and another radius',
    'reads it at that radius’s own transport scale, `transport`. Ice is another',
    'shape: `iceTransport` is its scale by the same moment, χ′₁ of the ice',
    'row’s phase with f_δ = 1/Q_ext of its forward peak clipped (`slabIce.ts`).',
    'Read at it, against the oracle on the ice phase itself at diameters',
    `${ice.diameters.join(', ')} µm, τ ${ice.depths.join(', ')} and suns 0.2, 0.5 and 0.77, the table is`,
    `${percent(ice.worst)} worst and ${percent(ice.rms)} RMS in radiance (${list(ice.byDepth)} worst at`,
    `each τ), at ${ice.where}. That is the figure an ice level declares.`,
    '',
    '- A sun under `sunMuMin`. The read holds the sun’s coordinate a 64th of',
    'a slice inside the first, so any lower sun reads the floor’s source, with',
    `a 64th of the next slice’s. Under the low suns the worst is ${percent(verdict.lowOnSlice)} read on`,
    `the slice and ${percent(low.worst)} held inside it.`,
    '',
    '- A slab past `depthMax` from the lit face. The read is the last node’s',
    'times diffusion’s law (`diffusionExtension`). At 10 µm, τ',
    `${deep.depths.join(' and ')}, transmitted light is ${list(deep.transmitted)} at worst, where the read`,
    `held at the node is ${list(deep.held.transmitted)}. Reflected light, which the extension`,
    `does not touch, is ${list(deep.reflected)}.`,
    '',
    '- The domain’s figures under τ 5 or under a sun of 0.2: the worst is',
    `${percent(thin.worst)} on thin slabs and ${percent(low.worst)} under low suns.`,
  ]
}
