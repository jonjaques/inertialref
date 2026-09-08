import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { WebGPURenderer } from 'three/webgpu'
import { createGalaxyField, type GalaxyField } from '@inertialref/universe'
import { IndexedDbGalaxySkyStore } from '../engine/galaxySkyStore.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  createGalaxyBackdrop,
  GalaxyVolumeNode,
} from '../render/galaxyVolume.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import type { createStarProjection } from '../render/starProjection.ts'
import type { StarExtinctionCache } from '../render/starExtinctionCache.ts'
import { acquireGalaxyStructure } from '../render/galaxyStructure.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** The effect owns GPU objects; StrictMode cleanup retires exactly the instance it creates. */
export function GalaxyVolume({ engine }: { engine: GameEngine }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const live = useRef<{
    volume: GalaxyVolumeNode
    mesh: ReturnType<typeof createGalaxyBackdrop>
    field: GalaxyField
    world: GameEngine['world']
  } | null>(null)

  useEffect(() => {
    const field = createGalaxyField(engine.world.galaxySeed)
    const structure = acquireGalaxyStructure(gl as unknown as WebGPURenderer)
    const volume = new GalaxyVolumeNode(field, {
      cache: {
        faceSize: 512,
        initialFaceSize: 32,
        refinements: [128],
        tileSize: 32,
        tilesPerSubmission: 2,
      },
      structure: structure.table,
      archive: (gl as unknown as { backend: { isWebGPUBackend?: boolean } })
        .backend.isWebGPUBackend
        ? new IndexedDbGalaxySkyStore()
        : undefined,
      temporal: { stride: 8 },
      resolutionDivisor: 2,
      maxLongEdge: 960,
    })
    const mesh = createGalaxyBackdrop(volume)
    const held = { volume, mesh, field, world: engine.world }
    live.current = held
    scene.add(mesh)
    const report = () => {
      const sprite = scene.getObjectByName('Starfield')
      const projection = sprite?.userData.starProjection as
        ReturnType<typeof createStarProjection> | undefined
      const extinction = sprite?.userData.starExtinction as
        StarExtinctionCache | undefined
      return {
        ...volume.diagnostics,
        resolvedStarExtinction: extinction?.diagnostics.ready ?? false,
        ...(projection === undefined || extinction === undefined
          ? {}
          : {
              stars: {
                ...projection.diagnostics,
                extinction: extinction.diagnostics,
              },
            }),
        exposure: engine.exposure,
        survey: engine.starSurvey,
        instrument: engine.galaxyInstrument,
        journey: engine.galaxyInstrument
          ? engine.harness.observatory.journey
          : null,
      }
    }
    engine.galaxyRenderer = report
    warmAtMount({
      label: 'warming the galaxy',
      units: 2,
      run: async (done) => {
        const current = live.current
        if (current === null) {
          done()
          done()
          return
        }
        await current.volume.warm(gl as unknown as WebGPURenderer)
        done()
        if (live.current === current)
          await warmCompile(warmRenderer(gl), {
            object: current.mesh,
            camera,
            scene,
          })
        done()
      },
    })
    return () => {
      if (live.current === held) live.current = null
      if (engine.galaxyRenderer === report) engine.galaxyRenderer = null
      scene.remove(mesh)
      volume.dispose()
      structure.release()
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }, [engine, gl, scene, camera])

  useTimedFrame('galaxy', () => {
    const current = live.current
    if (current === null) return
    if (current.world !== engine.world) {
      current.world = engine.world
      current.field = createGalaxyField(engine.world.galaxySeed)
    }
    const pose = engine.galaxyPose
    current.volume.configure(
      pose,
      engine.lens,
      current.field,
      engine.starField.resolved,
    )
    current.mesh.visible = current.volume.active && current.volume.ready
  })
  return null
}
