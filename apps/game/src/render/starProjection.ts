import { invariant, LIGHT_YEAR } from '@inertialref/shared'
import {
  SECTOR_SIZE,
  UV,
  type Quat,
  type RenderOrigin,
  type UniverseVector,
  type Vec3,
} from '@inertialref/spatial'
import {
  STAR_SHELL_RADIUS,
  STAR_POSITION_QUANTUM,
  STAR_SUBCELLS,
  stellarIlluminance,
  stellarVisualIlluminance,
  writeStarCoordinates,
} from '@inertialref/rendering'
import {
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector3,
  Vector4,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  atomicMax,
  atomicStore,
  bitcast,
  cross,
  Fn,
  If,
  instanceIndex,
  int,
  float,
  log2,
  storage,
  uint,
  uniform,
  vec3,
} from 'three/tsl'

interface Sources {
  readonly positions: readonly UniverseVector[]
  readonly luminosities: readonly number[]
  readonly visualLuminosities?: readonly number[]
  readonly ids?: readonly string[]
}

function coordinates(capacity: number) {
  const cells = new StorageInstancedBufferAttribute(
    new Int32Array(capacity * 4),
    4,
  )
  const offsets = new StorageInstancedBufferAttribute(
    new Float32Array(capacity * 4),
    4,
  )
  const subcells = new StorageInstancedBufferAttribute(
    new Int32Array(capacity * 4),
    4,
  )
  return {
    start: 0,
    cells,
    offsets,
    subcells,
    cellNode: storage(cells, 'ivec4', capacity).toReadOnly(),
    offsetNode: storage(offsets, 'vec4', capacity).toReadOnly(),
    subcellNode: storage(subcells, 'ivec4', capacity).toReadOnly(),
  }
}

function observer() {
  return {
    cells: uniform(new Vector3(), 'ivec3'),
    offsets: uniform(new Vector3()),
    subcells: uniform(new Vector3(), 'ivec3'),
    orientation: uniform(new Vector4(0, 0, 0, 1)),
    eye: uniform(new Vector3()),
  }
}

type Observer = ReturnType<typeof observer>
type Coordinates = ReturnType<typeof coordinates>

function writeObserver(
  target: Observer,
  position: UniverseVector,
  orientation: Quat,
  eye: Vec3,
): void {
  target.cells.value.set(position.sx, position.sy, position.sz)
  target.subcells.value.set(
    Math.floor(position.ox / STAR_POSITION_QUANTUM),
    Math.floor(position.oy / STAR_POSITION_QUANTUM),
    Math.floor(position.oz / STAR_POSITION_QUANTUM),
  )
  target.offsets.value.set(
    position.ox / STAR_POSITION_QUANTUM - target.subcells.value.x,
    position.oy / STAR_POSITION_QUANTUM - target.subcells.value.y,
    position.oz / STAR_POSITION_QUANTUM - target.subcells.value.z,
  )
  target.orientation.value.set(
    -orientation.x,
    -orientation.y,
    -orientation.z,
    orientation.w,
  )
  target.eye.value.set(eye.x, eye.y, eye.z)
}

/** Split sector subtraction avoids signed overflow between opposite galactic edges. */
function displacement(
  source: Coordinates,
  pose: Observer,
  index: Node<'uint'>,
) {
  index = index.add(source.start)
  const cells = source.cellNode.element(index).xyz
  const subcells = source.subcellNode.element(index).xyz.sub(pose.subcells)
  const axis = (key: 'x' | 'y' | 'z') => {
    const local = subcells[key]
    const carry = int(
      local
        .greaterThan(STAR_SUBCELLS / 2)
        .select(
          int(1),
          local.lessThan(-STAR_SUBCELLS / 2).select(int(-1), int(0)),
        ),
    )
    const balanced = local.sub(carry.mul(STAR_SUBCELLS))
    const sector = cells[key]
      .bitAnd(65535)
      .sub(pose.cells[key].bitAnd(65535))
      .add(carry)
    const sectorCarry = int(
      sector
        .greaterThan(32767)
        .select(int(1), sector.lessThan(-32768).select(int(-1), int(0))),
    )
    const high = cells[key]
      .shiftRight(16)
      .sub(pose.cells[key].shiftRight(16))
      .add(sectorCarry)
    const low = sector.sub(sectorCarry.mul(65536))
    return float(high)
      .mul(65536)
      .add(float(low))
      .add(
        float(balanced)
          .add(source.offsetNode.element(index)[key].sub(pose.offsets[key]))
          .div(STAR_SUBCELLS),
      )
  }
  return vec3(axis('x'), axis('y'), axis('z'))
}

function shell(offset: Node<'vec3'>, pose: Observer) {
  const distance = offset.length()
  const direction = distance
    .greaterThan(0)
    .select(offset.div(distance.max(1e-30)), vec3(0, 0, -1))
  const turn = cross(pose.orientation.xyz, direction).mul(2)
  return direction
    .add(turn.mul(pose.orientation.w))
    .add(cross(pose.orientation.xyz, turn))
    .mul(STAR_SHELL_RADIUS)
    .add(pose.eye)
}

/** The buffers change with selection; observer motion changes only these uniforms. */
export function createStarProjection(
  capacity: number,
  options: { compute?: boolean; visual?: boolean } = {},
) {
  const compute = options.compute ?? true
  const visual = options.visual ?? false
  const current = coordinates(compute ? capacity * 2 : capacity)
  // WebGL emulates storage as instance attributes, so previous records need
  // their own attribute. WebGPU shares three bindings across both poses.
  const previous = compute
    ? { ...current, start: capacity }
    : coordinates(capacity)
  const allocations = compute ? [current] : [current, previous]
  const pose = observer()
  const previousPose = observer()
  const previousSources = uniform(0)
  const absoluteVisibility = uniform(0)
  const illuminanceUnit = uniform(stellarIlluminance(1, SECTOR_SIZE))
  const count = uniform(0, 'uint')
  const maximum =
    visual || !compute
      ? null
      : new StorageBufferAttribute(new Uint32Array(1), 1)
  const maximumWrite =
    maximum === null ? null : storage(maximum, 'uint', 1).toAtomic()
  const fallbackMaximum = uniform(0)
  const maximumRead =
    maximum === null ? null : storage(maximum, 'uint', 1).toReadOnly()
  const clear =
    maximumWrite === null
      ? null
      : Fn(() => {
          atomicStore(maximumWrite.element(0), uint(0))
        })().compute(1)
  const flux = (index: Node<'uint'>) =>
    Fn(() => {
      const offset = displacement(current, pose, index).toVar()
      const squared = offset.dot(offset)
      return squared
        .greaterThan(0)
        .select(
          current.offsetNode
            .element(index)
            .w.div(squared.max((LIGHT_YEAR / SECTOR_SIZE) ** 2)),
          float(0),
        )
    })()
  const reduce =
    maximumWrite === null
      ? null
      : Fn(() => {
          If(instanceIndex.lessThan(count), () => {
            atomicMax(
              maximumWrite.element(0),
              bitcast(flux(instanceIndex), 'uint'),
            )
          })
        })().compute(capacity)
  const offset = displacement(current, pose, instanceIndex)
  const previousOffset = previousSources
    .greaterThan(0.5)
    .and(current.cellNode.element(instanceIndex).w.greaterThan(0))
    .select(
      displacement(previous, previousPose, instanceIndex),
      displacement(current, previousPose, instanceIndex),
    )
  const distanceSquared = offset.dot(offset).max((1 / SECTOR_SIZE) ** 2)
  const luminosity = current.offsetNode.element(instanceIndex).w
  const illuminance = luminosity.mul(illuminanceUnit).div(distanceSquared)
  const brightest =
    maximumRead !== null
      ? (bitcast(maximumRead.element(0), 'float') as unknown as Node<'float'>)
      : fallbackMaximum
  const visibility = visual
    ? float(0)
    : log2(flux(instanceIndex).max(1e-30).div(brightest.max(1e-30)))
        .mul(2.5 / (17 * Math.log2(10)))
        .add(1)
        .clamp(0, 1)
  let held: Sources | null = null
  let heldObserver: {
    origin: RenderOrigin
    position: UniverseVector
    eye: Vec3
  } | null = null
  let changed = false
  let uploads = 0
  let reductions = 0
  let disposed = false
  let normalized = false

  return {
    visual,
    current,
    previous,
    pose,
    previousPose,
    offset,
    point: Fn(() => shell(offset.toVar(), pose))(),
    previousPoint: Fn(() => shell(previousOffset.toVar(), previousPose))(),
    illuminance,
    visibility,
    absoluteVisibility,
    distance: offset.length().mul(SECTOR_SIZE),
    drawable: offset.dot(offset).greaterThan(0).select(1, 0),
    clear,
    reduce,
    maximum,
    get diagnostics() {
      return {
        count: count.value,
        uploads,
        reductions,
        bytes: capacity * 4 * 4 * 6 + (maximum?.array.byteLength ?? 0),
      }
    },
    upload(sources: Sources): void {
      if (disposed || sources === held) return
      invariant(
        !visual || sources.visualLuminosities !== undefined,
        'A visual projection requires V luminosities',
      )
      const priorCount = count.value
      let old: Map<string, UniverseVector> | null = null
      count.value = Math.min(capacity, sources.positions.length)
      absoluteVisibility.value =
        sources.visualLuminosities === undefined ? 0 : 1
      illuminanceUnit.value =
        sources.visualLuminosities === undefined
          ? stellarIlluminance(1, SECTOR_SIZE)
          : stellarVisualIlluminance(1, SECTOR_SIZE)
      let first = count.value
      let last = -1
      let previousFirst = count.value
      let previousLast = -1
      for (let i = 0; i < count.value; i++) {
        const position = sources.positions[i]!
        const id = sources.ids?.[i]
        let before: UniverseVector | undefined
        if (id !== undefined && held?.ids !== undefined) {
          if (held.ids[i] === id) before = held.positions[i]
          else {
            // Stable ordering needs no identity index. Build one only when a
            // replacement or reorder actually asks for a different old slot.
            if (old === null) {
              old = new Map()
              for (let j = 0; j < priorCount; j++)
                old.set(held.ids[j]!, held.positions[j]!)
            }
            before = old.get(id)
          }
        }
        const moved = before !== undefined && !UV.equals(before, position)
        const luminosity =
          sources.visualLuminosities?.[i] ?? sources.luminosities[i] ?? 1
        const oldPosition = held?.positions[i]
        const oldLuminosity =
          held?.visualLuminosities?.[i] ?? held?.luminosities[i] ?? 1
        if (
          i >= priorCount ||
          oldPosition === undefined ||
          !UV.equals(oldPosition, position) ||
          oldLuminosity !== luminosity ||
          current.cells.array[i * 4 + 3] !== Number(moved)
        ) {
          writeStarCoordinates(
            position,
            current.cells.array as Int32Array,
            current.offsets.array as Float32Array,
            current.subcells.array as Int32Array,
            i,
          )
          current.cells.array[i * 4 + 3] = Number(moved)
          current.offsets.array[i * 4 + 3] = luminosity
          first = Math.min(first, i)
          last = i
        }
        // Reordered and newly admitted static sources share their current
        // coordinates with the previous observer. Only actual stellar motion
        // needs a second packed position and its corresponding upload.
        if (moved && before !== undefined) {
          writeStarCoordinates(
            before,
            previous.cells.array as Int32Array,
            previous.offsets.array as Float32Array,
            previous.subcells.array as Int32Array,
            i + previous.start,
          )
          previousFirst = Math.min(previousFirst, i)
          previousLast = i
        }
      }
      const dirty = (coordinates: Coordinates, first: number, last: number) => {
        if (first > last) return
        for (const buffer of [
          coordinates.cells,
          coordinates.offsets,
          coordinates.subcells,
        ]) {
          buffer.addUpdateRange(
            (coordinates.start + first) * 4,
            (last - first + 1) * 4,
          )
          buffer.needsUpdate = true
        }
      }
      dirty(current, first, last)
      dirty(previous, previousFirst, previousLast)
      held = sources
      changed = true
      uploads++
    },
    update(
      renderer: WebGPURenderer,
      origin: RenderOrigin,
      position: UniverseVector,
      eye: Vec3,
      integrated: boolean,
    ): void {
      if (disposed) return
      const before = heldObserver ?? { origin, position, eye }
      writeObserver(
        previousPose,
        before.position,
        before.origin.orientation,
        before.eye,
      )
      writeObserver(pose, position, origin.orientation, eye)
      previousSources.value = changed ? 1 : 0
      if (
        changed ||
        heldObserver === null ||
        !UV.equals(position, before.position)
      )
        normalized = false
      if (
        integrated &&
        absoluteVisibility.value < 0.5 &&
        !normalized &&
        count.value > 0
      ) {
        if (compute) {
          renderer.compute(clear!)
          renderer.compute(reduce!, count.value)
          reductions++
        } else if (changed || heldObserver === null) {
          let maximum = 0
          for (let i = 0; i < count.value; i++) {
            const distance = UV.distance(held!.positions[i]!, position)
            if (distance > 0)
              maximum = Math.max(
                maximum,
                (held!.luminosities[i] ?? 1) /
                  (Math.max(distance, LIGHT_YEAR) / SECTOR_SIZE) ** 2,
              )
          }
          fallbackMaximum.value = maximum
        }
        normalized = true
      }
      heldObserver = { origin, position, eye }
      changed = false
    },
    dispose(): void {
      disposed = true
      clear?.dispose()
      reduce?.dispose()
      maximum?.dispose()
      for (const buffers of allocations)
        for (const buffer of [buffers.cells, buffers.offsets, buffers.subcells])
          buffer.dispose()
    },
  }
}

export type StarProjection = ReturnType<typeof createStarProjection>
