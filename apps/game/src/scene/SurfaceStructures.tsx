import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Group, type Scene } from 'three/webgpu'
import type { Quat, Vec3 } from '@inertialref/spatial'
import { parseAddress } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'
import { loadSurfaceModel } from '../render/surfaceModels.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** The Cinema stage's slot, when it stands in for a placement the world lacks. */
const STAGE_ID = 'cinematic:stage'

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
  const failed = useMemo(() => new Set<string>(), [])
  // Reused across frames: the pass runs in every mode with a scene, so what
  // it allocates it allocates sixty times a second for the whole session.
  const active = useMemo(() => new Set<string>(), [])

  useEffect(() => {
    // The assets the world has placed in the systems it has loaded, not the
    // catalog: boot cost grows with what is built near the player, and a
    // structure elsewhere compiles on first sight instead.
    const loaded = new Set(
      engine.world.loadedSystems().map((system) => system.id),
    )
    const assets = [
      ...new Set(
        engine.world.structures
          .filter((structure) => {
            const address = parseAddress(structure.bodyAddress)
            return address.kind === 'body' && loaded.has(address.system)
          })
          .map((structure) => structure.assetId),
      ),
    ]
    warmAtMount({
      label: 'compiling the surface structures',
      units: assets.length,
      run: async (done) => {
        for (const asset of assets) {
          const model = await loadSurfaceModel(asset, anisotropy)
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
  }, [engine, anisotropy, gl, camera, scene])

  useTimedFrame('surfaceStructures', () => {
    const view = engine.scene()
    if (view === null) return
    active.clear()

    const place = (
      id: string,
      assetId: string,
      position: Vec3,
      orientation: Quat,
    ): void => {
      active.add(id)
      const existing = instances.get(id)
      if (existing !== undefined && existing.assetId !== assetId) {
        root.remove(existing.group)
        instances.delete(id)
      }
      const instance = instances.get(id)
      if (instance === undefined) {
        const key = `${id}:${assetId}`
        if (pending.has(key) || failed.has(key)) return
        pending.add(key)
        void loadSurfaceModel(assetId, anisotropy).then((template) => {
          pending.delete(key)
          if (template === null) {
            // The loader remembers the failure; so does this pass, or it
            // would resolve the cached null once per frame for nothing.
            failed.add(key)
            return
          }
          const currentAsset =
            id === STAGE_ID
              ? engine.cinematic?.stage?.model
              : engine.scene()?.structures.find((item) => item.id === id)
                  ?.assetId
          if (currentAsset !== assetId) return
          // Geometry and node materials belong to the cached template. Each
          // placement owns only its transform so two pads cannot steal a mesh.
          const group = template.clone(true)
          group.visible = false
          instances.set(id, { assetId, group })
          root.add(group)
        })
        return
      }
      instance.group.visible = true
      instance.group.position.set(position.x, position.y, position.z)
      instance.group.quaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      )
    }

    for (const structure of view.structures)
      place(
        structure.id,
        structure.assetId,
        structure.position,
        structure.orientation,
      )
    const stage = engine.cinematic?.stage
    if (stage !== undefined && stage.placementId === undefined)
      place(STAGE_ID, stage.model, stage.position, stage.orientation)

    for (const [id, instance] of instances) {
      if (active.has(id)) continue
      root.remove(instance.group)
      instances.delete(id)
    }
  })

  return <primitive object={root} />
}
