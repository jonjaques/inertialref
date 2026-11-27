import { expect, it } from 'vitest'
import { clouds } from 'three-clouds-webgpu'
import { vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { cloudsMaterial } from './cloudsMaterial.ts'
import { cloudsTargetBytes } from './cloudsTargets.ts'

it('keys the material by the preset that builds its cloud layer', () => {
  const pass = clouds({ sceneDepth: null })
  const layer = pass.composite(vec4(0))
  const material = cloudsMaterial(layer as unknown as Node<'vec4'>, vec3(1))
  try {
    const context = pass.cloudsContext
    context.qualityPreset = 'low'
    const low = material.customProgramCacheKey()
    context.qualityPreset = 'high'
    expect(material.customProgramCacheKey()).not.toEqual(low)
    context.qualityPreset = 'low'
    expect(material.customProgramCacheKey()).toEqual(low)
  } finally {
    material.dispose()
    layer.dispose()
    pass.dispose()
    pass.cloudsContext.dispose()
  }
})

it('counts each march attachment before a resolve or a shadow atlas exists', () => {
  const pass = clouds({ sceneDepth: null })
  try {
    pass.layerRT.setSize(8, 4)
    const bytes = 8 * 4 * pass.layerRT.textures.length * 8
    expect(cloudsTargetBytes(pass, 512)).toEqual({
      depth: 512,
      march: bytes,
      resolve: 0,
      history: 0,
      shadows: 0,
      total: 512 + bytes,
    })
  } finally {
    pass.dispose()
    pass.cloudsContext.dispose()
  }
})
