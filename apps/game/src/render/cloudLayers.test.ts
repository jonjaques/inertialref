import { describe, expect, it } from 'vitest'
import {
  BufferGeometry,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  Scene,
  Sprite,
} from 'three/webgpu'
import { markOverClouds, OVER_CLOUDS_LAYER, overClouds } from './cloudLayers.ts'

/*
 * The frame's count of what draws over the clouds: what `chain` goes without
 * the second scene pass on, and what `lean` makes pass B's depth read-only
 * on. Each case has a scene of its own, since the marks are the module's and
 * a mark in one scene must not count in another.
 */

const blended = (): MeshBasicMaterial =>
  new MeshBasicMaterial({ transparent: true, depthWrite: false })

function marked(material = blended()): Mesh {
  const mesh = new Mesh(new BufferGeometry(), material)
  markOverClouds(mesh)
  return mesh
}

describe('the marks', () => {
  it('put the object and every descendant on the OVER layer alone', () => {
    const group = new Group()
    const child = new Mesh(new BufferGeometry(), blended())
    group.add(child)
    markOverClouds(group)
    for (const node of [group, child]) {
      expect(node.layers.isEnabled(OVER_CLOUDS_LAYER)).toBe(true)
      expect(node.layers.isEnabled(0)).toBe(false)
    }
  })
})

describe('what the marks put over the clouds', () => {
  it('is nothing in a scene that holds no mark', () => {
    const scene = new Scene()
    scene.add(new Mesh(new BufferGeometry(), blended()))
    expect(overClouds(scene)).toBe('nothing')
  })

  it('is drawn for every kind three draws, and nothing for a group that draws none', () => {
    for (const make of [
      () => new Mesh(new BufferGeometry(), blended()),
      () => new LineSegments(new BufferGeometry(), blended()),
      () => new Points(new BufferGeometry(), blended()),
      () => new Sprite(),
    ]) {
      const scene = new Scene()
      const drawn = make()
      ;(drawn.material as MeshBasicMaterial).depthWrite = false
      markOverClouds(drawn)
      scene.add(drawn)
      expect(overClouds(scene), drawn.type).toBe('drawn')
    }
    const scene = new Scene()
    const empty = new Group()
    markOverClouds(empty)
    scene.add(empty)
    expect(overClouds(scene)).toBe('nothing')
  })

  it('follows the object’s own flag and every ancestor’s', () => {
    const scene = new Scene()
    const outer = new Group()
    const inner = new Group()
    const mesh = marked()
    inner.add(mesh)
    outer.add(inner)
    scene.add(outer)
    expect(overClouds(scene)).toBe('drawn')
    for (const node of [mesh, inner, outer]) {
      node.visible = false
      expect(overClouds(scene), node.type).toBe('nothing')
      node.visible = true
    }
    expect(overClouds(scene)).toBe('drawn')
  })

  it('does not count a visible group whose meshes hide themselves: the plumes with every valve shut', () => {
    const scene = new Scene()
    const plumes = new Group()
    const sheath = new Mesh(new BufferGeometry(), blended())
    const disk = new Mesh(new BufferGeometry(), blended())
    plumes.add(sheath, disk)
    markOverClouds(plumes)
    scene.add(plumes)
    sheath.visible = false
    disk.visible = false
    expect(plumes.visible).toBe(true)
    expect(overClouds(scene)).toBe('nothing')
    disk.visible = true
    expect(overClouds(scene)).toBe('drawn')
  })

  it('counts only what hangs from the scene asked about', () => {
    const scene = new Scene()
    const other = new Scene()
    const mesh = marked()
    expect(overClouds(scene)).toBe('nothing')
    other.add(mesh)
    expect(overClouds(scene)).toBe('nothing')
    expect(overClouds(other)).toBe('drawn')
    mesh.removeFromParent()
    expect(overClouds(other)).toBe('nothing')
  })

  it('says depth where anything drawn writes it, one material of several included', () => {
    const scene = new Scene()
    scene.add(marked())
    expect(overClouds(scene)).toBe('drawn')
    const opaque = marked(new MeshBasicMaterial())
    scene.add(opaque)
    expect(overClouds(scene)).toBe('depth')
    opaque.visible = false
    expect(overClouds(scene)).toBe('drawn')
    const several = new Mesh(new BufferGeometry(), [
      blended(),
      new MeshBasicMaterial(),
    ])
    markOverClouds(several)
    scene.add(several)
    expect(overClouds(scene)).toBe('depth')
  })

  it('does not count an object put on the layer by hand: rule 69’s one way to mark', () => {
    const scene = new Scene()
    const mesh = new Mesh(new BufferGeometry(), blended())
    mesh.layers.set(OVER_CLOUDS_LAYER)
    scene.add(mesh)
    expect(overClouds(scene)).toBe('nothing')
  })
})
