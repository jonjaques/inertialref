import { getConsoleFunction, type WebGPURenderer } from 'three/webgpu'
import { expect, it, vi } from 'vitest'
import {
  watchRendererErrors,
  watchRendererValidation,
} from './rendererErrors.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const descriptor = {} as GPURenderPipelineDescriptor
const pipeline = {} as GPURenderPipeline
const validation = { message: 'Invalid fragment shader' } as GPUError

function webgpu() {
  const device = {
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async (): Promise<GPUError | null> => null),
    createRenderPipeline: vi.fn(
      (_descriptor: GPURenderPipelineDescriptor) => pipeline,
    ),
    createRenderPipelineAsync: vi.fn(
      async (_descriptor: GPURenderPipelineDescriptor) => pipeline,
    ),
  }
  const renderer = {
    backend: { isWebGPUBackend: true, device },
  } as unknown as WebGPURenderer
  return { device, renderer }
}

function webgl() {
  const gl = {
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    getProgramParameter: vi.fn(
      (_program: WebGLProgram, _parameter: number) => true,
    ),
    getShaderParameter: vi.fn(
      (_shader: WebGLShader, _parameter: number) => true,
    ),
    getProgramInfoLog: vi.fn(() => 'Program failed to link'),
    getShaderInfoLog: vi.fn(() => 'Shader failed to compile'),
  }
  const renderer = {
    backend: { getContext: () => gl },
  } as unknown as WebGPURenderer
  return { gl, renderer }
}

it('keeps backend error handling local and preserves the default callbacks', () => {
  const logger = getConsoleFunction()
  const loss = vi.fn()
  const error = vi.fn()
  const renderer = {
    onDeviceLost: loss,
    onError: error,
  } as unknown as WebGPURenderer
  const fail = vi.fn()
  const stop = watchRendererErrors(renderer, fail)
  expect(getConsoleFunction()).toBe(logger)
  const lost = renderer.onDeviceLost
  const errored = renderer.onError as (info: unknown) => void
  const info = {
    api: 'WebGPU' as const,
    message: 'Device reset',
    reason: 'unknown',
    originalEvent: {},
  }
  lost(info)
  errored({ message: 'Invalid command buffer' })
  expect(loss).toHaveBeenCalledWith(info)
  expect(loss.mock.contexts[0]).toBe(renderer)
  expect(error).toHaveBeenCalledWith({ message: 'Invalid command buffer' })
  expect(fail.mock.calls.map(([cause]) => cause.message)).toEqual([
    'Device reset',
    'Invalid command buffer',
  ])
  stop()
  lost(info)
  errored('Retired error')
  expect(fail).toHaveBeenCalledTimes(2)
  expect(renderer.onDeviceLost).toBe(loss)
  expect(renderer.onError).toBe(error)
})

it('reports a scoped render validation error while preserving the native result and receiver', async () => {
  const { device, renderer } = webgpu()
  const original = { ...device }
  original.popErrorScope.mockResolvedValueOnce(validation)
  const fail = vi.fn()
  const stop = watchRendererValidation(renderer, fail)
  device.pushErrorScope('validation')
  expect(device.createRenderPipeline(descriptor)).toBe(pipeline)
  await expect(device.popErrorScope()).resolves.toBe(validation)
  expect(fail.mock.calls[0]?.[0].message).toBe(validation.message)
  expect(original.createRenderPipeline.mock.contexts[0]).toBe(device)
  expect(original.popErrorScope.mock.contexts[0]).toBe(device)
  stop()
  expect(device.pushErrorScope).toBe(original.pushErrorScope)
  expect(device.popErrorScope).toBe(original.popErrorScope)
  expect(device.createRenderPipeline).toBe(original.createRenderPipeline)
  expect(device.createRenderPipelineAsync).toBe(
    original.createRenderPipelineAsync,
  )
})

it('preserves asynchronous pipeline rejection and successful pipeline results', async () => {
  const { device, renderer } = webgpu()
  const cause = new Error('Async pipeline rejected')
  const original = device.createRenderPipelineAsync
  original.mockRejectedValueOnce(cause)
  const fail = vi.fn()
  const stop = watchRendererValidation(renderer, fail)
  await expect(device.createRenderPipelineAsync(descriptor)).rejects.toBe(cause)
  await expect(device.createRenderPipelineAsync(descriptor)).resolves.toBe(
    pipeline,
  )
  expect(original.mock.contexts[0]).toBe(device)
  expect(fail.mock.calls[0]?.[0]).toBe(cause)
  expect(fail).toHaveBeenCalledOnce()
  stop()
})

it('preserves synchronous pipeline exceptions', () => {
  const { device, renderer } = webgpu()
  const cause = new Error('Invalid pipeline descriptor')
  device.createRenderPipeline.mockImplementationOnce(() => {
    throw cause
  })
  const fail = vi.fn()
  const stop = watchRendererValidation(renderer, fail)
  expect(() => device.createRenderPipeline(descriptor)).toThrow(cause)
  expect(fail.mock.calls[0]?.[0]).toBe(cause)
  stop()
})

it('does not turn handled compute validation into a fatal render failure', async () => {
  const { device, renderer } = webgpu()
  device.popErrorScope.mockResolvedValueOnce(validation)
  const fail = vi.fn()
  const stop = watchRendererValidation(renderer, fail)
  device.pushErrorScope('validation')
  await expect(device.popErrorScope()).resolves.toBe(validation)
  device.pushErrorScope('validation')
  device.createRenderPipeline(descriptor)
  await expect(device.popErrorScope()).resolves.toBeNull()
  expect(fail).not.toHaveBeenCalled()
  stop()
})

it('ignores delayed validation and pipeline rejection from a retired device', async () => {
  const first = webgpu()
  const scope = deferred<GPUError | null>()
  const build = deferred<GPURenderPipeline>()
  first.device.popErrorScope.mockReturnValueOnce(scope.promise)
  first.device.createRenderPipelineAsync.mockReturnValueOnce(build.promise)
  const firstFailure = vi.fn()
  const stopFirst = watchRendererValidation(first.renderer, firstFailure)
  first.device.pushErrorScope('validation')
  const compiled = first.device.createRenderPipelineAsync(descriptor)
  const scoped = first.device.popErrorScope()
  stopFirst()

  const second = webgpu()
  const secondFailure = vi.fn()
  const stopSecond = watchRendererValidation(second.renderer, secondFailure)
  const cause = new Error('Retired device lost')
  scope.resolve(validation)
  build.reject(cause)
  await expect(scoped).resolves.toBe(validation)
  await expect(compiled).rejects.toBe(cause)
  expect(firstFailure).not.toHaveBeenCalled()
  expect(secondFailure).not.toHaveBeenCalled()
  stopSecond()
})

it('reports WebGL compile and link failures without changing their status', () => {
  const { gl, renderer } = webgl()
  const original = { ...gl }
  const fail = vi.fn()
  const stop = watchRendererValidation(renderer, fail)
  const shader = {} as WebGLShader
  const program = {} as WebGLProgram
  expect(gl.getShaderParameter(shader, gl.COMPILE_STATUS)).toBe(true)
  expect(gl.getProgramParameter(program, gl.LINK_STATUS)).toBe(true)
  expect(fail).not.toHaveBeenCalled()
  original.getShaderParameter.mockReturnValue(false)
  original.getProgramParameter.mockReturnValue(false)
  expect(gl.getShaderParameter(shader, 0)).toBe(false)
  expect(gl.getProgramParameter(program, 0)).toBe(false)
  expect(fail).not.toHaveBeenCalled()
  expect(gl.getShaderParameter(shader, gl.COMPILE_STATUS)).toBe(false)
  expect(gl.getProgramParameter(program, gl.LINK_STATUS)).toBe(false)
  expect(fail.mock.calls.map(([cause]) => cause.message)).toEqual([
    'Shader failed to compile',
    'Program failed to link',
  ])
  expect(original.getShaderParameter.mock.contexts[0]).toBe(gl)
  expect(original.getProgramParameter.mock.contexts[0]).toBe(gl)
  stop()
  expect(gl.getProgramParameter).toBe(original.getProgramParameter)
  expect(gl.getShaderParameter).toBe(original.getShaderParameter)
})

it('does not overwrite methods installed after the observer', () => {
  const { device, renderer } = webgpu()
  const stop = watchRendererValidation(renderer, vi.fn())
  const replacement = { ...device }
  device.pushErrorScope = replacement.pushErrorScope = vi.fn()
  device.popErrorScope = replacement.popErrorScope = vi.fn(async () => null)
  device.createRenderPipeline = replacement.createRenderPipeline = vi.fn(
    () => pipeline,
  )
  device.createRenderPipelineAsync = replacement.createRenderPipelineAsync =
    vi.fn(async () => pipeline)
  stop()
  expect(device.pushErrorScope).toBe(replacement.pushErrorScope)
  expect(device.popErrorScope).toBe(replacement.popErrorScope)
  expect(device.createRenderPipeline).toBe(replacement.createRenderPipeline)
  expect(device.createRenderPipelineAsync).toBe(
    replacement.createRenderPipelineAsync,
  )
})
