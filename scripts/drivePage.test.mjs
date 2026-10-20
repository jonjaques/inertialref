import { describe, expect, it } from 'vitest'
import { boot, clearStorage, showing } from './drivePage.mjs'

const URL_ = 'http://localhost:5173/planetarium?at=earth&presentation=occluded'

/**
 * A scripted Chrome. `answer(kind)` names what the page says to each probe —
 * `ready`, `boot` (the cover phase), `here`, `blank`, `origin` — and the
 * commands it was sent are recorded in order.
 */
const chrome = (answer, { loaderId = 'L2', frameLoader = () => 'L2' } = {}) => {
  const sent = []
  const send = async (method, params = {}) => {
    sent.push(method)
    if (method === 'Page.navigate')
      return params.url === 'about:blank' ? {} : { loaderId }
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { loaderId: frameLoader() } } }
    if (method !== 'Runtime.evaluate') return {}
    const { expression } = params
    const kind = expression.includes('readyState')
      ? 'ready'
      : expression.includes("!== 'booting'")
        ? 'ready'
        : expression.includes('status.boot')
          ? 'boot'
          : expression.includes('location.pathname')
            ? 'here'
            : expression.includes('about:blank')
              ? 'blank'
              : 'origin'
    const value = answer(kind)
    if (value instanceof Error)
      return { result: {}, exceptionDetails: { text: value.message } }
    return { result: { value } }
  }
  return { send, sent }
}

/** A page whose clock only `sleep` advances, with the narration kept. */
const page = (document = false) => {
  let t = 0
  const notes = []
  return {
    url: URL_,
    document,
    note: (line) => notes.push(line),
    sleep: async (ms) => {
      t += ms
    },
    now: () => t,
    notes,
    elapsed: () => t,
  }
}

/** Answers that change with each read of a kind: the last one repeats. */
const ladder = (sequences) => {
  const reads = {}
  return (kind) => {
    const list = sequences[kind] ?? [null]
    const i = (reads[kind] = (reads[kind] ?? -1) + 1)
    return list[Math.min(i, list.length - 1)]
  }
}

describe('showing', () => {
  it('matches the path and the asked-for keys only', () => {
    expect(
      showing(URL_, '/planetarium?at=earth&presentation=occluded&t=4'),
    ).toBe(true)
    expect(showing(URL_, '/?at=earth&presentation=occluded')).toBe(false)
    expect(showing(URL_, '/planetarium?at=mars&presentation=occluded')).toBe(
      false,
    )
    expect(showing(URL_, '')).toBe(false)
  })
})

describe('boot', () => {
  const here = '/planetarium?at=earth&presentation=occluded'

  it('attaches to a booted page already showing the url', async () => {
    const { send, sent } = chrome(ladder({ ready: [true], here: [here] }))
    const p = page()
    await boot(send, { force: false }, p)
    expect(sent).not.toContain('Page.navigate')
    expect(p.notes).toEqual(['attached to a booted page'])
  })

  it('navigates when forced, or when the page shows something else', async () => {
    for (const [force, at] of [
      [true, here],
      [false, '/'],
    ]) {
      const { send, sent } = chrome(
        ladder({ ready: [true], here: [at], boot: ['booted'] }),
      )
      await boot(send, { force }, page())
      expect(sent).toContain('Page.navigate')
    }
  })

  it('climbs from booting through drawing to booted', async () => {
    const { send } = chrome(
      ladder({
        ready: [false, false, false, true],
        here: ['/'],
        boot: ['drawing', 'drawing', 'booted'],
      }),
    )
    const p = page()
    await boot(send, { force: false }, p)
    // Three polls of 500 ms to a renderer, then two to the cover.
    expect(p.elapsed()).toBe(2500)
    expect(p.notes).toEqual(['renderer ready in 2.5 s'])
  })

  it('gives the cover twelve seconds and then goes on', async () => {
    const { send, sent } = chrome(
      ladder({ ready: [false, true], here: ['/'], boot: ['drawing'] }),
    )
    const p = page()
    await boot(send, { force: false }, p)
    const covers = sent.filter((m) => m === 'Runtime.evaluate').length - 3
    expect(covers).toBe(24)
    expect(p.elapsed()).toBe(500 + 12_000)
    expect(p.notes).toEqual(['renderer ready in 12.5 s'])
  })

  it('reads a page whose cover probe throws as booted', async () => {
    const { send } = chrome(
      ladder({ ready: [false, true], here: ['/'], boot: [new Error('gone')] }),
    )
    const p = page()
    await boot(send, { force: false }, p)
    expect(p.elapsed()).toBe(500)
  })

  it('gives up when the renderer never appears', async () => {
    const { send } = chrome(ladder({ ready: [false], here: ['/'] }))
    const p = page()
    await expect(boot(send, { force: false }, p)).rejects.toThrow(
      'renderer never became ready',
    )
    expect(p.elapsed()).toBe(201 * 500)
  })

  it('throws the navigation’s own error', async () => {
    const send = async (method) =>
      method === 'Page.navigate'
        ? { errorText: 'net::ERR_CONNECTION_REFUSED' }
        : { result: { value: false } }
    await expect(boot(send, { force: true }, page())).rejects.toThrow(
      'net::ERR_CONNECTION_REFUSED',
    )
  })

  it('waits in document mode for the navigation’s own loader to commit', async () => {
    // The old document is complete until the new loader commits on the third read.
    let reads = 0
    const { send } = chrome(ladder({ ready: [true], here: ['/'] }), {
      frameLoader: () => (++reads < 3 ? 'L1' : 'L2'),
    })
    const p = page(true)
    await boot(send, { force: true }, p)
    expect(reads).toBe(3)
    expect(p.notes).toEqual(['document ready in 1.5 s'])
  })
})

describe('clearStorage', () => {
  it('leaves the page, then clears cookies and both origins', async () => {
    const calls = []
    const answer = ladder({
      origin: ['http://localhost:4173'],
      blank: [false, true],
    })
    const { send, sent } = chrome(answer)
    const recording = async (method, params) => {
      if (method === 'Storage.clearDataForOrigin') calls.push(params)
      return send(method, params)
    }
    const p = page()
    await clearStorage(recording, p)
    expect(sent.filter((m) => m === 'Page.navigate')).toHaveLength(1)
    expect(sent.indexOf('Network.clearBrowserCookies')).toBeGreaterThan(
      sent.indexOf('Page.navigate'),
    )
    expect(calls.map((c) => c.origin)).toEqual([
      'http://localhost:4173',
      'http://localhost:5173',
    ])
    expect(p.elapsed()).toBe(50)
    expect(p.notes).toEqual(['cleared local, session storage and cookies'])
  })

  it('skips an opaque origin', async () => {
    const calls = []
    const { send } = chrome(
      ladder({ origin: [new Error('no context')], blank: [true] }),
    )
    const recording = async (method, params) => {
      if (method === 'Storage.clearDataForOrigin') calls.push(params.origin)
      return send(method, params)
    }
    await clearStorage(recording, page())
    expect(calls).toEqual(['http://localhost:5173'])
  })

  it('refuses a page that never leaves', async () => {
    const { send } = chrome(
      ladder({ origin: [new Error('no context')], blank: [false] }),
    )
    await expect(clearStorage(send, page())).rejects.toThrow(
      'page did not leave before clearing storage',
    )
  })
})
