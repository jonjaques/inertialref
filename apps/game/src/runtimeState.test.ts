import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  publishRuntime,
  type RuntimeSnapshot,
  useRuntime,
} from './runtimeState.ts'

afterEach(() => publishRuntime(null))

describe('the server runtime snapshot', () => {
  it('never exposes a browser session to a server render', () => {
    const runtime = {} as RuntimeSnapshot
    publishRuntime(runtime)

    function ReadRuntime() {
      return createElement(
        'output',
        null,
        useRuntime() === null ? 'shell' : 'game',
      )
    }

    expect(renderToStaticMarkup(createElement(ReadRuntime))).toBe(
      '<output>shell</output>',
    )
  })
})
