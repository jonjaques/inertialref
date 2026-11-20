import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { expect } from 'vitest'
import { wgslEntryPoint, wgslStorage } from './wgslStorage.ts'

/**
 * An opt-in inventory of pipelines the GPU suite actually submits. This also
 * sees raw pipelines from libraries that bypass Three's node builder.
 */
export function reportWgslStorage(path: string): void {
  const sources = new WeakMap<GPUShaderModule, string>()
  const rows = new Set<string>()
  const device = GPUDevice.prototype
  const createModule = device.createShaderModule
  device.createShaderModule = function (descriptor) {
    const module = createModule.call(this, descriptor)
    sources.set(module, descriptor.code)
    return module
  }

  function stage(
    label: string | undefined,
    kind: 'vertex' | 'fragment' | 'compute',
    program: GPUProgrammableStage,
  ): void {
    const file = expect.getState().testPath
    const row = { pipeline: label, stage: kind, test: file && basename(file) }
    const source = sources.get(program.module)
    let entryPoint = program.entryPoint
    let result
    try {
      if (source === undefined)
        throw new Error('Shader module source is unavailable')
      entryPoint ??= wgslEntryPoint(source, kind)
      result = wgslStorage(source, entryPoint)
    } catch (cause) {
      result = { issue: cause instanceof Error ? cause.message : String(cause) }
    }
    const line = JSON.stringify({ ...row, entryPoint, ...result })
    if (rows.has(line)) return
    rows.add(line)
    appendFileSync(path, line + '\n')
  }

  function render(descriptor: GPURenderPipelineDescriptor): void {
    const label = descriptor.label?.replace(/_\d+$/, '')
    stage(label, 'vertex', descriptor.vertex)
    if (descriptor.fragment !== undefined)
      stage(label, 'fragment', descriptor.fragment)
  }

  const createRender = device.createRenderPipeline
  device.createRenderPipeline = function (descriptor) {
    render(descriptor)
    return createRender.call(this, descriptor)
  }
  const createRenderAsync = device.createRenderPipelineAsync
  device.createRenderPipelineAsync = function (descriptor) {
    render(descriptor)
    return createRenderAsync.call(this, descriptor)
  }

  const createCompute = device.createComputePipeline
  device.createComputePipeline = function (descriptor) {
    stage(descriptor.label, 'compute', descriptor.compute)
    return createCompute.call(this, descriptor)
  }
  const createComputeAsync = device.createComputePipelineAsync
  device.createComputePipelineAsync = function (descriptor) {
    stage(descriptor.label, 'compute', descriptor.compute)
    return createComputeAsync.call(this, descriptor)
  }
}
