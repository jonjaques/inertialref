import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
} from 'three/webgpu'
import { modelNear } from './modelNear.ts'

/*
 * The click test a drawn spacecraft takes, against geometry whose answer is
 * known: two wings with a gap between them, a plank that runs behind the eye,
 * and the quantized positions the shipped models carry.
 */

const SIZE = { width: 1600, height: 900 }

function camera(from: Vector3, at = new Vector3()): PerspectiveCamera {
  const lens = new PerspectiveCamera(65, SIZE.width / SIZE.height, 0.05, 1e10)
  lens.position.copy(from)
  lens.lookAt(at)
  lens.updateMatrixWorld(true)
  return lens
}

/** Where a point lands, in the CSS pixels a click arrives in. */
function pixel(point: Vector3, lens: PerspectiveCamera) {
  const ndc = point.clone().project(lens)
  return {
    x: (ndc.x * 0.5 + 0.5) * SIZE.width,
    y: (0.5 - ndc.y * 0.5) * SIZE.height,
  }
}

/** Several boxes as one geometry, as the shipped models batch by material. */
function batched(...parts: BufferGeometry[]): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  for (const part of parts) {
    const base = positions.length / 3
    const position = part.getAttribute('position')
    for (let i = 0; i < position.count; i += 1)
      positions.push(position.getX(i), position.getY(i), position.getZ(i))
    for (const index of part.index!.array) indices.push(base + index)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(positions), 3),
  )
  geometry.setIndex(indices)
  return geometry
}

/**
 * Two 40 m wings, face on to +Z, with 10 m of nothing between them, in one
 * mesh: its bounding sphere is centered on the gap, as the station's is.
 */
const wingGeometry = (): BufferGeometry =>
  batched(
    new BoxGeometry(40, 12, 0.2).translate(-25, 0, 0),
    new BoxGeometry(40, 12, 0.2).translate(25, 0, 0),
  )

function wings(): Group {
  const root = new Group()
  // Double-sided, as every material on the ISS is, so the raycaster below
  // counts a wing from behind.
  root.add(
    new Mesh(wingGeometry(), new MeshBasicMaterial({ side: DoubleSide })),
  )
  root.updateMatrixWorld(true)
  return root
}

describe('a click on a drawn model', () => {
  it('is tested against the triangles, not the sphere around them', () => {
    const model = wings()
    const lens = camera(new Vector3(0, 0, 200))
    // The gap is 35 px across from 200 m, and its middle is the middle of
    // the model's bounding sphere: inside the circle, and nothing there.
    const gap = pixel(new Vector3(0, 0, 0), lens)
    expect(modelNear(model, lens, gap, SIZE, 8)).toBe(false)
    expect(
      modelNear(model, lens, pixel(new Vector3(25, 0, 0), lens), SIZE, 0),
    ).toBe(true)
    // Five pixels into the gap from a wing's inner edge: off it, and inside
    // the reach a truss needs.
    const edge = pixel(new Vector3(5, 0, 0.1), lens)
    const beside = { x: edge.x - 5, y: edge.y }
    expect(modelNear(model, lens, beside, SIZE, 0)).toBe(false)
    expect(modelNear(model, lens, beside, SIZE, 8)).toBe(true)
    expect(modelNear(model, lens, { x: edge.x - 12, y: edge.y }, SIZE, 8)).toBe(
      false,
    )
  })

  it('clips a triangle that reaches behind the eye', () => {
    // A plank under the eye from 100 m behind to 100 m ahead. Projected whole,
    // its far half goes through infinity and lands above the horizon, upside
    // down; clipped, only the ground ahead is on screen.
    const plank = new Mesh(new BoxGeometry(1, 0.2, 200))
    const root = new Group()
    root.add(plank)
    root.updateMatrixWorld(true)
    const lens = camera(new Vector3(0, 2, 0), new Vector3(0, 2, -100))
    const middle = { x: SIZE.width / 2, y: SIZE.height / 2 }
    expect(
      modelNear(root, lens, { x: middle.x, y: middle.y + 120 }, SIZE, 0),
    ).toBe(true)
    expect(
      modelNear(root, lens, { x: middle.x, y: middle.y - 120 }, SIZE, 8),
    ).toBe(false)
  })

  it('reads quantized positions through the transform that dequantizes them', () => {
    // KHR_mesh_quantization's form: 16-bit snorm in a stride of four, under
    // a node scale back to meters. The same wings as floats answer the same.
    const box = wingGeometry()
    const floats = box.getAttribute('position')
    const shorts = new Int16Array(floats.count * 4)
    for (let i = 0; i < floats.count; i += 1) {
      shorts[i * 4] = Math.round((floats.getX(i) / 45) * 32767)
      shorts[i * 4 + 1] = Math.round((floats.getY(i) / 45) * 32767)
      shorts[i * 4 + 2] = Math.round((floats.getZ(i) / 45) * 32767)
    }
    const quantized = new BufferGeometry()
    quantized.setAttribute(
      'position',
      new InterleavedBufferAttribute(
        new InterleavedBuffer(shorts, 4),
        3,
        0,
        true,
      ),
    )
    quantized.setIndex(
      new BufferAttribute(Uint16Array.from(box.index!.array), 1),
    )
    const mesh = new Mesh(quantized)
    mesh.scale.setScalar(45)
    const root = new Group()
    root.add(mesh)
    root.updateMatrixWorld(true)
    const reference = wings()
    const lens = camera(new Vector3(30, 20, 150))
    let near = 0
    for (let x = 0; x <= SIZE.width; x += 20)
      for (let y = 0; y <= SIZE.height; y += 20) {
        const expected = modelNear(reference, lens, { x, y }, SIZE, 3)
        if (expected) near += 1
        expect(modelNear(root, lens, { x, y }, SIZE, 3)).toBe(expected)
      }
    // The wings cover 19,700 px² from here, which is 55 of the points.
    expect(near).toBeGreaterThan(30)
  })

  it('agrees with an exact ray at zero reach, from outside and from inside', () => {
    // The ray is three's own, through the same pixel. A grid rather than a
    // random draw, so a pixel landing on an edge is a fixed fact of the test
    // and not a flake.
    const model = wings()
    model.add(
      new Mesh(
        new BoxGeometry(4, 4, 30),
        new MeshBasicMaterial({ side: DoubleSide }),
      ),
    )
    model.updateMatrixWorld(true)
    const raycaster = new Raycaster()
    const poses = [
      camera(new Vector3(40, 30, 120)),
      camera(new Vector3(-70, -20, 60), new Vector3(10, 0, 0)),
      // Inside the sphere, over the body and between the wings, looking
      // along one: the body's top runs from behind the eye to ahead of it.
      camera(new Vector3(0, 3, 3), new Vector3(60, 0, 0)),
    ]
    let hits = 0
    for (const lens of poses)
      for (let x = 13; x < SIZE.width; x += 41)
        for (let y = 7; y < SIZE.height; y += 37) {
          raycaster.setFromCamera(
            new Vector2((x / SIZE.width) * 2 - 1, 1 - (y / SIZE.height) * 2),
            lens,
          )
          const ray = raycaster.intersectObject(model, true).length > 0
          if (ray) hits += 1
          expect(modelNear(model, lens, { x, y }, SIZE, 0)).toBe(ray)
        }
    // And the grid saw the model and saw past it, so the agreement is about
    // something.
    expect(hits).toBeGreaterThan(100)
    expect(hits).toBeLessThan(poses.length * 39 * 25 - 100)
  })

  it('finds any point of a triangle in front of the eye where it projects', () => {
    const lens = camera(new Vector3(0, 0, 0), new Vector3(0, 0, -1))
    const coordinate = fc.double({ min: -30, max: 30, noNaN: true })
    const depth = fc.double({ min: -200, max: -1, noNaN: true })
    const corner = fc.tuple(coordinate, coordinate, depth)
    fc.assert(
      fc.property(
        corner,
        corner,
        corner,
        fc.double({ min: 0.05, max: 0.9, noNaN: true }),
        fc.double({ min: 0.05, max: 0.9, noNaN: true }),
        (a, b, c, u, v) => {
          fc.pre(u + v <= 0.95)
          const geometry = new BufferGeometry()
          geometry.setAttribute(
            'position',
            new BufferAttribute(new Float32Array([...a, ...b, ...c]), 3),
          )
          const root = new Group()
          root.add(new Mesh(geometry))
          root.updateMatrixWorld(true)
          const at = new Vector3(...a)
            .multiplyScalar(1 - u - v)
            .add(new Vector3(...b).multiplyScalar(u))
            .add(new Vector3(...c).multiplyScalar(v))
          const point = pixel(at, lens)
          // A triangle seen edge-on has no inside, and a pixel on its line is
          // on its edge: a reach of a hundredth covers the float32 rounding.
          return modelNear(root, lens, point, SIZE, 0.01)
        },
      ),
      { numRuns: 300 },
    )
  })
})
