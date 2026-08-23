import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createWarpEffects } from '../render/warpEffects.ts'

/**
 * The cutscene's warp streaks, nacelle glow, flash wash and motion smear —
 * dormant (one visibility check per frame) unless a cutscene is playing.
 * Camera-space quads on the flare's pattern; see `render/warpEffects.ts`.
 */
export function WarpFx({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  // Same memo-without-dispose shape as SunFlare, same StrictMode reason.
  const fx = useMemo(
    () => createWarpEffects(() => engine.hull?.lengthMetres ?? 6),
    [engine],
  )

  /*
   * Compile these exact materials now, behind the boot overlay, not on the
   * first frame of a cutscene. The group sits invisible until a script turns
   * it on, so its shaders' first build used to land inside the one frame the
   * warp flash appeared in — measured as a hard hitch at `tng-intro` f1085 on
   * the WebGL fallback, where program linking is synchronous and the backend
   * builds shader source per material *instance* (an archetype warmed in
   * `render/preload.ts` does not cover it). `compileAsync` only walks visible
   * objects and its traversal is synchronous, so the toggle never lets the
   * quads reach a drawn frame; the per-frame `update` below keeps visibility
   * honest from the very next frame either way.
   */
  useEffect(() => {
    fx.group.visible = true
    void (gl as unknown as WebGPURenderer)
      .compileAsync(fx.group, camera, scene as Scene)
      .catch(() => {})
    fx.group.visible = false
  }, [fx, gl, camera, scene])

  useFrame(() => {
    fx.update(camera as PerspectiveCamera, engine.cinematic)
  })

  return <primitive object={fx.group} />
}
