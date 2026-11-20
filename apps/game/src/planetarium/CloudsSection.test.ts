import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { headlessEngine } from '../engine/headlessEngine.ts'
import { engineStore, sampleOnce } from '../state/engineStore.ts'
import { RENDER_CLOUDS, resetPreference, write } from '../state/preferences.ts'
import { CloudsSection } from './CloudsSection.tsx'

// The markup exercises the mounted planetarium, where browser preferences apply.
vi.mock('../state/hydration.ts', () => ({ useHydrated: () => true }))

it.each([
  {
    page: 'cloud link on WebGPU',
    stored: false,
    loaded: true,
    webgpu: true,
    visible: true,
  },
  {
    page: 'setting on WebGPU',
    stored: true,
    loaded: true,
    webgpu: true,
    visible: true,
  },
  {
    page: 'cloud link on WebGL',
    stored: true,
    loaded: true,
    webgpu: false,
    visible: false,
  },
  {
    page: 'page without a cloud renderer',
    stored: true,
    loaded: false,
    webgpu: true,
    visible: false,
  },
])(
  'shows the section according to the $page',
  ({ stored, loaded, webgpu, visible }) => {
    const engine = headlessEngine()
    const previous = engineStore.getState()
    const source = {
      ...previous.presentation,
      harness: engine.harness,
      owner: null,
      cutscene: engine.cutscene,
      cloudsAvailable: loaded,
      sensorDiagnostics: { automaticAvailable: webgpu },
    }
    try {
      write(RENDER_CLOUDS, stored)
      sampleOnce(engineStore, source)
      const markup = renderToStaticMarkup(
        createElement(CloudsSection, { takePicture: () => {} }),
      )
      expect(markup.includes('>Clouds</span>')).toBe(visible)
    } finally {
      resetPreference(RENDER_CLOUDS)
      engineStore.setState(previous, true)
      engine.dispose()
    }
  },
)
