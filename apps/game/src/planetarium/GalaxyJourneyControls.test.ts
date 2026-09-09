import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { UV } from '@inertialref/spatial'
import { headlessEngine } from '../engine/headlessEngine.ts'
import { engineStore } from '../state/engineStore.ts'
import { GalaxyJourneyControls } from './GalaxyJourneyControls.tsx'

it.each([
  ['Travel Out', 1],
  ['Return', 0],
] as const)(
  'keeps %s reachable after orbiting away from its endpoint',
  (label, progress) => {
    const engine = headlessEngine()
    const previous = engineStore.getState().observer
    try {
      const ir = engine.harness
      ir.galaxyJourney(progress)
      const endpoint = ir.observerSample(0)!
      ir.observatory.drag(45, 0)
      const displaced = ir.observerSample(0)!
      expect(
        UV.distance(displaced.position, endpoint.position),
      ).toBeGreaterThan(1)
      const observer = ir.observerStatus()
      expect(observer?.journey?.progress).toBe(progress)
      engineStore.setState({ observer })
      const markup = renderToStaticMarkup(
        createElement(GalaxyJourneyControls, { engine, onNotice: () => {} }),
      )
      const button = markup.match(
        new RegExp(`<button[^>]*title="${label}"[^>]*>`),
      )?.[0]
      expect(button).toBeDefined()
      expect(button).not.toContain(' disabled=""')
    } finally {
      engineStore.setState({ observer: previous })
      engine.dispose()
    }
  },
)
