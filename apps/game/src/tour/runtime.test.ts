import { describe, expect, it, vi } from 'vitest'
import { openSession } from '@inertialref/devtools'
import {
  GUIDE_SESSIONS_PATH,
  GUIDE_VERDICT_PATH,
  type GuideError,
  type GuideSessionCreated,
  type GuideVerdict,
} from '@inertialref/protocol'
import { GuideExecutor } from './executor.ts'
import { liveFake, provider, read } from './liveFake.ts'
import {
  connectionOf,
  GuideRuntime,
  type GuideHost,
  statusLine,
} from './runtime.ts'
import type { GuideAccess } from './verdict.ts'

function rig() {
  const session = openSession()
  session.harness.look('s:SOL/b:2', { ease: false })
  const requests: { path: string; body: unknown }[] = []
  const fake = liveFake()
  let time = 1000
  let access: GuideAccess = { state: 'granted', voices: ['marin', 'cedar'] }
  let run: (() => void) | null = null
  let visibility: ((visible: boolean) => void) | null = null
  let executor: GuideExecutor | null = null
  const host: GuideHost = {
    access: () => access,
    now: () => time,
    localTime: () => '21:04',
    request: async (path, body) => {
      requests.push({ path, body })
      // The fake Worker answers in the protocol's types, so a renamed field
      // fails here the way it would fail against the real one.
      if (path === GUIDE_VERDICT_PATH)
        return Response.json({
          granted: true,
          voices: ['marin', 'cedar'],
        } satisfies GuideVerdict)
      if (path === GUIDE_SESSIONS_PATH)
        return Response.json({
          sessionId: 'live_1',
          expiresAt: time + 7_200_000,
          sdp: 'answer',
        } satisfies GuideSessionCreated)
      return Response.json(
        { error: 'No such guide endpoint.' } satisfies GuideError,
        { status: 404 },
      )
    },
    executor: (events) => {
      executor = new GuideExecutor(session.harness, {
        now: () => time,
        ...events,
      })
      return executor
    },
    live: (onEvent) => {
      fake.listen(onEvent)
      return fake.live
    },
    poll: (tick) => {
      run = tick
      return () => {
        run = null
      }
    },
    visibility: (changed) => {
      visibility = changed
      return () => {
        visibility = null
      }
    },
  }
  const runtime = new GuideRuntime(host)
  let responses = 0
  const delegated = (name: string, args: Record<string, unknown>) => {
    const id = `resp_${++responses}`
    const callId = `call_${responses}`
    fake.emit(provider.responseCreated(id))
    fake.emit(provider.functionCall(callId, name, JSON.stringify(args)))
    fake.emit(provider.responseCompleted(id))
    return callId
  }
  const terminal = (text: string) => {
    const id = `resp_${++responses}`
    fake.emit(provider.responseCreated(id))
    fake.emit(provider.message(text))
    fake.emit(
      provider.responseCompleted(id, {
        input_tokens: 2000,
        input_tokens_details: { cached_tokens: 1900 },
        output_tokens: 30,
      }),
    )
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    runtime,
    session,
    grant: (next: GuideAccess) => {
      access = next
    },
    requests,
    fake,
    sent: fake.sent,
    receive: fake.emit,
    delegated,
    terminal,
    settle,
    executor: () => executor!,
    speak: fake.speak,
    tick: () => run?.(),
    advance: (ms: number, ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        time += ms / ticks
        run?.()
      }
    },
    arrive: () => {
      for (let i = 0; i < 600; i++) session.harness.observatory.sample(1 / 60)
      run?.()
    },
    hide: () => visibility?.(false),
    activity: () => runtime.getSnapshot().activity,
    developer: () => read.developer(fake.sent),
    outputs: () => read.outputs(fake.sent),
    creates: () => read.creates(fake.sent),
    appends: (kind: 'thinking' | 'instructions' | 'commentary') =>
      read.appends(fake.sent, kind),
    dispose: async () => {
      await runtime.end()
      session.dispose()
    },
  }
}

const status = (runtime: GuideRuntime) =>
  statusLine(runtime.getSnapshot().activity)
const connection = (runtime: GuideRuntime) =>
  connectionOf(runtime.getSnapshot().activity)

describe('the guide runtime', () => {
  it("reads the mode's verdict and never asks the Worker for one", async () => {
    const f = rig()
    f.grant({ state: 'granted', voices: ['marin'] })
    await f.runtime.start('cedar')
    // The verdict's voices decide the voice, and the verdict was never asked.
    expect(
      f.requests.filter((request) => request.path === GUIDE_VERDICT_PATH),
    ).toHaveLength(0)
    expect(f.runtime.getSnapshot().voice).toBe('marin')
    await f.dispose()
  })

  it('starts nothing, and says nothing of its own, for a refusal', async () => {
    const f = rig()
    for (const access of [
      { state: 'checking' },
      { state: 'refused', reason: 'not-granted' },
    ] as const) {
      f.grant(access)
      await f.runtime.start('marin')
      expect(connection(f.runtime)).toBe('offline')
      // A message here would greet whoever signs in next.
      expect(f.runtime.getSnapshot().message).toBeNull()
      // Loaded, it reports the verdict rather than an idle guide.
      expect(f.runtime.diagnostics()).toMatchObject({
        available: false,
        loaded: true,
        state: access.state === 'checking' ? 'checking' : access.reason,
      })
    }
    expect(
      f.requests.some((request) => request.path === GUIDE_SESSIONS_PATH),
    ).toBe(false)
    await f.dispose()
  })

  it('starts a session from the offer, greets by the documented recipe, and listens', async () => {
    const f = rig()
    await f.runtime.start('cedar')
    const creation = f.requests.find(
      (request) => request.path === GUIDE_SESSIONS_PATH,
    )!
    expect(creation.body).toMatchObject({ voice: 'cedar', sdp: 'offer' })
    expect(String((creation.body as { scene: string }).scene)).toContain(
      'local time is 21:04',
    )
    expect(f.fake.accepted).toEqual(['answer'])
    expect(f.appends('instructions')[0]).toMatch(
      /^Introduce yourself as Cedar, the guide here/,
    )
    expect(f.appends('commentary')[0]).toMatch(/^Begin the conversation now/)
    expect(read.indexOf(f.sent, 'session.commentary.append')).toBeGreaterThan(
      read.indexOf(f.sent, 'session.instructions.append'),
    )
    expect(connection(f.runtime)).toBe('connected')
    expect(f.runtime.getSnapshot().voice).toBe('cedar')
    expect(f.activity()).toEqual({ state: 'listening' })
    expect(f.runtime.diagnostics().sessionId).toBe('live_1')
    await f.dispose()
  })

  it('runs a delegated move at once and prompts the backend with the arrival', async () => {
    const f = rig()
    await f.runtime.start('marin')
    const call = f.delegated('go_to', {
      subject: 'Saturn',
      framing: 'portrait',
      motion: null,
    })
    await f.settle()
    expect(f.outputs()).toEqual([
      {
        callId: call,
        output: expect.objectContaining({
          status: 'moving',
          subject: 'Saturn',
        }),
      },
    ])
    expect(f.creates()).toBe(1)
    f.tick()
    expect(status(f.runtime)).toBe('Moving to Saturn')
    // The harness reads the code, which no rewording of the line moves.
    expect(f.runtime.diagnostics().state).toBe('moving')
    // The continuation ends the chain with words; only then may an arrival prompt.
    f.terminal('Heading over to Saturn.')
    f.arrive()
    const arrival = f
      .developer()
      .find((text) => text.startsWith('Arrived: Saturn'))
    expect(arrival).toContain('Narrate this stop now.')
    expect(f.creates()).toBe(2)
    expect(f.appends('thinking').at(-1)).toMatch(/looking at Saturn/)
    expect(f.runtime.getSnapshot().usage.responses).toBe(1)
    expect(f.runtime.getSnapshot().usage.cachedTokens).toBe(1900)
    await f.dispose()
  })

  it('lets a correction during travel replace the pending arrival without waiting', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Titan', framing: null, motion: null })
    await f.settle()
    f.terminal('Off to Titan.')
    f.tick()
    const correction = f.delegated('go_to', {
      subject: 'Enceladus',
      framing: null,
      motion: null,
    })
    await f.settle()
    expect(f.outputs().at(-1)).toEqual({
      callId: correction,
      output: expect.objectContaining({
        status: 'moving',
        subject: 'Enceladus',
      }),
    })
    f.terminal('Pivoting to Enceladus.')
    f.arrive()
    const arrivals = f.developer().filter((text) => text.startsWith('Arrived:'))
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]).toMatch(/^Arrived: Enceladus/)
    await f.dispose()
  })

  it('prompts an arrival that landed inside an open chain once the chain closes and the visitor is quiet', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('stand_at', { subject: 'Earth', site: 'summit' })
    await f.settle()
    const before = f.creates()
    // The stand completes before the backend has written its travel line.
    f.arrive()
    const arrivals = f.developer().filter((text) => text.startsWith('Arrived:'))
    expect(arrivals).toHaveLength(1)
    expect(f.creates()).toBe(before)
    f.terminal('Down to the summit.')
    f.receive(provider.visitorSaid('wait'))
    f.tick()
    expect(f.creates()).toBe(before)
    f.advance(1100, 2)
    expect(f.creates()).toBe(before + 1)
    expect(
      f.developer().filter((text) => text.startsWith('Arrived:')),
    ).toHaveLength(1)
    f.advance(1000, 5)
    expect(f.creates()).toBe(before + 1)
    await f.dispose()
  })

  it('tells the models about a drag once per gesture, not once per frame', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Titan', framing: null, motion: null })
    await f.settle()
    f.terminal('Heading to Titan.')
    const takeovers = () =>
      f.developer().filter((text) => text.startsWith('The visitor has taken'))
    for (let frame = 0; frame < 30; frame++) {
      f.session.harness.observatory.zoom(1.02)
      f.advance(16)
    }
    expect(takeovers()).toHaveLength(1)
    expect(
      f.appends('thinking').filter((text) => /taken the camera/.test(text)),
    ).toHaveLength(1)
    f.delegated('describe_view', {})
    await f.settle()
    f.session.harness.observatory.zoom(1.5)
    f.tick()
    expect(takeovers()).toHaveLength(2)
    await f.dispose()
  })

  it('executes a redelivered function call once', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('describe_view', {})
    f.receive(provider.functionCall('call_1', 'describe_view', '{}'))
    await f.settle()
    expect(f.outputs()).toHaveLength(1)
    expect(f.creates()).toBe(1)
    await f.dispose()
  })

  it('treats a takeover as the visitor choosing the view, and tells both models', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Titan', framing: null, motion: null })
    await f.settle()
    f.terminal('Heading to Titan.')
    f.session.harness.observatory.zoom(2)
    f.tick()
    expect(status(f.runtime)).toBe('You have the camera')
    expect(f.runtime.diagnostics().state).toBe('visitor-camera')
    expect(f.appends('thinking').at(-1)).toMatch(
      /^The visitor has taken the camera/,
    )
    const note = f.developer().at(-1)!
    expect(note).toMatch(/^The visitor has taken the camera/)
    expect(note).toContain('Current view:')
    f.arrive()
    expect(f.developer().some((text) => text.startsWith('Arrived:'))).toBe(
      false,
    )
    await f.dispose()
  })

  it('waits for the spoken beat and the declared quiet before continuing a tour', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Saturn', framing: null, motion: null })
    await f.settle()
    f.terminal('Heading to Saturn.')
    f.arrive()
    f.delegated('linger', { seconds: 5, reason: 'the rings' })
    await f.settle()
    expect(f.outputs().at(-1)?.output).toEqual({
      status: 'scheduled',
      seconds: 5,
    })
    f.terminal('Those rings are countless pieces of ice.')
    const before = f.creates()
    f.tick()
    f.speak(0.05)
    f.advance(2000, 20)
    f.speak(0)
    f.advance(2600, 26)
    await f.settle()
    // The declared quiet counts from the last word, not from the moment the
    // clock was sure the words had ended.
    f.advance(2000, 20)
    expect(f.creates()).toBe(before)
    f.advance(700, 7)
    expect(f.developer().at(-1)).toMatch(
      /^The visitor has looked quietly for 5 seconds/,
    )
    expect(f.creates()).toBe(before + 1)
    await f.dispose()
  })

  it.each([
    [
      'a refinement of the stop',
      'adjust_view',
      {
        azimuth_deg: 40,
        elevation_deg: null,
        distance_radii: null,
        zoom_factor: null,
      },
      true,
    ],
    [
      'a refused move',
      'go_to',
      { subject: 'No such world', framing: null, motion: null },
      true,
    ],
    ['a hold, which declares a new stop', 'hold_view', {}, false],
  ] as const)(
    'keeps a declared linger through %s only if it does not end the stop',
    async (_, name, args, keeps) => {
      const f = rig()
      await f.runtime.start('marin')
      f.delegated('go_to', { subject: 'Saturn', framing: null, motion: null })
      await f.settle()
      f.terminal('Heading to Saturn.')
      f.arrive()
      f.delegated('linger', { seconds: 5, reason: 'the rings' })
      await f.settle()
      f.delegated(name, args)
      await f.settle()
      f.terminal('There.')
      f.tick()
      f.speak(0.05)
      f.advance(2000, 20)
      f.speak(0)
      f.advance(2600, 26)
      await f.settle()
      f.advance(3000, 30)
      expect(
        f
          .developer()
          .some((text) => text.startsWith('The visitor has looked quietly')),
      ).toBe(keeps)
      await f.dispose()
    },
  )

  it('pauses both directions and holds the camera, then resumes, then ends cleanly', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.runtime.pause()
    expect(f.activity()).toEqual({ state: 'paused' })
    expect(status(f.runtime)).toBe('Paused')
    expect(f.runtime.diagnostics()).toMatchObject({
      state: 'paused',
      paused: true,
      microphone: 'muted',
    })
    expect(f.fake.microphone.at(-1)).toBe(true)
    expect(f.fake.guideAudio.at(-1)).toBe(true)
    expect(read.indexOf(f.sent, 'session.input_audio.mute')).toBeGreaterThan(-1)
    expect(f.appends('instructions').at(-1)).toMatch(/^The visitor paused/)
    f.runtime.resume()
    expect(f.activity()).toEqual({ state: 'listening' })
    expect(f.fake.microphone.at(-1)).toBe(false)
    expect(read.indexOf(f.sent, 'session.input_audio.unmute')).toBeGreaterThan(
      -1,
    )
    f.hide()
    expect(f.activity()).toEqual({ state: 'paused' })
    f.runtime.resume()
    f.runtime.pause()
    f.advance(180_000, 2)
    await f.settle()
    expect(connection(f.runtime)).toBe('offline')
    expect(f.runtime.getSnapshot().message).toMatch(/three minutes paused/)
    expect(f.fake.closes()).toBe(1)
    // Another account signing in drops it rather than being greeted by it.
    f.runtime.forgetMessage()
    expect(f.runtime.getSnapshot().message).toBeNull()
    f.session.dispose()
  })

  it('records an opt-in trace of the channel, bounded and detached', async () => {
    const f = rig()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      expect(f.runtime.trace()).toEqual([])
      f.runtime.trace(true)
      await f.runtime.start('marin')
      for (let i = 0; i < 210; i++) f.receive(provider.usage(i))
      // The guide's words arrive a fragment at a time and are not recorded.
      f.receive(provider.guideSaid('Those rings'))
      const entries = f.runtime.trace()
      expect(entries).toHaveLength(200)
      expect(JSON.stringify(entries)).not.toContain('Those rings')
      ;(entries[0] as unknown as { message: { type: string } }).message.type =
        'changed'
      expect(JSON.stringify(f.runtime.trace())).not.toContain('changed')
      expect(debug).toHaveBeenCalledWith('[guide]', expect.any(Object))
      f.runtime.trace(false)
      debug.mockClear()
      f.receive(provider.usage(999))
      expect(debug).not.toHaveBeenCalled()
    } finally {
      debug.mockRestore()
      await f.dispose()
    }
  })
})
