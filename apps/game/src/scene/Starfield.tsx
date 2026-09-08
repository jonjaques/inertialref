import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { instanceIndex, varying } from 'three/tsl'
import { createGalaxyField } from '@inertialref/universe'
import { Group, Sprite, type WebGPURenderer } from 'three/webgpu'
import { pixelsPerRadian } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { STAR_SPRITE_CEILING, type StarField } from '../engine/starSelection.ts'
import { createStarfieldMaterial } from '../render/materials.ts'
import {
  uploadStarfieldAppearance,
  type NamedStars,
} from '../render/starfieldAppearance.ts'
import { createStarProjection } from '../render/starProjection.ts'
import { StarExtinctionCache } from '../render/starExtinctionCache.ts'
import { acquireGalaxyStructure } from '../render/galaxyStructure.ts'
import { createGalaxyKernel } from '../render/galaxyKernel.ts'
import { warmAtMount } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

function createField(engine: GameEngine, renderer: WebGPURenderer) {
  const galaxy = createGalaxyField(engine.world.galaxySeed)
  const compute =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
  const structure = compute ? acquireGalaxyStructure(renderer) : null
  const kernel =
    structure === null
      ? undefined
      : createGalaxyKernel(galaxy, {
          structure: (position) => structure.table.sample(position),
        })
  const extinction = new StarExtinctionCache(STAR_SPRITE_CEILING, galaxy, {
    cpu: !compute,
    kernel,
  })
  const projection = createStarProjection(STAR_SPRITE_CEILING, {
    compute,
    visual: true,
  })
  const material = createStarfieldMaterial(
    STAR_SPRITE_CEILING,
    projection,
    varying(extinction.sample(instanceIndex)),
  )
  const sprite = new Sprite(material.material)
  sprite.name = 'Starfield'
  sprite.count = 0
  // The unit quad's bounds cannot contain its instances on the star shell.
  sprite.frustumCulled = false
  sprite.renderOrder = -2
  sprite.userData.starProjection = projection
  sprite.userData.starExtinction = extinction
  return {
    projection,
    material,
    sprite,
    extinction,
    structure,
    galaxy,
    world: engine.world,
  }
}

type Field = ReturnType<typeof createField>

/** One bounded instanced draw; selection owns uploads and the GPU owns parallax. */
export function Starfield({ engine }: { engine: GameEngine }) {
  const gl = useThree((state) => state.gl)
  const group = useMemo(() => new Group(), [])
  const field = useRef<Field | null>(null)
  const written = useRef<StarField | null>(null)
  const named = useRef<NamedStars>(new Map())
  const hidden = useRef(new Set<number>())

  useEffect(() => {
    const created = createField(engine, gl as unknown as WebGPURenderer)
    field.current = created
    written.current = null
    named.current.clear()
    hidden.current.clear()
    group.add(created.sprite)
    warmAtMount({
      label: 'warming stellar extinction',
      units: 1,
      run: async (done) => {
        const current = field.current
        if (current !== null) {
          await current.structure?.table.warm(gl as unknown as WebGPURenderer)
          await current.extinction.warm(gl as unknown as WebGPURenderer)
        }
        done()
      },
    })
    return () => {
      group.remove(created.sprite)
      field.current = null
      created.projection.dispose()
      created.extinction.dispose()
      created.structure?.release()
      created.material.material.dispose()
      // A Sprite shares its quad geometry. Its instanced buffers belong here.
      for (const attribute of [
        created.material.positions,
        created.material.colours,
        created.material.prominence,
        created.material.visibility,
        created.material.enabled,
        created.material.transmission,
      ])
        attribute.dispose()
    }
  }, [group, engine, gl])

  useTimedFrame('starfield', () => {
    const visibility = engine.visibilityProcessing
    const scene = engine.scene()
    const current = field.current
    if (scene === null || current === null) return
    const { projection, material, sprite } = current
    const stars = engine.starField
    if (current.world !== engine.world) {
      current.world = engine.world
      current.galaxy = createGalaxyField(engine.world.galaxySeed)
    }
    current.extinction.configure(
      stars,
      scene.camera.universePosition,
      current.galaxy,
    )
    current.extinction.advance(gl as unknown as WebGPURenderer)
    if (written.current !== stars) {
      projection.upload(stars)
      sprite.count = Math.min(stars.positions.length, STAR_SPRITE_CEILING)
      uploadStarfieldAppearance(
        material,
        stars,
        written.current,
        named.current,
        hidden.current,
        sprite.count,
      )
      written.current = stars
    }
    const view = engine.lensView()
    const ppr = view === null ? 848 : pixelsPerRadian(view.lens, view.viewport)
    material.angularDensity.value =
      (ppr * ppr) /
      (0.14661573215518503 * (material.size.value * engine.displayRatio) ** 2)
    material.integrated.value = visibility ? 1 : 0
    const resolved = new Set<number>()
    for (const star of scene.stars)
      if (star.placement.angularRadius * ppr > 0.75) {
        const indices = named.current.get(star.name)
        if (typeof indices === 'number') resolved.add(indices)
        else if (indices !== undefined) for (const i of indices) resolved.add(i)
      }
    for (const i of hidden.current)
      if (!resolved.has(i)) {
        material.enabled.array[i] = 1
        material.enabled.addUpdateRange(i, 1)
        material.enabled.needsUpdate = true
      }
    for (const i of resolved)
      if (!hidden.current.has(i)) {
        material.enabled.array[i] = 0
        material.enabled.addUpdateRange(i, 1)
        material.enabled.needsUpdate = true
      }
    hidden.current = resolved
    projection.update(
      gl as unknown as WebGPURenderer,
      scene.origin,
      scene.camera.universePosition,
      scene.camera.position,
      visibility,
    )
  })

  return <primitive object={group} />
}
