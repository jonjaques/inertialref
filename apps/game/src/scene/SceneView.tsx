import { useMemo } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createTerrainMaterial } from '../render/terrain.ts'
import { Bodies } from './Bodies.tsx'
import { CameraRig } from './CameraRig.tsx'
import { EngineTick } from './EngineTick.tsx'
import { NearFieldProps } from './NearFieldProps.tsx'
import { OrbitTraces } from './OrbitTraces.tsx'
import { ShipModel } from './ShipModel.tsx'
import { Starfield } from './Starfield.tsx'
import { SunFlare } from './SunFlare.tsx'
import { ScatterRocks } from './ScatterRocks.tsx'
import { TerrainPatches } from './TerrainPatches.tsx'
import { WarpFx } from './WarpFx.tsx'

/*
 * The React Three Fiber layer.
 *
 * Every component in this directory is a *consumer* of the scene description
 * the rendering package produced. None of them decide where anything is, none
 * of them hold simulation state, and none of them run gameplay logic in an
 * effect. When a frame is drawn they read plain numbers and write them onto
 * Three.js objects.
 *
 * Bodies and terrain are mutated imperatively rather than re-rendered: a React
 * reconcile per planet per frame at 144 Hz is a great deal of work to arrive at
 * the same matrix, and the scene graph is small and fixed enough that direct
 * mutation stays legible.
 *
 * Everything imports from `three/webgpu`, never `three`. The two entry points
 * share `three.core.js`, so `Mesh` is the same class either way and R3F's own
 * `instanceof` checks hold — but only `three/webgpu` carries the node system,
 * and a material picked out of the wrong one is a classic material that the
 * renderer has to convert behind your back. Materials themselves live in
 * `../render/materials.ts`; what is here is placement.
 *
 * **Order in this fragment is not load-bearing, and that is on purpose.** R3F
 * runs equal-priority `useFrame` callbacks in mount order, so the tick had to
 * run first or every consumer below would read a frame-stale world. `EngineTick`
 * says that with a negative priority instead of by sitting at the top of a
 * list, because moving one JSX line is not a thing anyone expects to break the
 * simulation.
 */
export function SceneView({ engine }: { engine: GameEngine }) {
  /*
   * One ground material for the session, shared by the patches and the rocks
   * standing on them.
   *
   * Here rather than inside `TerrainPatches` because two components draw with
   * it and only one may own it: a rock and the regolith under it are the same
   * surface a metre apart, and two instances of the same graph would drift the
   * first time either component was touched. `TerrainPatches` writes its
   * uniforms — the palette, the sun, the pixel angle, the archive's map — for
   * the same reason, so there is one producer of each.
   *
   * It is two *pipelines*, and that is Three's business rather than this file's:
   * the instancing insert changes the vertex stage, so the backend compiles a
   * second program from the same material. `ScatterRocks` warms it.
   */
  const terrain = useMemo(() => createTerrainMaterial(), [])
  return (
    <>
      {/* Space is genuinely high-contrast, but a debug build that renders its
          own spacecraft as a black silhouette is not a debug build. Ambient
          plus the camera-mounted fill in `CameraRig` keeps the near field
          readable; the fill is what does the work, and it was a fixed world
          direction pretending to be camera-mounted until the title sequence
          caught it. Ambient stays small because it is the one term with no
          direction, and it now reaches the ship and the near-field props
          alone: planets, atmospheres and the streamed ground all shade from
          their own `sunDirection` uniform and never see these lights. */}
      <ambientLight intensity={0.16} />
      <EngineTick engine={engine} />
      <CameraRig engine={engine} />
      <Starfield engine={engine} />
      <Bodies engine={engine} />
      <TerrainPatches engine={engine} terrain={terrain} />
      <ScatterRocks engine={engine} terrain={terrain} />
      <OrbitTraces engine={engine} />
      <SunFlare engine={engine} />
      <ShipModel engine={engine} />
      <NearFieldProps engine={engine} />
      <WarpFx engine={engine} />
    </>
  )
}
