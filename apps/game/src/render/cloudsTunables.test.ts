import { describe, expect, it } from 'vitest'
import {
  applyCloudTypePreset,
  CloudsContext,
  qualityPresets,
} from 'three-clouds-webgpu'
import {
  createCloudsSettings,
  readTunable,
  CLOUDS_TUNABLES,
} from './cloudsTunables.ts'

/**
 * A context as a chain builds one: the port's own, at its `high`, counting
 * the histories its setters clear as the pass's callback would.
 */
function built() {
  const context = new CloudsContext()
  let cleared = 0
  context.registerResetHistory(() => {
    cleared += 1
  })
  return { context, cleared: () => cleared }
}

const frame = () => ({})

describe('the clouds tunables', () => {
  it('names only paths the port’s context holds', () => {
    const { context } = built()
    for (const { path } of CLOUDS_TUNABLES)
      expect(() => readTunable(context, path), path).not.toThrow()
  })
})

describe('the clouds settings', () => {
  it('write a context at its own flush, never at another’s', () => {
    const settings = createCloudsSettings('low')
    const drawing = built()
    settings.attach(drawing.context, frame)
    settings.flush(drawing.context)
    expect(drawing.context.qualityPreset).toBe('low')

    // A successor is built beside the chain still drawing, and that chain's
    // frames go on ending: none of them is a frame the successor drew.
    const successor = built()
    settings.attach(successor.context, frame)
    settings.flush(drawing.context)
    expect(successor.context.qualityPreset).toBe('high')
    expect(successor.context.clouds.accurateSunSkyLight).toBe(true)
    expect(successor.context.graphVersion).toBe(0)

    settings.flush(successor.context)
    expect(successor.context.qualityPreset).toBe('low')
    expect(successor.context.clouds.accurateSunSkyLight).toBe(false)
  })

  it('reach every context followed, and none that is not', () => {
    const settings = createCloudsSettings()
    const first = built()
    const second = built()
    const gone = built()
    settings.attach(first.context, frame)
    settings.attach(second.context, frame)
    settings.attach(gone.context, frame)
    settings.detach(gone.context)
    settings.set({ coverage: 0.5 })

    settings.flush(first.context)
    settings.flush(gone.context)
    expect(first.context.coverage).toBe(0.5)
    expect(second.context.coverage).toBe(0.3)
    expect(gone.context.coverage).toBe(0.3)
    settings.flush(second.context)
    expect(second.context.coverage).toBe(0.5)
    // The newest still followed is what a read answers from.
    expect(settings.read()?.['coverage']).toBe(0.5)
  })

  it('write what changed: a held full-resolution march survives another tunable without a cleared history', () => {
    const settings = createCloudsSettings()
    const { context, cleared } = built()
    settings.attach(context, frame)
    settings.set({ temporalUpscale: false })
    settings.flush(context)
    expect(context.temporalUpscale).toBe(false)
    const version = context.graphVersion
    const histories = cleared()

    settings.set({ coverage: 0.5 })
    settings.flush(context)
    expect(context.coverage).toBe(0.5)
    expect(context.temporalUpscale).toBe(false)
    expect(context.graphVersion).toBe(version)
    expect(cleared()).toBe(histories)

    // And a flush that owes nothing writes nothing.
    settings.flush(context)
    expect(context.graphVersion).toBe(version)
  })

  it('apply a preset under the overrides, dropping the ones it names', () => {
    const settings = createCloudsSettings()
    const { context } = built()
    settings.attach(context, frame)
    settings.set({
      temporalUpscale: false,
      'clouds.maxIterationCount': 100,
      'shadow.mapSize': [64, 64],
      coverage: 0.4,
    })
    settings.flush(context)
    expect(context.clouds.maxIterationCount).toBe(100)
    expect(context.shadow.mapSize.toArray()).toEqual([64, 64])

    settings.preset('low')
    settings.flush(context)
    const low = qualityPresets.low
    expect(context.qualityPreset).toBe('low')
    expect(context.clouds.maxIterationCount).toBe(low.clouds.maxIterationCount)
    expect(context.shadow.mapSize.toArray()).toEqual(
      low.shadow.mapSize.toArray(),
    )
    // Only `lowEnd` names it, so the preset alone would leave it off.
    expect(context.temporalUpscale).toBe(true)
    expect(context.coverage).toBe(0.4)
    expect(settings.state().overrides).toEqual({ coverage: 0.4 })

    // An override set after the preset stands over it.
    settings.set({ qualityPreset: 'high', 'clouds.maxIterationCount': 64 })
    settings.flush(context)
    expect(context.qualityPreset).toBe('high')
    expect(context.clouds.maxIterationCount).toBe(64)
  })

  it('apply a cloud type under the overrides, dropping its coverage and layers', () => {
    const settings = createCloudsSettings()
    const { context } = built()
    const reference = new CloudsContext()
    applyCloudTypePreset(reference, 'overcastSheet')
    settings.attach(context, frame)
    settings.set({ coverage: 0.05, powderScale: 0.2 })
    settings.cloudType('overcastSheet')
    settings.flush(context)
    expect(context.coverage).toBe(reference.coverage)
    expect(context.powderScale).toBe(0.2)
    expect(settings.state().overrides).toEqual({ powderScale: 0.2 })

    settings.set({ coverage: 0.9 })
    settings.flush(context)
    expect(context.coverage).toBe(0.9)
  })

  it('give a context built later everything the page holds, at its first flush', () => {
    const settings = createCloudsSettings()
    settings.preset('medium')
    settings.cloudType('overcastSheet')
    settings.set({ powderScale: 0.2 })
    const reference = new CloudsContext()
    applyCloudTypePreset(reference, 'overcastSheet')

    const { context } = built()
    settings.attach(context, frame)
    expect(context.qualityPreset).toBe('high')
    settings.flush(context)
    expect(context.qualityPreset).toBe('medium')
    expect(context.coverage).toBe(reference.coverage)
    expect(context.powderScale).toBe(0.2)
  })

  it('refuse at the call what the port would refuse inside a frame, and hold none of the patch', () => {
    const settings = createCloudsSettings()
    const { context } = built()
    settings.attach(context, frame)
    expect(() => settings.set({ coverage: 0.5, coverge: 1 })).toThrow(
      'no such tunable',
    )
    expect(() => settings.set({ localWeatherRepeat: 2 })).toThrow(
      'takes an array',
    )
    expect(() => settings.set({ 'experimental.nope': true })).toThrow(
      'no such tunable',
    )
    expect(() => settings.set({ 'experimental.moonlight': 1 })).toThrow(
      'takes a boolean',
    )
    expect(() => settings.set({ qualityPreset: 'best' })).toThrow(
      'no such preset',
    )
    expect(settings.state().overrides).toEqual({})
    settings.flush(context)
    expect(context.coverage).toBe(0.3)
  })

  it('drop an override the first context refuses, and write the rest', () => {
    // With no context built there is nothing to check a path on.
    const settings = createCloudsSettings()
    settings.set({ coverge: 1, localWeatherRepeat: 2, coverage: 0.6 })
    const { context } = built()
    settings.attach(context, frame)
    expect(() => settings.flush(context)).not.toThrow()
    expect(context.coverage).toBe(0.6)
    expect(settings.state().overrides).toEqual({ coverage: 0.6 })

    // Nothing of the refusal is owed again.
    settings.set({ powderScale: 0.2 })
    expect(() => settings.flush(context)).not.toThrow()
    expect(context.powderScale).toBe(0.2)
  })

  it('take a preset or a patch through a handle’s methods held apart from it', () => {
    const { preset, set, state } = createCloudsSettings()
    set({ qualityPreset: 'ultra' })
    expect(state().preset).toBe('ultra')
    preset('low')
    expect(state().preset).toBe('low')
  })

  it('refuse a preset the port does not have before anything is built', () => {
    expect(() => createCloudsSettings('best')).toThrow('no such preset')
  })
})
