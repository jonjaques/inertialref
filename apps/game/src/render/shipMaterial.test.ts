import {
  DoubleSide,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  ObjectSpaceNormalMap,
  SRGBColorSpace,
  Texture,
} from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { rebuildShipMaterial } from './shipMaterial.ts'

describe('the glTF hull material boundary', () => {
  it('keeps the paint factor and vertex colors on the node material', () => {
    const source = new MeshStandardMaterial({
      color: 0x8c2819,
      vertexColors: true,
      flatShading: true,
    })
    const material = rebuildShipMaterial(source, 8)

    expect(material).toBeInstanceOf(MeshStandardNodeMaterial)
    expect(material.color).toEqual(source.color)
    expect(material.color).not.toBe(source.color)
    expect(material.vertexColors).toBe(true)
    expect(material.flatShading).toBe(true)
    expect(material.outputNode).not.toBeNull()
  })

  it('keeps packed occlusion, roughness and metalness on the same texture', () => {
    const orm = new Texture()
    orm.flipY = false
    orm.channel = 1
    orm.offset.set(0.25, 0.125)
    orm.repeat.set(2, 3)
    const source = new MeshStandardMaterial({
      aoMap: orm,
      aoMapIntensity: 0.65,
      roughnessMap: orm,
      metalnessMap: orm,
      roughness: 0.72,
      metalness: 0.85,
    })
    const material = rebuildShipMaterial(source, 8)

    expect(material.aoMap).toBe(orm)
    expect(material.roughnessMap).toBe(orm)
    expect(material.metalnessMap).toBe(orm)
    expect(material.aoMapIntensity).toBe(0.65)
    expect(material.roughness).toBe(0.72)
    expect(material.metalness).toBe(0.85)
    expect(orm.anisotropy).toBe(8)
    expect(orm.colorSpace).toBe('')
    expect(orm.flipY).toBe(false)
    expect(orm.channel).toBe(1)
    expect(orm.offset.toArray()).toEqual([0.25, 0.125])
    expect(orm.repeat.toArray()).toEqual([2, 3])
  })

  it('filters a separate occlusion map at the device anisotropy', () => {
    const source = new MeshStandardMaterial({ aoMap: new Texture() })
    const material = rebuildShipMaterial(source, 4)

    expect(material.aoMap).toBe(source.aoMap)
    expect(source.aoMap?.anisotropy).toBe(4)
  })

  it('keeps normals, emissive strength and alpha coverage from the loader', () => {
    const albedo = new Texture()
    albedo.colorSpace = SRGBColorSpace
    albedo.flipY = false
    const emissive = albedo.clone()
    const normal = new Texture()
    const source = new MeshPhysicalMaterial({
      name: 'Painted hull',
      map: albedo,
      normalMap: normal,
      normalMapType: ObjectSpaceNormalMap,
      emissive: 0x2040ff,
      emissiveMap: emissive,
      emissiveIntensity: 3,
      transparent: true,
      opacity: 0.7,
      alphaTest: 0.5,
      depthWrite: false,
      side: DoubleSide,
    })
    source.normalScale.set(0.6, -0.6)
    const material = rebuildShipMaterial(source, 4)

    expect(material.name).toBe(source.name)
    expect(material.map).toBe(albedo)
    expect(material.normalMap).toBe(normal)
    expect(material.normalMapType).toBe(ObjectSpaceNormalMap)
    expect(material.normalScale.toArray()).toEqual([0.6, -0.6])
    expect(material.normalScale).not.toBe(source.normalScale)
    expect(material.emissive).toEqual(source.emissive)
    expect(material.emissive).not.toBe(source.emissive)
    expect(material.emissiveMap).toBe(emissive)
    expect(material.emissiveIntensity).toBe(3)
    expect(material).toMatchObject({
      transparent: true,
      opacity: 0.7,
      alphaTest: 0.5,
      depthWrite: false,
      side: DoubleSide,
    })
    for (const texture of [albedo, emissive, normal]) {
      expect(texture.anisotropy).toBe(4)
    }
    expect(albedo.colorSpace).toBe(SRGBColorSpace)
    expect(emissive.colorSpace).toBe(SRGBColorSpace)
    expect(albedo.flipY).toBe(false)
  })
})
