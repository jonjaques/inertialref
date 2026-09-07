import {
  Line2NodeMaterial,
  LineBasicNodeMaterial,
  NormalBlending,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { integratedSkyGain, sensorRadiance } from './radiance.ts'

/** Pixel widths keep the landing promise legible over clouds and at retina density. */
function ink(
  color: readonly [number, number, number],
  width: number,
  depthTest = true,
): Line2NodeMaterial {
  const line = sensorRadiance(new Line2NodeMaterial())
  line.colorNode = vec3(...color).mul(integratedSkyGain)
  line.linewidth = width
  line.depthWrite = false
  line.depthTest = depthTest
  // Line2's transparent path samples the opaque viewport, before sensor response.
  // Alpha coverage needs ordinary blending here, without that second scene read.
  line.blending = NormalBlending
  return line
}

export function createEntryTraceMaterials() {
  const through = sensorRadiance(new LineBasicNodeMaterial())
  through.colorNode = vec3(0.25, 0.55, 0.8).mul(integratedSkyGain)
  through.transparent = true
  through.opacity = 0.25
  through.depthWrite = false
  through.depthTest = false
  return {
    fall: ink([0.18, 0.9, 1.5], 1.5),
    through,
    ring: ink([0.35, 1.2, 1.8], 2),
    hold: ink([0.35, 1.2, 1.8], 1.5, false),
    figure: ink([0.55, 1.5, 2], 2, false),
    // The dark keyline separates the destination from bright cloud and snow.
    outline: ink([0.006, 0.016, 0.028], 4),
  }
}
