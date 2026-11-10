import { writeFileSync } from 'node:fs'
import { toHalves } from '@inertialref/rendering'
import { capMoments } from './legendre.ts'
import { SOLAR_ANGULAR_RADIUS, meanMoments } from './moments.ts'
import {
  ALONG,
  COSINE,
  ONE,
  harmonic,
  hemispheres,
  lobeBasis,
  quadratureCosines,
  stretched,
  tabulate,
  threeTerms,
  times,
  viewNodes,
  type SourceForm,
  type ViewNodesOptions,
} from './slabForms.ts'
import {
  judge,
  type JudgedFlux,
  type JudgedRow,
  type Reconstruction,
  type SlabScale,
} from './slabJudge.ts'
import {
  MIDPOINT_BEARINGS,
  type SourceBearings,
  type SourceGrid,
  type SourceMedium,
  type SourceTable,
} from './slabSource.ts'
import {
  RENDERING,
  loadStage,
  loadTable,
  saveStage,
  saveTable,
} from './slabStages.ts'
import {
  SLAB_DOMAIN,
  SLAB_STREAMS,
  SOURCE_RADIUS,
  slabPopulation,
  type ReferenceStage,
  type SlabPopulation,
} from './slabTables.ts'
import {
  NUMBERS_TEXT,
  comment,
  halfDecimal,
  numbersText,
  percent,
} from './slabText.ts'

/*
 * The source tables' generator: the oracle's interior field, fitted by every
 * form a table can take (`slabForms.ts`), judged against the oracle's rows
 * (`slabJudge.ts`), and one form written as the table a march reads. It runs
 * in stages as `slabTables.ts` does, into the same directory, and reads that
 * generator's `reference` stages:
 *
 *   node apps/ingest/src/transport/slabSourceTable.ts stage three      (the three-term table's grid)
 *   node apps/ingest/src/transport/slabSourceTable.ts stage 20 0 4     (every form at 20 depth nodes: part, parts)
 *   node apps/ingest/src/transport/slabSourceTable.ts merge 20 4       (a grid's parts as one)
 *   node apps/ingest/src/transport/slabSourceTable.ts transport
 *   node apps/ingest/src/transport/slabSourceTable.ts judge 20         (every form's judgment, printed and kept)
 *   node apps/ingest/src/transport/slabSourceTable.ts write
 *   pnpm exec prettier -w packages/rendering/src/slabSource.generated.ts
 *
 * `stage <nodes>` takes any node count, so a form is judged at 16 or 32
 * nodes by naming them; `write` reads `three` and the count in `VIEW_GRID`.
 */

/** What every source table's axes share. */
export const SOURCE_AXES = {
  sunMuMin: 0.05,
  depthScale: 0.02,
  depthMax: 16,
} as const

/** The three-term table's grid, and where its source is sampled in bearing. */
export const THREE_GRID: SourceGrid = { ...SOURCE_AXES, nodes: 16, suns: 8 }

/**
 * The view table's grid. Eight suns leave the table's own interpolation 16%
 * off at worst and fifteen leave it 8%, which twenty-nine do not better;
 * sixteen depth nodes read 7.7% where twenty read 5.6%, and thirty-two read
 * the same 5.6%, which is the one table's distance from the other radii.
 */
export const VIEW_GRID: SourceGrid = { ...SOURCE_AXES, nodes: 20, suns: 15 }

/**
 * Bearings the forms are fitted on: a trapezoid's thirty-three from the
 * sun's own bearing to the one opposite, so that a fit sees both ends.
 */
export const VIEW_BEARINGS: SourceBearings = { count: 33, ends: true }

/**
 * Where the view table's cosines are sought, each hemisphere; the table's
 * are the oracle's quadrature cosines nearest them. The two ends are the
 * horizon and the normal: without them a grazing ray reads a node 30% off.
 */
export const VIEW_COSINES = [
  0, 0.04, 0.12, 0.24, 0.38, 0.53, 0.68, 0.82, 0.94, 1,
] as const

/** The view table's stretch of the bearing: ψ = π·(φ/π)^0.65. */
export const VIEW_STRETCH = 0.65

/**
 * Which first moment turns a scaled depth into a table's transport depth:
 * the formula's g′ = (g − f_δ)/(1 − f_δ), or the scaled phase's own χ′₁.
 * They differ by 0.005 at 10 µm and by 0.009 at 6 µm, and the difference
 * is 0.5 point of a slab's reflected flux: similarity between radii holds
 * in the moment the phase has, not in the one the formula gives it.
 */
export type SourceTransport = 'formula' | 'moment'

/** The medium a source table is cut from: a population's three bands as one, scaled. */
export function sourceMedium(
  population: SlabPopulation,
  transport: SourceTransport,
): SourceMedium {
  const moments = meanMoments(
    population.bands.map((band) => band.scaled.moments as Float64Array),
  )
  const cap = capMoments(SOLAR_ANGULAR_RADIUS, moments.length)
  return {
    moments,
    convolved: moments.map((value, l) => value * cap[l]!),
    asymmetry:
      transport === 'formula' ? population.asymmetry : population.moment,
  }
}

/** The view table's form: its cosines' targets, its stretch, and how a ray blends two cosines. */
export function viewForm(
  options: Pick<ViewNodesOptions, 'name' | 'blend'> & {
    readonly cosines?: readonly number[]
    readonly stretch?: number
  },
): SourceForm {
  const stretch = options.stretch ?? VIEW_STRETCH
  return viewNodes({
    name: options.name,
    cosines: options.cosines ?? [
      ...quadratureCosines(SLAB_STREAMS.scaled, VIEW_COSINES),
    ],
    basis: [0, 1, 2, 3].map((k) =>
      stretch === 1 ? harmonic(k) : stretched(k, stretch),
    ),
    measure: 'relative',
    blend: options.blend,
  })
}

/** The three-term forms, by the lobe's asymmetry: both measures, with the lobe and without. */
export function threeForms(lobe: number): SourceForm[] {
  return (['relative', 'absolute'] as const).flatMap((measure) =>
    [true, false].map((withLobe) => threeTerms({ lobe, measure, withLobe })),
  )
}

/**
 * Every form a grid's stage fits, by name. `asymmetry` is the medium's, and
 * the lobes are about its square, the twice-scattered phase's asymmetry.
 *
 *   three-…            J₀ + J₁·μ_v + J_f·Φ(ν) over the sphere: one read a step
 *   hemispheres        the same three terms, each hemisphere apart: one read
 *   hemispheres-plain  (J₀, J₁) each hemisphere: one read
 *   hemispheres-wide   eight terms each hemisphere: two reads
 *   views-fourier      ten cosines a hemisphere, cos kφ, blended in the cosine: two reads
 *   views              ten cosines, cos kψ, blended in the angle: two reads
 *   views-nearest      the same table, the nearer cosine alone: one read
 *   views-dense        twenty-four cosines, the nearer alone: one read
 */
export function sourceForms(asymmetry: number): SourceForm[] {
  const lobe = lobeBasis(asymmetry ** 2)
  const dense = Array.from({ length: 24 }, (_, i) =>
    Math.cos(((23 - i) / 23) * (Math.PI / 2)),
  )
  return [
    ...threeForms(asymmetry ** 2),
    hemispheres({
      name: 'hemispheres',
      basis: [ONE, COSINE, lobe],
      measure: 'relative',
    }),
    hemispheres({
      name: 'hemispheres-plain',
      basis: [ONE, COSINE],
      measure: 'relative',
    }),
    hemispheres({
      name: 'hemispheres-wide',
      basis: [
        ONE,
        COSINE,
        lobe,
        times(COSINE, COSINE),
        ALONG,
        times(COSINE, lobe),
        lobeBasis(0.8),
        times(ALONG, COSINE),
      ],
      measure: 'relative',
    }),
    viewForm({ name: 'views-fourier', blend: 'cosine', stretch: 1 }),
    viewForm({ name: 'views', blend: 'angle' }),
    viewForm({ name: 'views-nearest', blend: 'nearest' }),
    viewForm({
      name: 'views-dense',
      blend: 'nearest',
      cosines: quadratureCosines(SLAB_STREAMS.scaled, dense),
    }),
  ]
}

/** What a stage says of its tables; each form's table is a file of its own beside it. */
export interface SourceStage {
  readonly name: string
  readonly grid: SourceGrid
  readonly streams: number
  readonly transport: SourceTransport
  /** The medium's first moment, by `transport`, and its moments' digest. */
  readonly asymmetry: number
  readonly digest: string
  readonly delta: number
  readonly modes: number
  readonly forms: readonly string[]
}

/** A grid's name as a stage: `three`, or a count of depth nodes. */
function stagePlan(name: string): {
  grid: SourceGrid
  transport: SourceTransport
  bearings: SourceBearings
  forms: (asymmetry: number) => SourceForm[]
} {
  if (name === 'three')
    return {
      grid: THREE_GRID,
      transport: 'formula',
      bearings: MIDPOINT_BEARINGS,
      forms: (asymmetry) => threeForms(asymmetry ** 2),
    }
  const nodes = Number(name)
  if (!Number.isInteger(nodes) || nodes < 2)
    throw new Error(`slabSourceTable: ${name} is not a grid`)
  return {
    grid: { ...VIEW_GRID, nodes },
    transport: 'moment',
    bearings: VIEW_BEARINGS,
    forms: sourceForms,
  }
}

function runStage(name: string, part: number, parts: number): void {
  const plan = stagePlan(name)
  const population = slabPopulation(SOURCE_RADIUS)
  const medium = sourceMedium(population, plan.transport)
  const forms = plan.forms(medium.asymmetry)
  const rows = Array.from({ length: plan.grid.nodes }, (_, i) => i).filter(
    (i) => i % parts === part,
  )
  const made = tabulate(medium, plan.grid, SLAB_STREAMS.scaled, forms, {
    rows,
    bearings: plan.bearings,
  })
  const tag = parts === 1 ? name : `${name}-${part}of${parts}`
  for (const form of forms)
    saveTable(`source-${tag}-${form.name}`, made.tables.get(form.name)!)
  saveStage(`source-${tag}`, {
    name,
    grid: plan.grid,
    streams: SLAB_STREAMS.scaled,
    transport: plan.transport,
    asymmetry: medium.asymmetry,
    digest: population.digest,
    delta: made.delta,
    modes: made.modes,
    forms: forms.map((form) => form.name),
  } satisfies SourceStage)
}

/** A grid's parts as one stage: a part holds zeros where another holds a row. */
function mergeStage(name: string, parts: number): void {
  const stages = Array.from({ length: parts }, (_, part) =>
    loadStage<SourceStage>(`source-${name}-${part}of${parts}`),
  )
  for (const form of stages[0]!.forms) {
    const sum = loadTable(`source-${name}-0of${parts}-${form}`)
    for (let part = 1; part < parts; part += 1) {
      const more = loadTable(`source-${name}-${part}of${parts}-${form}`)
      for (let at = 0; at < sum.length; at += 1) sum[at] = sum[at]! + more[at]!
    }
    saveTable(`source-${name}-${form}`, sum)
  }
  saveStage(`source-${name}`, stages[0]!)
}

/**
 * A stage's table of one form, as a march reads it: every texel a half
 * float's value, rounded once from the fit's own. Through a float32 on the
 * way it is rounded twice, and one texel in six thousand lands on the other
 * half float.
 */
export function stageTable(stage: SourceStage, form: SourceForm): SourceTable {
  return {
    ...stage.grid,
    slabs: form.slabs,
    terms: loadTable(`source-${stage.name}-${form.name}`).map(Math.f16round),
  }
}

/** One radius of the transport stage: what its scaled depth is turned into a transport depth by. */
export interface TransportRow {
  readonly radius: number
  readonly share: number
  /** g′ by the formula, and χ′₁, the scaled phase's own first moment. */
  readonly asymmetry: number
  readonly moment: number
}

/** µm: the radii the transport stage is made at, the domain's among them. */
export const TRANSPORT_RADII = [2, 3, 4, 6, 8, 10, 12, 16, 20, 25, 32] as const

/**
 * Each radius's scale by a table's convention. A table cut by the moment
 * is read by each radius's own; one cut by the formula, by the formula's.
 */
export function sourceScales(
  transport: SourceTransport,
  rows: readonly TransportRow[],
): SlabScale[] {
  return rows.map((row) => ({
    radius: row.radius,
    share: row.share,
    asymmetry: transport === 'formula' ? row.asymmetry : row.moment,
  }))
}

/**
 * The formula's scales on a table cut by the moment: each radius's 1 − g′
 * in the ratio it bears to the table's own radius, which is what a reader
 * that knows only g′ can do.
 */
export function formulaScales(rows: readonly TransportRow[]): SlabScale[] {
  const own = rows.find((row) => row.radius === SOURCE_RADIUS)!
  return rows.map((row) => ({
    radius: row.radius,
    share: row.share,
    asymmetry:
      1 - ((1 - row.asymmetry) * (1 - own.moment)) / (1 - own.asymmetry),
  }))
}

/** The oracle's rows and fluxes a table is judged on. */
interface Judged {
  readonly rows: readonly JudgedRow[]
  readonly fluxes: readonly JudgedFlux[]
}

function judgedRows(): Judged {
  const references = SLAB_DOMAIN.radii.map((radius) =>
    loadStage<ReferenceStage>(`reference-${radius}`),
  )
  return {
    rows: references.flatMap((stage) => stage.rows),
    fluxes: references.flatMap((stage) => stage.fluxes),
  }
}

const tenth = (value: number): string => (100 * value).toFixed(1)

/** A judgment as a line of a table: the columns a report carries. */
export function judgmentLine(name: string, judged: Reconstruction): string {
  return [
    name.padEnd(24),
    `worst ${percent(judged.error)} rms ${percent(judged.rms)}`,
    `p50 ${percent(judged.median)} p95 ${percent(judged.ninetyFifth)} p99 ${percent(judged.ninetyNinth)}`,
    `flux ${percent(judged.flux)}`,
    `over 5%: ${judged.over} of ${judged.count}`,
    `μ₀ ${judged.bySun.map(([sun, error]) => `${sun}: ${tenth(error)}`).join(' ')}`,
    `τ ${judged.byDepth.map(([depth, error]) => `${depth}: ${tenth(error)}`).join(' ')}`,
    `thin ${judged.thin.map(tenth).join(' ')}`,
    `at ${judged.worst}`,
  ].join(' | ')
}

/** Every form of a stage judged, printed a line each and kept. */
function judgeStage(name: string): void {
  const stage = loadStage<SourceStage>(`source-${name}`)
  const transport = loadStage<TransportRow[]>('transport')
  const { rows, fluxes } = judgedRows()
  const forms =
    name === 'three'
      ? threeForms(stage.asymmetry ** 2)
      : sourceForms(stage.asymmetry)
  const scales = sourceScales(stage.transport, transport)
  const kept: Record<string, Reconstruction> = {}
  const say = (label: string, judged: Reconstruction): void => {
    kept[label] = judged
    console.log(judgmentLine(label, judged))
  }
  for (const form of forms)
    say(form.name, judge(stageTable(stage, form), form, scales, rows, fluxes))
  if (stage.transport === 'moment') {
    const form = forms.find((item) => item.name === 'views')!
    say(
      'views, by the formula',
      judge(
        stageTable(stage, form),
        form,
        formulaScales(transport),
        rows,
        fluxes,
      ),
    )
  }
  saveStage(`source-${name}-judged`, kept)
}

/** What `write` judges before it writes anything. */
export interface SourceVerdict {
  readonly three: SourceStage
  readonly views: SourceStage
  readonly transport: readonly TransportRow[]
  /** The three-term table by each measure, with the lobe and without. */
  readonly relative: Reconstruction
  readonly absolute: Reconstruction
  readonly plain: Reconstruction
  /** The view table. */
  readonly judged: Reconstruction
}

export function decide(): SourceVerdict {
  const three = loadStage<SourceStage>('source-three')
  const views = loadStage<SourceStage>(`source-${VIEW_GRID.nodes}`)
  const transport = loadStage<TransportRow[]>('transport')
  const { rows, fluxes } = judgedRows()
  const forms = threeForms(three.asymmetry ** 2)
  const threeJudged = (name: string): Reconstruction => {
    const form = forms.find((item) => item.name === name)!
    return judge(
      stageTable(three, form),
      form,
      sourceScales(three.transport, transport),
      rows,
      fluxes,
    )
  }
  const form = viewForm({ name: 'views', blend: 'angle' })
  return {
    three,
    views,
    transport,
    relative: threeJudged('three-relative'),
    absolute: threeJudged('three-absolute'),
    plain: threeJudged('three-relative-plain'),
    judged: judge(
      stageTable(views, form),
      form,
      sourceScales(views.transport, transport),
      rows,
      fluxes,
    ),
  }
}

const four = (value: number): number => Number(value.toPrecision(4))

/** A judgment as a generated file holds it. */
function reconstructionText(judged: Reconstruction): string {
  return JSON.stringify({
    grid: four(judged.grid),
    held: four(judged.held),
    rms: four(judged.rms),
    median: four(judged.median),
    ninetyFifth: four(judged.ninetyFifth),
    ninetyNinth: four(judged.ninetyNinth),
    thin: judged.thin.map(four),
    flux: four(judged.flux),
    over: judged.over,
    count: judged.count,
  })
}

/** A table's texels as base64: little-endian half floats, in the table's own order. */
export function texelsText(table: Float64Array): string {
  // Rounded to a half float first: `toHalves` is then exact.
  const halves = toHalves(Float32Array.from(table, Math.f16round))
  const bytes = Buffer.alloc(halves.length * 2)
  halves.forEach((bits, at) => bytes.writeUInt16LE(bits, 2 * at))
  return bytes.toString('base64')
}

/** `slabSource.generated.ts`'s text, before prettier. */
export function sourceText(verdict: SourceVerdict): string {
  const { three, views, judged, relative } = verdict
  const lobe = three.asymmetry ** 2
  const threeForm = threeForms(lobe).find(
    (item) => item.name === 'three-relative',
  )!
  const threeTable = stageTable(three, threeForm)
  // The three-term table holds three channels a texel: its fourth is no term.
  const terms: number[] = []
  for (let at = 0; at < threeTable.terms.length; at += 4)
    for (let term = 0; term < 3; term += 1)
      terms.push(halfDecimal(threeTable.terms[at + term]!))
  const cosines = quadratureCosines(views.streams, VIEW_COSINES)
  const slabs = 2 * cosines.length
  const bytes = views.grid.nodes ** 2 * views.grid.suns * slabs * 8
  const rule = verdict.transport.map(
    (row) => (row.moment - row.asymmetry) * row.radius,
  )
  const header = [
    'Generated by `node apps/ingest/src/transport/slabSourceTable.ts write`',
    'from the stages its header lists; rerun them rather than editing, then',
    '`pnpm exec prettier -w` this file.',
    '',
    'The higher orders’ source function in a plane slab of the renderer’s scaled',
    'medium, per unit of the sun’s irradiance and of scaled optical depth, sr⁻¹:',
    'what a march adds a step beyond first order. Both tables are fits of the',
    `adding-doubling oracle’s interior field at ${views.streams} streams (\`slabSource.ts\`),`,
    `for the droplet table’s population at ${SOURCE_RADIUS} µm with the three bands as one`,
    `(moments’ digest ${views.digest}), and both are indexed by two transport depths,`,
    't_d from the lit face and t_b from the far one, on',
    'u(t) = ln(1 + t/depthScale)/ln(1 + depthMax/depthScale), and by the sun’s',
    'cosine μ₀ to the lit face’s normal, evenly from `sunMuMin` to 1.',
    '',
    '`SLAB_VIEW_SOURCE` is the table a march reads. The source is tabulated at',
    '`cosines` of μ_v, the cosine to the lit face’s outward normal of light',
    'traveling to the eye, in each hemisphere: a slab is one hemisphere at one',
    'cosine, slab = (μ_v ≥ 0 ? 0 : cosines.length) + i. A slab’s texel is the four',
    'coefficients of the source’s dependence on bearing at that cosine,',
    '',
    '  c₀ + c₁·cos ψ + c₂·cos 2ψ + c₃·cos 3ψ        ψ = π·(φ/π)^stretch',
    '',
    'with φ, 0 to π, the angle between the light’s direction and the sun’s',
    'light’s, both laid on the slab’s plane: 0 where the light travels the way',
    'the sun’s does. A ray straight along the normal has no bearing and takes',
    'φ = π/2. A ray reads the two slabs whose cosines its |μ_v| lies between,',
    'blended in the polar angle θ = acos |μ_v|,',
    '',
    '  a = (acos cosines[i] − θ)/(acos cosines[i] − acos cosines[i + 1])',
    '  S_h = (1 − a)·T[i]·w + a·T[i + 1]·w        w = (1, cos ψ, cos 2ψ, cos 3ψ)',
    '',
    'and a ray outside the first or the last cosine reads that slab alone. The',
    'hemisphere, i, a and w are constant along a ray; a step is two reads and two',
    'products. T[i] is a linear 3D texture’s read: `nodes` wide in u(t_d),',
    '`nodes` high in u(t_b) and 2·cosines.length·`suns` deep, slice',
    'slab·suns + k for sun node k, read at texel centers,',
    '',
    '  x = (u(t_d)·(nodes − 1) + ½)/nodes        y = (u(t_b)·(nodes − 1) + ½)/nodes',
    '  z = (slab·suns + s·(suns − 1) + ½)/(2·cosines.length·suns)',
    '',
    'with s = (μ₀ − sunMuMin)/(1 − sunMuMin) held to 0…1, so that no read blends',
    'two slabs. `texels` is those texels as little-endian half floats in',
    `base64, laid out [slab][sun][bottom][top][channel]: ${bytes} bytes. The fit`,
    'at a cosine is least squares on the source over itself at thirty-three',
    'bearings, the forward cone within 6° of the sun left out.',
    '',
    'Its transport depth is t = (1 − χ′₁)·τ′, with χ′₁ the scaled phase’s own first',
    'moment at the sample’s radius, the three bands’ mean: `transport` is',
    '1 − χ′₁ at each of its radii. χ′₁ is over the formula’s',
    `g′ = (g − f_δ)/(1 − f_δ) by ${Math.min(...rule).toFixed(3)}/r to ${Math.max(...rule).toFixed(3)}/r, r the radius in µm, because the`,
    'diffraction pattern the scaling takes out has wings.',
    '',
    '`reconstructionError` is the worst relative error of a slab’s leaving',
    'radiance rebuilt through the table’s own read, first order beside it,',
    'against the oracle’s `scaled` rows of `slabReference.generated.ts`: every',
    'band, radius, depth, sun, view and azimuth of the domain’s grid and held-out',
    `slabs. It is ${percent(judged.error)}, at ${judged.worst}.`,
    `\`reconstruction\` breaks it down: ${percent(judged.grid)} on the grid, ${percent(judged.held)} on the held-out`,
    `slabs, ${percent(judged.rms)} root mean square; half of the ${judged.count} radiances are within`,
    `${percent(judged.median)}, 95% within ${percent(judged.ninetyFifth)} and 99% within ${percent(judged.ninetyNinth)}, and ${judged.over} are over 5%;`,
    `${judged.thin.map(percent).join(', ')} at τ ${SLAB_DOMAIN.depths.thin.join(', ')}; and ${percent(judged.flux)} in the reflected flux, the`,
    'higher orders summed at eight Gauss points in μ and sixteen azimuths.',
    '',
    '`SLAB_SOURCE` is the first table, three terms over the whole sphere,',
    '',
    '  J₀ + J₁·μ_v + J_f·Φ(ν)        Φ(ν) = 4π·HG(ν; lobe) − 1',
    '',
    'with ν the cosine between the sun’s light and the light to the eye, by the',
    'same least squares over every direction at sixteen bearings. It is laid',
    'out [sun][bottom][top][term], a half float’s value printed as the shortest',
    'decimal that rounds to it, and its transport depth is by the formula’s g′.',
    `Its worst error is ${percent(relative.error)}, at ${relative.worst};`,
    `${percent(relative.rms)} root mean square and ${percent(relative.flux)} in the reflected flux; ${percent(verdict.plain.error)} without the`,
    `lobe; and by least squares on the source itself, ${percent(verdict.absolute.error)}. One cosine cannot be`,
    'the step the source takes across the horizon, so no march draws with it:',
    '`cloudContracts.test.ts` holds its layout.',
  ]
  const body = [
    ...NUMBERS_TEXT,
    'export const SLAB_VIEW_SOURCE = {',
    "  format: 'inertialref/slab-view-source',",
    '  version: 1,',
    `  nodes: ${views.grid.nodes},`,
    `  suns: ${views.grid.suns},`,
    `  sunMuMin: ${views.grid.sunMuMin},`,
    `  depthScale: ${views.grid.depthScale},`,
    `  depthMax: ${views.grid.depthMax},`,
    '  /** µm: the radius row the table is generated at. */',
    `  radius: ${SOURCE_RADIUS},`,
    '  /** The cosines the view is tabulated at in each hemisphere, ascending. */',
    `  cosines: ${JSON.stringify(cosines.map((value) => Number(value.toPrecision(9))))},`,
    '  /** The bearing’s stretch: ψ = π·(φ/π)^stretch. */',
    `  stretch: ${VIEW_STRETCH},`,
    '  /** 1 − χ′₁ at each radius, µm: what turns a scaled depth into the table’s transport depth. */',
    '  transport: ' +
      JSON.stringify({
        radii: verdict.transport.map((row) => row.radius),
        scales: verdict.transport.map((row) =>
          Number((1 - row.moment).toPrecision(6)),
        ),
      }) +
      ',',
    '  /** The reconstruction’s worst relative error against the oracle, on the domain and between its nodes. */',
    `  reconstructionError: ${four(judged.error)},`,
    `  reconstruction: ${reconstructionText(judged)},`,
    '  /** nodes × nodes × (2·cosines.length·suns) RGBA16F texels, little-endian, in base64. */',
    `  texels: '${texelsText(loadTable(`source-${views.name}-views`))}' as string,`,
    '} as const',
    '',
    '/** The three-term table: no march draws with it. */',
    'export const SLAB_SOURCE = {',
    "  format: 'inertialref/slab-source',",
    '  version: 1,',
    `  nodes: ${three.grid.nodes},`,
    `  suns: ${three.grid.suns},`,
    `  sunMuMin: ${three.grid.sunMuMin},`,
    `  depthScale: ${three.grid.depthScale},`,
    `  depthMax: ${three.grid.depthMax},`,
    '  /** µm: the radius row the table is generated at. */',
    `  radius: ${SOURCE_RADIUS},`,
    '  /** The lobe’s asymmetry: g′² at that radius. */',
    `  lobe: ${Number(lobe.toPrecision(7))},`,
    '  /** The reconstruction’s worst relative error against the oracle, on the domain and between its nodes. */',
    `  reconstructionError: ${four(relative.error)},`,
    `  reconstruction: ${reconstructionText(relative)},`,
    `  terms: /*@__PURE__*/ numbers(${numbersText(terms, 12)}),`,
    '} as const',
    '',
  ]
  return comment(header) + body.join('\n')
}

function write(): void {
  const verdict = decide()
  writeFileSync(`${RENDERING}slabSource.generated.ts`, sourceText(verdict))
  saveStage('source-verdict', verdict)
  console.log(
    `slabSourceTable: wrote the source under ${RENDERING}; now run pnpm exec prettier -w on it`,
  )
}

if (import.meta.main) {
  const [stage, ...rest] = process.argv.slice(2)
  if (stage === 'stage')
    runStage(rest[0] ?? '', Number(rest[1] ?? 0), Number(rest[2] ?? 1))
  else if (stage === 'merge') mergeStage(rest[0] ?? '', Number(rest[1]))
  else if (stage === 'transport')
    saveStage(
      'transport',
      TRANSPORT_RADII.map((radius): TransportRow => {
        const { share, asymmetry, moment } = slabPopulation(radius)
        return { radius, share, asymmetry, moment }
      }),
    )
  else if (stage === 'judge') judgeStage(rest[0] ?? '')
  else if (stage === 'write') write()
  else {
    console.error(
      'slabSourceTable: a stage is one of stage <three | nodes> <part> <parts>, merge <nodes> <parts>, transport, judge <three | nodes>, write',
    )
    process.exit(1)
  }
}
