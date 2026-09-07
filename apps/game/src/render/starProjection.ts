import { LIGHT_YEAR } from '@inertialref/shared'
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
  writeStarCoordinates,
} from '@inertialref/rendering'
import {
  StorageBufferAttribute,
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
  readonly ids?: readonly string[]
}

function coordinates(capacity: number) {
  const cells = new StorageBufferAttribute(new Int32Array(capacity * 4), 4)
  const offsets = new StorageBufferAttribute(new Float32Array(capacity * 4), 4)
  const subcells = new StorageBufferAttribute(new Int32Array(capacity * 4), 4)
  return {
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
export function createStarProjection(capacity: number) {
  const current = coordinates(capacity)
  const previous = coordinates(capacity)
  const pose = observer()
  const previousPose = observer()
  const previousSources = uniform(0)
  const count = uniform(0, 'uint')
  const maximum = new StorageBufferAttribute(new Uint32Array(1), 1)
  const maximumWrite = storage(maximum, 'uint', 1).toAtomic()
  const maximumRead = storage(maximum, 'uint', 1).toReadOnly()
  const clear = Fn(() => {
    atomicStore(maximumWrite.element(0), uint(0))
  })().compute(1)
  const flux = (index: Node<'uint'>) => {
    const distance = displacement(current, pose, index)
      .length()
      .max(LIGHT_YEAR / SECTOR_SIZE)
    return displacement(current, pose, index)
      .dot(displacement(current, pose, index))
      .greaterThan(0)
      .select(
        current.offsetNode.element(index).w.div(distance.mul(distance)),
        float(0),
      )
  }
  const reduce = Fn(() => {
    If(instanceIndex.lessThan(count), () => {
      atomicMax(maximumWrite.element(0), bitcast(flux(instanceIndex), 'uint'))
    })
  })().compute(capacity)
  const offset = displacement(current, pose, instanceIndex)
  const previousOffset = previousSources
    .greaterThan(0.5)
    .select(
      displacement(previous, previousPose, instanceIndex),
      displacement(current, previousPose, instanceIndex),
    )
  const distanceSquared = offset.dot(offset).max((1 / SECTOR_SIZE) ** 2)
  const luminosity = current.offsetNode.element(instanceIndex).w
  const illuminance = luminosity
    .mul(stellarIlluminance(1, SECTOR_SIZE))
    .div(distanceSquared)
  const brightest = bitcast(
    maximumRead.element(0),
    'float',
  ) as unknown as Node<'float'>
  const visibility = log2(
    flux(instanceIndex).max(1e-30).div(brightest.max(1e-30)),
  )
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
    current,
    previous,
    pose,
    previousPose,
    offset,
    point: Fn(() => shell(offset.toVar(), pose))(),
    previousPoint: Fn(() => shell(previousOffset.toVar(), previousPose))(),
    illuminance,
    visibility,
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
        bytes: capacity * 4 * 4 * 6 + 4,
      }
    },
    upload(sources: Sources): void {
      if (disposed || sources === held) return
      const old = new Map(held?.ids?.map((id, i) => [id, held!.positions[i]!]))
      count.value = Math.min(capacity, sources.positions.length)
      for (let i = 0; i < count.value; i++) {
        const position = sources.positions[i]!
        const before = old.get(sources.ids?.[i] ?? '') ?? position
        writeStarCoordinates(
          position,
          current.cells.array as Int32Array,
          current.offsets.array as Float32Array,
          current.subcells.array as Int32Array,
          i,
        )
        writeStarCoordinates(
          before,
          previous.cells.array as Int32Array,
          previous.offsets.array as Float32Array,
          previous.subcells.array as Int32Array,
          i,
        )
        current.offsets.array[i * 4 + 3] = sources.luminosities[i] ?? 1
      }
      for (const buffers of [current, previous])
        for (const buffer of [buffers.cells, buffers.offsets, buffers.subcells])
          buffer.needsUpdate = true
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
      if (integrated && !normalized && count.value > 0) {
        renderer.compute(clear)
        renderer.compute(reduce, count.value)
        reductions++
        normalized = true
      }
      heldObserver = { origin, position, eye }
      changed = false
    },
    dispose(): void {
      disposed = true
      clear.dispose()
      reduce.dispose()
      maximum.dispose()
      for (const buffers of [current, previous])
        for (const buffer of [buffers.cells, buffers.offsets, buffers.subcells])
          buffer.dispose()
    },
  }
}

export type StarProjection = ReturnType<typeof createStarProjection>
