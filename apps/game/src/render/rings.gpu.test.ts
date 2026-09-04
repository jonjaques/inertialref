import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  Vector3,
} from 'three/webgpu'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { createRingMaterial } from './planet.ts'
import { proceduralRingStrip } from './proceduralRings.ts'

/*
 * A ring system, drawn and read back.
 *
 * Two claims are worth a real adapter. The first is photometric and
 * published: an optically thin ring is far brighter seen *against* the star
 * than lit from the camera's side, which is why Voyager found Jupiter's from
 * behind and why Cassini's backlit portraits look nothing like its lit ones —
 * and the crossover is near unit optical depth. The material gets there from
 * single scattering through a slab, with no term written for the purpose, so
 * the assertion is that it still does.
 *
 * The second is about variety. `proceduralRingStrip` draws a generated
 * system's architecture from its seed rather than from the host's class, and
 * the point of that change is a spread — measured here as the range of mean
 * brightness over twelve seeds, which was a single repeated value before.
 * [The rings plan](../../../../design/plans/rings.md) carries the numbers and
 * what was declined.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

/**
 * A flat annulus in XZ, which is the layout `createRingMaterial` reads.
 *
 * Its own geometry rather than Three's `RingGeometry`, which lies in XY: the
 * material takes the radial coordinate from `positionLocal.xz`, so a ring in
 * the wrong plane samples the strip along a degenerate axis and comes back
 * uniform — a picture that looks plausible and measures nothing.
 */
function annulus(): BufferGeometry {
  const segments = 128
  const inner = 0.25
  const positions = new Float32Array((segments + 1) * 2 * 3)
  const indices: number[] = []
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    const x = Math.cos(angle)
    const z = Math.sin(angle)
    const base = i * 6
    positions[base] = x * inner
    positions[base + 2] = z * inner
    positions[base + 3] = x
    positions[base + 5] = z
    if (i < segments) {
      const v = i * 2
      indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  const normals = new Float32Array(positions.length)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  return geometry
}

/**
 * Mean brightness over the whole annulus, seen face-on from +Y with the star
 * at `sunY`: +1 lights the face the camera is on, −1 puts the ring between
 * the camera and the star.
 *
 * The mean over the annulus rather than a sample along one radius, because a
 * thread system is mostly empty and the question is how much light the
 * system puts in the frame — which a point sample of one radius cannot say.
 */
async function ringValue(
  opticalDepth: number,
  sunY: number,
  strip?: { readonly kind: string; readonly address: string },
  size = 64,
): Promise<number> {
  const ring = createRingMaterial()
  if (strip !== undefined) {
    ring.setTexture(proceduralRingStrip(strip.kind, strip.address))
  }
  ring.opticalDepth.value = opticalDepth
  ring.innerFraction.value = 0.25
  ring.sunDirection.value.set(0, sunY, 0)
  // No body to eclipse the ring: the cylinder test would otherwise put half
  // of it in a shadow this measurement is not about.
  ring.bodyRadius.value = 0
  ring.centre.value.set(0, 0, 0)
  const mesh = new Mesh(annulus(), ring.material)
  const scene = new Scene()
  scene.add(mesh)
  const camera = new OrthographicCamera(-1.1, 1.1, 1.1, -1.1, 0.1, 10)
  camera.position.set(0, 3, 0)
  camera.lookAt(new Vector3(0, 0, 0))
  camera.updateMatrixWorld()
  scene.updateMatrixWorld(true)
  const pixels = await gpu.draw(scene, camera, {
    float: true,
    width: size,
    height: size,
  })
  let sum = 0
  let count = 0
  const half = size / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - half) / half
      const dy = (y + 0.5 - half) / half
      const radius = Math.hypot(dx, dy)
      // Inside the hole and outside the rim contribute nothing but zeros.
      if (radius < 0.27 || radius > 0.98) continue
      const [red, green, blue] = pixels.at(x, y)
      sum += (red + green + blue) / 3
      count += 1
    }
  }
  return sum / Math.max(count, 1)
}

describe('a ring against phase', () => {
  it('blazes backlit while it is thin, and stops once it is thick', async () => {
    // A dust band, measured at 52× backlit. Ten is the bound, loose because
    // the figure is a property of the scattering model rather than a
    // constant anyone chose.
    const thinLit = await ringValue(0.02, 1)
    const thinBack = await ringValue(0.02, -1)
    expect(thinBack / thinLit).toBeGreaterThan(10)

    // A dense one is a reflector: past unit depth the light no longer gets
    // through, so the lit face is the bright one.
    const thickLit = await ringValue(1.1, 1)
    const thickBack = await ringValue(1.1, -1)
    expect(thickBack).toBeLessThan(thickLit)

    // And the crossover sits near unit depth, which is where the published
    // behavior puts it: still brighter backlit at 0.7, no longer at 1.1.
    expect(await ringValue(0.7, -1)).toBeGreaterThan(await ringValue(0.7, 1))
  })

  it('draws a different ring system for every seed', async () => {
    const rows: string[] = []
    for (const kind of ['ice-giant', 'gas-giant']) {
      const values: number[] = []
      for (let i = 0; i < 12; i += 1) {
        values.push(
          await ringValue(0.7, 1, { kind, address: `b:probe${i}` }, 256),
        )
      }
      values.sort((a, b) => a - b)
      const low = values[0] as number
      const median = values[6] as number
      const high = values[11] as number
      rows.push(
        `${kind}  min ${low.toExponential(2)}  median ${median.toExponential(2)}  max ${high.toExponential(2)}`,
      )
      /*
       * A decade between the faintest and the brightest of twelve. While the
       * architecture came from the host's class, every body of a class
       * produced the identical strip and this ratio was exactly one — which
       * is the regression worth catching, so the bound is loose and the
       * claim is only that these are not all the same ring.
       */
      expect(high / Math.max(low, 1e-9)).toBeGreaterThan(10)
      /*
       * And the typical one is worth looking at. The fixed ice-giant strip
       * drew 3.8e-4 over the annulus, which is nothing; the median is 4.5e-3
       * for an ice giant and 8.2e-3 for a gas giant now, and a thousandth is
       * the floor between the old value and either.
       */
      expect(median).toBeGreaterThan(1e-3)
    }
    console.log(rows.join('\n'))
  })
})
