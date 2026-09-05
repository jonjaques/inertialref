import { afterAll, beforeAll, expect, it } from 'vitest'
import { PerspectiveCamera, Scene } from 'three/webgpu'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { Quaternion as Q, UV, vec3 } from '@inertialref/spatial'
import { createGalaxyField, integrateGalaxyRay } from '@inertialref/universe'
import {
  GALAXY_LUMINOUS_EFFICACY,
  GALAXY_VIEWS,
  SURFACE_LUMINANCE,
  verticalFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { createGalaxyBackdrop, GalaxyVolumeNode } from './galaxyVolume.ts'
import { warmCompile, warmRenderer } from './warmup.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

/*
 * Which way up the composed volume is.
 *
 * Its own file rather than a case in `galaxyVolume.gpu.test.ts`, because this
 * one wants a renderer nothing has declared a scene target or a tone curve on:
 * the claim is about the backdrop's own radiance, read out of a plain float
 * target, and a chain in front of it would be a second thing to hold still.
 *
 * The defect it guards is invisible in every plate the two fixed views can
 * take. `GalaxyVolumeNode` draws through a `QuadMesh`, whose `uv` attribute
 * runs v = 0 at the *top* of its attachment; `createGalaxyBackdrop` reads back
 * through a `PlaneGeometry`, whose v runs the other way. Get the sign of the
 * `up` term wrong and the two conventions compose into a vertical mirror —
 * which a face-on disk and an edge-on band both survive looking plausible, and
 * which reverses the arms' winding. So the assertion is against the CPU ray at
 * the same screen position, not against the frame's own symmetry.
 */
const SIZE = 256
const RADIANCE_TO_SCENE = (1e-9 * GALAXY_LUMINOUS_EFFICACY) / SURFACE_LUMINANCE

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
})
afterAll(() => gpu.dispose())

it.each(['outside', 'inside'] as const)(
  'puts the up-ray at the top of the %s composed frame',
  async (location) => {
    const view =
      location === 'outside'
        ? GALAXY_VIEWS['face-on']
        : {
            lens: GALAXY_VIEWS['edge-on'].lens,
            pose: {
              position: UV.fromMeters(-8178 * PARSEC, 20.8 * PARSEC, 0),
              orientation: Q.fromAxisAngle(vec3(0, 1, 0), -Math.PI / 2),
            },
          }
    const field = createGalaxyField(rootSeed('inertialref'))
    gpu.renderer.setSize(SIZE, SIZE, false)
    const volume = new GalaxyVolumeNode(field)
    const backdrop = createGalaxyBackdrop(volume)
    const scene = new Scene()
    const camera = new PerspectiveCamera(
      verticalFovDegrees(view.lens),
      1,
      0.1,
      100,
    )
    try {
      volume.configure(view.pose, view.lens)
      backdrop.visible = true
      scene.add(backdrop)
      camera.updateMatrixWorld()
      await volume.warm(gpu.renderer)
      await warmCompile(warmRenderer(gpu.renderer), {
        object: backdrop,
        camera,
        scene,
      })
      const pixels = await gpu.draw(scene, camera, {
        width: SIZE,
        height: SIZE,
        float: true,
      })
      // The volume is a quarter of each dimension, so a screen row lands on a
      // texel centre only every fourth one. Sampling anywhere else compares a
      // bilinear blend of two rays against one, which is a 20% claim at the
      // bulge's gradient and says nothing about which way up the frame is.
      const divisor = SIZE / volume.diagnostics.height
      const basis = Q.basis(view.pose.orientation)
      const half = Math.tan(verticalFov(view.lens) / 2)
      for (const texel of [4, 12, 52, 60]) {
        const row = texel * divisor + divisor / 2
        const screenY = 1 - (2 * (row + 0.5)) / SIZE
        const cpu = integrateGalaxyRay(
          field,
          view.pose.position,
          vec3(
            basis.forward.x + basis.up.x * screenY * half,
            basis.forward.y + basis.up.y * screenY * half,
            basis.forward.z + basis.up.z * screenY * half,
          ),
          { distanceParsecs: 100000, sampling: 'observer' },
        )
        // 3% rather than the kernel suite's 1%: the sensor's own bound is on a
        // ray, and this is that ray through a half-float texel and a bilinear
        // fetch. Measured at 0.4–0.9% across these four rows. The rows are the
        // outer ones on purpose — mirrored, these land 32% to 5.7× out, where a
        // pair either side of the bulge would be 3% out and pass.
        const expected = cpu.rgbNanowatts[0] * RADIANCE_TO_SCENE
        expect(
          Math.abs(pixels.at(SIZE / 2, row)[0] / expected - 1),
        ).toBeLessThan(0.03)
      }
    } finally {
      volume.dispose()
      backdrop.geometry.dispose()
      backdrop.material.dispose()
    }
  },
)
