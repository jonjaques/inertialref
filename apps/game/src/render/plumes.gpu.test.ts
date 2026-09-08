import { afterAll, beforeAll, expect, it } from 'vitest'
import { SURFACE_LUMINANCE, type ThrusterLayout } from '@inertialref/rendering'
import {
  Mesh,
  MeshBasicNodeMaterial,
  NodeUpdateType,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three/webgpu'
import { pass, vec3 } from 'three/tsl'
import { openGpu, type GpuSession, type Pixels } from './gpuHarness.ts'
import { createThrusterPlumes } from './plumes.ts'
import { setSceneExposure } from './radiance.ts'
import { sensorMrt } from './sensorMrt.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 64)
})
afterAll(() => gpu.dispose())

function brightest(pixels: Pixels): [number, number] {
  let best: [number, number] = [0, 0]
  let light = 0
  for (let y = 0; y < pixels.height; y += 1)
    for (let x = 0; x < pixels.width; x += 1) {
      const [r, g, b] = pixels.at(x, y)
      if (r + g + b > light) {
        light = r + g + b
        best = [x, y]
      }
    }
  return best
}

it.each(['rcs', 'pod', 'drive shell', 'drive disk'] as const)(
  'exposes the %s plume as light and preserves the surface underneath',
  async (kind) => {
    const camera = new PerspectiveCamera(65, 1, 0.01, 100)
    camera.position.z = 3
    const scene = new Scene()
    const surface = new Mesh(
      new PlaneGeometry(8, 8),
      new MeshBasicNodeMaterial(),
    )
    surface.material.colorNode = vec3(0)
    scene.add(surface)
    const mouth = { position: { x: 0, y: 0, z: 1 }, radius: 0.12 }
    const layout: ThrusterLayout =
      kind === 'rcs' || kind === 'pod'
        ? {
            nozzles: [{ ...mouth, exhaust: { x: 0, y: 0, z: 1 }, kind }],
            drive: null,
          }
        : { nozzles: [], drive: mouth }
    const plumes = createThrusterPlumes(layout)
    plumes.update(new Float32Array([1]), 1, 1)
    // Each production material must supply both radiance and the overlay flag;
    // a lit disk cannot cover for a shell that draws black, or the reverse.
    plumes.group.children.forEach((child, index) => {
      child.visible = index === (kind === 'drive disk' ? 1 : 0)
    })
    scene.add(plumes.group)
    const scenePass = pass(scene, camera)
    scenePass.updateBeforeType = NodeUpdateType.RENDER
    scenePass.setMRT(sensorMrt())
    const output = scenePass.getTextureNode('output')
    const motion = scenePass.getTextureNode('motion')
    try {
      setSceneExposure(gpu.renderer, 1 / SURFACE_LUMINANCE)
      const bright = await gpu.drawGraph(output, { float: true })
      const pixel = brightest(bright)
      const full = bright.at(...pixel)
      for (const channel of [0, 1, 2] as const)
        expect(full[channel]).toBeGreaterThan(0.1)

      setSceneExposure(gpu.renderer, 0.25 / SURFACE_LUMINANCE)
      const dim = await gpu.drawGraph(output, { float: true })
      const reduced = dim.at(...pixel)
      for (const channel of [0, 1, 2] as const)
        expect.soft(reduced[channel] / full[channel]).toBeCloseTo(0.25, 3)

      const depth = await gpu.drawGraph(motion, { float: true })
      // The plume is nearer than the three-meter surface. Test where it emits
      // light, as well as outside its footprint, so an invisible draw cannot pass.
      expect.soft(depth.at(...pixel)[2]).toBeCloseTo(1 / 3, 3)
      expect.soft(depth.at(2, 2)[2]).toBeCloseTo(1 / 3, 3)
      expect.soft(depth.at(...pixel)[0]).toBeCloseTo(0, 5)
      expect.soft(depth.at(...pixel)[1]).toBeCloseTo(0, 5)
    } finally {
      setSceneExposure(gpu.renderer, null)
      scenePass.dispose()
      plumes.dispose()
      surface.geometry.dispose()
      surface.material.dispose()
    }
  },
)
