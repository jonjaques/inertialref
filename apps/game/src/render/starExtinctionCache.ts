import {
  StorageInstancedBufferAttribute,
  Vector3,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn,
  If,
  float,
  instanceIndex,
  instancedBufferAttribute,
  mix,
  storage,
  uint,
  uvec4,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import { invariant, PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  integrateStarExtinction,
  SUN_POSITION,
  type GalaxyField,
} from '@inertialref/universe'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { createStarExtinction, starExtinctionOrigin } from './starExtinction.ts'
import { disposeAttributes } from './disposeAttributes.ts'

export const STAR_EXTINCTION_CACHE_RADIUS_PARSECS = 0.15
/** Shared-table M5 means: 1.5–1.7 ms; a cold catalogue correction is 3.1 ms. */
export const STAR_EXTINCTION_BATCH_SIZE = 1024
/** Measured M5 mean at 1–6 kpc: 0.85 ms per column, 1.65 ms with a cold Sol reference. */
export const STAR_EXTINCTION_CPU_BATCH_SIZE = 1
/** A finite presentation range, recorded when a reference correction exceeds it. */
export const STAR_EXTINCTION_MAX_LOG_GAIN = 16 * Math.LN2
const FADE_SUBMISSIONS = 6

export interface StarExtinctionSelection {
  readonly ids: readonly string[]
  readonly positions: readonly UniverseVector[]
  readonly catalogued: readonly boolean[]
}
interface Source {
  readonly id: string
  slot: number
  readonly position: UniverseVector
  readonly catalogued: boolean
  readonly version: number
  written: number
  queued: number
  selection: number
  seen: number
  reference?: readonly [number, number, number]
  corrected?: readonly [number, number, number]
  previous?: readonly [number, number, number]
  published?: number
}
export interface StarExtinctionBatch {
  readonly generation: number
  readonly sources: readonly Source[]
}

/** Source identities own slots; observer generations own the columns written there. */
export class StarExtinctionSchedule {
  readonly capacity: number
  readonly #sources = new Map<string, Source>()
  readonly #free: number[] = []
  #nextSlot = 0
  #selectionEpoch = 0
  #selection: StarExtinctionSelection | null = null
  #selected: Source[] = []
  #queue: Source[] = []
  #cursor = 0
  #field: GalaxyField | null = null
  #origin: UniverseVector | null = null
  #observer: UniverseVector | null = null
  #generation = 0
  #version = 0
  #disposed = false
  #cancellations = 0
  #completed = 0

  constructor(capacity: number) {
    invariant(
      Number.isInteger(capacity) && capacity > 0 && capacity <= 200000,
      'Star extinction capacity must be from 1 through 200000',
    )
    this.capacity = capacity
  }
  configure(
    selection: StarExtinctionSelection,
    observer: UniverseVector | null,
    field: GalaxyField,
  ): boolean {
    if (this.#disposed) return false
    const changedField = field !== this.#field
    const changedSelection =
      selection.ids !== this.#selection?.ids ||
      selection.positions !== this.#selection?.positions ||
      selection.catalogued !== this.#selection?.catalogued
    this.#observer = observer
    const moved =
      observer === null ||
      this.#origin === null ||
      UV.distance(observer, this.#origin) >
        STAR_EXTINCTION_CACHE_RADIUS_PARSECS * PARSEC
    // Finish a bounded cycle at one origin before chasing the moving observer.
    // Otherwise continuous travel keeps restarting at source zero forever.
    const refresh =
      changedField ||
      (observer === null
        ? this.#origin !== null
        : this.#origin === null ||
          (moved && this.#queue.length === this.#cursor))
    if (refresh) {
      if (this.#queue.length > this.#cursor) this.#cancellations++
      this.#generation++
      this.#origin =
        observer === null
          ? null
          : {
              ...(UV.distance(observer, SUN_POSITION) <=
              STAR_EXTINCTION_CACHE_RADIUS_PARSECS * PARSEC
                ? SUN_POSITION
                : observer),
            }
      this.#queue = []
      this.#cursor = 0
    }
    this.#field = field
    if (changedField || changedSelection) {
      invariant(
        selection.ids.length === selection.positions.length &&
          selection.ids.length === selection.catalogued.length &&
          selection.ids.length <= this.capacity,
        'Star extinction selection arrays must agree and fit their capacity',
      )
      const epoch = ++this.#selectionEpoch
      const selected: Source[] = new Array(selection.ids.length)
      const unassigned: Source[] = []
      for (let index = 0; index < selection.ids.length; index++) {
        const id = selection.ids[index]!,
          position = selection.positions[index]!,
          catalogued = selection.catalogued[index]!
        // Worker replies clone coordinates, but most identities keep their index.
        const atIndex = this.#selected[index]
        const previous = atIndex?.id === id ? atIndex : this.#sources.get(id)
        invariant(
          previous?.seen !== epoch,
          'Star extinction source ids must be unique',
        )
        if (previous !== undefined) previous.seen = epoch
        if (
          previous !== undefined &&
          !changedField &&
          previous.catalogued === catalogued &&
          UV.equals(previous.position, position)
        ) {
          previous.selection = epoch
          selected[index] = previous
        } else {
          const source: Source = {
            id,
            position: { ...position },
            catalogued,
            slot: previous?.slot ?? -1,
            version: ++this.#version,
            written: 0,
            queued: 0,
            selection: epoch,
            seen: epoch,
          }
          this.#sources.set(id, source)
          selected[index] = source
          if (source.slot < 0) unassigned.push(source)
        }
      }
      for (const [id, source] of this.#sources) {
        if (source.selection !== epoch) {
          this.#sources.delete(id)
          this.#free.push(source.slot)
        }
      }
      // Reclaim before assigning so a full-capacity replacement needs no spare slot.
      for (const source of unassigned)
        source.slot = this.#free.pop() ?? this.#nextSlot++
      this.#selected = selected
      this.#selection = selection
    }
    if (
      (changedSelection || refresh) &&
      this.#origin !== null &&
      UV.distance(this.#origin, SUN_POSITION) === 0
    )
      for (const source of this.#selected)
        if (source.catalogued && source.written !== this.#generation) {
          source.written = this.#generation
          source.corrected = [1, 1, 1]
          source.previous = undefined
          source.published = -1
        }
    if (changedSelection || refresh) {
      // Keep the old unfinished order when worker replies reorder the view.
      // A queued generation avoids rebuilding a membership Set for every star.
      const queue: Source[] = []
      if (this.#origin !== null) {
        for (let index = this.#cursor; index < this.#queue.length; index++) {
          const source = this.#queue[index]!
          if (
            source.selection === this.#selectionEpoch &&
            source.written !== this.#generation
          )
            queue.push(source)
        }
        for (const source of this.#selected) {
          if (
            source.written !== this.#generation &&
            source.queued !== this.#generation
          ) {
            source.queued = this.#generation
            queue.push(source)
          }
        }
      }
      this.#cursor = 0
      this.#queue = queue
    }
    return changedSelection || refresh
  }
  next(count: number): StarExtinctionBatch | null {
    return this.#disposed || this.#queue.length === this.#cursor
      ? null
      : {
          generation: this.#generation,
          sources: this.#queue.slice(this.#cursor, this.#cursor + count),
        }
  }
  complete(batch: StarExtinctionBatch): boolean {
    if (
      this.#disposed ||
      batch.generation !== this.#generation ||
      batch.sources.some(
        (source, i) => this.#queue[this.#cursor + i] !== source,
      )
    )
      return false
    for (const source of batch.sources) source.written = this.#generation
    this.#cursor += batch.sources.length
    this.#completed += batch.sources.length
    return true
  }
  get selected(): readonly Source[] {
    return this.#selected
  }
  get origin(): UniverseVector | null {
    return this.#origin
  }
  get generation(): number {
    return this.#generation
  }
  get diagnostics() {
    return {
      generation: this.#generation,
      pending: this.#queue.length - this.#cursor,
      retained: this.#sources.size,
      completed: this.#completed,
      cancellations: this.#cancellations,
      lagParsecs:
        this.#origin === null || this.#observer === null
          ? 0
          : UV.distance(this.#origin, this.#observer) / PARSEC,
    }
  }
  dispose(): void {
    this.#disposed = true
    this.#generation++
    this.#queue = []
    this.#selected = []
    this.#sources.clear()
    this.#free.length = 0
    this.#origin = null
    this.#observer = null
  }
}

export interface StarExtinctionCacheOptions {
  readonly batchSize?: number
  /** The fallback owns CPU columns and exposes an ordinary instance attribute. */
  readonly cpu?: boolean
  readonly cpuBatchSize?: number
  readonly kernel?: ReturnType<typeof createGalaxyKernel>
}

/** Interpolate optical depth when both columns exist; a new source fades in once. */
function displayedColumn(
  value: Node<'vec3'>,
  previous: Node<'vec4'>,
  alpha: Node<'float'>,
): Node<'vec3'> {
  const blended = mix(
    previous.rgb.max(1e-35).log(),
    value.max(1e-35).log(),
    alpha,
  ).exp()
  return alpha
    .greaterThanEqual(1)
    .select(value, previous.w.greaterThan(0).select(blended, value.mul(alpha)))
}

function gpuColumns(capacity: number, batchSize: number) {
  const floats = (count: number) =>
    new StorageInstancedBufferAttribute(new Float32Array(count * 4), 4)
  const uints = (count: number, stride: number) =>
    new StorageInstancedBufferAttribute(new Uint32Array(count * stride), stride)
  return {
    transmission: floats(capacity * 2),
    positions: floats(capacity),
    versions: uints(capacity, 1),
    mapping: uints(capacity, 4),
    pending: uints(batchSize, 1),
    reference: floats(capacity),
    stamp: uints(capacity, 4),
  }
}

function cpuColumns(capacity: number) {
  return {
    output: new StorageInstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    ),
    previous: new StorageInstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    ),
    instanceBySlot: new Int32Array(capacity),
  }
}

/** Bounded retained RGB transport, with the catalogue calibrated at its actual observing origin. */
export class StarExtinctionCache {
  readonly schedule: StarExtinctionSchedule
  readonly #gpu: ReturnType<typeof gpuColumns> | null
  readonly #cpuColumns: ReturnType<typeof cpuColumns> | null
  readonly #buffers: StorageInstancedBufferAttribute[]
  readonly #generation = uniform(0, 'uint')
  readonly #frame = uniform(0)
  readonly #count = uniform(0, 'uint')
  readonly #origin = uniform(new Vector3())
  readonly #atSol = uniform(false)
  readonly #active = uniform(false)
  readonly #extinction
  readonly #compute
  readonly #batchSize: number
  readonly #cpuBatchSize: number
  readonly #cpu: boolean
  #field: GalaxyField
  #selection: StarExtinctionSelection | null = null
  #renderer: WebGPURenderer | null = null
  #disposed = false
  #ready = false
  #warm: Promise<void> | null = null
  #draws = 0
  #saturated = 0
  #sourceRecordsWritten = 0
  #mappingRecordsWritten = 0

  constructor(
    capacity: number,
    field: GalaxyField,
    options: StarExtinctionCacheOptions = {},
  ) {
    this.schedule = new StarExtinctionSchedule(capacity)
    this.#field = field
    this.#batchSize = options.batchSize ?? STAR_EXTINCTION_BATCH_SIZE
    this.#cpuBatchSize = options.cpuBatchSize ?? STAR_EXTINCTION_CPU_BATCH_SIZE
    this.#cpu = options.cpu ?? false
    invariant(
      Number.isInteger(this.#batchSize) &&
        this.#batchSize >= 1 &&
        this.#batchSize <= 4096,
      'Star extinction batches must contain 1 through 4096 sources',
    )
    invariant(
      Number.isInteger(this.#cpuBatchSize) &&
        this.#cpuBatchSize >= 1 &&
        this.#cpuBatchSize <= 64,
      'CPU extinction batches must contain 1 through 64 sources',
    )
    this.#gpu = this.#cpu ? null : gpuColumns(capacity, this.#batchSize)
    this.#cpuColumns = this.#cpu ? cpuColumns(capacity) : null
    this.#buffers =
      this.#gpu === null
        ? [this.#cpuColumns!.output, this.#cpuColumns!.previous]
        : Object.values(this.#gpu)
    if (this.#cpu) {
      this.#extinction = null
      this.#compute = null
      return
    }
    this.#extinction = createStarExtinction(field, {}, options.kernel)
    const positions = storage(this.#gpu!.positions, 'vec4', capacity),
      versions = storage(this.#gpu!.versions, 'uint', capacity),
      pending = storage(this.#gpu!.pending, 'uint', this.#batchSize),
      reference = storage(this.#gpu!.reference, 'vec4', capacity),
      output = storage(this.transmission, 'vec4', capacity * 2),
      stamp = storage(this.#gpu!.stamp, 'uvec4', capacity)
    this.#compute = Fn(() => {
      If(instanceIndex.lessThan(this.#count), () => {
        const index = pending.element(instanceIndex).toVar(),
          source = positions.element(index).toVar(),
          version = versions.element(index).toVar()
        const metadata = stamp.element(index).toVar()
        const catalogued = source.w.greaterThan(0.5)
        const depth = vec3(0).toVar()
        If(catalogued.and(this.#atSol).not(), () => {
          depth.assign(
            this.#extinction!.opticalDepth(
              this.#origin,
              source.xyz.sub(this.#origin),
            ).negate(),
          )
          If(catalogued, () => {
            const saved = reference.element(index).toVar()
            If(metadata.z.notEqual(version), () => {
              const sol = vec3(starExtinctionOrigin(SUN_POSITION))
              saved.assign(
                vec4(
                  this.#extinction!.opticalDepth(sol, source.xyz.sub(sol)),
                  float(version),
                ),
              )
              reference.element(index).assign(saved)
              metadata.z.assign(version)
            })
            depth.addAssign(saved.rgb)
          })
        })
        const oldValue = output.element(index).toVar()
        const oldPrevious = output.element(index.add(capacity)).toVar()
        const alpha = this.#frame
          .sub(float(metadata.w))
          .add(1)
          .div(FADE_SUBMISSIONS)
          .clamp()
        const sameSource = metadata.y.equal(version)
        const calibratedAtSol = source.w
          .greaterThan(1.5)
          .and(metadata.x.notEqual(this.#generation))
        output
          .element(index.add(capacity))
          .assign(
            vec4(
              calibratedAtSol.select(
                vec3(1),
                sameSource.select(
                  displayedColumn(oldValue.rgb, oldPrevious, alpha),
                  vec3(0),
                ),
              ),
              float(sameSource.or(calibratedAtSol)),
            ),
          )
        const saturated = depth.x
          .max(depth.y)
          .max(depth.z)
          .greaterThan(STAR_EXTINCTION_MAX_LOG_GAIN)
        output
          .element(index)
          .assign(
            vec4(
              depth.min(STAR_EXTINCTION_MAX_LOG_GAIN).exp(),
              float(saturated),
            ),
          )
        stamp
          .element(index)
          .assign(
            uvec4(this.#generation, version, metadata.z, uint(this.#frame)),
          )
      })
    })().compute(this.#batchSize)
  }

  /** GPU readback for physical-column diagnostics. CPU columns are instance attributes. */
  get transmission(): StorageInstancedBufferAttribute {
    invariant(
      this.#gpu !== null,
      'CPU extinction has no GPU transmission buffer',
    )
    return this.#gpu.transmission
  }

  sample(index: Node<'uint'>): Node<'vec3'> {
    if (this.#cpu) {
      const value = instancedBufferAttribute<'vec4'>(
        this.#cpuColumns!.output,
        'vec4',
      )
      const previous = instancedBufferAttribute<'vec4'>(
        this.#cpuColumns!.previous,
        'vec4',
      )
      const alpha = this.#frame
        .sub(value.w)
        .add(1)
        .div(FADE_SUBMISSIONS)
        .clamp()
      return this.#active.select(
        value.w
          .lessThan(0)
          .select(
            value.rgb,
            value.w
              .greaterThan(0)
              .select(displayedColumn(value.rgb, previous, alpha), vec3(0)),
          ),
        vec3(0),
      )
    }
    const capacity = this.schedule.capacity
    const mapped = storage(this.#gpu!.mapping, 'uvec4', capacity).element(index)
    const slot = mapped.x
    const columns = storage(this.transmission, 'vec4', capacity * 2)
    const value = columns.element(slot)
    const previous = columns.element(slot.add(capacity))
    const version = mapped.y
    const stamp = storage(this.#gpu!.stamp, 'uvec4', capacity).element(slot)
    const valid = stamp.y.equal(version)
    const visibility = this.#frame
      .sub(float(stamp.w))
      .add(1)
      .div(FADE_SUBMISSIONS)
      .clamp()
    const catalogueAtSol = mapped.z
      .greaterThan(0)
      .and(this.#atSol)
      .or(mapped.w.greaterThan(0).and(stamp.x.notEqual(this.#generation)))
    return this.#active.select(
      catalogueAtSol.select(
        vec3(1),
        valid.select(displayedColumn(value.rgb, previous, visibility), vec3(0)),
      ),
      vec3(0),
    )
  }

  configure(
    selection: StarExtinctionSelection,
    observer: UniverseVector | null,
    field = this.#field,
  ): void {
    if (this.#disposed) return
    const inputsChanged =
      field !== this.#field ||
      selection.ids !== this.#selection?.ids ||
      selection.positions !== this.#selection?.positions ||
      selection.catalogued !== this.#selection?.catalogued
    if (field !== this.#field) {
      this.#field = field
      this.#extinction?.setField(field)
    }
    const previousOrigin = this.schedule.origin
    if (!this.schedule.configure(selection, observer, field)) return
    this.#generation.value = this.schedule.generation
    const origin = this.schedule.origin
    this.#active.value = origin !== null
    if (origin !== null) this.#origin.value.copy(starExtinctionOrigin(origin))
    this.#atSol.value =
      origin !== null && UV.distance(origin, SUN_POSITION) / PARSEC < 1e-6
    if (this.#cpuColumns !== null) {
      this.#selection = selection
      for (const [index, source] of this.schedule.selected.entries())
        this.#cpuColumns.instanceBySlot[source.slot] = index
      this.#writeCpu()
      return
    }
    if (inputsChanged || previousOrigin !== origin) {
      this.#selection = selection
      let sourceLo = this.schedule.capacity,
        sourceHi = -1
      let versionLo = this.schedule.capacity,
        versionHi = -1
      let mappingLo = this.schedule.capacity,
        mappingHi = -1
      const positions = this.#gpu!.positions.array,
        versions = this.#gpu!.versions.array,
        mapping = this.#gpu!.mapping.array
      const selected = this.schedule.selected
      for (let index = 0; index < selected.length; index++) {
        const source = selected[index]!,
          slot = source.slot,
          offset = slot * 4,
          mapped = index * 4
        const atSol = source.published === -1 ? 1 : 0
        const catalogued = source.catalogued ? 1 : 0
        const flag = catalogued + atSol
        if (versions[slot] !== source.version) {
          const p = starExtinctionOrigin(source.position)
          positions[offset] = p.x
          positions[offset + 1] = p.y
          positions[offset + 2] = p.z
          versions[slot] = source.version
          versionLo = Math.min(versionLo, slot)
          versionHi = Math.max(versionHi, slot)
          sourceLo = Math.min(sourceLo, slot)
          sourceHi = Math.max(sourceHi, slot)
          this.#sourceRecordsWritten++
        }
        if (positions[offset + 3] !== flag) {
          positions[offset + 3] = flag
          sourceLo = Math.min(sourceLo, slot)
          sourceHi = Math.max(sourceHi, slot)
        }
        if (
          mapping[mapped] !== slot ||
          mapping[mapped + 1] !== source.version ||
          mapping[mapped + 2] !== catalogued ||
          mapping[mapped + 3] !== atSol
        ) {
          mapping[mapped] = slot
          mapping[mapped + 1] = source.version
          mapping[mapped + 2] = catalogued
          mapping[mapped + 3] = atSol
          mappingLo = Math.min(mappingLo, index)
          mappingHi = Math.max(mappingHi, index)
          this.#mappingRecordsWritten++
        }
      }
      for (const [buffer, lo, hi, stride] of [
        [this.#gpu!.positions, sourceLo, sourceHi, 4],
        [this.#gpu!.versions, versionLo, versionHi, 1],
        [this.#gpu!.mapping, mappingLo, mappingHi, 4],
      ] as const) {
        if (hi < lo) continue
        buffer.addUpdateRange(lo * stride, (hi - lo + 1) * stride)
        buffer.needsUpdate = true
      }
    }
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#renderer = renderer
    if (this.#cpu) {
      this.#ready = true
      return Promise.resolve()
    }
    this.#warm ??= (async () => {
      this.#count.value = 0
      await renderer.computeAsync(this.#compute!)
      if (!this.#disposed) this.#ready = true
    })()
    return this.#warm
  }

  advance(renderer: WebGPURenderer): boolean {
    if (!this.#ready || this.#disposed) return false
    this.#frame.value++
    const batch = this.schedule.next(
      this.#cpu ? this.#cpuBatchSize : this.#batchSize,
    )
    if (batch === null) return false
    if (this.#cpu) {
      const origin = this.schedule.origin!
      for (const source of batch.sources) {
        let depth: readonly number[] = [0, 0, 0]
        if (!source.catalogued || !this.#atSol.value) {
          depth = integrateStarExtinction(
            this.#field,
            origin,
            source.position,
          ).opticalDepthRgb.map((value) => -value)
          if (source.catalogued) {
            source.reference ??= integrateStarExtinction(
              this.#field,
              SUN_POSITION,
              source.position,
            ).opticalDepthRgb
            depth = depth.map((value, c) => value + source.reference![c]!)
          }
        }
        if (depth.some((value) => value > STAR_EXTINCTION_MAX_LOG_GAIN))
          this.#saturated++
        const alpha = Math.max(
          0,
          Math.min(
            1,
            (this.#frame.value - (source.published ?? 0) + 1) /
              FADE_SUBMISSIONS,
          ),
        )
        source.previous = source.corrected?.map((value, c) =>
          source.published === -1 || alpha === 1
            ? value
            : source.previous === undefined
              ? value * alpha
              : Math.exp(
                  Math.log(Math.max(1e-35, source.previous[c]!)) * (1 - alpha) +
                    Math.log(Math.max(1e-35, value)) * alpha,
                ),
        ) as [number, number, number] | undefined
        source.corrected = depth.map((value) =>
          Math.exp(Math.min(value, STAR_EXTINCTION_MAX_LOG_GAIN)),
        ) as [number, number, number]
        source.published = this.#frame.value
      }
    } else {
      batch.sources.forEach((source, index) => {
        this.#gpu!.pending.array[index] = source.slot
      })
      this.#gpu!.pending.needsUpdate = true
      this.#count.value = batch.sources.length
      renderer.compute(this.#compute!)
      for (const source of batch.sources) source.published = this.#frame.value
    }
    this.schedule.complete(batch)
    this.#draws++
    if (this.#cpu) this.#writeCpu(batch.sources)
    return true
  }

  #writeCpu(sources = this.schedule.selected): void {
    sources.forEach((source) => {
      const index = this.#cpuColumns!.instanceBySlot[source.slot]!
      const valid = source.corrected !== undefined
      this.#cpuColumns!.output.addUpdateRange(index * 4, 4)
      this.#cpuColumns!.previous.addUpdateRange(index * 4, 4)
      this.#cpuColumns!.previous.array.set(
        source.previous === undefined ? [0, 0, 0, 0] : [...source.previous, 1],
        index * 4,
      )
      this.#cpuColumns!.output.array.set(
        valid ? [...source.corrected!, source.published!] : [0, 0, 0, 0],
        index * 4,
      )
    })
    this.#cpuColumns!.output.needsUpdate = true
    this.#cpuColumns!.previous.needsUpdate = true
  }

  get diagnostics() {
    return {
      ...this.schedule.diagnostics,
      ready: this.#ready && !this.#disposed,
      backend: this.#cpu ? 'cpu' : 'webgpu',
      batchSize: this.#cpu ? this.#cpuBatchSize : this.#batchSize,
      draws: this.#draws,
      sourceRecordsWritten: this.#sourceRecordsWritten,
      mappingRecordsWritten: this.#mappingRecordsWritten,
      radiusParsecs: STAR_EXTINCTION_CACHE_RADIUS_PARSECS,
      reference: 'catalogue-at-sol' as const,
      maxLogGain: STAR_EXTINCTION_MAX_LOG_GAIN,
      saturated: this.#cpu ? this.#saturated : null,
      saturationStoredOnGpu: !this.#cpu,
      bytes: this.#disposed
        ? 0
        : this.#buffers.reduce(
            (sum, buffer) => sum + buffer.array.byteLength,
            0,
          ),
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#ready = false
    this.#active.value = false
    this.schedule.dispose()
    this.#generation.value = this.schedule.generation
    this.#compute?.dispose()
    disposeAttributes(this.#renderer, this.#buffers)
    this.#renderer = null
  }
}
