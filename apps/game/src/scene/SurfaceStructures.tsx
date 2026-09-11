import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Group, type Scene } from 'three/webgpu'
import { SURFACE_ASSETS } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'
import { loadSurfaceModel } from '../render/surfaceModels.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** Draws the world's body-fixed structures, including a borrowed Cinema stage. */
export function SurfaceStructures({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const anisotropy = gl.capabilities?.getMaxAnisotropy?.() ?? 8
  const root = useMemo(() => new Group(), [])
  const instances = useMemo(
    () => new Map<string, { assetId: string; group: Group }>(),
    [],
  )
  const pending = useMemo(() => new Set<string>(), [])

  useEffect(() => {
    warmAtMount({
      label: 'compiling the surface structures',
      units: SURFACE_ASSETS.length,
      run: async (done) => {
        for (const asset of SURFACE_ASSETS) {
          const model = await loadSurfaceModel(asset.id, anisotropy)
          if (model !== null)
            await warmCompile(warmRenderer(gl), {
              object: model,
              camera,
              scene: scene as Scene,
            })
          done()
        }
      },
    })
  }, [anisotropy, gl, camera, scene])

  useTimedFrame('surfaceStructures', () => {
    const view = engine.scene()
    if (view === null) return
    const stage = engine.cinematic?.stage
    const structures =
      stage !== undefined && stage.placementId === undefined
        ? [
            ...view.structures,
            { ...stage, id: 'cinematic:stage', assetId: stage.model },
          ]
        : view.structures
    const active = new Set(structures.map((structure) => structure.id))
    for (const [id, instance] of instances) {
      if (!active.has(id)) {
        root.remove(instance.group)
        instances.delete(id)
      }
    }
    for (const structure of structures) {
      const existing = instances.get(structure.id)
      if (existing !== undefined && existing.assetId !== structure.assetId) {
        root.remove(existing.group)
        instances.delete(structure.id)
      }
      const instance = instances.get(structure.id)
      if (instance === undefined) {
        const key = `${structure.id}:${structure.assetId}`
        if (pending.has(key)) continue
        pending.add(key)
        void loadSurfaceModel(structure.assetId, anisotropy).then(
          (template) => {
            pending.delete(key)
            if (template === null) return
            const current = engine
              .scene()
              ?.structures.find((item) => item.id === structure.id)
            const currentAsset =
              structure.id === 'cinematic:stage'
                ? engine.cinematic?.stage?.model
                : current?.assetId
            if (currentAsset !== structure.assetId) return
            // Geometry and node materials belong to the cached template. Each
            // placement owns only its transform so two pads cannot steal a mesh.
            const group = template.clone(true)
            group.visible = false
            instances.set(structure.id, { assetId: structure.assetId, group })
            root.add(group)
          },
        )
        continue
      }
      instance.group.visible = true
      instance.group.position.set(
        structure.position.x,
        structure.position.y,
        structure.position.z,
      )
      instance.group.quaternion.set(
        structure.orientation.x,
        structure.orientation.y,
        structure.orientation.z,
        structure.orientation.w,
      )
    }
  })

  return <primitive object={root} />
}
