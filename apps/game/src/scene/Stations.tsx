import { getLogger } from '@inertialref/shared'
import { useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import { Group, type Scene } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  type StationRig,
  stationRig,
  turnArrays,
} from '../render/stationArrays.ts'
import { loadSurfaceModel } from '../render/surfaceModels.ts'
import { warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

const log = getLogger('game.stations')

/**
 * The stations the scene draws, with their arrays turned to the Sun.
 *
 * Fetched on first sight rather than at boot, through the loader the surface
 * structures use: the ISS is 21.8 MB, and a session that never comes within a
 * few hundred kilometers of it should not pay for it. A model is compiled
 * before the first frame that draws it, through `warmCompile` (Rule 61), so
 * the station appears whole rather than stalling the frame it arrives in.
 *
 * Drawn only where the scene says `drawn` — uncompressed and above the point
 * tier — and hidden rather than released when it is not, so coming back to it
 * costs nothing. An instance is released when its station leaves the scene,
 * which is its system unloading.
 */
export function Stations({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const anisotropy = gl.capabilities?.getMaxAnisotropy?.() ?? 8
  const root = useMemo(() => new Group(), [])
  const instances = useMemo(
    () => new Map<string, { asset: string; group: Group; rig: StationRig }>(),
    [],
  )
  const pending = useMemo(() => new Set<string>(), [])
  const failed = useMemo(() => new Set<string>(), [])
  // Reused across frames, for the reason `SurfaceStructures` gives.
  const present = useMemo(() => new Set<string>(), [])

  useTimedFrame('stations', () => {
    // Rebuilt every frame from what is actually visible, for the click filter.
    engine.stationsDrawn.clear()
    const view = engine.scene()
    if (view === null) return
    present.clear()
    for (const station of view.stations) {
      present.add(station.id)
      let instance = instances.get(station.id)
      if (instance !== undefined && instance.asset !== station.asset) {
        root.remove(instance.group)
        instances.delete(station.id)
        instance = undefined
      }
      if (instance === undefined) {
        if (!station.drawn) continue
        const key = `${station.id}:${station.asset}`
        if (pending.has(key) || failed.has(key)) continue
        pending.add(key)
        void (async () => {
          try {
            const template = await loadSurfaceModel(station.asset, anisotropy)
            // The loader remembers a failure; so does this pass, or it would
            // resolve the cached null once per frame for nothing.
            if (template === null) {
              failed.add(key)
              return
            }
            // Geometry and materials belong to the cached template; each
            // station owns only its transform and its joints' turns.
            const group = template.clone(true)
            group.visible = false
            await warmCompile(warmRenderer(gl, engine.sceneLayout(gl)), {
              object: group,
              camera,
              scene: scene as Scene,
            })
            const current = engine
              .scene()
              ?.stations.find((one) => one.id === station.id)
            if (current?.asset !== station.asset) return
            instances.set(station.id, {
              asset: station.asset,
              group,
              rig: stationRig(group),
            })
            root.add(group)
          } catch (cause) {
            // A compile that throws leaves nothing to draw. Remembered as a
            // failure, or the key stays pending and the station never loads,
            // with nothing said.
            failed.add(key)
            log.warn('station model failed', {
              asset: station.asset,
              cause: String(cause),
            })
          } finally {
            pending.delete(key)
          }
        })()
        continue
      }
      const group = instance.group
      group.visible = station.drawn
      if (!station.drawn) continue
      engine.stationsDrawn.add(station.address)
      const { position } = station.placement
      group.position.set(position.x, position.y, position.z)
      group.quaternion.set(
        station.orientation.x,
        station.orientation.y,
        station.orientation.z,
        station.orientation.w,
      )
      if (station.sun !== null) turnArrays(instance.rig, station.sun)
    }
    for (const [id, instance] of instances) {
      if (present.has(id)) continue
      root.remove(instance.group)
      instances.delete(id)
    }
  })

  return <primitive object={root} />
}
