import {
  Line2NodeMaterial,
  LineBasicNodeMaterial,
  type Node,
  NormalBlending,
  type UniformNode,
} from 'three/webgpu'
import {
  cameraProjectionMatrixInverse,
  clipSpace,
  length,
  vec3,
} from 'three/tsl'
import { cloudFrontThrough } from './cloudFront.ts'
import type { CloudFrontHandle } from './cloudSystem.ts'
import { integratedSkyGain, sensorRadiance } from './radiance.ts'
import { expandedLineDepth } from './sceneDepth.ts'

/**
 * What the trace reads the clouds in front of it through: the engine's
 * handle, and the target body's render compression, which turns a view
 * distance into the true meters the knots are in.
 */
export interface EntryTraceFront {
  readonly handle: CloudFrontHandle
  readonly compression: UniformNode<'float', number>
}

/*
 * Every part of the trace is alpha-blended, so with a front handle its color
 * becomes `color·T + L` and its coverage stays its own: the composite has
 * already laid the cloud's light over everything behind the line, and the
 * blend keeps that share. An ink drawn with no depth test is still behind
 * the cloud in front of it.
 *
 * The distance is the drawn fragment's, rebuilt from its clip position as
 * `expandedLineDepth` rebuilds its depth: Line2 expands its ribbon in its
 * own projection, so `positionView` there is the template's vertex at the
 * object's origin, not the segment's. Without a handle every graph is the
 * one a page without `?clouds=1` has always compiled.
 */
function throughClouds(
  color: Node<'vec3'>,
  front: EntryTraceFront | undefined,
): Node<'vec3'> {
  if (front === undefined) return color
  const view = cameraProjectionMatrixInverse.mul(clipSpace)
  const seen = cloudFrontThrough(
    front.handle,
    length(view.xyz.div(view.w)).div(front.compression),
  )
  return color.mul(seen.transmittance).add(seen.light)
}

/** Pixel widths keep the landing promise legible over clouds and at retina density. */
function ink(
  front: EntryTraceFront | undefined,
  color: readonly [number, number, number],
  width: number,
  depthTest = true,
): Line2NodeMaterial {
  const line = sensorRadiance(new Line2NodeMaterial(), true, true)
  line.colorNode = throughClouds(vec3(...color).mul(integratedSkyGain), front)
  line.linewidth = width
  line.depthWrite = false
  line.depthTest = depthTest
  // Line2 expands its instance endpoints in clip space, but its inherited
  // logarithmic depth uses the ribbon template at the object's origin. Read
  // the expanded vertex so foreground rope survives the body's depth test.
  line.depthNode = expandedLineDepth
  // Line2's transparent path samples the opaque viewport, before sensor response.
  // Alpha coverage needs ordinary blending here, without that second scene read.
  line.blending = NormalBlending
  return line
}

export function createEntryTraceMaterials(front?: EntryTraceFront) {
  const through = sensorRadiance(new LineBasicNodeMaterial(), true, true)
  through.colorNode = throughClouds(
    vec3(0.25, 0.55, 0.8).mul(integratedSkyGain),
    front,
  )
  through.transparent = true
  through.opacity = 0.25
  through.depthWrite = false
  through.depthTest = false
  return {
    fall: ink(front, [0.18, 0.9, 1.5], 1.5),
    through,
    ring: ink(front, [0.35, 1.2, 1.8], 2),
    hold: ink(front, [0.35, 1.2, 1.8], 1.5, false),
    figure: ink(front, [0.55, 1.5, 2], 2, false),
    // The dark keyline separates the destination from bright cloud and snow.
    outline: ink(front, [0.006, 0.016, 0.028], 4),
  }
}
