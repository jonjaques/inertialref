import { useEffect, useMemo, useRef } from 'react'
import { Group, Sprite, type WebGPURenderer } from 'three/webgpu'
import { pixelsPerRadian } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { STAR_SPRITE_CEILING, type StarField } from '../engine/starSelection.ts'
import { createStarfieldMaterial } from '../render/materials.ts'
import { createStarProjection } from '../render/starProjection.ts'
import { useTimedFrame } from './useTimedFrame.ts'

function createField() {
  const projection = createStarProjection(STAR_SPRITE_CEILING)
  const material = createStarfieldMaterial(STAR_SPRITE_CEILING, projection)
  const sprite = new Sprite(material.material)
  sprite.count = 0
  // The unit quad's bounds cannot contain its instances on the star shell.
  sprite.frustumCulled = false
  sprite.renderOrder = -2
  sprite.userData.starProjection = projection
  return { projection, material, sprite }
}

type Field = ReturnType<typeof createField>

/** One bounded instanced draw; selection owns uploads and the GPU owns parallax. */
export function Starfield({ engine }: { engine: GameEngine }) {
  const group = useMemo(() => new Group(), [])
  const field = useRef<Field | null>(null)
  const written = useRef<StarField | null>(null)
  const named = useRef(new Map<string, number[]>())
  const hidden = useRef(new Set<number>())

  useEffect(() => {
    const created = createField()
    field.current = created
    written.current = null
    group.add(created.sprite)
    return () => {
      group.remove(created.sprite)
      field.current = null
      created.projection.dispose()
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
  }, [group])

  useTimedFrame('starfield', ({ gl }) => {
    const scene = engine.scene()
    const current = field.current
    if (scene === null || current === null) return
    const { projection, material, sprite } = current
    const stars = engine.starField
    if (written.current !== stars) {
      projection.upload(stars)
      const colours = material.colours.array as Float32Array
      const names = new Map<string, number[]>()
      sprite.count = Math.min(stars.positions.length, STAR_SPRITE_CEILING)
      for (let i = 0; i < sprite.count; i++) {
        const colour = stars.colours[i] ?? [1, 1, 1]
        colours.set(colour, i * 3)
        const name = stars.names[i] ?? ''
        const indices = names.get(name) ?? []
        indices.push(i)
        names.set(name, indices)
      }
      material.colours.needsUpdate = true
      material.enabled.array.fill(1)
      material.enabled.needsUpdate = true
      named.current = names
      hidden.current = new Set()
      written.current = stars
    }
    const view = engine.lensView()
    const ppr = view === null ? 848 : pixelsPerRadian(view.lens, view.viewport)
    material.angularDensity.value =
      (ppr * ppr) /
      (0.14661573215518503 * (material.size.value * engine.displayRatio) ** 2)
    material.integrated.value = engine.visibilityProcessing ? 1 : 0
    const resolved = new Set<number>()
    for (const star of scene.stars)
      if (star.placement.angularRadius * ppr > 0.75)
        for (const i of named.current.get(star.name) ?? []) resolved.add(i)
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
      engine.visibilityProcessing,
    )
  })

  return <primitive object={group} />
}
