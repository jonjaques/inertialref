import {
  AddEquation,
  CustomBlending,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ZeroFactor,
} from 'three/webgpu'
import { Fn, mrt, output, vec4 } from 'three/tsl'
import { sensorRadiance } from './radiance.ts'

/*
 * The native composite's blend (`compositeOver`, `cloudComposite.ts`),
 * written again because that module is the native system's and this chunk
 * loads none of it: premultiplied over, (One, OneMinusSrcAlpha), and alpha
 * left as the scene wrote it.
 */
function compositeOver(material: MeshBasicNodeMaterial): void {
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneMinusSrcAlphaFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
}

export function cloudsMaterial(
  layer: Node<'vec4'>,
  gain: Node<'vec3'>,
): MeshBasicNodeMaterial {
  const material = sensorRadiance(
    new MeshBasicNodeMaterial(),
    false,
    false,
    'alpha',
  )
  const radiance = material.outputNode!
  // The material's program key walks the function's inputs. A layer captured
  // only by the callback leaves the first preset's program cached on a switch.
  material.outputNode = Fn(([cloud]: [Node<'vec4'>]) => {
    output.assign(vec4(cloud.rgb.mul(gain), cloud.a))
    return radiance
  })(vec4(layer))
  // Alpha zero under the row's `over` blend: the scene keeps its own motion
  // and depth behind a cloud.
  material.mrtNode = mrt({ motion: vec4(0) })
  material.name = 'clouds composite'
  material.depthTest = false
  material.depthWrite = false
  material.fog = false
  compositeOver(material)
  return material
}
